const { app, BrowserWindow, WebContentsView, ipcMain, dialog, safeStorage, Menu, shell, webFrameMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('./agent');
const { Account, PORTAL: ACCOUNT_PORTAL } = require('./account');
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
// 工具市场里别人的工具加密保存，密钥存这里（见 toolcrypt.js）
const vault = new ToolVault(() => path.join(app.getPath('userData'), 'tool-keys.json'));
const RECON_DIR = () => path.join(app.getPath('userData'), 'recon');
const DEFAULTS = {
  apiKey: '', baseUrl: '', model: 'claude-sonnet-5', cwd: os.homedir(), permissionMode: 'bypassPermissions', home: 'https://www.xingke888.com',
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

const send = (ch, v) => win?.webContents.send(ch, v);

// 右侧页面主框架加载失败时的错误存在各标签的 navError 上（Electron 的错误页是一片空白，交给界面显示说明，见 renderer.js renderNavError）
let covered = false; // 界面弹窗打开时暂时藏起原生视图（它总是盖在 DOM 上面，居中的弹窗会被挡住）
const syncViewVisible = () => { for (const t of tabs.values()) t.view.setVisible(t === cur && !t.navError && !covered); };

function navState(t = cur) {
  const wc = t.view.webContents;
  return { url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(),
    canBack: wc.navigationHistory.canGoBack(), canForward: wc.navigationHistory.canGoForward(), error: t.navError };
}

const tabList = () => [...tabs.values()].map((t) => ({ id: t.id, title: t.view.webContents.getTitle(), url: t.view.webContents.getURL(), current: t === cur }));
const sendTabs = () => send('tabs', tabList());
const tabOf = (id) => (id && tabs.get(id)) || cur;
const makingTab = () => [...tabs.values()].find((t) => t.agent.making);

function createTab(url = cfg.home) {
  if (tabs.size >= MAX_TABS) throw new Error(`最多开 ${MAX_TABS} 个标签，先关掉一些`);
  const id = ++tabSeq;
  // backgroundThrottling 关掉：藏起来的标签里，页面计时器和助手的操作照常跑
  const view = new WebContentsView({ webPreferences: { partition: 'persist:browser', backgroundThrottling: false } }); // 记住登录状态（所有标签共用）
  const t = { id, view, navError: null };
  win.contentView.addChildView(view);
  if (stageBounds) view.setBounds(stageBounds);
  view.setVisible(false);
  const wc = view.webContents;
  // 主框架加载失败：先把原生视图藏起来，露出下面 #stage 里的说明（否则只看到空白）；
  // 下一次成功导航（did-navigate 只在非错误页时触发）再显示回来。-3 ERR_ABORTED 是被新导航打断，不算失败
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    t.navError = { code, desc, url };
    syncViewVisible();
  });
  wc.on('did-navigate', () => {
    t.navError = null;
    syncViewVisible();
  });
  for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading', 'did-fail-load']) {
    wc.on(ev, () => { if (t === cur) send('nav', navState()); });
  }
  for (const ev of ['did-navigate', 'page-title-updated']) wc.on(ev, sendTabs);
  // 焦点在右侧网页里时，标签快捷键（⌘T / ⌘W / ⌘1…9 / ⌘⇧[ ]）也要能用：拦下来转给界面处理
  wc.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown' || !i.meta || i.alt || i.control) return;
    if ((!i.shift && /^([tw1-9])$/.test(i.key)) || (i.shift && /^Bracket(Left|Right)$/.test(i.code))) {
      e.preventDefault();
      send('tabkey', { key: i.key, code: i.code, shift: i.shift });
    }
  });
  // 新窗口链接在本标签的视图里打开（标签和对话一一对应，不凭空多出没有对话的标签）
  wc.setWindowOpenHandler(({ url }) => { wc.loadURL(url); return { action: 'deny' }; });
  wc.loadURL(url).catch(() => {});

  t.agent = new Agent({
    webContents: wc,
    vault,
    show: async () => {},
    getCfg: () => cfg,
    getToolsDir: TOOLS_DIR,
    getReconDir: RECON_DIR,
    emit: (ev) => send('agent', { ...ev, tab: id }),
    // 制作工具模式同一时间只允许一个标签（草稿、工具目录是共用的）
    otherMaking: () => [...tabs.values()].find((x) => x !== t && x.agent.making)?.agent.making.name,
    // 工具箱有变化（制作完成、导入）：其它标签正在进行的对话也重新加载工具
    toolsChanged: () => { for (const x of tabs.values()) if (x !== t) x.agent.reloadCustomTools(); },
    isMarketTool: (name) => isMarketTool(name),
  });
  tabs.set(id, t);
  sendTabs();
  return t;
}

function switchTab(id) {
  const t = tabs.get(id);
  if (!t) throw new Error('标签不存在');
  cur = t;
  syncViewVisible();
  send('nav', navState());
  sendTabs();
  return id;
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return cur?.id;
  if (tabs.size === 1) throw new Error('至少要留一个标签');
  if (t.agent.making) throw new Error(`这个标签正在制作工具 ${t.agent.making.name}，先点横幅上的「完成」或「放弃」`);
  try { if (t.agent.rec.active) t.agent.rec.save(); } catch {}
  t.agent.stopTool();
  t.agent.reset();
  const ids = [...tabs.keys()];
  const i = ids.indexOf(id);
  tabs.delete(id);
  win.contentView.removeChildView(t.view);
  t.view.webContents.close();
  if (cur === t) switchTab(ids[i + 1] ?? ids[i - 1]);
  else sendTabs();
  return cur.id;
}

// 地址栏输入：网址直接打开，其它当作搜索
function toUrl(s) {
  s = s.trim();
  if (/^https?:\/\//i.test(s)) return s;
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

// 应用菜单：替换 Electron 默认菜单（默认的「帮助」里全是 Electron 官网 / 文档 / 社区链接）。
// 编辑 / 显示 / 窗口 用系统角色保留：复制粘贴（⌘C/⌘V）、刷新界面（⌘R）等快捷键靠它们
// 使用说明 / 软件特色：一个独立窗口（help.html），hash 跳到对应部分；已打开就复用
let helpWin = null;
function openHelp(section) {
  const opts = { query: { v: require('./package.json').version }, hash: section };
  if (helpWin && !helpWin.isDestroyed()) {
    helpWin.loadFile(path.join(__dirname, 'help.html'), opts);
    helpWin.show();
    helpWin.focus();
    return;
  }
  helpWin = new BrowserWindow({ width: 820, height: 760, minWidth: 480, minHeight: 400, title: 'BrowserX 使用说明', webPreferences: { sandbox: true } });
  helpWin.setMenuBarVisibility(false);
  // 说明页里的外部链接用系统浏览器打开，不在说明窗口里跳走
  helpWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  helpWin.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); } });
  helpWin.on('closed', () => { helpWin = null; });
  helpWin.loadFile(path.join(__dirname, 'help.html'), opts);
}

function buildMenu() {
  const openInView = (url) => cur?.view.webContents.loadURL(url).catch(() => {});
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: 'BrowserX',
      submenu: [
        { role: 'about', label: '关于 BrowserX' },
        { type: 'separator' },
        // 左侧栏收起时设置面板在隐藏的左栏里，看不到：先展开左栏再打开设置
        { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => { win?.show(); win?.webContents.executeJavaScript("document.body.classList.contains('side-collapsed') && $('sideToggle').click(); $('settings').hidden && $('btnSettings').click()").catch(() => {}); } },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 BrowserX' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出 BrowserX' },
      ],
    }] : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '拷贝' }, { role: 'paste', label: '粘贴' },
        { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' }, { role: 'delete', label: '删除' }, { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '显示',
      submenu: [
        { role: 'reload', label: '刷新界面' }, { role: 'forceReload', label: '强制刷新界面' }, { role: 'toggleDevTools', label: '界面开发者工具' },
        // 右侧网页的开发者工具（原来在浏览器工具栏上，那个位置换成了收藏夹按钮）
        { label: '网页开发者工具', accelerator: 'Alt+CmdOrCtrl+I', click: () => cur?.view.webContents.toggleDevTools() },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    { role: 'windowMenu', label: '窗口' },
    {
      role: 'help',
      label: '帮助',
      submenu: [
        { label: '使用说明', click: () => openHelp('guide') },
        { label: '软件特色', click: () => openHelp('features') },
        { label: `版本 ${require('./package.json').version}`, enabled: false },
        { type: 'separator' },
        { label: '打开门户网站', click: () => openInView(PORTAL) },
        { label: '在系统浏览器打开门户网站', click: () => shell.openExternal(PORTAL) },
        { type: 'separator' },
        { label: '打开工具箱文件夹', click: () => shell.openPath(TOOLS_DIR()) },
        { label: '打开录制文件夹', click: () => { fs.mkdirSync(RECON_DIR(), { recursive: true }); shell.openPath(RECON_DIR()); } },
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

app.whenReady().then(() => {
  buildMenu();
  // npm start 直接跑时 Dock 显示的是 Electron 默认图标；打包后 electron-builder 会用 build/icon.png 生成正式图标
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(__dirname, 'build', 'icon.png'));
  cfg = loadCfg();
  cfg.permissionMode = 'bypassPermissions'; // 每次启动都从「全部允许」开始（等同 claude --dangerously-skip-permissions），会话中可以在界面上切换
  encryptMarketTools();
  createWindow();
  if (process.env.CB_ACCOUNT_TOKEN) accountToken = process.env.CB_ACCOUNT_TOKEN; // 测试用：不走浏览器授权，直接用给定的 token（配合 CB_PORTAL / CB_USER_DATA）
  account.refresh().catch(() => {}); // 上次登录过：拉一下账号和授权状态（网络不通就先显示上次的登录状态）
});
app.on('window-all-closed', () => app.quit());

// ---------------------------------------------------------------- IPC

const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => {
  // url / needLogin：账号接口的错误带上网站地址（去购买、开通会员）或「要先登录」，界面据此给按钮
  try { return { ok: true, data: await fn(...a) }; } catch (e) { return { ok: false, error: e.message, url: e.url, needLogin: e.needLogin }; }
});

// 渲染进程告知浏览器区域位置。拖动分隔条时传 0 大小只是把前台视图藏起来，后台标签保持原大小（助手可能正在截图）
handle('bounds', (r) => {
  const b = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  if (!b.width || !b.height) { cur?.view.setBounds(b); return; }
  stageBounds = b;
  for (const t of tabs.values()) t.view.setBounds(b);
});
handle('nav:state', () => navState());
handle('nav:go', (s) => cur.view.webContents.loadURL(toUrl(s)).catch(() => {}));
handle('nav:back', () => cur.view.webContents.navigationHistory.goBack());
handle('nav:forward', () => cur.view.webContents.navigationHistory.goForward());
handle('nav:reload', () => cur.view.webContents.reload());
handle('nav:stop', () => cur.view.webContents.stop());
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
handle('cfg:set', (c) => {
  const same = (k) => JSON.stringify(c[k]) === JSON.stringify(cfg[k]);
  // 密钥、地址、工作目录变化后开始新会话；换模型不用重开
  const restart = ['apiKey', 'baseUrl', 'cwd'].some((k) => k in c && !same(k));
  const modelChanged = 'model' in c && c.model !== cfg.model;
  cfg = { ...cfg, ...c };
  saveCfg();
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
handle('agent:permit', (id, decision, tab) => tabOf(tab).agent.permit(id, decision));
handle('agent:answer', (id, result, tab) => tabOf(tab).agent.answer(id, result));
// 右侧浏览器是独立的 WebContentsView，原生输入焦点可能还停在它上面；
// 光靠渲染进程里 textarea.focus() 只改 DOM 内部状态，改不了原生焦点，要显式把根 webContents 切回来
handle('win:focus', () => win.webContents.focus());

handle('history:list', () => cur.agent.listHistory());
handle('history:resume', (id, tab) => tabOf(tab).agent.resume(id));
handle('history:rename', (id, title) => cur.agent.renameHistory(id, title));
handle('history:delete', (id) => cur.agent.deleteHistory(id));

handle('tools:list', () => cur.agent.listCustomTools().map((t) => ({ ...t, market: isMarketTool(t.name) })));
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
  const r = await dialog.showOpenDialog(win, { title: '导入工具', properties: ['openFile'], filters: [{ name: 'BrowserX 工具', extensions: ['js'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  importer = cur.agent; // 选文件和确认之间可能切了标签：确认时用同一个（待导入的内容存在它身上）
  marketPending = null;
  return importer.importPreview(r.filePaths[0]);
});
let importer = null;
handle('tools:importConfirm', async (opts) => {
  // 从市场装别人的工具：加密保存（.bxt）；自己的工具、本地导入的照旧存明文 .js
  const r = await (importer || cur.agent).importConfirm({ ...opts, encrypt: !!marketPending && !marketPending.mine });
  // 从工具市场装的：记下版本，市场列表上显示「已安装」
  if (marketPending && marketPending.name === r.name) {
    const all = readInstalled();
    all[r.name] = { id: marketPending.id, version: marketPending.version, sha256: marketPending.sha256, mine: marketPending.mine, at: Date.now() };
    fs.writeFileSync(INSTALLED_FILE(), JSON.stringify(all, null, 1));
  }
  else if (!marketPending) {
    const all = readInstalled(); // 用本地文件覆盖了同名的市场工具：不再算市场工具
    if (all[r.name]) { delete all[r.name]; fs.writeFileSync(INSTALLED_FILE(), JSON.stringify(all, null, 1)); }
  }
  marketPending = null;
  return r;
});

// 网络录制（界面按钮用；对话里走 rec_start/rec_stop 工具，是同一个 Recorder）
// ---------------------------------------------------------------- BrowserX 账号（见 account.js）

const account = new Account({
  getToken: () => accountToken,
  setToken: (t) => { accountToken = t || null; saveCfg(); },
  open: (url) => shell.openExternal(url),
  focus: () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); app.focus({ steal: true }); } },
  emit: (st) => send('account', st),
});
handle('account:state', () => account.state());
handle('account:login', () => account.login());
handle('account:cancel', () => account.cancel());
handle('account:logout', () => account.logout());
handle('account:refresh', () => account.refresh());
// 只允许用系统浏览器打开账号网站上的页面（会员中心、购买、我的工具）
handle('account:open', (url) => {
  if (!String(url).startsWith(ACCOUNT_PORTAL + '/')) throw new Error('只能打开 BrowserX 网站上的页面');
  return shell.openExternal(url);
});

// 工具市场：从市场装过的工具记在 <userData>/market-installed.json（name → { id, version, sha256 }），列表上据此显示「已安装 / 有更新」
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
  for (const t of r.items) t.local = { exists: local.has(t.name), version: installed[t.name]?.version || null };
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
  marketPending = { name: r.name, id: Number(id), version: r.version, sha256: r.sha256, mine: !!r.mine };
  // 市场工具是别人的作品：不把源代码发给界面（确认页不显示「查看源代码」）；代码已读进 pendingImport，临时文件马上删掉
  const { code, ...preview } = importer.importPreview(file);
  fs.rmSync(file, { force: true });
  return { ...preview, market: { title: r.title, version: r.version } };
});
// 购买付费工具：网站建 Stripe 付款页，用系统浏览器打开（不用另外登录网站）；付款状态由界面轮询 market:purchase
handle('market:buy', async (id) => {
  const r = await account.api(`/market/${Number(id)}/checkout`, { method: 'POST' });
  await shell.openExternal(r.url);
  return true;
});
handle('market:purchase', (id) => account.api(`/market/${Number(id)}/purchase`));

// 删除本地工具：文件移到废纸篓（可以从废纸篓恢复），所有标签正在进行的对话里也去掉这个工具
handle('tools:delete', async (name) => {
  if (makingTab()?.agent.making.name === name) throw new Error(`正在修改工具 ${name}，先点横幅上的「完成」或「放弃」`);
  const files = cur.agent.toolFiles(name);
  for (const f of files) await shell.trashItem(f);
  vault.remove(name); // 加密工具的密钥一起删（废纸篓里的 .bxt 就打不开了，要用请重新从市场安装）
  const installed = readInstalled();
  if (installed[name]) { delete installed[name]; fs.writeFileSync(INSTALLED_FILE(), JSON.stringify(installed, null, 1)); }
  for (const t of tabs.values()) t.agent.reloadCustomTools();
  return { files: files.length };
});

// 发布：读工具箱里的文件，连同表单发到网站「我的工具」（新工具或新版本，进入审核）
handle('market:publishInfo', async (name) => {
  const { secrets } = cur.agent.exportInfo(name);
  const [mine, meta] = await Promise.all([account.api('/my-tools'), account.api('/meta')]);
  return { secrets, remote: mine.find((t) => t.name === name) || null, meta };
});
handle('market:publish', async (name, form) => {
  const { code } = cur.agent.exportInfo(name);
  return account.api('/my-tools', { method: 'POST', body: { ...form, code } });
});

// 录制按钮在浏览器工具栏上，作用在当前标签；每个标签有自己的 Recorder
handle('rec:status', () => cur.agent.rec.status());
handle('rec:start', (opts) => cur.agent.rec.start(opts));
handle('rec:mark', (label) => cur.agent.rec.mark(label));
handle('rec:stop', () => cur.agent.rec.stop());
