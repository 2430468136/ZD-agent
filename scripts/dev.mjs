import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const api = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: 'inherit', env: process.env, windowsHide: true })
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { cwd: root, stdio: 'inherit', env: process.env, windowsHide: true })
let stopping = false

function stop(code = 0) {
  if (stopping) return
  stopping = true
  api.kill('SIGTERM')
  vite.kill('SIGTERM')
  process.exitCode = code
}

api.on('error', (error) => {
  console.error(`Local API failed to start: ${error.message}`)
  stop(1)
})
vite.on('error', (error) => {
  console.error(`Vite failed to start: ${error.message}`)
  stop(1)
})
api.on('exit', (code) => {
  if (!stopping && code !== 0) stop(code ?? 1)
})
vite.on('exit', (code) => {
  if (!stopping) stop(code ?? 0)
})
process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))
