// Run from the project root after changing the vector mark. Requires librsvg.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

function render(size) {
  return execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), 'ui/assets/clipkeeper.svg'])
}

function chunk(type, data) {
  const header = Buffer.alloc(8)
  header.write(type)
  header.writeUInt32BE(data.length + header.length, 4)
  return Buffer.concat([header, data])
}

const representations = { icp4:16, icp5:32, ic07:128, ic08:256, ic09:512, ic10:1024, ic11:32, ic12:64, ic13:256, ic14:512 }
const pngs = new Map([...new Set(Object.values(representations))].map(size => [size, render(size)]))
const icons = Object.entries(representations).map(([type, size]) => chunk(type, pngs.get(size)))
writeFileSync('assets/ClipKeeper.icns', chunk('icns', Buffer.concat(icons)))
writeFileSync('ui/assets/dock.png', pngs.get(512))
