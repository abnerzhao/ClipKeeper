const { contextBridge, ipcRenderer } = require('electron')
const api = {}
for (const name of ['list','import','edit','remove','reveal','cancel','proxy','export']) {
  api[name] = (...args) => ipcRenderer.invoke(name, ...args)
}
api.onProgress = fn => ipcRenderer.on('progress', (_event, data) => fn(data))
contextBridge.exposeInMainWorld('cutshelf', api)
