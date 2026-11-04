// 自动更新：Electron 自带的 autoUpdater（Mac 上是 Squirrel.Mac），见 https://www.electronjs.org/docs/latest/api/auto-updater
// 门户 GET /api/desktop/update/<平台>-<架构>?v=当前版本：有新版回 200 {url: zip 地址, name, notes}，没有回 204。
// 只有签名 + 公证过的正式版能自动更新：启动后检查一次、之后每 4 小时一次，有新版就在后台下载，下载好提示重启；
// 用户不重启的话，下次退出时自动装上。开发时（npm start）没有签名，菜单里的「检查更新…」只比较版本号、提示去下载页。
// CB_UPDATE_FEED 可以把更新地址指到别处；CB_UPDATE_TEST=install / quit：下载好后不弹窗，直接「立即重启更新」/ 正常退出（都是本机测试用）
const { app, autoUpdater, dialog, shell } = require('electron');

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

  start() {
    if (!this.enabled) return;
    const feed = process.env.CB_UPDATE_FEED || `${this.portal}/api/desktop/update/${process.platform}-${process.arch}?v=${app.getVersion()}`;
    try { autoUpdater.setFeedURL({ url: feed }); } catch (e) { console.warn(`自动更新不可用：${e.message}`); return; }
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
    autoUpdater.on('update-downloaded', (_e, _notes, name) => {
      this.state = 'ready';
      this.ready = name || '新版本';
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
    try { autoUpdater.checkForUpdates(); } catch (e) { this.manual = false; if (manual) this.failed(e); }
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
    if (r.response === 0) autoUpdater.quitAndInstall();
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
      const res = await fetch(`${this.portal}/api/desktop/version`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
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
    if (r.response === 0) shell.openExternal(`${this.portal}/download`);
  }

  box({ type = 'info', message, detail, buttons = [this.t('好')] }) {
    return dialog.showMessageBox(this.getWin(), { type, message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1 });
  }
}

module.exports = { Updater, newer };
