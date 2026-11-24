const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

// Walk real path components so similarly named folders on different disks stay distinct.
function folderChain(file, roots) {
  const chain = []
  let top = 0
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    chain.push(dir)
    if (roots.has(dir)) top = chain.length - 1
    if (path.dirname(dir) === dir) break
  }
  return chain.slice(0, top + 1).reverse()
}

class Library {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, 'library.json')
    this.clips = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : []
    if (!Array.isArray(this.clips) || this.clips.some(c => !c?.id || typeof c.path !== 'string'))
      throw new Error('素材库格式无效：' + this.file)
  }
  commit(items) {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(items), { mode: 0o600 })
    fs.renameSync(this.file + '.tmp', this.file)
    this.clips = items
  }
  get(id) {
    const clip = this.clips.find(c => c.id === id)
    if (!clip) throw new Error('未找到素材')
    return clip
  }
  rows() {
    const roots = new Set(this.clips.map(c => c.root).filter(Boolean))
    return this.clips.map(clip => ({
      ...clip,
      folders: folderChain(clip.path, roots).map(dir => ({ path: dir, name: path.basename(dir) || dir }))
    }))
  }
  add(files, note = '', importedRoots = []) {
    const roots = new Set([...this.clips.map(c => c.root).filter(Boolean), ...importedRoots])
    const items = [...this.clips]
    const index = new Map(items.map((c, i) => [c.path, i]))
    const fresh = []
    let changed = false
    for (const file of files) {
      const firstFolder = folderChain(file, roots)[0]
      const root = roots.has(firstFolder) ? firstFolder : undefined
      const i = index.get(file)
      if (i !== undefined) {
        if (items[i].root !== root) {
          items[i] = { ...items[i], root }
          changed = true
        }
        continue
      }
      const clip = { id: randomUUID(), path: file, name: path.basename(file), note, start: 0, end: null }
      if (root) clip.root = root
      index.set(file, items.length)
      items.push(clip)
      fresh.push(clip)
    }
    if (fresh.length || changed) this.commit(items)
    return fresh
  }
  update(id, changes) {
    const clip = this.get(id)
    const next = { ...clip, ...changes }
    this.commit(this.clips.map(c => c.id === id ? next : c))
    return next
  }
  remove(id) { this.commit(this.clips.filter(clip => clip.id !== id)) }
}
module.exports = { Library }
