// 自动更新：electron-updater（electron-builder 配套的更新库），见 https://www.electron.build/auto-update
// 门户 <portal>/updates/ 下放 electron-builder 生成的 latest-mac.yml（版本号、zip 地址和 sha512）、zip 和 zip.blockmap（分块清单）。
// 差量更新：用上一次更新下载的 update.zip（缓存在 ~/Library/Caches/browserx-updater/）跟新版的分块清单对比，只下载变了的块，
// 平时发版只改了自己的代码（app.asar 二三十 MB），不用每次再下完整的 255 MB。第一次用这个机制更新（从 dmg 装的、或从 0.1.8
// 用老机制更新上来的）本地还没有 update.zip，会整包下载一次，之后都是差量。安装最后还是交给 Squirrel.Mac（要签名一致）。
// 只有签名 + 公证过的正式版能自动更新：启动后检查一次、之后每 4 小时一次，有新版就在后台下载，下载好提示重启；
// 用户不重启的话，下次退出时自动装上。开发时（npm start）没有签名，菜单里的「检查更新…」只比较版本号、提示去下载页。
// 0.1.8 及以前的客户端用 Electron 自带的 autoUpdater + /api/desktop/update/darwin-arm64，那个接口门户继续保留。
// CB_UPDATE_FEED 可以把更新地址（放 latest-mac.yml 的目录）指到别处；CB_UPDATE_TEST=install / quit：下载好后不弹窗，
// 直接「立即重启更新」/ 正常退出（都是本机测试用）。每次检查、下载的过程（含差量下载了多少）记在 <userData>/logs/updater.log
const { app, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const EVERY = 4 * 60 * 60 * 1000;

// a 比 b 新
const newer = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

class Updater {
  constructor({ portal, getWin, t }) {
    this.portal = portal;
    this.getWin = getWin;
    this.t = t || ((k, v = []) => k.replace(/\{(\d+)\}/g, (_, i) => v[i] ?? ''));
    this.state = 'idle'; // idle / checking / downloading / ready
    this.manual = false; // 这次检查是用户在菜单里点的：结果都要弹窗告诉用户；后台自动检查只在下载好时提示
    this.ready = null; // 下载好的版本名
  }

  get enabled() { return app.isPackaged && process.platform === 'darwin'; }

  // electron-updater 的日志写到 <userData>/logs/updater.log（超过 1MB 从头写），排查更新问题、看差量下载了多少
  logger() {
    const file = path.join(app.getPath('userData'), 'logs', 'updater.log');
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); if (fs.statSync(file, { throwIfNoEntry: false })?.size > 1 << 20) fs.rmSync(file); } catch {}
    const write = (level) => (...a) => { try { fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${a.map((x) => (x instanceof Error ? x.stack || x.message : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`); } catch {} };
    return { info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug') };
  }

  start() {
    if (!this.enabled) return;
    const { autoUpdater } = require('electron-updater'); // 只在正式版的 Mac 上用到，开发时不加载
    this.au = autoUpdater;
    autoUpdater.logger = this.logger();
    autoUpdater.autoDownload = true; // 有新版就在后台下载
    autoUpdater.autoInstallOnAppQuit = true; // 用户不点「立即重启更新」，下次退出时装上
    const feed = process.env.CB_UPDATE_FEED || `${this.portal}/updates/`;
    try { autoUpdater.setFeedURL({ provider: 'generic', url: feed }); } catch (e) { console.warn(`自动更新不可用：${e.message}`); return; }
    autoUpdater.on('checking-for-update', () => { this.state = 'checking'; });
    autoUpdater.on('update-available', () => {
      this.state = 'downloading';
      if (this.manual) this.box({ message: this.t('发现新版本，正在后台下载'), detail: this.t('下载好后会提示你重启更新，期间可以照常使用。') });
    });
    autoUpdater.on('update-not-available', () => {
      this.state = 'idle';
      if (this.manual) this.box({ message: this.t('已是最新版本'), detail: this.t('当前版本 {0}。', [app.getVersion()]) });
      this.manual = false;
    });
    autoUpdater.on('update-downloaded', (info) => {
      this.state = 'ready';
      this.ready = info?.version ? `BrowserX ${info.version}` : this.t('新版本');
      this.manual = false;
      if (process.env.CB_UPDATE_TEST === 'install') return autoUpdater.quitAndInstall();
      if (process.env.CB_UPDATE_TEST === 'quit') return app.quit();
      this.askRestart();
    });
    autoUpdater.on('error', (e) => {
      const wasManual = this.manual;
      this.state = this.ready ? 'ready' : 'idle';
      this.manual = false;
      console.warn(`自动更新失败：${e.message}`);
      if (wasManual) this.failed(e);
    });
    setTimeout(() => this.check(false), 30 * 1000); // 别跟启动抢网络
    setInterval(() => this.check(false), EVERY);
  }

  check(manual) {
    if (manual) this.manual = true;
    if (this.state === 'ready') return manual && this.askRestart();
    if (this.state !== 'idle') {
      if (manual) this.box({ message: this.t(this.state === 'downloading' ? '新版本正在后台下载' : '正在检查更新'), detail: this.t('好了会提示你。') });
      return;
    }
    // 失败也会发 error 事件（上面统一处理），这里只是别让 Promise 的拒绝没人接
    this.au.checkForUpdates().catch(() => {});
  }

  // 菜单「检查更新…」
  async menuCheck() {
    if (this.enabled) return this.check(true);
    return this.checkVersionOnly();
  }

  async askRestart() {
    const r = await this.box({
      message: this.t('{0} 已下载好', [this.ready]),
      detail: this.t('重启 BrowserX 就会更新。登录状态和工具箱都会保留。\n不想现在重启的话，下次退出 BrowserX 时会自动装上。'),
      buttons: [this.t('立即重启更新'), this.t('稍后')],
    });
    if (r.response === 0) this.au.quitAndInstall();
  }

  // 自动更新失败（最常见：BrowserX 没放进「应用程序」，直接在安装包里或下载文件夹里打开）：给一个去下载页手动更新的按钮
  async failed(e) {
    const r = await this.box({
      type: 'warning',
      message: this.t('自动更新失败'),
      detail: `${e.message}\n\n${this.t('请确认 BrowserX 已经拖进「应用程序」文件夹再试；也可以去网站下载新版手动安装。')}`,
      buttons: [this.t('去下载页'), this.t('关闭')],
    });
    if (r.response === 0) shell.openExternal(`${this.portal}/download`);
  }

  // 没法自动更新时（开发版）：只比较版本号，提示去下载页
  async checkVersionOnly() {
    let info;
    try {
      // 带上平台：网站有 Windows 版时，Windows 上拿到的是 Windows 版的版本号和下载地址
      const res = await fetch(`${this.portal}/api/desktop/version?platform=${process.platform}-${process.arch}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      info = await res.json();
    } catch (e) {
      return this.box({ type: 'warning', message: this.t('检查更新失败'), detail: this.t('连不上 {0}：{1}。请检查网络后再试。', [this.portal, e.cause?.code || e.message]) });
    }
    if (!info.version || !newer(info.version, app.getVersion())) return this.box({ message: this.t('已是最新版本'), detail: this.t('当前版本 {0}。', [app.getVersion()]) });
    const r = await this.box({
      message: this.t('发现新版本 {0}', [info.version]),
      detail: this.t('当前版本 {0}。点「下载新版本」会在浏览器里下载安装包，装好后替换旧版即可。', [app.getVersion()]),
      buttons: [this.t('下载新版本'), this.t('以后再说')],
    });
    // 用网站给的下载地址（Windows 版是 /download/windows）；不是网站自己的地址就不打开，退回 /download
    const url = typeof info.url === 'string' && info.url.startsWith(`${this.portal}/`) ? info.url : `${this.portal}/download`;
    if (r.response === 0) shell.openExternal(url);
  }

  box({ type = 'info', message, detail, buttons = [this.t('好')] }) {
    return dialog.showMessageBox(this.getWin(), { type, message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1 });
  }
}

module.exports = { Updater, newer };
