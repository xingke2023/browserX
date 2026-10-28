const { app, BrowserWindow, WebContentsView, ipcMain, dialog, safeStorage, Menu, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('./agent');

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
const RECON_DIR = () => path.join(app.getPath('userData'), 'recon');
const DEFAULTS = {
  apiKey: '', baseUrl: '', model: 'claude-sonnet-5', cwd: os.homedir(), permissionMode: 'bypassPermissions', home: 'https://www.xingke888.com',
};
let cfg, win, view, agent;

// API Key 用系统钥匙串加密后再写入配置文件
function loadCfg() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CFG_FILE(), 'utf8')); } catch {}
  if (c.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try { c.apiKey = safeStorage.decryptString(Buffer.from(c.apiKeyEnc, 'base64')); } catch { c.apiKey = ''; }
  }
  delete c.apiKeyEnc;
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
  fs.mkdirSync(path.dirname(CFG_FILE()), { recursive: true });
  fs.writeFileSync(CFG_FILE(), JSON.stringify(out, null, 2));
}

const send = (ch, v) => win?.webContents.send(ch, v);

// 右侧页面主框架加载失败时的错误（Electron 的错误页是一片空白，交给界面显示说明，见 renderer.js renderNavError）
let navError = null;
let covered = false; // 界面弹窗打开时暂时藏起原生视图（它总是盖在 DOM 上面，居中的弹窗会被挡住）
const syncViewVisible = () => view.setVisible(!navError && !covered);

function navState() {
  const wc = view.webContents;
  return { url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(),
    canBack: wc.navigationHistory.canGoBack(), canForward: wc.navigationHistory.canGoForward(), error: navError };
}

// 地址栏输入：网址直接打开，其它当作搜索
function toUrl(s) {
  s = s.trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(s) || /^localhost(:\d+)?/.test(s)) return (s.startsWith('localhost') ? 'http://' : 'https://') + s;
  return `https://www.bing.com/search?q=${encodeURIComponent(s)}`;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 1000, minWidth: 1000, minHeight: 640, title: 'BrowserX',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile('index.html');
  win.on('closed', () => app.quit());
  for (const ev of ['enter-full-screen', 'leave-full-screen']) win.on(ev, () => send('fullscreen', win.isFullScreen()));

  view = new WebContentsView({ webPreferences: { partition: 'persist:browser' } }); // 记住登录状态
  win.contentView.addChildView(view);
  const wc = view.webContents;
  // 主框架加载失败：先把原生视图藏起来，露出下面 #stage 里的说明（否则只看到空白）；
  // 下一次成功导航（did-navigate 只在非错误页时触发）再显示回来。-3 ERR_ABORTED 是被新导航打断，不算失败
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    navError = { code, desc, url };
    syncViewVisible();
  });
  wc.on('did-navigate', () => {
    navError = null;
    syncViewVisible();
  });
  for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading', 'did-fail-load']) {
    wc.on(ev, () => send('nav', navState()));
  }
  // 新窗口链接在当前视图打开
  wc.setWindowOpenHandler(({ url }) => { wc.loadURL(url); return { action: 'deny' }; });
  wc.loadURL(cfg.home);

  agent = new Agent({
    webContents: wc,
    show: async () => {},
    getCfg: () => cfg,
    getToolsDir: TOOLS_DIR,
    getReconDir: RECON_DIR,
    emit: (ev) => send('agent', ev),
  });
}

// 退出时还在录制：把已录到的内容存下来，别丢
app.on('before-quit', () => {
  try { if (agent?.rec.active) agent.rec.save(); } catch {}
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
  const openInView = (url) => view?.webContents.loadURL(url).catch(() => {});
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
  createWindow();
});
app.on('window-all-closed', () => app.quit());

// ---------------------------------------------------------------- IPC

const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => {
  try { return { ok: true, data: await fn(...a) }; } catch (e) { return { ok: false, error: e.message }; }
});

// 渲染进程告知浏览器区域位置
handle('bounds', (r) => {
  view.setBounds({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
});
handle('nav:state', () => navState());
handle('nav:go', (s) => view.webContents.loadURL(toUrl(s)).catch(() => {}));
handle('nav:back', () => view.webContents.navigationHistory.goBack());
handle('nav:forward', () => view.webContents.navigationHistory.goForward());
handle('nav:reload', () => view.webContents.reload());
handle('nav:stop', () => view.webContents.stop());
handle('nav:devtools', () => view.webContents.toggleDevTools());
handle('win:fullscreen', () => win.setFullScreen(!win.isFullScreen()));

handle('cfg:get', () => cfg);
handle('cfg:set', (c) => {
  const same = (k) => JSON.stringify(c[k]) === JSON.stringify(cfg[k]);
  // 密钥、地址、工作目录变化后开始新会话；换模型不用重开
  const restart = ['apiKey', 'baseUrl', 'cwd'].some((k) => k in c && !same(k));
  const modelChanged = 'model' in c && c.model !== cfg.model;
  cfg = { ...cfg, ...c };
  saveCfg();
  if ('permissionMode' in c) agent.setPermissionMode(cfg.permissionMode);
  if (modelChanged && !restart) agent.setModel(cfg.model);
  if (restart && agent.q) agent.reset();
  return cfg;
});
handle('cwd:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: cfg.cwd });
  if (r.canceled || !r.filePaths[0]) return cfg.cwd;
  if (r.filePaths[0] !== cfg.cwd) {
    cfg.cwd = r.filePaths[0];
    saveCfg();
    if (agent.q) agent.reset();
  }
  return cfg.cwd;
});

handle('agent:send', (text) => agent.userSend(text)); // 用户发的消息：制作工具期间会记进制作记录
handle('agent:stop', () => agent.stop());
handle('agent:reset', () => agent.reset());
handle('agent:permit', (id, decision) => agent.permit(id, decision));
handle('agent:answer', (id, result) => agent.answer(id, result));
// 右侧浏览器是独立的 WebContentsView，原生输入焦点可能还停在它上面；
// 光靠渲染进程里 textarea.focus() 只改 DOM 内部状态，改不了原生焦点，要显式把根 webContents 切回来
handle('win:focus', () => win.webContents.focus());

handle('history:list', () => agent.listHistory());
handle('history:resume', (id) => agent.resume(id));
handle('history:rename', (id, title) => agent.renameHistory(id, title));
handle('history:delete', (id) => agent.deleteHistory(id));

handle('tools:list', () => agent.listCustomTools());
handle('tools:run', (name, args) => agent.runCustomTool(name, args));
handle('tools:form', (name) => agent.toolFormUrl(name));
handle('tools:stop', () => agent.stopTool());
handle('view:cover', (on) => { covered = !!on; syncViewVisible(); });

// 制作工具模式（见 agent.js startMaking/finishMaking）
handle('making:state', () => agent.makingState());
handle('making:start', (opts) => agent.startMaking(opts));
handle('making:draft', () => agent.describeDraft());
handle('making:run', (args) => agent.runDraft(args));
handle('making:finish', (opts) => agent.finishMaking(opts));
handle('making:cancel', () => agent.cancelMaking());
handle('making:continue', (name) => agent.continueMaking(name));

// 单个工具导入 / 导出（见 agent.js exportInfo / importPreview / importConfirm）
handle('tools:exportCheck', (name) => {
  const { secrets } = agent.exportInfo(name);
  return { secrets };
});
handle('tools:export', async (name) => {
  const { code } = agent.exportInfo(name);
  const r = await dialog.showSaveDialog(win, { title: `导出工具 ${name}`, defaultPath: path.join(app.getPath('downloads'), `${name}.js`), filters: [{ name: 'BrowserX 工具', extensions: ['js'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, code);
  return r.filePath;
});
handle('tools:importPick', async () => {
  const r = await dialog.showOpenDialog(win, { title: '导入工具', properties: ['openFile'], filters: [{ name: 'BrowserX 工具', extensions: ['js'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  return agent.importPreview(r.filePaths[0]);
});
handle('tools:importConfirm', (opts) => agent.importConfirm(opts));

// 网络录制（界面按钮用；对话里走 rec_start/rec_stop 工具，是同一个 Recorder）
handle('rec:status', () => agent.rec.status());
handle('rec:start', (opts) => agent.rec.start(opts));
handle('rec:mark', (label) => agent.rec.mark(label));
handle('rec:stop', () => agent.rec.stop());
