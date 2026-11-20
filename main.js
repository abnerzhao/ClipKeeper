const { app, BrowserWindow, dialog, ipcMain, protocol, shell, Menu, nativeImage } = require('electron')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { Readable } = require('node:stream')
const { pathToFileURL } = require('node:url')
const { randomUUID } = require('node:crypto')
const { Library } = require('./library')
const { discover, suggestName, exportCut, preview, writable, extension, formats } = require('./media')

protocol.registerSchemesAsPrivileged([{ scheme: 'clip', privileges: {
  standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true
} }])
const page = pathToFileURL(path.join(__dirname, 'ui', 'index.html')).href
let win, library, cacheDir, job
const proxies = new Map()

async function stream(request) {
  const url = new URL(request.url)
  const id = url.pathname.slice(1)
  const file = url.hostname === 'proxy' ? proxies.get(id) : library.clips.find(c => c.id === id)?.path
  if (!file) return new Response(null, { status: 404 })
  try {
    const { size } = await fsp.stat(file)
    const mime = { '.mov':'video/quicktime', '.webm':'video/webm', '.mkv':'video/x-matroska',
      '.avi':'video/x-msvideo', '.mpg':'video/mpeg', '.mpeg':'video/mpeg' }
    const headers = { 'Content-Type': mime[extension(file)] || 'video/mp4', 'Access-Control-Allow-Origin':'*', 'Accept-Ranges':'bytes', 'Cache-Control':'no-store' }
    let start = 0, end = size - 1
    const range = request.headers.get('range')
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416 })
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
      end = match[1] && match[2] ? Math.min(end, Number(match[2])) : end
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range':'bytes */' + size } })
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size
    }
    headers['Content-Length'] = String(end - start + 1)
    const body = request.method === 'HEAD' || !size ? null : Readable.toWeb(fs.createReadStream(file, { start, end }))
    return new Response(body, { status: range ? 206 : 200, headers })
  } catch { return new Response(null, { status: 404 }) }
}

function openWindow() {
  win = new BrowserWindow({ width: 1240, height: 810, minWidth: 880, minHeight: 650,
    backgroundColor: '#ffffff', title: app.name,
    ...(process.platform === 'darwin' ? { titleBarStyle:'hiddenInset', trafficLightPosition:{ x:20, y:19 } } : {}), webPreferences: {
      preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false
    } })
  win.webContents.setWindowOpenHandler(() => ({ action:'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.on('close', e => {
    if (job) { e.preventDefault(); dialog.showMessageBoxSync(win, { message:'请先完成或取消当前任务，再关闭窗口。' }) }
  })
  win.on('closed', () => { win = null })
  win.loadFile(path.join(__dirname, 'ui', 'index.html'))
}

function handle(name, fn) {
  ipcMain.handle(name, (event, ...args) => {
    if (!win || event.sender !== win.webContents || event.senderFrame?.url !== page)
      throw new Error('未知窗口')
    return fn(...args)
  })
}
function tick(label, percent) {
  win?.webContents.send('progress', { label, percent })
}

async function runJob(fn) {
  if (job) throw new Error('请等待当前任务完成')
  job = new AbortController()
  try { return await fn(job.signal) }
  finally { job = null }
}

function bind() {
  handle('list', () => library.rows())
  handle('import', async kind => {
    const folder = kind === 'folder'
    const pick = await dialog.showOpenDialog(win, {
      title: folder ? '导入素材文件夹' : '批量导入视频',
      properties: ['multiSelections', folder ? 'openDirectory' : 'openFile'],
      filters: folder ? [] : [{ name:'视频素材', extensions:[...formats].map(x => x.slice(1)) }]
    })
    if (pick.canceled) return null
    const { files, skipped, roots } = await discover(pick.filePaths)
    const fresh = library.add(files, '', roots)
    return { clips:library.rows(), first:fresh[0]?.id, added:fresh.length, duplicate:files.length - fresh.length, skipped }
  })
  handle('edit', (id, changes) => {
    const valid = {}
    if (typeof changes.note === 'string') valid.note = changes.note.slice(0, 4000)
    if (Number.isFinite(changes.start) && changes.start >= 0 &&
      (changes.end === null || Number.isFinite(changes.end) && changes.end > changes.start)) {
      valid.start = changes.start; valid.end = changes.end
    }
    return library.update(id, valid)
  })
  handle('remove', id => { library.remove(id); proxies.delete(id); return library.rows() })
  handle('reveal', id => shell.showItemInFolder(library.get(id).path))
  handle('cancel', () => job?.abort())
  handle('proxy', id => runJob(async signal => {
    const file = library.get(id).path
    const temp = path.join(cacheDir, randomUUID() + '.mp4')
    try {
      await preview(file, temp, signal)
      proxies.set(id, temp)
    } catch (error) { await fsp.rm(temp, { force:true }); throw error }
  }))
  handle('export', (id, range, mode) => runJob(async signal => {
    const clip = library.get(id)
    const overwrite = mode === 'overwrite'
    if (!overwrite && mode !== 'new') throw new Error('未知导出模式')
    let target
    if (overwrite) {
      if (!writable.has(extension(clip.path))) throw new Error('该格式请另存为 MP4')
      const answer = await dialog.showMessageBox(win, { type:'warning', message:'覆盖「' + clip.name + '」？',
        detail:'将用所选区间替换原片。仅导出主视频和第一条音轨（H.264 8-bit / AAC），其他轨道和原始编码信息可能丢失。此操作无法撤销。',
        buttons:['取消','覆盖原片'], defaultId:0, cancelId:0 })
      if (answer.response !== 1) return null
      target = clip.path
    } else {
      const result = await dialog.showSaveDialog(win, { title:'导出为新视频',
        defaultPath:path.join(path.dirname(clip.path), suggestName(clip.path, clip.note)),
        filters:[{ name:'MP4 视频', extensions:['mp4'] }, { name:'QuickTime 视频', extensions:['mov'] }] })
      if (result.canceled) return null
      target = result.filePath
    }
    tick('正在导出', 0)
    await exportCut({ source:clip.path, target, ...range, overwrite, signal,
      onProgress: seconds => tick('正在导出', Math.min(99, Math.round(seconds * 100 / (range.end - range.start)))) })
    try {
      const outputPath = await fsp.realpath(target)
      const existing = library.clips.find(item => item.path === outputPath)
      const output = existing ? library.update(existing.id, { start:0, end:null, note:clip.note }) : library.add([outputPath], clip.note)[0]
      proxies.delete(output.id)
      return { clips:library.rows(), id:output.id, file:target }
    } catch (e) { throw new Error('视频已保存到 ' + target + '，素材库更新失败：' + e.message) }
  }))
}

// Keep the profile independent of the localized display name.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  const profile = path.join(app.getPath('appData'), 'ClipKeeper')
  app.setPath('userData', profile)
  app.setPath('sessionData', profile)
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (win) { win.restore(); win.focus() } })
  app.whenReady().then(async () => {
    if (app.dock) {
      const icon = fs.readFileSync(path.join(__dirname, 'ui', 'assets', 'dock.png'))
      app.dock.setIcon(nativeImage.createFromBuffer(icon))
    }
    library = new Library(app.getPath('userData'))
    cacheDir = await fsp.mkdtemp(path.join(app.getPath('temp'), 'clipkeeper-preview-'))
    protocol.handle('clip', stream)
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role:'appMenu' }] : []),
      { role:'editMenu', label:'编辑' }, { role:'windowMenu', label:'窗口' }
    ]))
    bind(); openWindow()
  }).catch(error => { dialog.showErrorBox(app.name + ' 启动失败', error.message); app.quit() })
  app.on('window-all-closed', () => app.quit())
  app.on('quit', () => { if (cacheDir) fs.rmSync(cacheDir, { recursive:true, force:true }) })
}
