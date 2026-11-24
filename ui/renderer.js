'use strict'
if (navigator.platform.includes('Mac')) document.documentElement.classList.add('mac')
const $ = id => document.getElementById(id)
const api = window.clipkeeper
api.onFullscreen(active => document.documentElement.classList.toggle('window-fullscreen', active))
const video = $('video')
let clips = [], selected, busy = false, generation = 0
let pendingWrite = Promise.resolve(), writeError
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

const trimTrack = $('trimTrack')
let trimDrag
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const divider = $('divider')
function setSidebarWidth(px) {
  const width = Math.round(clamp(px, 212, window.innerWidth - 400))
  document.documentElement.style.setProperty('--sidebar-width', width + 'px')
  divider.setAttribute('aria-valuenow', width)
}
const storedWidth = Number(localStorage.getItem('sidebarWidth'))
if (storedWidth > 0) setSidebarWidth(storedWidth)
new ResizeObserver(() => {
  divider.setAttribute('aria-valuemin', 212)
  divider.setAttribute('aria-valuemax', window.innerWidth - 400)
  divider.setAttribute('aria-valuenow', $('library').offsetWidth)
}).observe($('library'))
divider.onpointerdown = event => {
  if (event.button !== 0 || !event.isPrimary) return
  event.preventDefault()
  divider.setPointerCapture(event.pointerId)
  divider.classList.add('dragging')
}
divider.onpointermove = event => {
  if (divider.hasPointerCapture(event.pointerId)) setSidebarWidth(event.clientX)
}
divider.onlostpointercapture = () => {
  divider.classList.remove('dragging')
  localStorage.setItem('sidebarWidth', $('library').offsetWidth)
}
divider.ondblclick = () => {
  document.documentElement.style.removeProperty('--sidebar-width')
  localStorage.removeItem('sidebarWidth')
}
divider.onkeydown = event => {
  if (!['ArrowLeft','ArrowRight'].includes(event.key)) return
  event.preventDefault()
  setSidebarWidth($('library').offsetWidth + (event.key === 'ArrowLeft' ? -16 : 16))
  localStorage.setItem('sidebarWidth', $('library').offsetWidth)
}

function pinchSelection(event) {
  if (!event.ctrlKey || !selected || !duration()) return
  event.preventDefault()
  if (busy || trimDrag || video.error || !event.deltaY) return
  const total = duration(), start = selected.start, end = outPoint()
  const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.12 : 0.012))
  const length = clamp((end - start) * factor, Math.min(0.001, total), total)
  const left = clamp((start + end - length) / 2, 0, total - length)
  const right = Math.min(total, left + length)
  if (left === start && right === end) return
  video.pause()
  if (video.currentTime < left || video.currentTime > right) video.currentTime = left
  edit({ start:left, end:right >= total ? null : right })
}
for (const target of [$('ruler'), $('segments')]) target.addEventListener('wheel', pinchSelection, { passive:false })

async function showMetadata(clip, version) {
  const list = $('metadata')
  list.replaceChildren()
  try {
    const data = await api.metadata(clip.id)
    if (version !== generation) return
    const size = data.size >= 1e6 ? (data.size / 1e6).toFixed(1) + ' MB' : (data.size / 1e3).toFixed(1) + ' KB'
    for (const [label, value] of [['分辨率', data.resolution], ['帧率', data.fps && data.fps + ' fps'],
      ['格式', [data.format, data.codec].filter(Boolean).join(' / ')], ['文件大小', size], ['拍摄设备', data.device]]) {
      if (!value) continue
      const item = document.createElement('span')
      item.textContent = value
      item.title = label + '：' + value
      list.append(item)
    }
  } catch {
    if (version === generation) list.textContent = '无法读取原文件信息'
  }
}

function pointTime(clientX) {
  const box = trimTrack.getBoundingClientRect()
  return clamp((clientX - box.left) / box.width, 0, 1) * duration()
}

trimTrack.onpointerdown = event => {
  if (event.button !== 0 || !event.isPrimary || trimDrag || busy || !selected || !duration() || video.error) return
  event.preventDefault()
  const start = selected.start, end = outPoint(), anchor = pointTime(event.clientX)
  const whole = start === 0 && end === duration()
  const mode = event.shiftKey ? 'draw' : event.target.dataset.edge ||
    (event.target === $('trimBand') && !whole ? 'move' : 'draw')
  trimDrag = { id:event.pointerId, mode, anchor, clientX:event.clientX, start, end, moved:false, previousTime:video.currentTime }
  video.pause()
  trimTrack.setPointerCapture(event.pointerId)
}

function updateDrag(event) {
  const drag = trimDrag
  if (!drag || drag.id !== event.pointerId) return
  if (!drag.moved && Math.abs(event.clientX - drag.clientX) < 2) return
  drag.moved = true
  const time = pointTime(event.clientX), total = duration()
  // Preserve the grab offset while resizing.
  const box = trimTrack.getBoundingClientRect()
  const delta = (event.clientX - drag.clientX) * total / box.width
  const start = selected.start, end = outPoint()
  const gap = Math.min(0.001, end - start)
  let preview
  switch (drag.mode) {
    case 'start':
      drag.start = clamp(start + delta, 0, end - gap)
      preview = drag.start
      break
    case 'end':
      drag.end = clamp(end + delta, start + gap, total)
      preview = drag.end
      break
    case 'move': {
      const shift = clamp(delta, -start, total - end)
      drag.start = start + shift
      drag.end = end + shift
      preview = clamp(drag.anchor + shift, 0, total)
      break
    }
    case 'draw':
      drag.start = Math.min(time, drag.anchor)
      drag.end = Math.max(time, drag.anchor)
      preview = time
      break
  }
  if (video.currentTime !== preview) video.currentTime = preview
  controls()
}
trimTrack.onpointermove = updateDrag

function finishDrag(commit) {
  const drag = trimDrag
  if (!drag) return
  trimDrag = null
  if (trimTrack.hasPointerCapture(drag.id)) trimTrack.releasePointerCapture(drag.id)
  if (commit && drag.moved && drag.end > drag.start) {
    edit({ start:drag.start, end:drag.end === duration() ? null : drag.end })
  } else {
    if (drag.moved && duration()) video.currentTime = drag.previousTime
    controls()
  }
}
trimTrack.onpointerup = event => {
  if (event.pointerId !== trimDrag?.id) return
  updateDrag(event)
  finishDrag(true)
}
trimTrack.onlostpointercapture = trimTrack.onpointercancel = event => {
  if (event.pointerId === trimDrag?.id) finishDrag(false)
}
window.addEventListener('blur', () => finishDrag(false))

function clipRow(clip) {
  const row = document.createElement('button')
  row.className = 'item' + (clip.id === selected?.id ? ' active' : '')
  row.disabled = busy
  const format = document.createElement('span')
  format.className = 'format'; format.textContent = clip.name.split('.').pop().toUpperCase()
  const info = document.createElement('span')
  info.className = 'item-text'
  const name = document.createElement('strong')
  name.textContent = clip.name
  info.append(name)
  if (clip.note?.trim()) {
    const note = document.createElement('small')
    note.textContent = clip.note
    info.append(note)
  }
  format.dataset.clip = clip.id
  if (thumbs.has(clip.id)) applyThumb(format, thumbs.get(clip.id))
  else thumbObserver.observe(format)
  row.append(format, info); row.title = clip.path
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
function segmentIndex() {
  if (!selected?.cuts?.length) return -1
  const boundaries = [0, ...selected.cuts, duration()]
  const index = boundaries.indexOf(selected.start)
  return boundaries[index + 1] === outPoint() ? index : -1
}

function chooseSegment(index, cuts = selected.cuts) {
  video.pause()
  const start = index === 0 ? 0 : cuts[index - 1]
  video.currentTime = start
  edit({ cuts, start, end:cuts[index] ?? null })
}

function renderSegments() {
  const group = $('segments')
  group.replaceChildren()
  group.hidden = !duration() || !selected?.cuts?.length
  if (group.hidden) return
  const active = segmentIndex()
  for (const [i, start] of [0, ...selected.cuts].entries()) {
    const button = document.createElement('button')
    button.textContent = '片段 ' + (i + 1)
    button.title = clock(start) + ' – ' + clock(selected.cuts[i] ?? duration())
    button.setAttribute('aria-pressed', String(i === active))
    button.disabled = busy
    button.onclick = () => {
      chooseSegment(i)
      group.querySelector('[aria-pressed="true"]')?.focus()
    }
    if (i !== active) {
      group.append(button)
      continue
    }
    const chip = document.createElement('span')
    chip.className = 'selected-segment'
    const undo = document.createElement('button')
    undo.className = 'undo-split'
    undo.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 3.5-4 4 4 4M3.5 7.5H11a4.5 4.5 0 0 1 0 9H9"/></svg>'
    undo.title = '取消切分，' + (i === 0 ? '与后一段合并' : '与前一段合并')
    undo.setAttribute('aria-label', button.textContent + '：' + undo.title)
    undo.disabled = busy
    undo.onclick = () => {
      const boundary = Math.max(0, i - 1)
      const cuts = selected.cuts.filter((_, index) => index !== boundary)
      chooseSegment(boundary, cuts)
      const focusTarget = group.querySelector('[aria-pressed="true"]') || $('play')
      focusTarget.focus()
    }
    chip.append(button, undo)
    group.append(chip)
  }
}

function controls() {
  const ready = !!selected && duration() > 0 && !video.error
  for (const id of ['play','seek','newFile']) $(id).disabled = busy || !ready
  const time = video.currentTime
  $('split').disabled = busy || !ready || time < 0.001 || duration() - time < 0.001 ||
    !!selected?.cuts?.some(cut => Math.abs(cut - time) < 0.001)
  $('capture').disabled = busy || !ready || video.seeking || video.readyState < 2
  $('overwrite').disabled = busy || !ready || !/\.(mp4|m4v|mov)$/i.test(selected?.name || '')
  for (const id of ['remove','reveal','importFiles','importFolder','firstImport','makeProxy']) $(id).disabled = busy
  $('seek').max = duration() || 1
  $('seek').value = video.currentTime || 0
  $('position').textContent = clock(video.currentTime)
  $('duration').textContent = clock(duration())
  const start = trimDrag?.start ?? selected?.start ?? 0, end = trimDrag?.end ?? outPoint()
  const band = $('trimBand'), total = duration() || 1
  $('rangeLabel').hidden = !ready || (start === 0 && end === total)
  $('rangeLabel').textContent = '选区  ' + clock(start) + ' – ' + clock(end)
  band.hidden = !ready
  band.style.left = (100 * start / total) + '%'
  band.style.right = (100 * (1 - end / total)) + '%'
  band.classList.toggle('full', start === 0 && end === total)
  $('play').textContent = video.paused ? '▶' : 'Ⅱ'
}
function select(clip) {
  finishDrag(false)
  video.pause()
  $('more').open = false
  selected = clip
  for (const folder of clip?.folders || []) collapsed.delete(folder.path)
  generation++
  $('empty').hidden = !!clip; $('editor').hidden = !clip
  $('viewerMessage').hidden = true
  if (clip) {
    showMetadata(clip, generation)
    $('name').textContent = clip.name; $('filePath').textContent = clip.path
    video.src = 'clip://' + (compatible.has(clip.id) ? 'proxy/' : 'source/') + clip.id + '?v=' + generation
  } else { video.removeAttribute('src') }
  video.load()
  renderSegments()
  list(); controls()
}

function edit(values) {
  if (!selected) return
  const clip = selected
  Object.assign(clip, values)
  const snapshot = { start:clip.start, end:clip.end, cuts:clip.cuts }
  renderSegments()
  pendingWrite = pendingWrite.then(async () => {
    try {
      await api.edit(clip.id, snapshot)
      writeError = undefined
    } catch (error) {
      writeError = error
      fail(error)
    }
  })
  controls()
}

async function task(fn, cancellable = false) {
  if (busy) return
  finishDrag(false)
  busy = true; $('cancel').hidden = !cancellable
  renderSegments()
  list(); controls()
  try {
    await pendingWrite
    if (writeError) throw writeError
    await fn()
  } catch (error) { fail(error) }
  finally { busy = false; renderSegments(); $('cancel').hidden = true; updateFeedbackLifetime(); list(); controls() }
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
$('seek').oninput = () => {
  if (segmentIndex() >= 0) video.pause()
  video.currentTime = Number($('seek').value)
}
$('split').onclick = () => {
  video.pause()
  const time = video.currentTime
  const cuts = [...(selected.cuts || []), time].sort((a, b) => a - b)
  edit({ cuts, start:time, end:cuts[cuts.indexOf(time) + 1] ?? null })
}
$('capture').onclick = () => {
  video.pause()
  const time = video.currentTime, id = selected.id
  task(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0)
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('无法读取当前视频帧')
    const target = await api.capture(id, time, await blob.arrayBuffer())
    status(target ? '截图已保存到 ' + target : '已取消截图')
  })
}
$('play').onclick = () => {
  if (!video.paused) { video.pause(); return }
  if (segmentIndex() >= 0 && (video.currentTime < selected.start || video.currentTime >= outPoint())) video.currentTime = selected.start
  video.play().catch(fail)
}
video.ontimeupdate = controls
let playbackFrame
function stopAtSegmentEnd() {
  if (video.paused) return
  if (segmentIndex() >= 0 && video.currentTime >= outPoint()) {
    video.pause()
    video.currentTime = outPoint()
  } else playbackFrame = requestAnimationFrame(stopAtSegmentEnd)
}
video.onplay = () => { controls(); stopAtSegmentEnd() }
video.onpause = () => { cancelAnimationFrame(playbackFrame); controls() }
video.onseeking = video.onseeked = video.onloadeddata = controls
video.ondurationchange = controls
video.onloadedmetadata = () => {
  if (selected && duration()) {
    if (selected.start >= duration() || (selected.end !== null && selected.end > duration() + 0.001)) edit({ start:0, end:null })
    if (selected.cuts?.some(cut => cut >= duration())) edit({ cuts:selected.cuts.filter(cut => cut < duration()) })
    renderSegments()
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
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('more').open) {
    $('more').open = false
    $('more').querySelector('summary').focus()
  }
})
$('reveal').onclick = () => {
  $('more').open = false
  const id = selected.id
  task(() => api.reveal(id))
}
$('remove').onclick = () => {
  $('more').open = false
  const id = selected.id
  task(async () => {
    const remaining = await api.remove(id)
    if (!remaining) return
    clips = remaining
    compatible.delete(id); thumbs.delete(id); attempted.delete(id)
    select(clips[0])
    status('已移出素材库，磁盘文件保留')
  })
}
function output(mode) {
  if (!selected || !duration()) return
  video.pause()
  const dialog = $('noteDialog')
  $('noteTitle').textContent = mode === 'overwrite' ? '覆盖原片' : '导出为新文件'
  $('note').value = selected.note || ''
  dialog.returnValue = ''
  dialog.onclose = () => {
    if (dialog.returnValue === 'continue') saveVideo(mode, $('note').value)
  }
  dialog.showModal()
}
function saveVideo(mode, note) {
  const id = selected.id, range = { start:selected.start, end:outPoint() }
  task(async () => {
    status('等待导出选择…')
    const result = await api.export(id, range, mode, note)
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
  if (trimDrag) {
    if (event.key === 'Escape') finishDrag(false)
    return
  }
  if ($('noteDialog').open || busy || !selected || !duration() || event.metaKey || event.ctrlKey || event.altKey ||
    event.target.closest('aside,textarea,input,[contenteditable]')) return
  if (event.code === 'Space') { event.preventDefault(); $('play').click() }
})
api.list().then(items => { clips = items; select(items[0]) }).catch(fail)
