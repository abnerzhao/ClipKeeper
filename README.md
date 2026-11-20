# ClipKeeper · 拾片

本地视频素材库与单片段粗剪工作台。Electron + FFmpeg，无需账号。

## 使用

1. 打开拾片，批量选择视频或递归导入文件夹。左侧会按磁盘文件夹展示可折叠的目录树；搜索支持文件夹名、文件名和备注。
2. 选择素材，拖动时间尺，空格播放或暂停。按 I 设置入点，按 O 设置出点，可播放选段。
3. 输入素材备注，应用会自动存入本机素材库。左侧可以按文件名、备注搜索。
4. 导出为新文件时，默认名称包含备注，可以修改。新文件自动加入素材库并继承备注。覆盖原片需要单独确认，仅开放 MP4、MOV、M4V。

视频通过 FFmpeg 编码为 H.264（8-bit）/ AAC，包含主视频和首条音轨。建议对 HDR、多音轨、字幕等素材使用另存。覆盖使用同目录临时文件，编码完成后再替换。备注保存在 Electron 的 userData/library.json，单独复制视频时可通过文件名保留简短说明。原片移走后需重新导入。对无法直接播放的素材可以生成临时兼容预览。

## 开发

使用 Node.js 22.12+ 和 npm。

```sh
npm ci
npm start
npm test
npm run test:desktop
npm run package
```

打包产物位于 dist/。Apple Silicon Mac 产物为 dist/ClipKeeper-darwin-arm64/ClipKeeper.app。首次安装和打包需要联网。如果已有 Electron 官方发行 ZIP，可以设置 ELECTRON_ZIP_DIR 为其父目录来离线打包。桌面测试使用临时目录和生成的音视频，不读取个人素材库。
