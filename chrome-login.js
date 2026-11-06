// 用真浏览器（Chrome，没有就用 Edge / Brave / Chromium / Vivaldi）登录 Google，再把登录状态搬进内置浏览器。
// Google 不让在嵌入式浏览器（Electron）里登录：伪装成 Chrome 会被「无法登录」，用 Electron 原始身份会被分到简化版、最后「浏览器不支持 JavaScript」。
// 但在真 Chrome 里登录后，把 Google 的 Cookie 复制进内置浏览器，Google 照样认（实测 Gmail、Google 账号页、Google 首页都是登录状态，15 分钟后刷新仍然有效）。
// 流程：用一个临时的独立配置目录打开用户电脑上的 Chrome（不碰用户平时的 Chrome）→ 用户登录 → 读到登录 Cookie →
// 关掉这个 Chrome、删掉临时目录 → 返回 Cookie，由 main.js 写进 persist:browser
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GOOGLE_DOMAIN = /(^|\.)(google\.[a-z.]+|gmail\.com|youtube\.com)$/i;
const LOGIN_COOKIES = ['SID', '__Secure-1PSID', '__Secure-3PSID']; // 有这几个就算登录了

// 能用来登录的浏览器：Chromium 内核的都行（调试接口跟 Chrome 一样）。按顺序找，找到哪个用哪个。
// 是打开用户电脑上真的这个浏览器让用户登录，不是让内置浏览器冒充它。Windows 都自带 Edge
const BROWSERS = [
  { name: 'Chrome', mac: 'Google Chrome', win: ['Google/Chrome/Application/chrome.exe'], linux: ['google-chrome', 'google-chrome-stable'] },
  { name: 'Edge', mac: 'Microsoft Edge', win: ['Microsoft/Edge/Application/msedge.exe'], linux: ['microsoft-edge', 'microsoft-edge-stable'] },
  { name: 'Brave', mac: 'Brave Browser', win: ['BraveSoftware/Brave-Browser/Application/brave.exe'], linux: ['brave-browser'] },
  { name: 'Chromium', mac: 'Chromium', win: ['Chromium/Application/chrome.exe'], linux: ['chromium', 'chromium-browser'] },
  { name: 'Vivaldi', mac: 'Vivaldi', win: ['Vivaldi/Application/vivaldi.exe'], linux: ['vivaldi', 'vivaldi-stable'] },
];
const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
function findBrowser() {
  for (const b of BROWSERS) {
    const c = process.platform === 'darwin'
      ? ['/Applications', path.join(os.homedir(), 'Applications')].map((d) => path.join(d, `${b.mac}.app`, 'Contents', 'MacOS', b.mac))
      : process.platform === 'win32'
        ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).flatMap((d) => b.win.map((w) => path.join(d, ...w.split('/'))))
        : b.linux.flatMap((n) => [`/usr/bin/${n}`, `/snap/bin/${n}`]);
    const exe = c.find(isFile);
    if (exe) return { name: b.name, exe };
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 跟 Chrome 的调试接口说一句话（浏览器级别的连接），拿到结果就断开
async function cdp(wsUrl, method, params = {}) {
  const ws = new WebSocket(wsUrl);
  try {
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('连不上 Chrome')); });
    return await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Chrome 没有响应')), 10000);
      ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id !== 1) return; clearTimeout(t); d.error ? reject(new Error(d.error.message)) : resolve(d.result); };
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally { try { ws.close(); } catch {} }
}

// 打开 Chrome 等用户登录。返回 Google 相关的 Cookie（Chrome 调试接口的格式）。
// signal：取消（用户在界面上点了取消）；用户自己关掉这个 Chrome 窗口也算取消；10 分钟没登录完就放弃
// onStart(name)：找到并打开了哪个浏览器（界面上提示「已打开 Edge…」）
async function loginWithChrome({ url = 'https://accounts.google.com/', signal, onStart } = {}) {
  const b = findBrowser();
  if (!b) throw Object.assign(new Error('这台电脑上没有找到能用来登录 Google 的浏览器（Chrome、Edge、Brave、Chromium、Vivaldi 都可以）。请先安装其中一个，比如 Chrome（google.com/chrome）'), { noBrowser: true });
  const { exe, name } = b;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserx-google-login-'));
  // 端口给 0：Chrome 自己挑一个空闲端口，写进配置目录里的 DevToolsActivePort
  const child = spawn(exe, [`--user-data-dir=${dir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--new-window', url], { stdio: 'ignore', detached: false });
  let exited = false;
  child.on('exit', () => { exited = true; });
  onStart?.(name);
  let ws = null;
  let noPageSince = 0; // macOS 上关掉最后一个窗口 Chrome 不会退出：连着几秒一个网页都没有，就当用户关掉了
  try {
    const t0 = Date.now();
    for (;;) {
      if (signal?.aborted) throw Object.assign(new Error(`已取消用 ${name} 登录 Google`), { cancelled: true });
      if (exited) throw Object.assign(new Error(`${name} 窗口关掉了，没有登录 Google`), { cancelled: true });
      if (Date.now() - t0 > 10 * 60 * 1000) throw new Error(`10 分钟内没有在 ${name} 里登录完 Google，已放弃`);
      if (!ws) {
        try {
          const [port, p] = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n');
          if (port && p) ws = `ws://127.0.0.1:${port.trim()}${p.trim()}`;
        } catch { /* Chrome 还在启动 */ }
      }
      if (ws) {
        const { targetInfos } = await cdp(ws, 'Target.getTargets').catch(() => ({ targetInfos: null }));
        if (targetInfos && !targetInfos.some((x) => x.type === 'page')) {
          noPageSince ||= Date.now();
          if (Date.now() - noPageSince > 3000) throw Object.assign(new Error(`${name} 窗口关掉了，没有登录 Google`), { cancelled: true });
        } else noPageSince = 0;
        const { cookies } = await cdp(ws, 'Storage.getCookies').catch(() => ({ cookies: [] }));
        const g = cookies.filter((c) => GOOGLE_DOMAIN.test(c.domain.replace(/^\./, '')));
        if (LOGIN_COOKIES.every((n) => g.some((c) => c.name === n))) {
          // 登录 Cookie 刚出现时，Google 往往还在跳转、补写别的 Cookie：等它停下来再拿最后一份
          await sleep(4000);
          const { cookies: last } = await cdp(ws, 'Storage.getCookies').catch(() => ({ cookies }));
          return last.filter((c) => GOOGLE_DOMAIN.test(c.domain.replace(/^\./, '')));
        }
      }
      await sleep(1500);
    }
  } finally {
    // 关掉这个临时 Chrome，删掉临时配置目录（里面有刚登录的 Cookie）
    if (ws && !exited) await cdp(ws, 'Browser.close').catch(() => {});
    for (let i = 0; i < 20 && !exited; i++) await sleep(250);
    if (!exited) try { child.kill(); } catch {}
    for (let i = 0; i < 10; i++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(500); }
    }
  }
}

// 把 Chrome 调试接口格式的 Cookie 写进 Electron 的会话。返回写进去的个数
async function importCookies(ses, cookies) {
  let n = 0;
  for (const c of cookies) {
    const host = c.domain.replace(/^\./, '');
    const d = {
      url: `https://${host}${c.path || '/'}`, name: c.name, value: c.value, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly,
      sameSite: { Strict: 'strict', Lax: 'lax', None: 'no_restriction' }[c.sameSite] || 'unspecified',
    };
    if (c.domain.startsWith('.') && !c.name.startsWith('__Host-')) d.domain = c.domain; // __Host- 开头的不能带 domain
    if (c.expires > 0) d.expirationDate = c.expires;
    try { await ses.cookies.set(d); n++; } catch { /* 个别写不进去的跳过 */ }
  }
  await ses.cookies.flushStore().catch(() => {});
  return n;
}

const isGoogleLoginUrl = (u) => /^https:\/\/accounts\.google\.[a-z.]+\/(v3\/)?(signin|ServiceLogin|InteractiveLogin|AccountChooser|AddSession)/i.test(u || '');

module.exports = { findBrowser, loginWithChrome, importCookies, isGoogleLoginUrl, GOOGLE_DOMAIN };
