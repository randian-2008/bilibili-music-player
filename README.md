# B站听歌列表

一个基于 Manifest V3 的 Chrome / Edge 浏览器扩展，可以将 B站视频或分 P 添加到自定义歌单，并在跳转或关闭网页后继续播放音频。

项目以“浏览器内的轻量音乐播放器”为目标：不需要保持视频页面开启，也不依赖额外桌面客户端，歌单和设置均保存在浏览器本地。

[下载最新版](https://github.com/randian-2008/bilibili-music-player/releases/latest) · [使用指南](USER_GUIDE.md) · [更新日志](CHANGELOG.md) · [架构说明](docs/architecture.md)

## 主要功能

- 从 B站视频页面一键添加当前视频或分 P，自动获取标题、封面和音频信息。
- 支持多个自定义歌单，以及新建、重命名、删除、拖拽排序和批量移动、复制、删除。
- 使用后台音频文档播放，跳转或关闭当前网页后音乐仍可继续。
- 支持播放 / 暂停、上一首、下一首、停止、进度调节、音量和静音。
- 提供顺序播放、随机播放、单曲循环、列表循环和随机循环五种模式。
- 支持 TXT、Markdown 和 JSON 导出，以及 JSON 歌单导入。
- 记忆歌单、播放进度、音量、主题和浮动面板的位置与尺寸。
- 集成系统 MediaSession，并提供多音源切换、断点续播和网络异常自恢复。

播放器以浮动面板显示在普通网页右下角，可以自由拖动和调整尺寸。项目内置六套固定配色，主题只影响界面，不改变播放和歌单数据。

## 实现方式

扩展由四个主要运行模块组成：

```text
网页浮层与歌单界面
        │
        ▼
Content Script 消息桥接
        │
        ▼
Service Worker：歌单、状态与 B站接口
        │
        ▼
Offscreen Document：后台音频播放
```

- `content.js` 使用 closed Shadow DOM 注入浮动入口和播放器外壳，减少与网页样式及其他扩展的冲突。
- `sidepanel.*` 提供播放器、歌单管理和导入导出界面，并通过 Content Script 与后台通信。
- `background.js` 管理歌单和持久化状态，调用 B站接口解析视频信息与音频候选源。
- `offscreen.js` 持有唯一的 `<audio>` 实例，使播放不依赖当前标签页的生命周期。
- `chrome.storage.local` 保存用户数据；`declarativeNetRequest` 为必要的媒体请求设置来源请求头。

播放命令优先通过长连接 Port 发送，并使用请求 ID 去重。网络请求、媒体加载和播放过程均设置了超时与有限重试；快速切歌时，旧的异步结果会被取消，避免过期音源覆盖当前歌曲。更完整的设计说明见 [docs/architecture.md](docs/architecture.md)。

## 安装

运行要求：Chrome 或 Edge 109 及以上版本。

1. 从 [GitHub Releases](https://github.com/randian-2008/bilibili-music-player/releases) 下载最新版本 ZIP，不要下载 GitHub 自动生成的 `Source code` 压缩包。
2. 将 ZIP 解压到一个准备长期保留的目录。
3. Chrome 打开 `chrome://extensions/`，Edge 打开 `edge://extensions/`。
4. 开启“开发者模式”，点击“加载已解压的扩展程序”。
5. 选择包含 `manifest.json` 的解压目录。

浏览器不能直接安装 ZIP。安装后请勿随意移动或删除解压目录。更新时用新版文件替换原目录内容，然后在扩展管理页点击“重新加载”，使用同一扩展目录时原有歌单和设置会保留。

安装完成后，打开任意普通网页，点击右下角的音符按钮即可展开播放器。在 B站视频页面展开面板后，可以使用顶部的“＋加入”保存当前视频。完整操作说明见 [USER_GUIDE.md](USER_GUIDE.md)。

## 已知限制

- 完全关闭浏览器后，后台音频也会停止。
- 部分高音质、大会员或地区受限内容取决于当前 B站账号权限。
- Chromium 可能回收长时间暂停的后台音频文档，再次播放时需要短暂重建并恢复进度。
- 当前通过开发者模式加载，尚未发布到 Chrome Web Store 或 Edge 加载项商店。

## 未来目标

- 持续提升不同 Chrome / Edge 版本及复杂网络环境下的播放稳定性。
- 改进歌单备份、迁移和批量管理体验。
- 优化后台资源占用、错误提示和问题诊断能力。
- 在条件成熟时研究浏览器扩展商店分发与自动更新。
- 在不增加使用负担的前提下，逐步完善无障碍和键盘操作体验。

## 项目信息

- 当前版本：**v2.5.2**
- 开源许可：[GNU GPL v3.0 或更高版本](LICENSE)
- 参与贡献：[CONTRIBUTING.md](CONTRIBUTING.md)
- 安全问题：[SECURITY.md](SECURITY.md)
- 版本变化：[CHANGELOG.md](CHANGELOG.md)

本项目在维护者的设计、测试和审查下使用 AI 工具辅助开发，项目维护、发布和相关责任由维护者承担。
