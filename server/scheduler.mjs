const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/

function parseInstant(value) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error('时间必须是有效的 ISO 日期或时间戳。')
  return timestamp
}

function assertTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) throw new Error('周期计划必须指定 IANA 时区。')
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(0) } catch { throw new Error(`无效的 IANA 时区：${timeZone}`) }
  return timeZone
}

export function normalizeRecurrence(value) {
  if (!value || typeof value !== 'object') throw new Error('缺少计划重复规则。')
  if (value.kind === 'once') {
    if (typeof value.runAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.runAt)) throw new Error('一次性计划必须使用含时区偏移的 ISO 时间。')
    const runAt = parseInstant(value.runAt)
    return { kind: 'once', runAt: new Date(runAt).toISOString(), timezone: 'UTC' }
  }
  const timeZone = assertTimeZone(value.timezone)
  if (typeof value.time !== 'string' || !TIME_PATTERN.test(value.time)) throw new Error('周期计划时间必须使用 24 小时 HH:mm 格式。')
  if (value.kind === 'daily') return { kind: 'daily', time: value.time, timezone: timeZone }
  if (value.kind === 'weekly') {
    if (!Array.isArray(value.days) || value.days.length === 0 || value.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error('每周计划必须选择至少一个有效星期（0=周日，6=周六）。')
    return { kind: 'weekly', days: [...new Set(value.days)].sort((a, b) => a - b), time: value.time, timezone: timeZone }
  }
  throw new Error(`不支持的计划重复规则：${String(value.kind ?? '')}`)
}

function zonedParts(timestamp, timeZone) {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp))
  const parts = Object.fromEntries(values.map(({ type, value }) => [type, value]))
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) }
}

function sameWallTime(parts, target) {
  return parts.year === target.year && parts.month === target.month && parts.day === target.day && parts.hour === target.hour && parts.minute === target.minute
}

function wallClockToInstant(target, timeZone) {
  const naiveUtc = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute)
  const offsets = new Set()
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = naiveUtc + hours * 60 * 60 * 1000
    const parts = zonedParts(sample, timeZone)
    offsets.add((Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(sample / 1000) * 1000) / 60_000)
  }
  const candidates = [...offsets].map((offset) => naiveUtc - offset * 60_000).map((timestamp) => ({ timestamp, local: zonedParts(timestamp, timeZone) }))
  const exact = candidates.filter(({ local }) => sameWallTime(local, target)).sort((a, b) => a.timestamp - b.timestamp)
  if (exact.length) return exact[0].timestamp // Ambiguous fall-back time: choose the earlier instant.

  // A spring-forward wall time does not exist. Shift it forward by the DST gap,
  // choosing the candidate with the smallest local-time overshoot (e.g. 02:30 -> 03:30).
  const targetWall = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute)
  const afterGap = candidates.map((candidate) => ({ ...candidate, localWall: Date.UTC(candidate.local.year, candidate.local.month - 1, candidate.local.day, candidate.local.hour, candidate.local.minute) }))
    .filter((candidate) => candidate.localWall > targetWall)
    .sort((a, b) => (a.localWall - targetWall) - (b.localWall - targetWall) || a.timestamp - b.timestamp)
  if (afterGap.length) return afterGap[0].timestamp
  throw new Error('无法解析该时区的本地计划时间。')
}

function addCalendarDays({ year, month, day }, count) {
  const date = new Date(Date.UTC(year, month - 1, day + count))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

export function nextScheduleAt(recurrenceInput, after = Date.now()) {
  const recurrence = normalizeRecurrence(recurrenceInput)
  const afterTimestamp = parseInstant(after)
  if (recurrence.kind === 'once') return Date.parse(recurrence.runAt) > afterTimestamp ? recurrence.runAt : null
  const current = zonedParts(afterTimestamp, recurrence.timezone)
  const [hour, minute] = recurrence.time.split(':').map(Number)
  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const date = addCalendarDays(current, dayOffset)
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
    if (recurrence.kind === 'weekly' && !recurrence.days.includes(weekday)) continue
    const candidate = wallClockToInstant({ ...date, hour, minute }, recurrence.timezone)
    if (candidate > afterTimestamp) return new Date(candidate).toISOString()
  }
  throw new Error('无法计算下一次计划运行时间。')
}

export function deterministicOccurrenceId(scheduleId, scheduledFor) {
  const safeTime = new Date(parseInstant(scheduledFor)).toISOString()
  return `occ-${encodeURIComponent(scheduleId)}-${safeTime.replace(/[^0-9A-Za-z]/g, '')}`
}

