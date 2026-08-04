# 贡献指南

感谢你愿意改进 B站听歌列表。项目使用原生 JavaScript 与 Manifest V3，不需要安装运行时依赖。

## 开始开发

1. Fork 仓库并创建一个主题明确的分支。
2. 在 Chrome 或 Edge 的 `chrome://extensions/` 中开启开发者模式，并加载本项目根目录。
3. 使用 Node.js 18 或更高版本运行完整检查：

```bash
npm test
```

Windows 上的可发布 ZIP 可通过以下命令生成：

```powershell
npm run package:windows
```

该命令会重建项目外的 `release/` 目录；不要提交 ZIP、解压后的发布目录或 Chrome 自动生成的 `_metadata/`。

## 变更原则

- 保持 `background.js`、`offscreen.js`、`content.js` 与 `sidepanel.*` 的职责边界。整体架构见 [`docs/architecture.md`](docs/architecture.md)。
- 调整播放、存储、桥接消息或主题语义变量时，更新相应的 `tests/test-*.js`。
- UI 改动请同时检查停止态、播放态、窄面板和可调整尺寸后的长列表；涉及外观时附截图会提高审查效率。
- 不要在代码、Issue、PR 或测试样例中提交 Cookie、授权信息、个人播放链接或完整诊断日志。
- 保持改动聚焦，避免混合无关格式化、重命名和功能变更。

## 提交与 PR

提交信息建议使用简短前缀，例如 `fix:`、`feat:`、`docs:` 或 `test:`。提交 PR 时说明用户可见行为、验证方式和兼容性影响；CI 通过是合并的最低条件。

提交贡献即表示你有权提供相关内容，并同意贡献内容随项目按照 [GNU GPL v3.0 或更高版本](LICENSE)发布。
