# DeepSeek Harness Desktop

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的 Windows 桌面壳：用 Electron 原生窗口包装 dsh 官方 Web UI，无需浏览器、无需终端。

## 功能

- 🪟 **原生窗口** — 双击即开，加载期间显示启动动画
- 📌 **后台常驻** — 关闭窗口只是隐藏到系统托盘，dsh 服务保持运行，恢复秒开
- 🔁 **单实例** — 重复双击快捷方式恢复窗口，而不是开新副本
- 🚪 **干净退出** — 托盘右键 / 任务栏右键 Jump List「退出」时彻底回收 dsh 进程树，不留孤儿
- ⬆️ **自我更新** — 托盘菜单「检查更新」自动对比 npm 上的 `@deepseek-ai/dsh` 版本，一键升级并重启
- 🎨 **自定义图标**

## 前置要求

- Node.js ≥ 18
- 已全局安装 dsh：`npm install -g @deepseek-ai/dsh`

## 使用

安装 release 中的任一安装包：

| 文件 | 说明 |
|------|------|
| `DeepSeek-Harness-x.y.z-x64.exe` | NSIS 安装器（推荐） |
| `DeepSeek-Harness-x.y.z-x64.msi` | MSI 安装器（适合企业部署） |
| `DeepSeek-Harness-Portable-x.y.z-x64.exe` | 便携版，免安装 |

安装后从桌面快捷方式启动。

## 开发

```sh
npm install
npm start          # 开发模式运行
npm run pack       # 构建 Windows 安装包（portable / nsis / msi）
```

国内网络环境建议：

```sh
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npm run pack
```

## 工作原理

`main.js` 在应用启动时并行拉起 `dsh web --port 0`（系统分配空闲端口），解析其 stdout 中的 URL，随后在 Electron 窗口中加载该地址。窗口关闭 → 隐藏到托盘；显式「退出」→ `taskkill /T` 同步回收整个 dsh 进程树。

## License

MIT
