const { app, BrowserWindow, WebContentsView, ipcMain, dialog, safeStorage, Menu, shell, webFrameMain, clipboard, session, Notification } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent, CB_TAG, scanRisks, BLOCKING_SECRETS } = require('./agent');
const { Account, PORTAL: ACCOUNT_PORTAL } = require('./account');
const { Updater } = require('./updater');
const { Scheduler } = require('./scheduler');
const { ToolVault } = require('./toolcrypt');

// 不打包直接跑 `electron .` 时，app.getName() 默认读 package.json 的 name（"browserx"），
// 但 macOS 菜单栏/Dock 显示的是 Electron.app 这个可执行文件本身的 Info.plist 名字（"Electron"），
// 跟这个调用没关系——这行只保证 app.getName() 之类的 API 返回值对，不保证菜单栏文字变了
app.setName('BrowserX');

if (process.env.CB_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.CB_DEBUG_PORT);
if (process.env.CB_USER_DATA) app.setPath('userData', process.env.CB_USER_DATA); // 测试用：独立的配置与登录状态

const CFG_FILE = () => path.join(app.getPath('userData'), 'config.json');
// 自定义工具（“工具箱”）存放目录，见 agent.js 的 loadCustomTools/TOOLBOX_PROMPT
const TOOLS_DIR = () => {
  const d = path.join(app.getPath('userData'), 'tools');
  fs.mkdirSync(d, { recursive: true });
  return d;
};
// 网络录制文件存放目录，见 recorder.js（含真实业务数据，放 userData 下，不进项目目录）
// 插件市场里别人的工具加密保存，密钥存这里（见 toolcrypt.js）
const vault = new ToolVault(() => path.join(app.getPath('userData'), 'tool-keys.json'));
const RECON_DIR = () => path.join(app.getPath('userData'), 'recon');
// 默认工作目录用单独的 ~/BrowserX：主目录下往往配了跟浏览器任务无关的 MCP 服务、插件（每个新对话都要加载，拖慢启动）
const WORK_DIR = path.join(os.homedir(), 'BrowserX');
const DEFAULTS = {
  apiKey: '', baseUrl: '', model: 'claude-opus-5-5', cwd: WORK_DIR, permissionMode: 'bypassPermissions', home: 'https://browserx.xingke888.com/',
  replyLang: 'system', // Claude 的回复语言：system = 跟随系统语言，或 zh-CN / zh-TW / en
  autoUpdateTools: true, // 从插件市场装的工具有审核通过的新版本时自动更新（工具箱顶部可以关）
};
let cfg, win;
let accountToken = null;
// 标签：左侧一个对话 = 右侧一个浏览器视图 = 一个 Agent，一一对应。cur 是当前显示的那个；
// 其它标签的视图只是藏起来（setVisible(false)），后台的助手照样能截图、执行脚本、发输入事件（实测过）
const tabs = new Map(); // id → { id, view, agent, navError }
let cur = null;
let tabSeq = 0;
let stageBounds = null; // #stage 的位置，所有视图都用这个大小（后台标签截图尺寸跟前台一致）
const MAX_TABS = 8;

// API Key 用系统钥匙串加密后再写入配置文件
function loadCfg() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CFG_FILE(), 'utf8')); } catch {}
  if (c.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try { c.apiKey = safeStorage.decryptString(Buffer.from(c.apiKeyEnc, 'base64')); } catch { c.apiKey = ''; }
  }
  delete c.apiKeyEnc;
  // BrowserX 账号的 token：不放进 cfg（cfg 会整个发给界面），单独存在 accountToken 里
  if (c.accountTokenEnc && safeStorage.isEncryptionAvailable()) {
    try { accountToken = safeStorage.decryptString(Buffer.from(c.accountTokenEnc, 'base64')); } catch { accountToken = null; }
  }
  delete c.accountTokenEnc;
  if (c.home === 'https://www.bing.com/') delete c.home; // 旧版默认主页存进了配置，跟着换成新的默认主页（自己填过别的就不动）
  delete c.useRemote; // 服务器（SSH）模式已移除，旧配置里的这两项忽略
  delete c.remote;
  return { ...DEFAULTS, ...c };
}
function saveCfg() {
  const out = { ...cfg };
  if (cfg.apiKey && safeStorage.isEncryptionAvailable()) {
    out.apiKeyEnc = safeStorage.encryptString(cfg.apiKey).toString('base64');
    delete out.apiKey;
  }
  // 账号 token 只在能用系统钥匙串加密时才落盘；不能加密就只留在内存里（下次启动重新登录）
  if (accountToken && safeStorage.isEncryptionAvailable()) out.accountTokenEnc = safeStorage.encryptString(accountToken).toString('base64');
  fs.mkdirSync(path.dirname(CFG_FILE()), { recursive: true });
  fs.writeFileSync(CFG_FILE(), JSON.stringify(out, null, 2));
}

const send = (ch, v) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(ch, v); };
let quitting = false; // 退出时网页一个个销毁，不要再当成「网页自己关掉」去补空白页、更新界面
app.on('before-quit', () => { quitting = true; });

// 右侧页面主框架加载失败时的错误存在各标签的 navError 上（Electron 的错误页是一片空白，交给界面显示说明，见 renderer.js renderNavError）
let covered = false; // 界面弹窗打开时暂时藏起原生视图（它总是盖在 DOM 上面，居中的弹窗会被挡住）
// 只显示当前对话的当前网页标签
const syncViewVisible = () => { for (const t of tabs.values()) for (const p of t.pages) p.view.setVisible(t === cur && p === t.page && !p.navError && !covered); };

function navState(t = cur) {
  const wc = t.view.webContents;
  return { url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(),
    canBack: wc.navigationHistory.canGoBack(), canForward: wc.navigationHistory.canGoForward(), error: t.page.navError };
}

const tabList = () => [...tabs.values()].map((t) => ({ id: t.id, title: t.view.webContents.getTitle(), url: t.view.webContents.getURL(), current: t === cur }));
const sendTabs = () => send('tabs', tabList());
const tabOf = (id) => (id && tabs.get(id)) || cur;
const makingTab = () => [...tabs.values()].find((t) => t.agent.making);

// 开会话、工具里调模型（ctx.ask）之前确认账号还有效、额度没用完。1 分钟内查过就用上次的结果（工具里可能连着调好几次模型）；
// 网络一时不通就按上次的状态继续（真失效了中转会拒绝）。token 失效时 refresh 会清掉登录并抛「登录已失效，请重新登录」
let accountCheckedAt = 0;
async function checkAccount() {
  if (Date.now() - accountCheckedAt < 60 * 1000 && account.user) return account.state();
  try {
    const st = await account.refresh();
    accountCheckedAt = Date.now();
    return st;
  } catch (e) {
    // 连不上门户（网络 / 代理问题）：不拿旧数据拦用户（旧的「额度已用完」可能早就不对了，比如管理员清零、用户刚买了套餐），
    // 标成 stale 放行，额度由中转在服务器上判断（真超额会回 402）
    if (e.network) return { ...account.state(), stale: true };
    throw e;
  }
}

// ---------------------------------------------------------------- 网页标签
// 一个对话（左侧标签）可以开多个网页标签（右侧浏览器上方那一排）：t.pages，t.page 是当前的，t.view 指向它。
// 网站 window.open / target=_blank 时新开一个网页标签并切过去（保留 opener，登录弹窗之类回传结果的流程能走通）；助手用 tab_* 工具切换
const MAX_PAGES = 10;
const pageList = (t) => t.pages.map((p, i) => {
  const wc = p.view.webContents;
  return { index: i + 1, title: wc.getTitle(), url: wc.getURL(), loading: wc.isLoading(), active: p === t.page };
});
const sendPages = (t) => { if (t === cur) send('pages', pageList(t)); };
const pageAt = (t, index) => {
  const p = index == null ? t.page : t.pages[Number(index) - 1];
  if (!p) throw new Error(`没有标签页 ${index}，现在有 ${t.pages.length} 个`);
  return p;
};

// 往对话 t 里加一个网页标签。view 是网站 window.open 时 Electron 建好的，或者这里新建
function addPage(t, { view, url, activate = true } = {}) {
  if (t.pages.length >= MAX_PAGES) throw new Error(`一个对话最多开 ${MAX_PAGES} 个标签页，先关掉一些`);
  // backgroundThrottling 关掉：藏起来的标签里，页面计时器和助手的操作照常跑
  view = view || new WebContentsView({ webPreferences: { partition: 'persist:browser', backgroundThrottling: false } }); // 记住登录状态（所有标签共用）
  const p = { view, navError: null };
  win.contentView.addChildView(view);
  if (stageBounds) view.setBounds(stageBounds);
  view.setVisible(false);
  const wc = view.webContents;
  // 主框架加载失败：先把原生视图藏起来，露出下面 #stage 里的说明（否则只看到空白）；
  // 下一次成功导航（did-navigate 只在非错误页时触发）再显示回来。-3 ERR_ABORTED 是被新导航打断，不算失败
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    p.navError = { code, desc, url };
    syncViewVisible();
  });
  wc.on('did-navigate', () => {
    p.navError = null;
    syncViewVisible();
  });
  for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading', 'did-fail-load']) {
    wc.on(ev, () => { if (t === cur && p === t.page) send('nav', navState()); sendPages(t); });
  }
  for (const ev of ['did-navigate', 'page-title-updated']) wc.on(ev, () => { if (p === t.page) sendTabs(); });
  // 焦点在右侧网页里时，标签快捷键（⌘T / ⌘W / ⌘1…9 / ⌘⇧[ ]）也要能用：拦下来转给界面处理
  wc.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown' || !i.meta || i.alt || i.control) return;
    if ((!i.shift && /^([tw1-9])$/.test(i.key)) || (i.shift && /^Bracket(Left|Right)$/.test(i.code))) {
      e.preventDefault();
      send('tabkey', { key: i.key, code: i.code, shift: i.shift });
    }
  });
  // 网站要开新窗口 / 新标签：在这个对话里新开一个网页标签并切过去（不另开系统窗口）。标签太多时退回在当前页打开
  wc.setWindowOpenHandler(({ url }) => {
    if (t.pages.length >= MAX_PAGES) { wc.loadURL(url).catch(() => {}); return { action: 'deny' }; }
    return {
      action: 'allow',
      outlivesOpener: true, // 关掉打开它的标签时不跟着关
      createWindow: (options) => {
        const child = new WebContentsView({ webContents: options.webContents, webPreferences: { ...options.webPreferences, backgroundThrottling: false } });
        // 先不切过去：有些网站（永明登入页）一打开就 window.open 再马上 close 一个小窗口。立刻切过去的话，
        // 工具 / 助手正在操作的就成了这个转眼关掉的页面（报 Object has been destroyed）。活过 400ms 才算真的新标签
        const np = addPage(t, { view: child, activate: false });
        np.opener = p; // 关掉时切回打开它的页面
        setTimeout(() => {
          if (!t.pages.includes(np) || child.webContents.isDestroyed()) return;
          activatePage(t, np);
          t.agent.pageOpened({ index: t.pages.indexOf(np) + 1, url });
        }, 400);
        return child.webContents;
      },
    };
  });
  // 网页自己关掉（window.close()，比如登录弹窗登完）：从标签里拿掉
  wc.once('destroyed', () => { if (!quitting && win && !win.isDestroyed() && t.pages.includes(p)) removePage(t, p, false); });
  t.pages.push(p);
  t.agent.watchPage(wc);
  if (url) wc.loadURL(url).catch(() => {});
  if (activate || !t.page) activatePage(t, p);
  else sendPages(t);
  return p;
}

function activatePage(t, p) {
  t.page = p;
  syncViewVisible();
  if (t === cur) send('nav', navState());
  sendPages(t);
  sendTabs();
}

function removePage(t, p, closeIt = true) {
  const i = t.pages.indexOf(p);
  if (i < 0) return;
  t.pages.splice(i, 1);
  try { win.contentView.removeChildView(p.view); } catch {}
  if (closeIt && !p.view.webContents.isDestroyed()) p.view.webContents.close();
  if (!t.pages.length) { if (tabs.has(t.id)) addPage(t, { url: 'about:blank' }); return; } // 最后一个网页自己关掉了：留一个空白页
  if (t.page === p) activatePage(t, (p.opener && t.pages.includes(p.opener) && p.opener) || t.pages[i] || t.pages[i - 1]);
  else sendPages(t);
}

// 给 Agent 用的网页标签操作（编号从 1 开始，跟 tab_list 一致）
const pagesApi = (t) => ({
  list: () => pageList(t),
  open: (url) => { const p = addPage(t, { url: toUrl(url || 'about:blank') }); return t.pages.indexOf(p) + 1; },
  switch: (index) => activatePage(t, pageAt(t, index)),
  close: (index) => {
    if (t.pages.length === 1) throw new Error('最后一个标签页不能关');
    removePage(t, pageAt(t, index));
  },
  // 只留当前标签（制作新工具时从干净的浏览器开始）
  reset: () => { for (const p of [...t.pages]) if (p !== t.page) removePage(t, p); },
});

function createTab(url = cfg.home) {
  if (tabs.size >= MAX_TABS) throw new Error(`最多开 ${MAX_TABS} 个标签，先关掉一些`);
  const id = ++tabSeq;
  const t = { id, pages: [], page: null, get view() { return this.page.view; } };
  t.agent = new Agent({
    getWc: () => t.page.view.webContents,
    pages: pagesApi(t),
    vault,
    show: async () => {},
    getCfg: () => cfg,
    replyLang, // 回复语言（见 replyLang）
    getAccountToken: () => accountToken, // 没填 API Key 时，Claude 请求经门户中转，用账号 token 认证
    checkAccount, // 开会话 / 调模型前确认账号（见 checkAccount）
    getToolsDir: TOOLS_DIR,
    getReconDir: RECON_DIR,
    emit: (ev) => send('agent', { ...ev, tab: id }),
    // 制作工具模式同一时间只允许一个标签（草稿、工具目录是共用的）
    otherMaking: () => [...tabs.values()].find((x) => x !== t && x.agent.making)?.agent.making.name,
    // 工具箱有变化（制作完成、导入）：其它标签正在进行的对话也重新加载工具
    toolsChanged: () => { for (const x of tabs.values()) if (x !== t) x.agent.reloadCustomTools(); },
    isMarketTool: (name) => isMarketTool(name),
    trash: (f) => shell.trashItem(f), // 放弃制作时草稿移到废纸篓
  });
  tabs.set(id, t);
  addPage(t, { url: toUrl(url) });
  sendTabs();
  return t;
}

function switchTab(id) {
  const t = tabs.get(id);
  if (!t) throw new Error('标签不存在');
  cur = t;
  syncViewVisible();
  send('nav', navState());
  sendPages(t);
  sendTabs();
  return id;
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return cur?.id;
  if (tabs.size === 1) throw new Error('至少要留一个标签');
  if (t.agent.making) throw new Error(`这个标签正在制作工具「${t.agent.making.title || '新工具'}」，先点横幅上的「保存工具」或「不做了」`);
  try { if (t.agent.rec.active) t.agent.rec.save(); } catch {}
  t.agent.stopTool();
  t.agent.reset();
  const ids = [...tabs.keys()];
  const i = ids.indexOf(id);
  tabs.delete(id);
  for (const p of [...t.pages]) { t.pages = t.pages.filter((x) => x !== p); try { win.contentView.removeChildView(p.view); } catch {} if (!p.view.webContents.isDestroyed()) p.view.webContents.close(); }
  if (cur === t) switchTab(ids[i + 1] ?? ids[i - 1]);
  else sendTabs();
  return cur.id;
}

// 地址栏输入：网址直接打开，其它当作搜索
function toUrl(s) {
  s = s.trim();
  if (/^(https?:\/\/|about:|file:)/i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(s) || /^localhost(:\d+)?/.test(s)) return (s.startsWith('localhost') ? 'http://' : 'https://') + s;
  return `https://www.bing.com/search?q=${encodeURIComponent(s)}`;
}

// 填表页面「跟着最新内容滚动」：点过页面上的按钮（试算、查询…）之后，新内容出现在可见区下面就滚过去
// （大块内容滚到它的开头）；本来就在页面最底下也一直跟着。在可见区里的变化（选产品后字段重画）不滚。
// 自己往上滚（滚轮 / ↑ / PageUp / Home）就停，下次点按钮再开始。页面自己设了 window.__bxAutoScroll（自己处理了滚动）就跳过
const FORM_FOLLOW = `(() => {
  if (window.__bxFollowInstalled || window.__bxAutoScroll) return;
  window.__bxFollowInstalled = true;
  const root = document.scrollingElement || document.documentElement;
  const atBottom = () => root.scrollHeight - root.scrollTop - innerHeight < 40;
  let follow = false;
  addEventListener('click', (e) => { if (e.target.closest('button, input[type=submit], input[type=button], [role=button]')) follow = true; }, true);
  addEventListener('wheel', (e) => { if (e.deltaY < 0) follow = false; }, { passive: true });
  addEventListener('keydown', (e) => { if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) follow = false; });
  new MutationObserver((ms) => {
    if (window.__bxAutoScroll) return;
    const bottom = atBottom();
    if (!follow && !bottom) return;
    let el = null;
    for (const m of ms) {
      const n = m.type === 'characterData' ? m.target : m.addedNodes[m.addedNodes.length - 1] || m.target;
      el = (n.nodeType === 1 ? n : n.parentElement) || el;
    }
    if (!el || !el.isConnected) return;
    const r = el.getBoundingClientRect();
    if (r.height === 0 || r.bottom <= innerHeight) return; // 新内容就在眼前，不动
    // 一行行冒出来的进度：直接跳（平滑滚动跟不上快速更新）；一大块结果：平滑滚到它开头
    const big = r.height > innerHeight * 0.8;
    el.scrollIntoView({ block: big ? 'start' : 'end', behavior: big ? 'smooth' : 'auto' });
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
})();`;

function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 1000, minWidth: 1000, minHeight: 640, title: 'BrowserX',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile('index.html');
  // 工具自带的填表页面（工具箱里的 iframe，本机 127.0.0.1 小服务）：注入「跟着最新内容滚动」，所有这类工具都有，不用每个工具自己写
  win.webContents.on('did-frame-finish-load', (_e, isMainFrame, processId, routingId) => {
    if (isMainFrame) return;
    const f = webFrameMain.fromId(processId, routingId);
    if (f && /^http:\/\/127\.0\.0\.1:\d+\//.test(f.url)) f.executeJavaScript(FORM_FOLLOW).catch(() => {});
  });
  win.on('closed', () => app.quit());
  for (const ev of ['enter-full-screen', 'leave-full-screen']) win.on(ev, () => send('fullscreen', win.isFullScreen()));

  switchTab(createTab().id);
}

// 退出时还在录制：把已录到的内容存下来，别丢
app.on('before-quit', () => {
  for (const t of tabs.values()) try { if (t.agent.rec.active) t.agent.rec.save(); } catch {}
});

const PORTAL = 'https://www.xingke888.com';
// 正式打包给客户的版本不显示设置（API Key、模型、工作目录等）：客户登录账号就能用，不需要也不该改这些。
// 开发时（npm start）照常显示；正式版要排查问题时用 CB_SETTINGS=1 启动
const SHOW_SETTINGS = !app.isPackaged || process.env.CB_SETTINGS === '1';

// 应用菜单：替换 Electron 默认菜单（默认的「帮助」里全是 Electron 官网 / 文档 / 社区链接）。
// 编辑 / 显示 / 窗口 用系统角色保留：复制粘贴（⌘C/⌘V）、刷新界面（⌘R）等快捷键靠它们
// 使用说明 / 软件特色：一个独立窗口（help.html），hash 跳到对应部分；已打开就复用
let helpWin = null;
// 说明页按当前语言打开 locales/help/<语言>.html（scripts/i18n-help.py 生成），简体中文或没有译文就用原版 help.html
function helpFile() {
  const f = path.join(__dirname, 'locales', 'help', `${replyLang()}.html`);
  return replyLang() !== 'zh-CN' && fs.existsSync(f) ? f : path.join(__dirname, 'help.html');
}
function reloadHelp() {
  if (!helpWin || helpWin.isDestroyed()) return;
  const hash = new URL(helpWin.webContents.getURL()).hash.slice(1);
  helpWin.setTitle(L('BrowserX 使用说明'));
  helpWin.loadFile(helpFile(), { query: { v: require('./package.json').version }, hash: hash || undefined });
}
function openHelp(section) {
  const opts = { query: { v: require('./package.json').version }, hash: section };
  if (helpWin && !helpWin.isDestroyed()) {
    helpWin.loadFile(helpFile(), opts);
    helpWin.show();
    helpWin.focus();
    return;
  }
  helpWin = new BrowserWindow({ width: 820, height: 760, minWidth: 480, minHeight: 400, title: L('BrowserX 使用说明'), webPreferences: { sandbox: true } });
  helpWin.setMenuBarVisibility(false);
  // 说明页里的外部链接用系统浏览器打开，不在说明窗口里跳走
  helpWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  helpWin.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); } });
  helpWin.on('closed', () => { helpWin = null; });
  helpWin.loadFile(helpFile(), opts);
}

// Claude 的回复语言：设成「跟随系统」时看 macOS 的首选语言——繁体（香港 / 台湾 / 澳门）→ 繁體中文，其它中文 → 简体中文，
// 日 / 法 / 德 / 西 / 韩对应各自的语言，其它 → English
const REPLY_LANG_NAMES = { 'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English', ja: '日本語', fr: 'Français', de: 'Deutsch', es: 'Español', ko: '한국어' };
function systemReplyLang() {
  const l = (app.getPreferredSystemLanguages?.()[0] || app.getLocale() || '').toLowerCase();
  if (/^zh-(hant|tw|hk|mo)/.test(l)) return 'zh-TW';
  if (/^zh/.test(l)) return 'zh-CN';
  const base = l.split(/[-_]/)[0];
  return REPLY_LANG_NAMES[base] ? base : 'en';
}
const replyLang = () => (REPLY_LANG_NAMES[cfg?.replyLang] ? cfg.replyLang : systemReplyLang());
// 界面语言跟回复语言是同一个设置（菜单「BrowserX → 语言」）：简体中文是原文，其它语言读 locales/<语言>.json（见 i18n.js）
const I18N = require('./i18n');
let uiDict = {}, ui = I18N.makeT({});
function loadUiLang() {
  const l = replyLang();
  uiDict = {};
  if (l !== 'zh-CN') { try { uiDict = JSON.parse(fs.readFileSync(path.join(__dirname, 'locales', `${l}.json`), 'utf8')); } catch { /* 没有这个语言的文件：显示中文 */ } }
  ui = I18N.makeT(uiDict);
}
const L = (key, vals) => ui.t(key, vals);
function setReplyLang(v) {
  cfg.replyLang = v;
  saveCfg();
  loadUiLang();
  buildMenu();
  send('cfg', cfg);
  send('i18n', { lang: replyLang(), dict: uiDict }); // 界面马上按新语言重翻
  reloadHelp();
}

// 自动更新（见 updater.js）
const updater = new Updater({ portal: ACCOUNT_PORTAL, getWin: () => win, t: (k, v) => L(k, v) });

function buildMenu() {
  const openInView = (url) => cur?.view.webContents.loadURL(url).catch(() => {});
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: 'BrowserX',
      submenu: [
        { role: 'about', label: L('关于 BrowserX') },
        { label: L('检查更新…'), click: () => updater.menuCheck() },
        { type: 'separator' },
        { label: L('语言'), submenu: [
          { label: L('跟随系统（{0}）', [REPLY_LANG_NAMES[systemReplyLang()]]), type: 'radio', checked: !REPLY_LANG_NAMES[cfg?.replyLang], click: () => setReplyLang('system') },
          ...Object.entries(REPLY_LANG_NAMES).map(([v, name]) => ({ label: name, type: 'radio', checked: cfg?.replyLang === v, click: () => setReplyLang(v) })),
        ] },
        { type: 'separator' },
        // 左侧栏收起时设置面板在隐藏的左栏里，看不到：先展开左栏再打开设置
        ...(SHOW_SETTINGS ? [
          { label: L('设置…'), accelerator: 'CmdOrCtrl+,', click: () => { win?.show(); win?.webContents.executeJavaScript("document.body.classList.contains('side-collapsed') && $('sideToggle').click(); $('settings').hidden && $('btnSettings').click()").catch(() => {}); } },
          { type: 'separator' },
        ] : []),
        { role: 'hide', label: L('隐藏 BrowserX') },
        { role: 'hideOthers', label: L('隐藏其他') },
        { role: 'unhide', label: L('全部显示') },
        { type: 'separator' },
        { role: 'quit', label: L('退出 BrowserX') },
      ],
    }] : []),
    {
      label: L('编辑'),
      submenu: [
        { role: 'undo', label: L('撤销') }, { role: 'redo', label: L('重做') }, { type: 'separator' },
        { role: 'cut', label: L('剪切') }, { role: 'copy', label: L('拷贝') }, { role: 'paste', label: L('粘贴') },
        { role: 'pasteAndMatchStyle', label: L('粘贴并匹配样式') }, { role: 'delete', label: L('删除') }, { role: 'selectAll', label: L('全选') },
      ],
    },
    {
      label: L('显示'),
      submenu: [
        { role: 'reload', label: L('刷新界面') }, { role: 'forceReload', label: L('强制刷新界面') }, { role: 'toggleDevTools', label: L('界面开发者工具') },
        // 右侧网页的开发者工具（原来在浏览器工具栏上，那个位置换成了收藏夹按钮）
        { label: L('网页开发者工具'), accelerator: 'Alt+CmdOrCtrl+I', click: () => cur?.view.webContents.toggleDevTools() },
        { type: 'separator' },
        { role: 'resetZoom', label: L('实际大小') }, { role: 'zoomIn', label: L('放大') }, { role: 'zoomOut', label: L('缩小') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: L('全屏') },
      ],
    },
    { role: 'windowMenu', label: L('窗口') },
    {
      role: 'help',
      label: L('帮助'),
      submenu: [
        { label: L('使用说明'), click: () => openHelp('guide') },
        { label: L('软件特色'), click: () => openHelp('features') },
        { label: `版本 ${require('./package.json').version}`, enabled: false },
        { type: 'separator' },
        { label: L('打开门户网站'), click: () => openInView(PORTAL) },
        { label: L('在系统浏览器打开门户网站'), click: () => shell.openExternal(PORTAL) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  app.setAboutPanelOptions({
    applicationName: 'BrowserX',
    applicationVersion: require('./package.json').version,
    version: '',
    copyright: PORTAL.replace('https://', ''),
    iconPath: path.join(__dirname, 'build', 'icon.png'),
  });
}

// 旧版默认工作目录是主目录：换到 ~/BrowserX，并把本应用自己的对话（带 CB_TAG 标签的）搬过去，历史列表照样能看到、能继续。
// 会话按工作目录存在 ~/.claude/projects/<目录名>/，终端里 claude 的会话（没有这个标签）留在原处不动
async function migrateWorkDir() {
  if (cfg.cwd !== os.homedir()) return;
  fs.mkdirSync(WORK_DIR, { recursive: true });
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const projDir = (d) => path.join(os.homedir(), '.claude', 'projects', d.replace(/[^a-zA-Z0-9]/g, '-'));
    const from = projDir(os.homedir()), to = projDir(WORK_DIR);
    const mine = (await sdk.listSessions({ dir: os.homedir(), limit: 5000 })).filter((s) => s.tag === CB_TAG);
    fs.mkdirSync(to, { recursive: true });
    for (const s of mine) {
      for (const name of [`${s.sessionId}.jsonl`, s.sessionId]) { // 会话文件 + 同名目录（子任务、大工具结果）
        const src = path.join(from, name);
        if (fs.existsSync(src) && !fs.existsSync(path.join(to, name))) fs.renameSync(src, path.join(to, name));
      }
    }
  } catch (e) { console.error(`搬历史对话失败：${e.message}`); }
  cfg.cwd = WORK_DIR;
  saveCfg();
}

// 下载：右侧网页下载文件时不弹「存储为」（助手操作不了），直接存到 下载/BrowserX/，重名加 (1)(2)…；存好后告诉发起下载的那个对话
const DOWNLOAD_DIR = () => path.join(app.getPath('downloads'), 'BrowserX');
function uniquePath(dir, name) {
  name = (name || 'download').replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 1; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}
// 右侧网页的浏览器身份（User-Agent）：去掉 Electron 默认加的「Electron/x.y」「BrowserX/x.y」，跟真 Chrome 一样。
// 有的网站（Akamai 这类防爬虫）看到这两个标记就当成自动化程序直接拦（实测永明）。内核本来就是同版本的 Chromium，报 Chrome 是实话
function useChromeIdentity() {
  const ses = session.fromPartition('persist:browser');
  const ua = ses.getUserAgent().replace(/\s+(Electron|BrowserX|browserx|claude-browser)\/\S+/gi, '');
  ses.setUserAgent(ua);
  // 改了 User-Agent 以后，打开网页（主文档、iframe）的请求不再带 sec-ch-ua 这组请求头（页面里的 fetch 由 agent.applyIdentity 补上了）。
  // 真 Chrome 访问 https 时默认都会带这三个，没有反而像自动化程序：缺了就补上，有了不动
  const major = process.versions.chrome.split('.')[0];
  const ch = {
    'sec-ch-ua': `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not:A-Brand";v="8"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'}"`,
  };
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (d, cb) => {
    const h = d.requestHeaders;
    if (d.resourceType === 'mainFrame' || d.resourceType === 'subFrame') {
      const has = new Set(Object.keys(h).map((k) => k.toLowerCase()));
      for (const [k, v] of Object.entries(ch)) if (!has.has(k)) h[k] = v;
    }
    cb({ requestHeaders: h });
  });
  return ua;
}

function watchDownloads() {
  session.fromPartition('persist:browser').on('will-download', (_e, item, wc) => {
    const t = [...tabs.values()].find((x) => x.pages.some((p) => p.view.webContents === wc)) || cur;
    fs.mkdirSync(DOWNLOAD_DIR(), { recursive: true });
    const file = uniquePath(DOWNLOAD_DIR(), item.getFilename());
    item.setSavePath(file);
    const url = item.getURL();
    t?.agent.downloadStarted({ file, url });
    item.once('done', (_ev, state) => t?.agent.downloadDone({ file, url, state, bytes: item.getReceivedBytes() }));
  });
}

// 定时运行工具（见 scheduler.js）：到点后在后台的「定时任务」对话里直接调工具（不经过模型、不花 token），跑完发系统通知，点通知切到那个对话
let schedTabId = null;
async function runScheduled(task) {
  let t = tabs.get(schedTabId);
  if (!t) {
    if (tabs.size >= MAX_TABS) throw Object.assign(new Error(`左侧标签已满（最多 ${MAX_TABS} 个），关掉一个才能运行定时任务`), { retry: true });
    t = createTab('about:blank');
    schedTabId = t.id;
  }
  if (t.agent._toolRunning || t.agent.running || t.agent.making) throw Object.assign(new Error('「定时任务」对话正忙'), { retry: true }); // 下一轮再试
  if (!t.agent.listCustomTools().some((x) => x.name === task.tool)) throw new Error(`工具箱里没有 ${task.tool} 了（可能被删了）`);
  const emit = (ev) => send('agent', { ...ev, tab: t.id });
  emit({ type: 'sched', phase: 'start', title: task.title });
  let ok = true, text;
  try { text = await t.agent.runCustomTool(task.tool, task.args || {}); }
  catch (e) { ok = false; text = e.message; }
  emit({ type: 'sched', phase: 'done', title: task.title, ok, text });
  if (Notification.isSupported()) {
    const n = new Notification({ title: `定时任务${ok ? '完成' : '失败'}：${task.title}`, body: String(text).replace(/\s+/g, ' ').slice(0, 120), silent: ok });
    n.on('click', () => { if (win) { win.show(); win.focus(); } if (tabs.has(t.id)) switchTab(t.id); });
    n.show();
  }
  if (!ok) throw new Error(text);
  return text;
}
const scheduler = new Scheduler({
  file: () => path.join(app.getPath('userData'), 'schedules.json'),
  run: runScheduled,
  onChange: (list) => send('schedules', list),
});

app.whenReady().then(async () => {
  useChromeIdentity(); // 要在建第一个网页标签之前
  watchDownloads();
  buildMenu();
  updater.start();
  // 市场工具更新：启动 40 秒后查一次，之后每 4 小时（没登录就跳过）
  setTimeout(() => checkToolUpdates({ auto: true }).catch((e) => console.error('检查工具更新失败', e.message)), 40 * 1000);
  setInterval(() => checkToolUpdates({ auto: true }).catch(() => {}), 4 * 3600 * 1000);
  // npm start 直接跑时 Dock 显示的是 Electron 默认图标；打包后 electron-builder 会用 build/icon.png 生成正式图标
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(__dirname, 'build', 'icon.png'));
  cfg = loadCfg();
  loadUiLang();
  buildMenu(); // 有了设置（语言）再按它重建一次菜单
  cfg.permissionMode = 'bypassPermissions'; // 每次启动都从「全部允许」开始（等同 claude --dangerously-skip-permissions），会话中可以在界面上切换
  encryptMarketTools();
  await migrateWorkDir();
  fs.mkdirSync(cfg.cwd, { recursive: true });
  createWindow();
  if (process.env.CB_ACCOUNT_TOKEN) accountToken = process.env.CB_ACCOUNT_TOKEN; // 测试用：不走浏览器授权，直接用给定的 token（配合 CB_PORTAL / CB_USER_DATA）
  account.refresh().catch(() => {}); // 上次登录过：拉一下账号和授权状态（网络不通就先显示上次的登录状态）
  scheduler.start(); // 窗口和第一个标签都有了再开始（定时任务要在后台开一个对话）
});
app.on('window-all-closed', () => app.quit());

// ---------------------------------------------------------------- IPC

const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => {
  // url / needLogin：账号接口的错误带上网站地址（去购买、开通会员）或「要先登录」，界面据此给按钮
  try { return { ok: true, data: await fn(...a) }; } catch (e) { return { ok: false, error: e.message, url: e.url, label: e.label, quota: e.quota, needLogin: e.needLogin }; }
});

// 渲染进程告知浏览器区域位置。拖动分隔条时传 0 大小只是把前台视图藏起来，后台标签保持原大小（助手可能正在截图）
handle('bounds', (r) => {
  const b = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  if (!b.width || !b.height) { cur?.view.setBounds(b); return; }
  stageBounds = b;
  for (const t of tabs.values()) for (const p of t.pages) p.view.setBounds(b);
});
handle('nav:state', () => navState());
// 地址栏 / 前进后退 / 刷新也算用户在操作网页：制作工具时自动开始录制（见 Agent.autoRecord）
handle('nav:go', (s) => { cur.agent.autoRecord(); return cur.view.webContents.loadURL(toUrl(s)).catch(() => {}); });
handle('nav:back', () => { cur.agent.autoRecord(); cur.view.webContents.navigationHistory.goBack(); });
handle('nav:forward', () => { cur.agent.autoRecord(); cur.view.webContents.navigationHistory.goForward(); });
handle('nav:reload', () => { cur.agent.autoRecord(); cur.view.webContents.reload(); });
handle('nav:stop', () => cur.view.webContents.stop());
// 右侧浏览器上方的网页标签条
handle('pages:switch', (index) => activatePage(cur, pageAt(cur, index)));
handle('pages:close', (index) => pagesApi(cur).close(index));
handle('pages:new', () => { cur.agent.autoRecord(); addPage(cur, { url: 'about:blank' }); });
handle('schedules:list', () => scheduler.list());
handle('schedules:add', (task) => scheduler.add(task));
handle('schedules:update', (id, patch) => scheduler.update(id, patch));
handle('schedules:remove', (id) => scheduler.remove(id));
handle('schedules:history', (id) => scheduler.history(id)); // 执行情况：最近 50 次运行
handle('schedules:runNow', (id) => { const t = scheduler.tasks.find((x) => x.id === id); if (!t) throw new Error('定时任务不存在'); scheduler.runTask(t).catch(() => {}); });
handle('downloads:show', (file) => { if (String(file).startsWith(DOWNLOAD_DIR() + path.sep)) shell.showItemInFolder(file); }); // 只能打开下载文件夹里的文件
// 收藏夹：<userData>/bookmarks.json，[{ url, title, added }]，所有标签共用，新收藏放最前面
const BM_FILE = () => path.join(app.getPath('userData'), 'bookmarks.json');
const readBookmarks = () => { try { return JSON.parse(fs.readFileSync(BM_FILE(), 'utf8')); } catch { return []; } };
const writeBookmarks = (list) => { fs.writeFileSync(BM_FILE(), JSON.stringify(list, null, 1)); return list; };
handle('bookmarks:list', () => readBookmarks());
handle('bookmarks:add', (url, title) => {
  if (!/^https?:\/\//i.test(url)) throw new Error('只能收藏网页地址');
  const list = readBookmarks().filter((b) => b.url !== url);
  return writeBookmarks([{ url, title: String(title || url).slice(0, 80), added: Date.now() }, ...list].slice(0, 200));
});
handle('bookmarks:remove', (url) => writeBookmarks(readBookmarks().filter((b) => b.url !== url)));

handle('tabs:list', () => tabList());
handle('tab:new', () => createTab().id);
handle('tab:switch', (id) => switchTab(id));
handle('tab:close', (id) => closeTab(id));
// 某条历史对话已经在哪个标签里打开了（同一个会话不能两个标签同时续写）
handle('tabs:find', (sessionId) => [...tabs.values()].find((t) => t.agent.sessionId === sessionId)?.id ?? null);
handle('win:fullscreen', () => win.setFullScreen(!win.isFullScreen()));

handle('cfg:get', () => cfg);
handle('i18n:get', () => ({ lang: replyLang(), dict: uiDict }));
handle('app:showSettings', () => SHOW_SETTINGS);
handle('cfg:set', (c) => {
  const same = (k) => JSON.stringify(c[k]) === JSON.stringify(cfg[k]);
  // 密钥、地址、工作目录变化后开始新会话；换模型不用重开
  const restart = ['apiKey', 'baseUrl', 'cwd'].some((k) => k in c && !same(k));
  const modelChanged = 'model' in c && c.model !== cfg.model;
  cfg = { ...cfg, ...c };
  saveCfg();
  if ('replyLang' in c) { loadUiLang(); buildMenu(); send('i18n', { lang: replyLang(), dict: uiDict }); reloadHelp(); } // 菜单、界面跟着换语言
  for (const { agent } of tabs.values()) {
    if ('permissionMode' in c) agent.setPermissionMode(cfg.permissionMode);
    if (modelChanged && !restart) agent.setModel(cfg.model);
    if (restart && agent.q) agent.reset();
  }
  return cfg;
});
handle('cwd:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: cfg.cwd });
  if (r.canceled || !r.filePaths[0]) return cfg.cwd;
  if (r.filePaths[0] !== cfg.cwd) {
    cfg.cwd = r.filePaths[0];
    saveCfg();
    for (const { agent } of tabs.values()) if (agent.q) agent.reset();
  }
  return cfg.cwd;
});

// 对话相关的调用都带上标签 id（不带就是当前标签）：后台标签的批准 / 回答 / 运行结果不能落到别的标签上
handle('agent:send', (text, tab) => tabOf(tab).agent.userSend(text)); // 用户发的消息：制作工具期间会记进制作记录
handle('agent:stop', (tab) => tabOf(tab).agent.stop());
handle('agent:reset', (tab) => tabOf(tab).agent.reset());
handle('agent:clear', (tab) => tabOf(tab).agent.clear());
handle('agent:permit', (id, decision, tab) => tabOf(tab).agent.permit(id, decision));
handle('agent:answer', (id, result, tab) => tabOf(tab).agent.answer(id, result));
// 右侧浏览器是独立的 WebContentsView，原生输入焦点可能还停在它上面；
// 光靠渲染进程里 textarea.focus() 只改 DOM 内部状态，改不了原生焦点，要显式把根 webContents 切回来
handle('win:focus', () => win.webContents.focus());

handle('history:list', () => cur.agent.listHistory());
handle('history:resume', (id, tab) => tabOf(tab).agent.resume(id));
handle('history:rename', (id, title) => cur.agent.renameHistory(id, title));
handle('history:delete', (id) => cur.agent.deleteHistory(id));
// 清空历史：全部删掉，包括左边正开着的对话。正开着的先结束会话（背后的 claude 进程还在写记录，不先关掉删了会被写回来），
// 聊天内容留在界面上，下一条消息开始新对话。有对话正在回复 / 工具正在跑：不清，让用户等它结束
handle('history:clear', async () => {
  const busy = [...tabs.values()].filter((t) => t.agent.running || t.agent._toolRunning);
  if (busy.length) throw new Error('有对话正在进行（助手在回复或工具在运行），等它结束再清空');
  if (makingTab()) throw new Error('正在制作 / 修改工具，先保存或点「不做了」再清空');
  for (const t of tabs.values()) if (t.agent.q || t.agent.sessionId) t.agent.reset();
  await new Promise((r) => setTimeout(r, 800)); // 等 claude 进程把最后的记录写完退出
  return cur.agent.clearHistory((f) => shell.trashItem(f));
});
handle('history:prune', () => cur.agent.pruneHistory()); // 打开历史时顺手把超过 30 条的旧记录删掉

// fromMarket：从插件市场下载安装的（包括自己发布后又装回来的），工具箱里不显示「发布」
handle('tools:list', () => { const inst = readInstalled(); return cur.agent.listCustomTools().map((t) => ({ ...t, market: isMarketTool(t.name), fromMarket: !!inst[t.name] })); });
handle('tools:run', (name, args, tab) => tabOf(tab).agent.runCustomTool(name, args));
handle('tools:form', (name) => cur.agent.toolFormUrl(name));
handle('tools:formSpec', (name, values, tab) => tabOf(tab).agent.toolFormSpec(name, values));
handle('tools:stop', (tab) => tabOf(tab).agent.stopTool());
handle('view:cover', (on) => { covered = !!on; syncViewVisible(); });

// 制作工具模式（见 agent.js startMaking/finishMaking）。同一时间只有一个标签在制作，横幅上的按钮都作用在那个标签上
handle('making:state', (tab) => tabOf(tab).agent.makingState());
handle('making:start', (opts) => cur.agent.startMaking(opts));
handle('making:draft', () => (makingTab() || cur).agent.describeDraft());
handle('making:run', (args) => (makingTab() || cur).agent.runDraft(args));
handle('making:formSpec', (values) => (makingTab() || cur).agent.draftFormSpec(values));
handle('making:log', (text) => (makingTab() || cur).agent.logMaking(String(text))); // 界面上的事记进过程记录（不发给助手）
handle('making:finish', (opts) => (makingTab() || cur).agent.finishMaking(opts));
handle('making:cancel', () => (makingTab() || cur).agent.cancelMaking());
handle('making:continue', (name) => cur.agent.continueMaking(name));

// 单个工具导入 / 导出（见 agent.js exportInfo / importPreview / importConfirm）
handle('tools:exportCheck', (name) => {
  const { secrets } = cur.agent.exportInfo(name);
  return { secrets };
});
handle('tools:export', async (name) => {
  const { code } = cur.agent.exportInfo(name);
  const r = await dialog.showSaveDialog(win, { title: `导出工具 ${name}`, defaultPath: path.join(app.getPath('downloads'), `${name}.js`), filters: [{ name: 'BrowserX 工具', extensions: ['js'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, code);
  return r.filePath;
});
handle('tools:importPick', async () => {
  const r = await dialog.showOpenDialog(win, { title: L('导入工具'), properties: ['openFile'], filters: [{ name: L('BrowserX 工具'), extensions: ['js'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  importer = cur.agent; // 选文件和确认之间可能切了标签：确认时用同一个（待导入的内容存在它身上）
  marketPending = null;
  // 不把源代码发给界面（导入页不提供查看源代码）；代码已读进 pendingImport，确认时用
  const { code, ...preview } = importer.importPreview(r.filePaths[0]);
  return preview;
});
let importer = null;
handle('tools:importConfirm', (opts) => confirmImport(opts));
async function confirmImport(opts = {}) {
  // 从市场装别人的工具：加密保存（.bxt）；自己的工具、本地导入的照旧存明文 .js
  const r = await (importer || cur.agent).importConfirm({ ...opts, encrypt: !!marketPending && !marketPending.mine });
  // 从插件市场装的：记下版本，市场列表上显示「已安装」
  if (marketPending && marketPending.name === r.name) {
    const all = readInstalled();
    all[r.name] = { id: marketPending.id, version: marketPending.version, build: marketPending.build, sha256: marketPending.sha256, mine: marketPending.mine, at: Date.now() };
    fs.writeFileSync(INSTALLED_FILE(), JSON.stringify(all, null, 1));
  }
  else if (!marketPending) {
    const all = readInstalled(); // 用本地文件覆盖了同名的市场工具：不再算市场工具
    if (all[r.name]) { delete all[r.name]; fs.writeFileSync(INSTALLED_FILE(), JSON.stringify(all, null, 1)); }
  }
  marketPending = null;
  if (toolUpdates[r.name]) { delete toolUpdates[r.name]; send('toolUpdates', toolUpdates); } // 装的就是新版本：不再提示更新
  return r;
}

// 网络录制（界面按钮用；对话里走 rec_start/rec_stop 工具，是同一个 Recorder）
// ---------------------------------------------------------------- BrowserX 账号（见 account.js）

const account = new Account({
  getToken: () => accountToken,
  setToken: (t) => {
    const changed = (t || null) !== accountToken;
    accountToken = t || null;
    accountCheckedAt = 0; // 换了账号：下次重新确认
    saveCfg();
    // 登录 / 退出 / token 失效：没填自己 API Key 的对话要换新 token 重开（下一条消息自动重开）
    if (changed && !cfg.apiKey) for (const { agent } of tabs.values()) if (agent.q) agent.reset();
  },
  open: (url) => shell.openExternal(url),
  focus: () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); app.focus({ steal: true }); } },
  emit: (st) => send('account', st),
});
handle('account:state', () => account.state());
handle('account:login', () => account.login());
handle('account:cancel', () => account.cancel());
// 退出 BrowserX 账号：这个账号在本机记住的插件账号密码一起清掉
handle('account:logout', async () => { const key = credAccount(); await account.logout(); clearAccountCreds(key); });
handle('account:refresh', () => account.refresh());
// 邀约有礼：邀约链接 / 二维码 / 积分，积分兑换会员天数（兑换后刷新账号状态，会员到期日跟着变）
handle('invite:get', () => account.api('/invite'));
handle('invite:redeem', async (days) => {
  const r = await account.api('/invite/redeem', { method: 'POST', body: { days } });
  account.refresh().catch(() => {});
  return r;
});
handle('invite:redeemCredit', async (points) => {
  const r = await account.api('/invite/redeem-credit', { method: 'POST', body: { points } });
  account.refresh().catch(() => {}); // 账号面板的 Tokens 余额跟着变
  return r;
});
handle('invite:copy', (text) => { clipboard.writeText(String(text)); });
// 只允许用系统浏览器打开账号网站上的页面（会员中心、购买、我的工具）
handle('account:open', (url) => {
  if (!String(url).startsWith(ACCOUNT_PORTAL + '/')) throw new Error('只能打开 BrowserX 网站上的页面');
  return shell.openExternal(url);
});

// 插件市场：从市场装过的工具记在 <userData>/market-installed.json（name → { id, version, build, sha256 }），列表上据此显示「已安装 / 有更新」。
// version 是开发者填的、只用来显示；build 是网站分配的内部版本号（从 1 开始的整数），判断有没有新版本只看它
const INSTALLED_FILE = () => path.join(app.getPath('userData'), 'market-installed.json');
const readInstalled = () => { try { return JSON.parse(fs.readFileSync(INSTALLED_FILE(), 'utf8')); } catch { return {}; } };
let marketPending = null;
// 升级前从市场装的别人的工具是明文 .js：启动时转成加密的 .bxt（解密校验一致才删明文）
function encryptMarketTools() {
  for (const [name, x] of Object.entries(readInstalled())) {
    if (x.mine) continue;
    const js = path.join(TOOLS_DIR(), `${name}.js`);
    if (!fs.existsSync(js)) continue;
    try {
      const code = fs.readFileSync(js, 'utf8');
      const bxt = path.join(TOOLS_DIR(), `${name}.bxt`);
      fs.writeFileSync(bxt, vault.encrypt(name, code));
      if (vault.decrypt(name, fs.readFileSync(bxt)) !== code) throw new Error('解密校验不一致');
      fs.unlinkSync(js);
    } catch (e) { console.error(`加密市场工具 ${name} 失败：${e.message}`); }
  }
}

// 从市场装的、别人的工具：不让导出 / 编辑 / 发布（界面隐藏按钮，agent.js 的 exportInfo / startMaking 也会拦）
const isMarketTool = (name) => { const x = readInstalled()[name]; return !!x && !x.mine; }; // 正在确认安装的市场工具（确认导入成功后才记进 market-installed.json）

handle('market:meta', () => account.api('/meta'));
handle('market:list', async (params = {}) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  const r = await account.api(`/market?${q}`);
  const installed = readInstalled();
  const local = new Set(cur.agent.readCustomToolDefs().map((e) => e.def.name));
  for (const t of r.items) t.local = { exists: local.has(t.name), version: installed[t.name]?.version || null, build: installed[t.name]?.build ?? null };
  return r;
});
// 安装 = 下载代码到临时文件，再走跟「导入」一模一样的流程：静态检查 → 界面上让用户确认 → tools:importConfirm 写进工具箱
handle('market:install', async (id) => {
  const r = await account.api(`/market/${Number(id)}/download`);
  const dir = path.join(os.tmpdir(), 'browserx-market');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${r.name}.js`);
  fs.writeFileSync(file, r.code);
  importer = cur.agent;
  marketPending = { name: r.name, id: Number(id), version: r.version, build: r.build, sha256: r.sha256, mine: !!r.mine };
  // 市场工具是别人的作品：不把源代码发给界面（确认页不显示「查看源代码」）；代码已读进 pendingImport，临时文件马上删掉
  const { code, ...preview } = importer.importPreview(file);
  fs.rmSync(file, { force: true });
  return { ...preview, market: { title: r.title, version: r.version } };
});
// ---------------------------------------------------------------- 插件记住的账号密码
// 用户在插件表单上勾了「记住账号密码」：只存账号密码那几栏（其它参数不存），用 macOS 钥匙串（safeStorage）加密，
// 存在 <userData>/tool-creds.json：{ <BrowserX 账号>: { <工具 ID>: 加密后的 base64 } }。按 BrowserX 账号分开（换账号看不到），
// 没登录时记在 'local' 下。不发给模型、不进对话；删除插件、退出账号时清掉。safeStorage 不可用就不存（不落明文）
const CRED_FILE = () => path.join(app.getPath('userData'), 'tool-creds.json');
const readCreds = () => { try { return JSON.parse(fs.readFileSync(CRED_FILE(), 'utf8')); } catch { return {}; } };
const writeCreds = (all) => fs.writeFileSync(CRED_FILE(), JSON.stringify(all, null, 1), { mode: 0o600 });
const credAccount = () => { const st = account.state(); return (st?.loggedIn && (st.user?.email || st.user?.name)) || 'local'; };
function clearToolCreds(tool) {
  const all = readCreds();
  let changed = false;
  for (const acc of Object.keys(all)) if (all[acc][tool]) { delete all[acc][tool]; changed = true; }
  if (changed) writeCreds(all);
}
function clearAccountCreds(acc) {
  const all = readCreds();
  if (all[acc]) { delete all[acc]; writeCreds(all); }
}
handle('creds:get', (tool) => {
  const enc = readCreds()[credAccount()]?.[String(tool)];
  if (!enc || !safeStorage.isEncryptionAvailable()) return null;
  try { return JSON.parse(safeStorage.decryptString(Buffer.from(enc, 'base64'))); } catch { return null; }
});
handle('creds:set', (tool, values) => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('这台电脑上没法加密保存（钥匙串不可用），没有记住账号密码');
  const clean = Object.fromEntries(Object.entries(values || {}).filter(([, v]) => typeof v === 'string' && v !== '').map(([k, v]) => [k, v.slice(0, 500)]));
  const all = readCreds();
  const acc = credAccount();
  all[acc] ||= {};
  if (Object.keys(clean).length) all[acc][String(tool)] = safeStorage.encryptString(JSON.stringify(clean)).toString('base64');
  else delete all[acc][String(tool)];
  writeCreds(all);
  return true;
});
handle('creds:clear', (tool) => {
  const all = readCreds();
  const acc = credAccount();
  if (all[acc]?.[String(tool)]) { delete all[acc][String(tool)]; writeCreds(all); }
  return true;
});

// ---------------------------------------------------------------- 工具更新
// 从市场装过的工具，作者发了新版本、管理员审核通过后：启动 40 秒后和每 4 小时问一次网站（market/updates），
// 工具箱里显示「有新版本」+「更新」按钮。开着「自动更新工具」时直接装上，但新版本比旧版本多用了敏感能力
// （scanRisks 多出新的一类，比如开始读 cookie / 读写本机文件）就不自动装，留给用户点「更新」走跟安装一样的确认页
let toolUpdates = {}; // name → { id, version, from, changelog, can_install, reason, needsConfirm? }
const riskSet = (code) => new Set(scanRisks(code).map((r) => r.label));
function installedCode(name) {
  const js = path.join(TOOLS_DIR(), `${name}.js`), bxt = path.join(TOOLS_DIR(), `${name}.bxt`);
  if (fs.existsSync(bxt)) return vault.decrypt(name, fs.readFileSync(bxt));
  if (fs.existsSync(js)) return fs.readFileSync(js, 'utf8');
  return null;
}
async function checkToolUpdates({ auto = false } = {}) {
  if (!accountToken) return toolUpdates;
  const installed = readInstalled();
  // 按内部版本号 build 比（网站上每个工具从 1 开始、每个新版本 +1）；旧记录没有 build 的发 version，网站换算成 build
  const tools = Object.values(installed).filter((x) => x.id).map((x) => (Number.isInteger(x.build) ? { id: x.id, build: x.build } : { id: x.id, version: x.version || '' }));
  if (!tools.length) { toolUpdates = {}; send('toolUpdates', toolUpdates); return toolUpdates; }
  const r = await account.api('/market/updates', { method: 'POST', body: { tools } });
  const next = {};
  for (const u of r.updates || []) if (installed[u.name]?.id === u.id) next[u.name] = { ...u, needsConfirm: toolUpdates[u.name]?.needsConfirm };
  toolUpdates = next;
  send('toolUpdates', toolUpdates);
  if (auto && cfg.autoUpdateTools !== false) {
    for (const name of Object.keys(toolUpdates)) {
      const u = toolUpdates[name];
      if (!u.can_install || u.needsConfirm) continue;
      try { await updateMarketTool(name, { auto: true }); } catch (e) { console.error(`自动更新工具 ${name} 失败：${e.message}`); }
    }
  }
  return toolUpdates;
}
// 装新版本。auto：自动更新（敏感能力变多就不装，标 needsConfirm）；手动点「更新」时敏感能力变多返回 { needsConfirm }，界面改走安装确认页
async function updateMarketTool(name, { auto = false } = {}) {
  const u = toolUpdates[name];
  if (!u) throw new Error(`工具 ${name} 没有可用的更新`);
  if (!u.can_install) throw new Error(u.reason || '现在不能更新这个工具');
  if (makingTab()?.agent.making?.name === name) throw new Error(`正在修改工具 ${name}，先保存或退出修改再更新`);
  const r = await account.api(`/market/${Number(u.id)}/download`);
  const old = installedCode(name);
  const added = old == null ? [] : [...riskSet(r.code)].filter((x) => !riskSet(old).has(x));
  if (added.length) {
    toolUpdates[name] = { ...u, needsConfirm: true, addedRisks: added };
    send('toolUpdates', toolUpdates);
    if (auto) return { needsConfirm: true };
    return { needsConfirm: true, added };
  }
  const dir = path.join(os.tmpdir(), 'browserx-market');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${r.name}.js`);
  fs.writeFileSync(file, r.code);
  const agent = cur.agent;
  importer = agent;
  marketPending = { name: r.name, id: Number(u.id), version: r.version, build: r.build, sha256: r.sha256, mine: !!r.mine };
  try { agent.importPreview(file); } finally { fs.rmSync(file, { force: true }); }
  await confirmImport({ overwrite: true, quiet: true });
  const title = u.title ? `${u.title}（${name}）` : name;
  agent.ctx.emit({ type: 'note', text: `— 工具 ${title} 已${auto ? '自动' : ''}更新到 ${r.version}${u.changelog ? `：${String(u.changelog).slice(0, 200)}` : ''} —` });
  return { ok: true, version: r.version };
}
handle('tools:updates', () => toolUpdates);
handle('tools:checkUpdates', () => checkToolUpdates({ auto: false }));
handle('tools:update', (name) => updateMarketTool(String(name)));
handle('tools:autoUpdate', (on) => { cfg.autoUpdateTools = !!on; saveCfg(); if (on) checkToolUpdates({ auto: true }).catch(() => {}); return cfg.autoUpdateTools; });

// 购买付费工具：网站建 Stripe 付款页，用系统浏览器打开（不用另外登录网站）；付款状态由界面轮询 market:purchase
handle('market:buy', async (id) => {
  const r = await account.api(`/market/${Number(id)}/checkout`, { method: 'POST' });
  await shell.openExternal(r.url);
  return true;
});
handle('market:purchase', (id) => account.api(`/market/${Number(id)}/purchase`));

// 删除本地工具：文件移到废纸篓（可以从废纸篓恢复），所有标签正在进行的对话里也去掉这个工具
handle('tools:delete', async (name) => {
  if (makingTab()?.agent.making.name === name) throw new Error(`正在修改工具 ${name}，先点横幅上的「完成制作 / 保存工具」或「退出」`);
  const files = cur.agent.toolFiles(name);
  for (const f of files) await shell.trashItem(f);
  vault.remove(name); // 加密工具的密钥一起删（废纸篓里的 .bxt 就打不开了，要用请重新从市场安装）
  clearToolCreds(name); // 记住的账号密码也删
  const installed = readInstalled();
  if (installed[name]) { delete installed[name]; fs.writeFileSync(INSTALLED_FILE(), JSON.stringify(installed, null, 1)); }
  for (const t of tabs.values()) t.agent.reloadCustomTools();
  return { files: files.length };
});

// 发布：读工具箱里的文件，连同表单发到网站「我的工具」（新工具或新版本，进入审核）
handle('market:publishInfo', async (name) => {
  const { secrets } = cur.agent.exportInfo(name);
  const [mine, meta] = await Promise.all([account.api('/my-tools'), account.api('/meta')]);
  // developer：有没有开发者认证（网站后台管理员开通；没开通不能发布）
  return { secrets, remote: mine.find((t) => t.name === name) || null, meta, developer: meta.can_publish !== false };
});
handle('market:publish', async (name, form) => {
  const { code, secrets } = cur.agent.exportInfo(name);
  // 写死了用户名 / 密码 / token：不发（网站那边也会拒绝），说清楚是哪几行
  const bad = secrets.filter((x) => BLOCKING_SECRETS.has(x.label));
  if (bad.length) throw new Error(`代码里不能写死用户名、密码、token 之类的账号信息：${bad.map((x) => `${x.label}（第 ${x.lines.join('、')} 行）`).join('；')}。先点「编辑」让助手改成运行时读取，再发布。`);
  return account.api('/my-tools', { method: 'POST', body: { ...form, code } });
});

// 录制按钮在浏览器工具栏上，作用在当前标签；每个标签有自己的 Recorder
handle('rec:status', () => cur.agent.rec.status());
handle('rec:start', (opts) => cur.agent.rec.start(opts));
handle('rec:mark', (label) => cur.agent.rec.mark(label));
handle('rec:stop', () => cur.agent.rec.stop());
handle('making:recStop', (tab) => tabOf(tab).agent.finishMakingRec()); // 制作工具时点「停止录制」：停录制 + 结果交给助手
