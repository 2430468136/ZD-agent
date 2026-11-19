'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('zhidianDesktop', Object.freeze({
  getAppInfo: () => ipcRenderer.invoke('zhidian:app-info'),
  loadHarnessLayout: () => ipcRenderer.invoke('zhidian:load-harness-layout'),
  saveHarnessLayout: (layout) => ipcRenderer.invoke('zhidian:save-harness-layout', layout),
  openCodexCli: () => ipcRenderer.invoke('zhidian:open-codex-cli'),
}))
