import test from 'node:test'
import assert from 'node:assert/strict'
import { deterministicOccurrenceId, nextScheduleAt, normalizeRecurrence } from './scheduler.mjs'

test('one-time schedules normalize timestamps and become due exactly once', () => {
  const recurrence = normalizeRecurrence({ kind: 'once', runAt: '2026-12-01T10:00:00-07:00' })
  assert.deepEqual(recurrence, { kind: 'once', runAt: '2026-12-01T17:00:00.000Z', timezone: 'UTC' })
  assert.equal(nextScheduleAt(recurrence, '2026-12-01T16:59:59.000Z'), recurrence.runAt)
  assert.equal(nextScheduleAt(recurrence, '2026-12-01T17:00:00.000Z'), null)
})

test('daily schedules resolve local time in an IANA timezone', () => {
  const recurrence = { kind: 'daily', time: '09:15', timezone: 'America/Phoenix' }
  assert.equal(nextScheduleAt(recurrence, '2026-11-19T15:00:00.000Z'), '2026-11-19T16:15:00.000Z')
  assert.equal(nextScheduleAt(recurrence, '2026-11-19T17:00:00.000Z'), '2026-11-20T16:15:00.000Z')
})

test('weekly schedules select the next configured weekday', () => {
  const recurrence = { kind: 'weekly', days: [5, 1, 5], time: '09:00', timezone: 'America/Phoenix' }
  assert.deepEqual(normalizeRecurrence(recurrence).days, [1, 5])
  assert.equal(nextScheduleAt(recurrence, '2026-11-19T15:00:00.000Z'), '2026-11-20T16:00:00.000Z')
  assert.equal(nextScheduleAt(recurrence, '2026-11-20T17:00:00.000Z'), '2026-11-23T16:00:00.000Z')
})

test('DST boundaries choose the earlier ambiguous time and shift nonexistent wall time forward', () => {
  const fallBack = { kind: 'daily', time: '01:30', timezone: 'America/New_York' }
  assert.equal(nextScheduleAt(fallBack, '2026-11-01T04:00:00.000Z'), '2026-11-01T05:30:00.000Z')
  const springForward = { kind: 'daily', time: '02:30', timezone: 'America/New_York' }
  assert.equal(nextScheduleAt(springForward, '2026-03-08T05:00:00.000Z'), '2026-03-08T07:30:00.000Z')
})

test('invalid recurrence inputs fail closed and occurrence IDs are deterministic', () => {
  assert.throws(() => normalizeRecurrence({ kind: 'daily', time: '25:00', timezone: 'UTC' }), /HH:mm/)
  assert.throws(() => normalizeRecurrence({ kind: 'daily', time: '08:00', timezone: 'Not/AZone' }), /IANA/)
  assert.throws(() => normalizeRecurrence({ kind: 'weekly', days: [], time: '08:00', timezone: 'UTC' }), /星期/)
  assert.equal(deterministicOccurrenceId('schedule-1', '2026-11-19T10:00:00Z'), deterministicOccurrenceId('schedule-1', '2026-11-19T10:00:00.000Z'))
})
