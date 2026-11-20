'use strict'
if (navigator.platform.includes('Mac')) document.documentElement.classList.add('mac')
const $ = id => document.getElementById(id)
const api = window.clipkeeper
const video = $('video')
let clips = [], selected, busy = false, selectionPlayback = false, generation = 0
let pendingWrite = Promise.resolve(), writeVersion = 0, writeError
const compatible = new Set()
const duration = () => Number.isFinite(video.duration) ? video.duration : 0
const outPoint = () => Math.min(selected?.end ?? duration(), duration())
const clock = seconds => {
  const ms = Math.round(Math.max(0, seconds || 0) * 1000)
  return String(Math.floor(ms / 60000)).padStart(2,'0') + ':' + String(Math.floor(ms / 1000) % 60).padStart(2,'0') + '.' + String(ms % 1000).padStart(3,'0')
}

let feedbackTimer
function updateFeedbackLifetime() {
  clearTimeout(feedbackTimer)
  if (!busy && !$('dismiss').hidden) return
  if (!busy) feedbackTimer = setTimeout(() => { $('feedback').hidden = true }, 5000)
}

$('dismiss').onclick = () => { $('feedback').hidden = true }

function status(message, error = false) {
  $('feedback').hidden = false
  $('dismiss').hidden = !error
  $('status').textContent = message
  $('status').classList.toggle('error', error)
  updateFeedbackLifetime()
}
function fail(error) {
  status(String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true)
}
const thumbs = new Map(), attempted = new Set(), thumbQueue = new Set()
let makingThumb = false
function applyThumb(tile, url) {
  const img = document.createElement('img')
  img.alt = ''; img.src = url
  tile.replaceChildren(img)
}
const thumbObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const id = entry.target.dataset.clip
    if (entry.isIntersecting && !attempted.has(id)) thumbQueue.add(id)
    else if (!entry.isIntersecting) thumbQueue.delete(id)
  }
  pumpThumbs()
}, { root:$('items') })

async function pumpThumbs() {
  if (makingThumb) return
  makingThumb = true
  try {
    for (const id of thumbQueue) {
      thumbQueue.delete(id)
      if (attempted.has(id) || !clips.some(c => c.id === id)) continue
      attempted.add(id)
      const v = document.createElement('video')
      v.muted = true
      try {
        const data = await new Promise(resolve => {
          const timeout = setTimeout(() => finish(null), 3500)
          function finish(value) {
            clearTimeout(timeout)
            v.onloadeddata = v.onseeked = v.onerror = null
            resolve(value)
          }
          function capture() {
            const canvas = document.createElement('canvas')
            canvas.width = 120; canvas.height = 76
            const ctx = canvas.getContext('2d')
            const scale = Math.max(120 / v.videoWidth, 76 / v.videoHeight)
            const w = v.videoWidth * scale, h = v.videoHeight * scale
            try {
              ctx.drawImage(v,(120 - w) / 2,(76 - h) / 2,w,h)
              finish(canvas.toDataURL('image/jpeg',0.72))
            } catch { finish(null) }
          }
          v.onloadeddata = () => {
            if (v.duration > 0.12) { v.onseeked = capture; v.currentTime = Math.min(1, v.duration / 4) }
            else capture()
          }
          v.onerror = () => finish(null)
          v.crossOrigin = 'anonymous'
          v.src = 'clip://source/' + id
        })
        if (data) {
          thumbs.set(id,data)
          const tile = document.querySelector('[data-clip="' + CSS.escape(id) + '"]')
          if (tile) applyThumb(tile,data)
        }
      } finally { v.removeAttribute('src'); v.load() }
    }
  } finally { makingThumb = false }
}

function drawRuler() {
  const canvas = $('ruler'), box = canvas.getBoundingClientRect()
  if (box.width < 1) return
  const dpr = window.devicePixelRatio, w = box.width, h = box.height
  if (canvas.width !== Math.round(w*dpr) || canvas.height !== Math.round(h*dpr)) {
    canvas.width = Math.round(w*dpr); canvas.height = Math.round(h*dpr)
  }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr,0,0,dpr,0,0)
  ctx.clearRect(0,0,w,h)
  const side = 7, usable = w - 2*side, total = duration() || 1
  const x = t => side + Math.max(0, Math.min(1, t/total)) * usable
  ctx.fillStyle = '#eee'; ctx.fillRect(side,4,usable,h-8)
  const a = x(selected?.start || 0), b = x(outPoint())
  ctx.fillStyle = '#cee6a6'; ctx.fillRect(a,4,b-a,h-8)
  // Keep the perforations inside the selection and clear of the lower time ticks.
  ctx.fillStyle = '#f8fbea'
  for (let hole = a + 5; hole + 4 < b - 2; hole += 12) ctx.fillRect(hole, 6, 4, 3)
  ctx.fillStyle = '#999'
  for (let i = 0; i <= 40; i++) {
    const tick = i % 5 ? 3 : 6
    ctx.fillRect(side + usable*i/40,h-4-tick,1,tick)
  }
  ctx.fillStyle = '#55783d'; ctx.fillRect(a,3,2,h-6); ctx.fillRect(b-2,3,2,h-6)
}
new ResizeObserver(drawRuler).observe($('ruler'))

function clipRow(clip) {
  const row = document.createElement('button')
  row.className = 'item' + (clip.id === selected?.id ? ' active' : '')
  row.disabled = busy
  const format = document.createElement('span')
  format.className = 'format'; format.textContent = clip.name.split('.').pop().toUpperCase()
  const info = document.createElement('span')
  info.className = 'item-text'
  const name = document.createElement('strong'), note = document.createElement('small')
  name.textContent = clip.name; note.textContent = clip.note || '无备注'
  format.dataset.clip = clip.id
  if (thumbs.has(clip.id)) applyThumb(format, thumbs.get(clip.id))
  else thumbObserver.observe(format)
  info.append(name, note); row.append(format, info); row.title = clip.path
  row.onclick = () => { if (clip !== selected) select(clip) }
  return row
}

const collapsed = new Set()
const searchCollapsed = new Set()
const folderOrder = new Intl.Collator('zh-CN', { numeric:true })

function renderFolders(parent, branch, closed) {
  const groups = [...branch.children.values()].sort((a, b) => folderOrder.compare(a.name, b.name))
  for (const group of groups) {
    const details = document.createElement('details')
    details.className = 'folder'
    details.open = !closed.has(group.path)
    const summary = document.createElement('summary')
    summary.title = group.path
    const label = document.createElement('span')
    label.textContent = group.name
    const count = document.createElement('small')
    count.textContent = group.count
    summary.append(label, count)
    summary.onclick = () => {
      if (details.open) closed.add(group.path)
      else closed.delete(group.path)
    }
    const children = document.createElement('div')
    children.className = 'folder-contents'
    renderFolders(children, group, closed)
    details.append(summary, children)
    parent.append(details)
  }
  for (const clip of branch.clips) parent.append(clipRow(clip))
}

function list() {
  const query = $('search').value.trim().toLowerCase()
  const tree = { children:new Map(), clips:[] }
  let matches = 0
  for (const clip of clips) {
    const folderName = clip.folders.map(f => f.name).join('/')
    if (query && !(folderName + '/' + clip.name + ' ' + clip.note).toLowerCase().includes(query)) continue
    matches++
    let branch = tree
    for (const folder of clip.folders) {
      if (!branch.children.has(folder.path)) {
        branch.children.set(folder.path, { ...folder, count:0, children:new Map(), clips:[] })
      }
      branch = branch.children.get(folder.path)
      branch.count++
    }
    branch.clips.push(clip)
  }
  thumbObserver.disconnect()
  $('items').replaceChildren()
  renderFolders($('items'), tree, query ? searchCollapsed : collapsed)
  if (!matches && query) {
    const hint = document.createElement('p')
    hint.textContent = '没有匹配的素材'
    $('items').append(hint)
  }
  $('total').textContent = clips.length

}
function controls() {
  const ready = !!selected && duration() > 0 && !video.error
  for (const id of ['markIn','markOut','play','playRange','reset','seek','newFile']) $(id).disabled = busy || !ready
  $('overwrite').disabled = busy || !ready || !/\.(mp4|m4v|mov)$/i.test(selected?.name || '')
  for (const id of ['remove','note','importFiles','importFolder','firstImport','makeProxy']) $(id).disabled = busy
  $('seek').max = duration() || 1
  $('seek').value = video.currentTime || 0
  $('position').textContent = clock(video.currentTime)
  $('duration').textContent = clock(duration())
  $('start').textContent = clock(selected?.start)
  $('end').textContent = clock(outPoint())
  $('length').textContent = '选中 ' + clock(Math.max(0, outPoint() - (selected?.start || 0)))
  drawRuler()
  $('play').textContent = video.paused ? '▶' : 'Ⅱ'
}
function select(clip) {
  video.pause()
  selectionPlayback = false
  $('more').open = false
  selected = clip
  for (const folder of clip?.folders || []) collapsed.delete(folder.path)
  generation++
  $('empty').hidden = !!clip; $('editor').hidden = !clip
  $('viewerMessage').hidden = true
  $('saved').textContent = ''
  if (clip) {
    $('name').textContent = clip.name; $('filePath').textContent = clip.path
    $('note').value = clip.note
    video.src = 'clip://' + (compatible.has(clip.id) ? 'proxy/' : 'source/') + clip.id + '?v=' + generation
  } else { video.removeAttribute('src') }
  video.load()
  list(); controls()
}

function edit(values) {
  if (!selected) return
  const clip = selected
  const version = ++writeVersion
  Object.assign(clip, values)
  $('saved').textContent = '保存中…'
  // IPC invocations are queued so rapid keystrokes cannot restore an older note.
  const snapshot = { note:clip.note, start:clip.start, end:clip.end }
  pendingWrite = pendingWrite.then(async () => {
    try {
      await api.edit(clip.id, snapshot)
      writeError = undefined
      if (clip === selected && version === writeVersion) $('saved').textContent = '已保存'
    } catch (error) {
      writeError = error
      if (clip === selected) $('saved').textContent = '保存失败'
      fail(error)
    }
  })
  controls()
}

async function task(fn, cancellable = false) {
  if (busy) return
  busy = true; $('cancel').hidden = !cancellable
  list(); controls()
  try {
    await pendingWrite
    if (writeError) throw writeError
    await fn()
  } catch (error) { fail(error) }
  finally { busy = false; $('cancel').hidden = true; updateFeedbackLifetime(); list(); controls() }
}
function pick(kind) {
  task(async () => {
    status('正在导入…')
    const result = await api.import(kind)
    if (!result) { status('已取消导入'); return }
    clips = result.clips
    $('search').value = ''
    select(clips.find(c => c.id === (result.first || selected?.id)) || clips[0])
    status('已导入 ' + result.added + ' 条，重复 ' + result.duplicate + ' 条' + (result.skipped ? '，无法读取 ' + result.skipped + ' 项' : ''))
  })
}
$('search').oninput = () => { searchCollapsed.clear(); list() }
$('importFiles').onclick = $('firstImport').onclick = () => pick('files')
$('importFolder').onclick = () => pick('folder')
$('note').oninput = () => { edit({ note:$('note').value }); list() }
$('seek').oninput = () => { selectionPlayback = false; video.currentTime = Number($('seek').value) }
$('play').onclick = () => {
  selectionPlayback = false
  if (video.paused) video.play().catch(fail)
  else video.pause()
}
$('markIn').onclick = () => {
  if (video.currentTime >= outPoint()) return status('入点必须早于出点', true)
  edit({ start:video.currentTime })
}
$('markOut').onclick = () => {
  if (video.currentTime <= selected.start) return status('出点必须晚于入点', true)
  edit({ end:video.currentTime })
}
$('reset').onclick = () => edit({ start:0, end:null })
$('playRange').onclick = () => { video.currentTime = selected.start; selectionPlayback = true; video.play().catch(fail) }
video.ontimeupdate = () => {
  if (selectionPlayback && video.currentTime >= outPoint()) {
    selectionPlayback = false; video.pause(); video.currentTime = outPoint()
  }
  controls()
}
video.onplay = video.onpause = controls
video.ondurationchange = controls
video.onloadedmetadata = () => {
  if (selected && duration()) {
    if (selected.start >= duration() || (selected.end !== null && selected.end > duration() + 0.001)) edit({ start:0, end:null })
    video.currentTime = selected.start
    $('viewerMessage').hidden = true
  }
  controls()
}
video.onerror = () => {
  if (!selected) return
  $('viewerMessage').hidden = false
  $('mediaError').textContent = '无法直接播放，请确认文件仍在原位置，或生成兼容预览。'
  controls()
}
$('makeProxy').onclick = () => task(async () => {
  const clip = selected
  status('正在生成兼容预览…')
  await api.proxy(clip.id); compatible.add(clip.id); select(clip); status('兼容预览已就绪')
}, true)
document.addEventListener('click', event => {
  if (!$('more').contains(event.target)) $('more').open = false
})
document.addEventListener('keydown', event => { if (event.key === 'Escape') $('more').open = false })
$('reveal').onclick = () => { $('more').open = false; api.reveal(selected.id).catch(fail) }
$('remove').onclick = () => task(async () => {
  clips = await api.remove(selected.id)
  select(clips[0]); status('已移出素材库，磁盘文件保留')
})
function output(mode) {
  if (!selected || !duration()) return
  video.pause()
  const id = selected.id, range = { start:selected.start, end:outPoint() }
  task(async () => {
    status('等待导出选择…')
    const result = await api.export(id, range, mode)
    if (!result) { status('已取消导出'); return }
    clips = result.clips; compatible.delete(result.id); thumbs.delete(result.id); attempted.delete(result.id); $('search').value = ''
    select(clips.find(c => c.id === result.id)); status('已保存到 ' + result.file)
  }, true)
}
$('overwrite').onclick = () => output('overwrite')
$('newFile').onclick = () => output('new')
$('cancel').onclick = () => api.cancel().catch(fail)
api.onProgress(({ label, percent }) => status(label + ' · ' + percent + '%'))
document.addEventListener('keydown', event => {
  if (busy || !selected || !duration() || event.metaKey || event.ctrlKey || event.altKey ||
    event.target.matches('textarea,input,[contenteditable]')) return
  const action = { Space:'play', KeyI:'markIn', KeyO:'markOut' }[event.code]
  if (action) { event.preventDefault(); $(action).click() }
})
api.list().then(items => { clips = items; select(items[0]) }).catch(fail)
