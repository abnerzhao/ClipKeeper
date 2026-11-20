import { packager } from '@electron/packager'
await packager({
  electronZipDir: process.env.ELECTRON_ZIP_DIR,
  dir: '.', name: 'ClipKeeper', executableName: '拾片', out: 'dist', overwrite: true,
  appBundleId: 'local.cutshelf.desktop',
  icon: process.platform === 'darwin' ? 'assets/CutShelf.icns' : undefined,
  asar: { unpack: '**/node_modules/@ffmpeg-installer/**/*' },
  ignore: [/^\/(test|dist|scripts|assets)(\/|$)/]
})
