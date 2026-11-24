const { contextBridge, ipcRenderer } = require('electron')
const api = {}
for (const name of ['list','metadata','import','edit','remove','reveal','cancel','proxy','capture','export']) {
  api[name] = (...args) => ipcRenderer.invoke(name, ...args)
}
api.onFullscreen = fn => { ipcRenderer.on('window-fullscreen', (_event, active) => fn(active)) }
api.onProgress = fn => ipcRenderer.on('progress', (_event, data) => fn(data))
contextBridge.exposeInMainWorld('clipkeeper', api)
