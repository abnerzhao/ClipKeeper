const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const encoder = require('@ffmpeg-installer/ffmpeg').path.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1')

const formats = new Set('.mp4 .mov .m4v .mkv .webm .avi .mts .m2ts .mpg .mpeg .wmv .3gp .mxf'.split(' '))
const writable = new Set(['.mp4', '.mov', '.m4v'])
const extension = file => path.extname(file).toLowerCase()

async function discover(inputs) {
  const files = new Set()
  const visited = new Set()
  const roots = new Set()
  let skipped = 0
  async function visit(input, topLevel = false) {
    try {
      const file = await fs.realpath(input)
      const stat = await fs.stat(file)
      if (stat.isFile() && formats.has(extension(file))) files.add(file)
      if (!stat.isDirectory()) return
      if (topLevel) roots.add(file)
      if (visited.has(file)) return
      visited.add(file)
      const entries = await fs.readdir(file, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
        if (entry.isDirectory() || formats.has(extension(entry.name))) await visit(path.join(file, entry.name))
      }
    } catch { skipped++ }
  }
  for (const input of inputs) await visit(input, true)
  return { roots: [...roots], files: [...files].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true })), skipped }
}

function suggestName(file, note) {
  const clean = note.trim().replace(/[\x00-\x1f\\/:*?"<>|]+/g, ' ').replace(/\s+/g, '_')
  const base = Array.from(path.parse(file).name).slice(0, 45).join('')
  return base + '_' + (Array.from(clean).slice(0, 18).join('') || '粗剪') + '.mp4'
}

function encode(args, signal, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn(encoder, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-nostats',
      '-progress', 'pipe:1', ...args], { signal, windowsHide: true })
    let stderr = '', lines = '', failure
    proc.on('error', error => { failure = error })
    proc.stderr.on('data', data => { stderr = (stderr + data).slice(-1800) })
    proc.stdout.on('data', data => {
      const parts = (lines + data).split(/\r?\n/)
      lines = parts.pop()
      for (const line of parts) {
        if (line.startsWith('out_time_ms=')) {
          const seconds = Number(line.slice(12)) / 1000000
          if (Number.isFinite(seconds)) onProgress?.(seconds)
        }
      }
    })
    proc.on('close', code => {
      if (signal?.aborted) reject(new Error('操作已取消'))
      else if (failure || code !== 0) reject(failure || new Error('视频处理失败：' + stderr.trim()))
      else resolve()
    })
  })
}

const inputArgs = file => ['-protocol_whitelist', 'file,pipe', '-i', file]
const tracks = ['-map', '0:V:0', '-map', '0:a:0?']
const codecs = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart']

async function preview(source, output, signal) {
  await encode([...inputArgs(source), ...tracks, '-vf', "scale=w='min(1280,iw)':h=-2,pad=ceil(iw/2)*2:ceil(ih/2)*2",
    ...codecs, '-preset', 'veryfast', '-crf', '24', '-f', 'mp4', output], signal)
}

async function exportCut({ source, target, start, end, overwrite, signal, onProgress }) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start)
    throw new Error('请选择有效的入点和出点')
  if (!writable.has(extension(target))) throw new Error('仅支持导出 MP4、MOV 和 M4V')
  if ((source === target) !== overwrite) throw new Error('另存需要使用新的文件名')
  if (!overwrite) {
    try { await fs.lstat(target); throw new Error('同名文件已存在，请另选文件名') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const before = await fs.lstat(source, { bigint: true })
  if (!before.isFile()) throw new Error('原片已移动或替换，请重新导入')
  const dir = await fs.mkdtemp(path.join(path.dirname(target), '.clipkeeper-'))
  const temp = path.join(dir, 'cut' + extension(target))
  try {
    await encode(['-abort_on', 'empty_output', '-ss', String(start), ...inputArgs(source), '-t', String(end - start), ...tracks,
      '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', ...codecs, '-preset', 'veryfast', '-crf', '18',
      '-f', extension(target) === '.mov' ? 'mov' : 'mp4', temp], signal, onProgress)
    const after = await fs.lstat(source, { bigint: true })
    if (before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.size !== after.size)
      throw new Error('原片在导出时发生变化，请重新预览')
    signal?.throwIfAborted()
    if (overwrite) {
      await fs.chmod(temp, Number(before.mode & 0o777n))
      await fs.rename(temp, target)
    } else {
      try { await fs.link(temp, target) }
      catch (error) {
        if (!['ENOTSUP','EOPNOTSUPP','EPERM','ENOSYS'].includes(error.code)) throw error
        await fs.copyFile(temp, target, fs.constants.COPYFILE_EXCL)
      }
    }
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('同名文件已存在，请另选文件名')
    throw error
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

module.exports = { discover, suggestName, exportCut, preview, writable, extension, formats }
