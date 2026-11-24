const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { _electron } = require('playwright-core')

test('桌面批量导入、播放、拖拽选段、自动保存、另存与覆盖', { timeout:90000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clipkeeper-ui-'))
  let desktop
  try {
    const root = path.join(dir, '旅行')
    const file = path.join(root, '杭州', '白天', 'A.mp4'), second = path.join(root, '苏州', 'B.mp4')
    const output = path.join(path.dirname(file), 'A_日落.mp4')
    for (const clip of [file, second]) await fs.mkdir(path.dirname(clip), { recursive:true })
    execFileSync(require('@ffmpeg-installer/ffmpeg').path, ['-loglevel','error','-f','lavfi','-i','testsrc2=size=256x144:rate=25',
      '-f','lavfi','-i','sine','-t','4','-c:v','libx264','-c:a','aac','-metadata','com.apple.quicktime.model=ClipKeeper Test Camera','-movflags','use_metadata_tags',file])
    await fs.copyFile(file, second)
    const packaged = process.env.CLIPKEEPER_TEST_EXECUTABLE
    const options = { executablePath:packaged || require('electron'), args:[...(packaged ? [] : [path.resolve(__dirname,'..')]),
      '--user-data-dir=' + path.join(dir,'profile')] }
    desktop = await _electron.launch(options)
    let page = await desktop.firstWindow()
    await desktop.evaluate(({ dialog }, { file, second, output, root }) => {
      dialog.showOpenDialog = async (_window, options) => ({ canceled:false, filePaths:options.properties.includes('openDirectory') ? [root] : [file, second] })
      dialog.showSaveDialog = async () => ({ canceled:false, filePath:output })
      dialog.showMessageBox = async () => ({ response:1 })
    }, { file, second, output, root })
    if (process.env.CLIPKEEPER_SCREENSHOT_DIR) await page.screenshot({ path:path.join(process.env.CLIPKEEPER_SCREENSHOT_DIR,'library.png') })
    await page.locator('#firstImport').click()
    await page.waitForFunction(() => document.querySelectorAll('.item').length === 2 && document.querySelector('video').duration > 3)
    if (process.platform === 'darwin') {
      const titleTop = () => page.locator('.side-title h2').evaluate(el => el.getBoundingClientRect().top)
      const normalTop = await titleTop()
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true))
      await page.waitForSelector('html.window-fullscreen')
      await page.reload()
      await page.waitForSelector('html.window-fullscreen #name:visible')
      const fullTop = await titleTop()
      assert.ok(normalTop - fullTop >= 25)
      assert.ok(Math.abs(fullTop - await page.locator('#name').evaluate(el => el.getBoundingClientRect().top)) <= 1)
      if (process.env.CLIPKEEPER_SCREENSHOT_DIR) await page.screenshot({ path:path.join(process.env.CLIPKEEPER_SCREENSHOT_DIR,'fullscreen.png') })
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(false))
      await page.waitForSelector('html:not(.window-fullscreen)')
      assert.equal(await titleTop(), normalTop)
    }
    const divider = await page.locator('#divider').boundingBox()
    await page.mouse.move(divider.x + 4, 200)
    await page.mouse.down()
    await page.mouse.move(divider.x + 64, 200)
    await page.mouse.up()
    assert.ok(Math.abs(await page.locator('#library').evaluate(el => el.offsetWidth) - divider.x - 64) < 2)
    await page.locator('#divider').dblclick()
    await page.locator('#metadata').getByText('256 × 144').waitFor()
    assert.match(await page.locator('#metadata').textContent(), /ClipKeeper Test Camera/)
    await page.locator('#importFolder').click()
    const trip = page.locator('summary').filter({ hasText:'旅行' })
    await trip.waitFor()
    assert.equal(await page.locator('.item').count(), 2)
    await trip.click()
    assert.equal(await page.locator('.item:visible').count(), 0)
    await page.locator('#search').fill('杭州')
    assert.equal(await page.locator('.item:visible').count(), 1)
    await page.locator('#search').fill('')
    assert.equal(await page.locator('.item:visible').count(), 0)
    await trip.click()
    await page.locator('#play').click()
    await page.waitForFunction(() => document.querySelector('video').currentTime > 0.05)
    await page.locator('#play').click()
    const track = await page.locator('#trimTrack').boundingBox()
    const y = track.y + track.height / 2
    const x = fraction => track.x + track.width * fraction
    async function drag(from, to) {
      await page.mouse.move(from, y)
      await page.mouse.down()
      await page.mouse.move(to, y, { steps:6 })
      await page.mouse.up()
    }
    async function expectRange(start, end) {
      const band = await page.locator('#trimBand').boundingBox()
      const duration = await page.locator('video').evaluate(v => v.duration)
      const timeAt = px => (px - track.x) / track.width * duration
      assert.ok(Math.abs(timeAt(band.x) - start) < 0.03)
      assert.ok(Math.abs(timeAt(band.x + band.width) - end) < 0.03)
    }
    // Reverse marquee on a full selection, resize both ends, then translate it.
    await drag(x(0.65), x(0.15))
    await expectRange(0.6, 2.6)
    for (const selector of ['.trim-edge.left', '.trim-edge.right']) {
      const handle = await page.locator(selector).boundingBox()
      const center = handle.x + handle.width / 2
      await drag(center, center + 0.05 * track.width)
    }
    await expectRange(0.8, 2.8)
    await drag(x(0.45), x(0.55))
    await expectRange(1.2, 3.2)
    await page.locator('.item').filter({ hasText:'B.mp4' }).click()
    await page.locator('.item').filter({ hasText:'A.mp4' }).click()
    await page.waitForFunction(() => document.querySelector('video').duration > 3)
    await expectRange(1.2, 3.2)
    assert.ok(await page.locator('#note').isHidden())
    await page.locator('#newFile').click()
    await page.locator('#note').fill('放弃的备注')
    await page.keyboard.press('Escape')
    assert.ok(await page.locator('#note').isHidden())
    await page.waitForSelector('.format img', { timeout:10000 })
    if (process.env.CLIPKEEPER_SCREENSHOT_DIR) await page.screenshot({ path:path.join(process.env.CLIPKEEPER_SCREENSHOT_DIR,'editor.png') })
    await page.locator('#newFile').click()
    assert.equal(await page.locator('#note').inputValue(), '')
    await page.locator('#note').fill('日落')
    await page.getByRole('button', { name:'继续' }).click()
    await page.waitForFunction(() => document.querySelector('#name').textContent === 'A_日落.mp4' && document.querySelector('video').duration > 0)
    assert.ok(Math.abs(await page.locator('video').evaluate(v => v.duration) - 2) < 0.12)
    assert.equal(await page.locator('.item.active small').textContent(), '日落')
    await page.locator('#overwrite').click()
    assert.equal(await page.locator('#note').inputValue(), '日落')
    await page.locator('#note').fill('放弃的修改')
    await page.getByRole('button', { name:'取消', exact:true }).click()
    assert.equal(await page.locator('.item.active small').textContent(), '日落')
    assert.deepEqual(await fs.readFile(file), await fs.readFile(second))
    assert.equal(await page.locator('#items > .folder').count(), 1)
    await page.getByText('A.mp4', { exact:true }).first().click()
    await page.waitForFunction(() => !document.querySelector('#overwrite').disabled)
    await page.locator('#overwrite').click()
    assert.equal(await page.locator('#note').inputValue(), '')
    await page.locator('#note').fill('原片日落')
    await page.getByRole('button', { name:'继续' }).click()
    await page.waitForFunction(() => document.querySelector('#status').textContent.endsWith('/A.mp4') && document.querySelector('video').duration < 2.2)
    await desktop.close()
    desktop = await _electron.launch(options)
    page = await desktop.firstWindow()
    await page.waitForFunction(() => document.querySelectorAll('.item').length === 3 && document.querySelector('.item.active small')?.textContent === '原片日落')
    await page.locator('#search').fill('日落')
    assert.equal(await page.locator('.item').count(), 2)

    await page.locator('#search').fill('')
    await page.locator('.item').filter({ hasText:'B.mp4' }).click()
    const seekTo = async seconds => {
      await page.locator('#seek').evaluate((input, time) => {
        input.value = time
        input.dispatchEvent(new Event('input'))
      }, seconds)
      await page.waitForFunction(time => {
        const v = document.querySelector('video')
        return !v.seeking && Math.abs(v.currentTime - time) < 0.001 && v.readyState >= 2
      }, seconds)
    }
    await page.waitForFunction(() => document.querySelector('video').duration > 3)
    assert.equal(await page.locator('#split').isDisabled(), true)
    for (const t of [2.5, 1]) {
      await seekTo(t)
      await page.locator('#split').click()
      assert.equal(await page.locator('#split').isDisabled(), true)
    }
    const segments = page.locator('#segments button[aria-pressed]')
    assert.equal(await segments.count(), 3)
    await segments.first().click()
    await page.locator('#play').click()
    await page.waitForFunction(() => {
      const v = document.querySelector('video')
      return v.paused && Math.abs(v.currentTime - 1) < 0.001
    })
    await segments.nth(1).click()
    const selectedChip = await segments.nth(1).boundingBox()
    const session = await page.context().newCDPSession(page)
    await session.send('Input.synthesizePinchGesture', { x:selectedChip.x + 8, y:selectedChip.y + 8,
      scaleFactor:2, gestureSourceType:'mouse' })
    await page.waitForFunction(async () => (await window.clipkeeper.list()).some(clip =>
      clip.name === 'B.mp4' && clip.start < 1 && (clip.end ?? 4) > 2.5))
    assert.ok(await page.locator('#ruler').evaluate(el => el.scrollWidth === el.clientWidth))
    assert.equal(await segments.count(), 3)
    await session.send('Input.synthesizePinchGesture', { x:selectedChip.x + 8, y:selectedChip.y + 8,
      scaleFactor:0.5, gestureSourceType:'mouse' })
    await page.waitForFunction(async () => (await window.clipkeeper.list()).some(clip =>
      clip.name === 'B.mp4' && (clip.end ?? 4) - clip.start < 2))
    await segments.nth(1).click()
    await session.detach()

    await page.waitForFunction(async () => (await window.clipkeeper.list()).some(clip => clip.name === 'B.mp4' && clip.start === 1 && clip.end === 2.5))
    await desktop.close()
    desktop = await _electron.launch(options)
    page = await desktop.firstWindow()
    await page.locator('.item').filter({ hasText:'B.mp4' }).click()
    await page.getByRole('button', { name:'片段 2', pressed:true }).waitFor()
    await seekTo(1.5)
    const png = path.join(dir, '当前帧.png'), segment = path.join(dir, '第二段.mp4')
    await desktop.evaluate(({ dialog }, { png, segment }) => {
      dialog.showSaveDialog = async (_window, options) => ({
        canceled:false, filePath:options.filters[0].extensions[0] === 'png' ? png : segment
      })
    }, { png, segment })
    const expected = await page.locator('video').evaluate(v => {
      const canvas = document.createElement('canvas')
      canvas.width = v.videoWidth
      canvas.height = v.videoHeight
      canvas.getContext('2d').drawImage(v, 0, 0)
      return canvas.toDataURL().split(',')[1]
    })
    await page.locator('#capture').click()
    await page.waitForFunction(p => document.querySelector('#status').textContent.endsWith(p), png)
    assert.deepEqual(await fs.readFile(png), Buffer.from(expected, 'base64'))
    for (const selector of ['.empty h1', '.side-title h2', '#overwrite', '.notebox label', '#note', '.timecode']) {
      assert.match(await page.locator(selector).evaluate(el => getComputedStyle(el).fontFamily), /^system-ui/)
    }
    const original = await fs.readFile(second)
    await page.locator('#newFile').click()
    await page.getByRole('button', { name:'继续' }).click()
    await page.waitForFunction(() => document.querySelector('#name').textContent === '第二段.mp4' && document.querySelector('video').duration > 0)
    assert.ok(Math.abs(await page.locator('video').evaluate(v => v.duration) - 1.5) < 0.12)
    assert.deepEqual(await fs.readFile(second), original)
    assert.equal(await page.locator('#segments').isHidden(), true)
    await page.locator('.item').filter({ hasText:'B.mp4' }).click()
    const undoSplit = page.locator('.selected-segment').getByRole('button', { name:/取消切分/ })
    await page.getByRole('button', { name:'片段 2', pressed:true }).waitFor()
    assert.ok(await undoSplit.locator('svg[aria-hidden=true]').isVisible())
    assert.equal(await undoSplit.getAttribute('title'), '取消切分，与前一段合并')
    await undoSplit.click()
    await page.getByRole('button', { name:'片段 1', pressed:true }).waitFor()
    await page.waitForFunction(async () => {
      const clip = (await window.clipkeeper.list()).find(c => c.name === 'B.mp4')
      return clip.cuts.length === 1 && clip.cuts[0] === 2.5 && clip.start === 0 && clip.end === 2.5
    })
    assert.equal(await undoSplit.getAttribute('title'), '取消切分，与后一段合并')
    await undoSplit.click()
    await page.waitForFunction(async () => {
      const clip = (await window.clipkeeper.list()).find(c => c.name === 'B.mp4')
      return clip.cuts.length === 0 && clip.start === 0 && clip.end === null
    })
    assert.equal(await page.locator('#segments').isHidden(), true)
    assert.deepEqual(await fs.readFile(second), original)

    await desktop.evaluate(({ shell, dialog }) => {
      globalThis.revealed = []
      shell.showItemInFolder = file => globalThis.revealed.push(file)
      dialog.showMessageBox = async () => ({ response:0 })
    })
    assert.equal(await page.getByRole('button', { name:'多选' }).count(), 0)
    const more = page.locator('.clip-title #more summary')
    await more.click()
    await page.locator('#reveal').click()
    await page.waitForFunction(() => !document.querySelector('#reveal').disabled)
    assert.deepEqual(await desktop.evaluate(() => globalThis.revealed), [await fs.realpath(second)])
    await more.click()
    await page.locator('#remove').click()
    await page.waitForFunction(() => !document.querySelector('#remove').disabled)
    assert.equal(await page.locator('#name').textContent(), 'B.mp4')
    await desktop.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response:1 }) })
    await more.click()
    await page.locator('#remove').click()
    await page.waitForFunction(() => document.querySelector('#total').textContent === '3')
    assert.deepEqual(await fs.readFile(second), original)
    assert.equal(await page.locator('.item').filter({ hasText:'B.mp4' }).count(), 0)
  } finally {
    if (desktop) await desktop.close().catch(() => {})
    await fs.rm(dir, { recursive:true, force:true })
  }
})
