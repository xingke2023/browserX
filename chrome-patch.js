// 内置浏览器的「补差异」：Electron 嵌入的 Chromium 跟真 Chrome 在页面里能看出几处不同，Google 登录页靠这些认出嵌入式浏览器、拒绝登录。
// 实测（2026-11-06，Google 登录页输入邮箱后）：只换 UA / 品牌，4/4 次「无法登录」；补了下面几项但漏了 window.chrome，3/3 次还是拒；
// 连 window.chrome 一起补上，没再出现「无法登录」（放行 / 验证码，验证码是同一 IP 测太多次）。window.chrome 是关键。
// 补的东西（跟真 Chrome 157 对比出来的）：
//   1. window.chrome：Electron 里是空对象。补 app / csi / loadTimes；Google 登录页上真 Chrome 还多 3 个同步加密接口
//      （setSyncEncryptionKeys 等，Chrome 跟 Google 账号同步之间用的），这里只能是空壳，回调照常调
//   2. outerWidth / outerHeight：嵌入的视图没有窗口，是 0。改成内容区大小（高度加 87，真 Chrome 实测的工具栏高度）
//   3. navigator.share / canShare：Electron 没有
//   4. Notification.permission：Electron 默认 granted，真 Chrome 没问过是 default
//   补出来的函数 toString() 跟原生的一样（[native code]）。语言列表（navigator.languages）在 main.js / agent.js 里用 acceptLanguage 改，不在这里。
// Agent.applyIdentity() 用 CDP Page.addScriptToEvaluateOnNewDocument 在每个文档的脚本之前跑它；白名单网站（原始身份）不跑
const CHROME_PATCH = `(() => {
  const nativeStr = new WeakMap();
  const origToString = Function.prototype.toString;
  const fakeToString = function toString() { return nativeStr.has(this) ? nativeStr.get(this) : origToString.call(this); };
  nativeStr.set(fakeToString, 'function toString() { [native code] }');
  Object.defineProperty(Function.prototype, 'toString', { value: fakeToString, writable: true, configurable: true });
  const native = (name, fn) => { Object.defineProperty(fn, 'name', { value: name }); nativeStr.set(fn, \`function \${name}() { [native code] }\`); return fn; };
  // 1. window.chrome
  if (!window.chrome || !window.chrome.csi) { // Electron 里 window.chrome 是个空对象，往里填
    const t0 = performance.timeOrigin / 1000;
    const app = {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      getDetails: native('getDetails', function getDetails() { return null; }),
      getIsInstalled: native('getIsInstalled', function getIsInstalled() { return false; }),
      installState: native('installState', function installState(cb) { if (typeof cb === 'function') setTimeout(() => cb('not_installed')); }),
      runningState: native('runningState', function runningState() { return 'cannot_run'; }),
    };
    const chrome = {
      app,
      csi: native('csi', function csi() { return { startE: Math.round(t0 * 1000), onloadT: Math.round(t0 * 1000 + performance.now()), pageT: performance.now(), tran: 15 }; }),
      loadTimes: native('loadTimes', function loadTimes() {
        const n = performance.getEntriesByType('navigation')[0] || {};
        return { requestTime: t0, startLoadTime: t0, commitLoadTime: t0 + (n.responseStart || 0) / 1000, finishDocumentLoadTime: t0 + (n.domContentLoadedEventEnd || 0) / 1000,
          finishLoadTime: t0 + (n.loadEventEnd || 0) / 1000, firstPaintTime: t0 + (n.responseEnd || 0) / 1000, firstPaintAfterLoadTime: 0, navigationType: 'Other',
          wasFetchedViaSpdy: true, wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, connectionInfo: 'h2' };
      }),
    };
    // Google 登录页上 Chrome 额外给的同步加密接口（Chrome 和 Google 账号同步之间用的）：这里只能是空壳，回调照常调
    if (/^accounts\\.google\\./.test(location.hostname)) {
      for (const n of ['setSyncEncryptionKeys', 'addTrustedSyncEncryptionRecoveryMethod', 'setClientEncryptionKeys'])
        chrome[n] = native(n, function (...a) { const cb = a.find((x) => typeof x === 'function'); if (cb) setTimeout(cb); });
    }
    if (window.chrome && typeof window.chrome === 'object') { for (const [k, v] of Object.entries(chrome)) { try { Object.defineProperty(window.chrome, k, { value: v, writable: true, configurable: true, enumerable: true }); } catch {} } }
    else Object.defineProperty(window, 'chrome', { value: chrome, writable: true, configurable: false, enumerable: true });
  }
  // 2. 窗口外框：嵌入的视图没有窗口，outer 是 0
  const get = (obj, k, fn) => { const g = native(\`get \${k}\`, fn); Object.defineProperty(obj, k, { get: g, configurable: true, enumerable: true }); };
  if (window.outerWidth === 0) { get(window, 'outerWidth', () => window.innerWidth); get(window, 'outerHeight', () => window.innerHeight + 87); }
  // 3. navigator.share
  if (!navigator.share) {
    Navigator.prototype.share = native('share', function share() { return Promise.reject(new DOMException('Share canceled', 'AbortError')); });
    Navigator.prototype.canShare = native('canShare', function canShare() { return true; });
  }
  // 4. 通知权限：真 Chrome 没问过时是 default
  if (window.Notification && Notification.permission === 'granted') {
    get(Notification, 'permission', () => 'default');
    const q = Permissions.prototype.query;
    Permissions.prototype.query = native('query', function query(d) {
      return d && d.name === 'notifications' ? Promise.resolve(Object.setPrototypeOf({ state: 'prompt', status: 'prompt', name: 'notifications', onchange: null }, PermissionStatus.prototype)) : q.call(this, d);
    });
  }
})();
`;

module.exports = { CHROME_PATCH };
