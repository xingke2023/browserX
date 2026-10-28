<p align="center"><img src="build/icon.png" alt="BrowserX" width="96"></p>

<h1 align="center">BrowserX</h1>

<p align="center">左边是智能助手，右边是浏览器。用中文说要做什么，助手直接在右边的浏览器里帮你点、帮你填、帮你查，全程看得到。</p>

## 下载安装

到 [Releases](https://github.com/xingke2023/browserX/releases) 下载最新的 `BrowserX-<版本>-arm64.dmg`：

1. 双击打开 dmg，把 BrowserX 拖进「应用程序」。
2. 第一次打开时系统会提示「无法验证开发者」（应用没有用开发者证书签名和公证）：打开「系统设置 → 隐私与安全性」，在下方点「仍要打开」。
3. 安装包已内置运行所需的全部组件，不需要安装 Node 或其他依赖。

**要求**

- 仅支持 Apple 芯片的 Mac（M1 及以后）。
- 对话需要账号：在设置里填写 API Key，或本机已登录过 Claude Code。

## 主要功能

| 功能 | 说明 |
|---|---|
| 说话就能操作网页 | 打开网站、搜索、点击、填写表单、读取页面内容 |
| 登录状态保留 | 右侧浏览器记住登录过的网站，重启也不用重新登录 |
| 工具箱 | 常用流程做成工具，填参数一键运行，不经过对话、不花额度；支持搜索、中文名、分页 |
| 制作工具 | 「新建工具 / 编辑」进入制作模式：代码写在草稿里，试运行没问题再点「完成」放进工具箱 |
| 网络录制 | 手工操作一遍并录制接口，交给助手分析后做成稳定、快速的工具；录制时自动给密码和 token 打码 |
| 导入导出 | 工具导出成一个 `.js` 文件分享；导入前列出敏感能力并可查看源代码 |
| 文件保护 | 助手不能直接改工具箱里的正式工具文件，只能改草稿 |
| 选择题卡片 | 助手需要你做选择时，弹出可点选的卡片 |

更详细的说明在应用菜单「帮助 → 使用说明」。

## 开发

```bash
npm install
npm start          # 运行（开发模式）
npm run debug      # 带调试端口 9334 运行
```

### 打包

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac
# 输出：dist/BrowserX-<版本>-arm64.dmg
```

- 不使用开发者证书：打包后由 `scripts/after-pack.js` 做本机临时签名（ad-hoc）。
- 打包峰值约需 1.3 GB 磁盘空间。
- 版本号改 `package.json` 里的 `version`。

### 目录结构

```
main.js          主进程：窗口、右侧浏览器视图、菜单、IPC
agent.js         助手会话（Claude Agent SDK）、浏览器工具、工具箱、制作模式
recorder.js      网络录制
renderer.js      界面逻辑
index.html       界面结构        style.css  样式
help.html        帮助页（使用说明 / 软件特色）
wechat.js        微信公众号后台操作      article.js  文章排版
example-tools/   示例工具（参考副本）
scripts/         开发与打包脚本
build/icon.png   应用图标
```

用户数据（工具箱、录制文件、登录状态、设置）保存在 `~/Library/Application Support/BrowserX/`，不在项目目录里。

开发细节见 [CLAUDE.md](CLAUDE.md)。

---

[www.xingke888.com](https://www.xingke888.com)
