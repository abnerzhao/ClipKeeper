const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { _electron } = require('playwright-core')

test('桌面批量导入、播放、设置入出点、自动保存、另存与覆盖', { timeout:90000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clipkeeper-ui-'))
  let desktop
  try {
    const root = path.join(dir, '旅行')
    const file = path.join(root, '杭州', '白天', 'A.mp4'), second = path.join(root, '苏州', 'B.mp4')
    const output = path.join(path.dirname(file), 'A_日落.mp4')
    for (const clip of [file, second]) await fs.mkdir(path.dirname(clip), { recursive:true })
    execFileSync(require('@ffmpeg-installer/ffmpeg').path, ['-loglevel','error','-f','lavfi','-i','testsrc2=size=256x144:rate=25',
      '-f','lavfi','-i','sine','-t','4','-c:v','libx264','-c:a','aac',file])
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
    for (const [seconds, button] of [[0.52,'markIn'],[2.52,'markOut']]) {
      await page.locator('#seek').evaluate((slider, time) => {
        slider.value = time
        slider.dispatchEvent(new Event('input'))
      }, seconds)
      await page.waitForFunction(() => !document.querySelector('video').seeking)
      await page.locator('#' + button).click()
    }
    await page.locator('#note').fill('日落')
    await page.waitForFunction(() => document.querySelector('#saved').textContent === '已保存')
    await page.waitForSelector('.format img', { timeout:10000 })
    if (process.env.CLIPKEEPER_SCREENSHOT_DIR) await page.screenshot({ path:path.join(process.env.CLIPKEEPER_SCREENSHOT_DIR,'editor.png') })
    await page.locator('#newFile').click()
    await page.waitForFunction(() => document.querySelector('#name').textContent === 'A_日落.mp4' && document.querySelector('video').duration > 0)
    assert.ok(Math.abs(await page.locator('video').evaluate(v => v.duration) - 2) < 0.12)
    assert.equal(await page.locator('#note').inputValue(), '日落')
    assert.deepEqual(await fs.readFile(file), await fs.readFile(second))
    assert.equal(await page.locator('#items > .folder').count(), 1)
    await page.getByText('A.mp4', { exact:true }).first().click()
    await page.waitForFunction(() => !document.querySelector('#overwrite').disabled)
    await page.locator('#overwrite').click()
    await page.waitForFunction(() => document.querySelector('#status').textContent.endsWith('/A.mp4') && document.querySelector('video').duration < 2.2)
    await desktop.close()
    desktop = await _electron.launch(options)
    page = await desktop.firstWindow()
    await page.waitForFunction(() => document.querySelectorAll('.item').length === 3 && document.querySelector('#note').value === '日落')
    await page.locator('#search').fill('日落')
    assert.equal(await page.locator('.item').count(), 2)
  } finally {
    if (desktop) await desktop.close().catch(() => {})
    await fs.rm(dir, { recursive:true, force:true })
  }
})
