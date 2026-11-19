'use strict'

const { app, BrowserWindow, dialog, ipcMain, session, utilityProcess } = require('electron')
const { randomBytes } = require('node:crypto')
const { execFile, spawn } = require('node:child_process')
const { promisify } = require('node:util')
const { mkdir } = require('node:fs/promises')
const { join } = require('node:path')
const { loadHarnessLayout, saveHarnessLayout } = require('./harness-layout.cjs')

const execFileAsync = promisify(execFile)
const APP_SCHEME = 'http:'
let mainWindow = null
let serverProcess = null
let serverOrigin = null
let serverToken = null
let quitAfterShutdown = false
let shutdownPromise = null
let serverExitPromise = null
let isStopping = false

app.setName('Zhidian')
app.setAppUserModelId('com.zhidian.desktop')
const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    try {
      serverToken = randomBytes(32).toString('base64url')
      serverOrigin = await startLocalServer(serverToken)
      await createMainWindow()
    } catch (error) {
      console.error('Zhidian desktop startup failed:', error?.name ?? 'Error')
      dialog.showErrorBox('织点启动失败', '本机工作服务未能安全启动。请关闭应用后重试；如果问题持续，请检查安装是否完整。')
      app.quit()
    }
  })
}

function safeServerEnvironment(token) {
  const allowedKeys = [
    'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'TEMP', 'TMP',
    'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'CODEX_HOME',
  ]
  const env = Object.fromEntries(allowedKeys.filter((key) => process.env[key]).map((key) => [key, process.env[key]]))
  const userData = app.getPath('userData')
  env.ZHIDIAN_DESKTOP_MODE = '1'
  env.ZHIDIAN_DESKTOP_TOKEN = token
  env.ZHIDIAN_API_PORT = '0'
  env.ZHIDIAN_DATA_DIR = join(userData, 'data')
  return env
}

async function startLocalServer(token) {
  const userData = app.getPath('userData')
  const dataDir = join(userData, 'data')
  await mkdir(dataDir, { recursive: true })
  const serverEntry = join(app.getAppPath(), 'server.mjs')
  const child = utilityProcess.fork(serverEntry, [], {
    cwd: userData,
    env: safeServerEnvironment(token),
    stdio: ['ignore', 'pipe', 'pipe'],
    serviceName: 'Zhidian Local Workbench',
  })
  serverProcess = child
  serverExitPromise = new Promise((resolveExit) => child.once('exit', resolveExit))
  child.stderr?.on('data', () => {})
  child.once('exit', (code) => {
    if (serverOrigin && !isStopping) {
      serverToken = null
      serverOrigin = null
      dialog.showErrorBox('织点本机服务已停止', '本机工作服务意外退出（代码 ' + code + '）。请重新启动织点；未完成的任务状态会保留在本机记录中。')
      app.quit()
    }
  })

  return new Promise((resolve, reject) => {
    let output = ''
    let settled = false
    const timeout = setTimeout(() => finish(new Error('Local service startup timed out.')), 30_000)
    const finish = (error, origin) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) child.stdout?.removeListener('data', onStdout)
      child.removeListener('exit', onExit)
      if (error) reject(error)
      else resolve(origin)
    }
    const onStdout = (chunk) => {
      if (settled) return
      output = (output + chunk.toString('utf8')).slice(-4096)
      const match = /(?:^|\n)ZHIDIAN_DESKTOP_READY:(\d+)(?:\r?\n|$)/.exec(output)
      if (match) finish(null, APP_SCHEME + '//127.0.0.1:' + match[1])
    }
    const onExit = (code) => finish(new Error('Local service exited before ready (' + code + ').'))
    child.stdout?.on('data', onStdout)
    child.once('exit', onExit)
    child.once('error', () => finish(new Error('Local service process could not start.')))
  })
}

function isTrustedAppUrl(value) {
  if (!serverOrigin || typeof value !== 'string') return false
  try { return new URL(value).origin === serverOrigin } catch { return false }
}

function installRequestAuthorization(window) {
  const webRequest = session.defaultSession.webRequest
  const webContentsId = window.webContents.id
  webRequest.onBeforeSendHeaders({ urls: ['http://127.0.0.1/*'] }, (details, callback) => {
    const headers = { ...details.requestHeaders }
    let trusted = false
    try {
      const requestUrl = new URL(details.url)
      trusted = requestUrl.origin === serverOrigin
        && details.webContentsId === webContentsId
        && (!details.initiatorOrigin || details.initiatorOrigin === serverOrigin)
    } catch { /* Deny malformed request URLs. */ }
    for (const name of Object.keys(headers)) if (name.toLowerCase() === 'authorization') delete headers[name]
    if (trusted && serverToken) headers.Authorization = 'Bearer ' + serverToken
    callback({ requestHeaders: headers })
  })
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#f5f2eb',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged && process.env.ZHIDIAN_DESKTOP_DEVTOOLS === '1',
    },
  })
  installRequestAuthorization(mainWindow)
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedAppUrl(url)) event.preventDefault()
  })
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (!isTrustedAppUrl(url)) event.preventDefault()
  })
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = null })
  await mainWindow.loadURL(serverOrigin + '/')
}

function assertTrustedIpc(event) {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id || !isTrustedAppUrl(event.senderFrame?.url)) {
    throw new Error('Untrusted desktop IPC sender.')
  }
}

ipcMain.handle('zhidian:app-info', (event) => {
  assertTrustedIpc(event)
  return { name: '织点', version: app.getVersion(), desktop: true }
})

ipcMain.handle('zhidian:load-harness-layout', (event) => {
  assertTrustedIpc(event)
  return loadHarnessLayout(app.getPath('userData'))
})

ipcMain.handle('zhidian:save-harness-layout', (event, layout) => {
  assertTrustedIpc(event)
  return saveHarnessLayout(app.getPath('userData'), layout)
})

ipcMain.handle('zhidian:open-codex-cli', (event) => {
  assertTrustedIpc(event)
  if (process.platform !== 'win32') throw new Error('此入口当前仅支持 Windows。')
  const allowedKeys = [
    'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'TEMP', 'TMP',
    'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'CODEX_HOME',
  ]
  const env = Object.fromEntries(allowedKeys.filter((key) => process.env[key]).map((key) => [key, process.env[key]]))
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('powershell.exe', ['-NoLogo', '-NoExit', '-Command', 'codex'], {
        detached: true, windowsHide: false, stdio: 'ignore', shell: false, env,
      })
    } catch { reject(new Error('无法启动 Codex CLI 终端。')); return }
    child.once('spawn', () => { child.unref(); resolve(true) })
    child.once('error', () => reject(new Error('未能打开 Codex CLI；请确认 codex 在 PATH 中。')))
  })
})

function waitForExit(child, timeoutMs) {
  if (!child) return Promise.resolve(true)
  const exit = serverExitPromise ?? new Promise((resolveExit) => child.once('exit', resolveExit))
  return new Promise((resolve) => {
    let settled = false
    const finish = (exited) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(exited)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    void exit.then(() => finish(true))
  })
}

async function forceStopProcessTree(child) {
  if (process.platform === 'win32' && child.pid) {
    try {
      await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 })
      return
    } catch { /* Fall back to terminating the utility process itself. */ }
  }
  child.kill()
}

async function stopLocalServer() {
  const child = serverProcess
  if (!child) return
  isStopping = true
  const exited = waitForExit(child, 12_000)
  try { child.postMessage({ type: 'zhidian:shutdown' }) } catch { /* It may have exited already. */ }
  if (!await exited) {
    const forcedExit = waitForExit(child, 4_000)
    await forceStopProcessTree(child)
    await forcedExit
  }
  if (serverProcess === child) serverProcess = null
  serverOrigin = null
  serverToken = null
}

app.on('before-quit', (event) => {
  if (quitAfterShutdown || !serverProcess) return
  event.preventDefault()
  if (shutdownPromise) return
  shutdownPromise = stopLocalServer().finally(() => {
    quitAfterShutdown = true
    app.quit()
  })
})

app.on('window-all-closed', () => app.quit())
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverOrigin) void createMainWindow()
})
