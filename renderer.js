const $ = (id) => document.getElementById(id);

async function call(ch, ...a) {
  const r = await api.call(ch, ...a);
  if (!r.ok) throw Object.assign(new Error(r.error), { url: r.url, needLogin: r.needLogin }); // url / needLogin 见 main.js handle()
  return r.data;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 右侧浏览器是独立的原生 WebContentsView，原生输入焦点可能还留在那边；
// textarea.focus() 只改本页 DOM 内部状态，改不动原生焦点，要先让主进程把根 webContents 切回来
async function focusInput() {
  await call('win:focus').catch(() => {});
  $('input').focus();
}

// 极简 Markdown：代码块、行内代码、粗体、标题、列表、链接文字
function md(text) {
  const parts = String(text).split(/```(\w*)\n?([\s\S]*?)```/g);
  let html = '';
  for (let i = 0; i < parts.length; i += 3) {
    html += esc(parts[i])
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/^#{1,4} (.+)$/gm, '<b class="h">$1</b>')
      .replace(/^[-*] /gm, '• ')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<u title="$2">$1</u>');
    if (parts[i + 2] !== undefined) html += `<pre>${esc(parts[i + 2].replace(/\n$/, ''))}</pre>`;
  }
  return html;
}

// ---------------------------------------------------------------- 对话

// 标签：左侧每个标签一个对话（自己的消息区和状态），对应右侧一个浏览器视图（主进程里一个 Agent）。
// cur 是当前显示的标签；T 是「正在往里画」的标签——平时就是 cur，处理后台标签的事件或异步回来的结果时用 inTab() 临时切过去，
// 这样 add()/toolCard() 这些函数不用到处传标签参数
const tabState = new Map(); // id → { id, el, toolEls, permEls, qEls, textEl, skills, running, making, attn, chatTitle, pageTitle, url }
let cur = null;
let T = null;
const SIDE_COMPOSER = document.querySelector('#side .composer');
function tabOf(id) {
  let t = tabState.get(id);
  if (t) return t;
  const el = document.createElement('div');
  el.className = 'msgs';
  el.hidden = true;
  el.setAttribute('aria-live', 'polite');
  SIDE_COMPOSER.before(el);
  t = { id, el, toolEls: new Map(), permEls: new Map(), qEls: new Map(), textEl: null, skills: null, running: false, making: null, attn: false, chatTitle: '', pageTitle: '', url: '', tbRunning: false };
  tabState.set(id, t);
  return t;
}
function inTab(t, fn) {
  const prev = T;
  T = t;
  try { return fn(); } finally { T = prev || cur; }
}

function nearBottom() { return T.el.scrollHeight - T.el.scrollTop - T.el.clientHeight < 60; }
function add(cls, html, force) {
  const stick = force || nearBottom();
  const d = document.createElement('div');
  d.className = cls;
  d.innerHTML = html;
  T.el.appendChild(d);
  if (stick) T.el.scrollTop = T.el.scrollHeight;
  return d;
}

function setRunning(r) {
  T.running = r;
  if (T === cur) renderRunning();
  renderTabs();
}
function renderRunning() {
  $('btnStop').hidden = !cur.running;
  $('status').textContent = cur.running ? '执行中…' : '';
  document.body.classList.toggle('running', cur.running);
}

const BROWSER = 'mcp__browser__';
const WECHAT = 'mcp__wechat__';
const TOOL_NAMES = { screenshot: '截图', page_info: '读取页面', navigate: '打开', click: '点击', type: '输入', press: '按键', scroll: '滚动', eval: '执行脚本', cdp: 'CDP' };
const WECHAT_NAMES = { wx_fill: '填写文章', wx_save_draft: '保存草稿', wx_publish: '发表' };

// 工具卡片标题：名称 + 最有代表性的参数
// 工具箱里自定义工具的中文名（title），对话区的工具卡片 / 提示用它显示「中文名（英文名）」
const toolTitles = new Map();
const toolLabel = (name) => (toolTitles.get(name) ? `${toolTitles.get(name)}（${name}）` : name);
function refreshToolTitles(items) {
  const fill = (list) => { toolTitles.clear(); for (const t of list) if (t.title) toolTitles.set(t.name, t.title); };
  if (items) fill(items);
  else call('tools:list').then(fill).catch(() => {});
}
refreshToolTitles();

function toolTitle(name, input = {}) {
  if (name.startsWith('mcp__custom__')) {
    const arg = Object.values(input).find((v) => typeof v === 'string' && v) || '';
    return { icon: '⚙', name: `工具 · ${toolLabel(name.slice('mcp__custom__'.length))}`, arg };
  }
  if (name.startsWith('mcp__toolbox__')) {
    const n = name.slice('mcp__toolbox__'.length);
    return { icon: '⚙', name: { toolbox_new: '工具箱 · 新建工具', toolbox_edit: '工具箱 · 修改工具' }[n] || `工具箱 · ${n}`, arg: input.title || input.name || '' };
  }
  if (name.startsWith(BROWSER)) {
    const n = name.slice(BROWSER.length);
    const arg = input.url || input.text || input.selector || input.key || input.method || input.code
      || (input.x != null ? `(${input.x}, ${input.y})` : input.dy != null ? `${input.dy > 0 ? '↓' : '↑'}${Math.abs(input.dy)}` : '');
    return { icon: '◎', name: `浏览器 · ${TOOL_NAMES[n] || n}`, arg };
  }
  if (name.startsWith(WECHAT)) {
    return { icon: '✎', name: `公众号 · ${WECHAT_NAMES[name] || name}`, arg: input.title || '' };
  }
  const arg = input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.description || input.prompt || '';
  return { icon: '›', name, arg };
}

function toolCard(ev) {
  const t = toolTitle(ev.name, ev.input);
  const d = add('tool', `<details><summary><span class="ti">${t.icon}</span><span class="tn">${esc(t.name)}</span><span class="ta">${esc(String(t.arg).split('\n')[0].slice(0, 160))}</span><span class="ts"></span></summary>
    <pre class="tin">${esc(JSON.stringify(ev.input, null, 2))}</pre><pre class="tout" hidden></pre></details>`);
  T.toolEls.set(ev.id, d);
}

function toolResult(ev) {
  const d = T.toolEls.get(ev.id);
  if (!d) return;
  d.classList.add(ev.error ? 'err' : 'ok');
  d.querySelector('.ts').textContent = ev.error ? '失败' : '';
  const out = d.querySelector('.tout');
  out.hidden = !ev.text;
  out.textContent = ev.text;
}

function permissionCard(ev) {
  const t = toolTitle(ev.tool, ev.input);
  const detail = ev.input.command || ev.input.file_path ? '' : JSON.stringify(ev.input, null, 2);
  const d = add('perm' + (ev.warn ? ' warn' : ''), `
    <div class="ph">${ev.warn ? '⚠ 可能不可撤回的浏览器操作' : '需要你的批准'}</div>
    <div class="pt"><b>${esc(t.name)}</b></div>
    ${t.arg ? `<pre class="pa">${esc(String(t.arg).slice(0, 1200))}</pre>` : ''}
    ${detail && detail !== '{}' ? `<details><summary>完整参数</summary><pre>${esc(detail.slice(0, 4000))}</pre></details>` : ''}
    <div class="pb"><button class="primary" data-d="allow">允许</button>${ev.warn ? '' : '<button data-d="always">本会话总是允许</button>'}<button class="ghost" data-d="deny">拒绝</button><span class="pr"></span></div>`, true);
  d.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => call('agent:permit', ev.id, b.dataset.d, ev.tab).catch(() => {})));
  T.permEls.set(ev.id, d);
  window.focus();
}

function permissionDone(ev) {
  const d = T.permEls.get(ev.id);
  if (!d) return;
  d.classList.add('done');
  d.querySelectorAll('[data-d]').forEach((b) => (b.disabled = true));
  d.querySelector('.pr').textContent = { allow: '已允许', always: '已允许（本会话）', deny: '已拒绝' }[ev.decision] || '';
}

// Claude 的 AskUserQuestion：画成可点选的卡片，提交后答案交回 agent.js questionHook
function questionCard(ev) {
  const qs = ev.questions;
  const d = add('perm qcard', `<div class="ph">助手想问你</div>
    ${qs.map((q, i) => `<div class="qq" data-i="${i}">
      <div class="qh">${q.header ? `<span class="qchip">${esc(q.header)}</span>` : ''}${esc(q.question)}${q.multiSelect ? '<span class="qmulti">（可多选）</span>' : ''}</div>
      <div class="qopts">
        ${(q.options || []).map((o, j) => `<button class="qopt" data-j="${j}"><b>${esc(o.label)}</b>${o.description ? `<small>${esc(o.description)}</small>` : ''}</button>`).join('')}
        <button class="qopt qother"><b>其他…</b><small>都不合适，自己写</small></button>
        <input class="qother-in" hidden placeholder="写下你的回答">
      </div>
      <pre class="qprev" hidden></pre>
    </div>`).join('')}
    <div class="pb"><button class="primary qsubmit" disabled>提交</button><button class="ghost qskip">跳过</button><span class="pr"></span></div>`, true);
  T.qEls.set(ev.id, d);

  const answerOf = (qd, q) => {
    const picked = [...qd.querySelectorAll('.qopt.sel:not(.qother)')].map((b) => q.options[b.dataset.j].label);
    const other = qd.querySelector('.qother.sel') && qd.querySelector('.qother-in').value.trim();
    if (other) picked.push(other);
    return picked;
  };
  const refresh = () => {
    d.querySelector('.qsubmit').disabled = !qs.every((q, i) => answerOf(d.querySelector(`.qq[data-i="${i}"]`), q).length);
  };
  qs.forEach((q, i) => {
    const qd = d.querySelector(`.qq[data-i="${i}"]`);
    const prev = qd.querySelector('.qprev');
    const otherIn = qd.querySelector('.qother-in');
    for (const b of qd.querySelectorAll('.qopt')) {
      b.addEventListener('click', () => {
        if (!q.multiSelect) for (const x of qd.querySelectorAll('.qopt')) if (x !== b) x.classList.remove('sel');
        b.classList.toggle('sel', q.multiSelect ? !b.classList.contains('sel') : true);
        const isOther = b.classList.contains('qother');
        if (isOther || !q.multiSelect) otherIn.hidden = !qd.querySelector('.qother.sel');
        if (isOther && b.classList.contains('sel')) otherIn.focus();
        // 选项带 preview（代码、示意图）时显示最后点的那个
        const p = !isOther && b.classList.contains('sel') ? q.options[b.dataset.j].preview : '';
        prev.hidden = !p;
        prev.textContent = p || '';
        refresh();
      });
    }
    otherIn.addEventListener('input', refresh);
  });

  d.querySelector('.qsubmit').addEventListener('click', () => {
    const answers = {};
    qs.forEach((q, i) => { answers[q.question] = answerOf(d.querySelector(`.qq[data-i="${i}"]`), q).join(', '); });
    d.dataset.summary = qs.map((q) => `${q.header || q.question}：${answers[q.question]}`).join('　');
    call('agent:answer', ev.id, { answers }, ev.tab).catch(() => {});
  });
  d.querySelector('.qskip').addEventListener('click', () => call('agent:answer', ev.id, null, ev.tab).catch(() => {}));
  window.focus();
}

function questionDone(ev) {
  const d = T.qEls.get(ev.id);
  if (!d) return;
  T.qEls.delete(ev.id);
  d.classList.add('done');
  d.querySelectorAll('button, input').forEach((b) => (b.disabled = true));
  d.querySelector('.pr').textContent = ev.answered ? `已回答 · ${d.dataset.summary || ''}` : '已跳过';
}

// 把 resume 拿到的历史文字/工具记录一次性铺进消息区（不触发「运行中」状态）
function renderHistoryEvents(events) {
  for (const ev of events) {
    // 单条历史记录格式有问题也不能让整个恢复流程炸掉——那样连「已载入历史对话」的提示都不会显示
    try {
      if (ev.type !== 'text') T.textEl = null;
      if (ev.type === 'user') add('msg user', esc(ev.text));
      else if (ev.type === 'text') {
        if (T.textEl) { T.textEl.dataset.raw += '\n\n' + ev.text; T.textEl.innerHTML = md(T.textEl.dataset.raw); }
        else { T.textEl = add('msg ai', md(ev.text)); T.textEl.dataset.raw = ev.text; }
      } else if (ev.type === 'tool') toolCard(ev);
      else if (ev.type === 'tool_result') toolResult(ev);
    } catch (e) { console.error('渲染历史消息失败', ev, e); }
  }
  T.textEl = null;
}

api.on('agent', (ev) => {
  const t = tabState.get(ev.tab);
  if (t) inTab(t, () => onAgentEvent(ev));
});
function onAgentEvent(ev) {
  if (ev.type !== 'text') T.textEl = null;
  // 后台标签要用户批准 / 回答时，在标签上亮提示
  if ((ev.type === 'permission' || ev.type === 'question') && T !== cur) { T.attn = true; renderTabs(); }
  switch (ev.type) {
    case 'user':
      add('msg user', esc(ev.text), true);
      if (!T.chatTitle) T.chatTitle = ev.text.split('\n')[0].slice(0, 40);
      setRunning(true);
      break;
    case 'history':
      T.el.innerHTML = '';
      T.toolEls.clear(); T.permEls.clear();
      T.chatTitle = (ev.events || []).find((x) => x.type === 'user')?.text.split('\n')[0].slice(0, 40) || '历史对话';
      renderHistoryEvents(Array.isArray(ev.events) ? ev.events : []);
      add('note', '— 已载入历史对话，继续输入将接着聊 —', true);
      setRunning(false);
      break;
    case 'init': T.skills = ev.skills; break;
    case 'text':
      if (T.textEl) { T.textEl.dataset.raw += '\n\n' + ev.text; T.textEl.innerHTML = md(T.textEl.dataset.raw); }
      else { T.textEl = add('msg ai', md(ev.text)); T.textEl.dataset.raw = ev.text; }
      break;
    case 'tool': toolCard(ev); break;
    case 'tool_result': toolResult(ev); break;
    case 'image': {
      const img = add('shot', `<img src="data:image/jpeg;base64,${ev.data}" alt="浏览器截图">`).querySelector('img');
      img.addEventListener('click', () => img.classList.toggle('big'));
      break;
    }
    case 'permission': permissionCard(ev); break;
    case 'question': questionCard(ev); break;
    case 'question-done': questionDone(ev); break;
    case 'permission-done': permissionDone(ev); break;
    case 'note': add('note', esc(ev.text), true); break;
    case 'tool_done': {
      refreshToolTitles();
      // 工具制作完成：带一个「继续修改」，在当前对话里重新进入编辑（不清空对话）
      const d = add('note', `${esc(ev.text)}<div style="margin-top:6px"><button class="ghost tbcont">继续修改</button></div>`, true);
      d.querySelector('.tbcont').addEventListener('click', () => {
        const mk = makingTabState();
        if (mk) { add('note err', `✗ 正在制作工具 ${esc(mk.making.name)}，先点横幅上的「完成」或「放弃」`, true); return; }
        call('making:continue', ev.name).catch((e) => add('note err', `✗ ${esc(e.message)}`, true));
      });
      break;
    }
    case 'done':
      setRunning(false);
      if (ev.error) add('note err', `✗ ${esc(ev.error)}`);
      else add('note', '✓ 指令完成，还有什么需要可以继续告诉我');
      break;
    case 'error': add('note err', `✗ ${esc(ev.text)}`); break;
    case 'reset':
      setRunning(false);
      if (T.el.children.length) add('note', '— 对话已结束，下一条消息将开始新对话 —');
      break;
    case 'making':
      T.making = ev.making;
      if (T === cur) renderMaking(cur.making);
      renderTabs();
      break;
    case 'rec':
      if (T === cur) renderRec(ev);
      break;
  }
}

async function sendMsg() {
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  // /skills 是终端界面的命令，SDK 会话里不可用，这里用会话初始化时拿到的列表代替
  if (text === '/skills') {
    if (!cur.skills) add('note', '还没有开始会话。发送任意消息后，再输入 /skills 查看已加载的 skills', true);
    else add('msg ai', md(`**当前会话已加载 ${cur.skills.length} 个 skills：**\n${cur.skills.map((s) => `- \`${s}\``).join('\n')}\n\n直接用自然语言描述任务，助手会自动选用；也可以输入 \`/技能名\` 来调用。`), true);
    return;
  }
  const m = text.match(/^\/model(?:\s+(\S+))?$/);
  if (m) {
    if (m[1]) await setModel(MODELS.find(([id, name]) => name.toLowerCase().replace(/\s/g, '') === m[1].toLowerCase())?.[0] || m[1]).catch(() => {});
    else add('note', `当前模型：${(MODELS.find(([id]) => id === cfg.model) || [, cfg.model])[1]}。用法：/model opus5.5（也可以在设置里切换）`, true);
    return;
  }
  try { await call('agent:send', text, cur.id); } catch (e) { add('note err', `✗ ${esc(e.message)}`, true); }
}
$('btnSend').addEventListener('click', sendMsg);
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMsg(); }
});
$('btnStop').addEventListener('click', () => call('agent:stop', cur.id).catch(() => {}));
async function clearChat() {
  $('history').hidden = true;
  $('settings').hidden = true;
  $('toolbox').hidden = true;
  $('account').hidden = true;
  const t = cur;
  await call('agent:reset', t.id).catch(() => {});
  t.el.innerHTML = '';
  t.toolEls.clear(); t.permEls.clear();
  t.chatTitle = '';
  renderTabs();
}
$('btnNew').addEventListener('click', async () => {
  await clearChat();
  focusInput();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && cur.running) call('agent:stop', cur.id).catch(() => {});
  if (e.metaKey && e.key === 'l') { e.preventDefault(); $('url').select(); }
});

// ---------------------------------------------------------------- 简单弹窗
// Electron 渲染进程不支持 window.prompt()（会直接抛异常），window.confirm() 也没有文档保证，
// 用同一套小弹窗替代，避免调用点的 async 函数在未捕获异常里中途断掉。

function modal(html) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-box">${html}</div>`;
    document.body.appendChild(overlay);
    // 右侧浏览器是原生视图，总盖在 DOM 上面，居中的弹窗会被它挡住：弹窗期间先藏起来
    call('view:cover', true).catch(() => {});
    const done = (v) => { overlay.remove(); call('view:cover', false).catch(() => {}); resolve(v); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
    overlay.querySelector('[data-a=cancel]')?.addEventListener('click', () => done(null));
    const input = overlay.querySelector('.modal-input');
    if (input) {
      input.focus(); input.select();
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(input.value); } });
      overlay.querySelector('[data-a=ok]').addEventListener('click', () => done(input.value));
    } else {
      overlay.querySelector('[data-a=ok]').addEventListener('click', () => done(true));
    }
  });
}
function askText(message, defaultValue = '') {
  return modal(`<div class="modal-msg">${esc(message)}</div><input class="modal-input" spellcheck="false" value="${esc(defaultValue)}">
    <div class="modal-actions"><button class="ghost" data-a="cancel">取消</button><button class="primary" data-a="ok">确定</button></div>`);
}
function askConfirm(message) {
  return modal(`<div class="modal-msg">${esc(message)}</div>
    <div class="modal-actions"><button class="ghost" data-a="cancel">取消</button><button class="primary" data-a="ok">确定</button></div>`);
}

// ---------------------------------------------------------------- 历史对话
// 对话本身由 claude 自动持久化到磁盘；这里只是保存/浏览/继续它（最多保留最近 100 个，见 agent.js pruneHistory）

function fmtTime(ms) {
  const d = new Date(ms), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
}

const hState = { page: 0 };

// keepPage：重命名 / 删除后重新渲染时停在当前页；打开面板时从第 1 页（最新）开始
async function renderHistoryList(keepPage) {
  if (!keepPage) hState.page = 0;
  const list = $('h_list');
  list.innerHTML = '<div class="hempty">加载中…</div>';
  let items;
  try { items = await call('history:list'); } catch (e) { list.innerHTML = `<div class="hempty">${esc(e.message)}</div>`; return; }
  list.innerHTML = items.length ? '' : '<div class="hempty">还没有保存的对话</div>';
  for (const it of items) {
    const d = document.createElement('div');
    d.className = 'hitem' + (it.mine ? ' mine' : '');
    d.innerHTML = `<span class="ht">${esc(it.title)}</span><span class="htime">${fmtTime(it.time)}</span><button data-a="rename" title="重命名">✎</button><button data-a="delete" title="删除">✕</button>`;
    d.addEventListener('click', (e) => { if (!e.target.closest('button')) resumeHistory(it.id); });
    d.querySelector('[data-a=rename]').addEventListener('click', async (e) => {
      e.stopPropagation();
      const title = await askText('重命名对话', it.title);
      if (!title || !title.trim()) return;
      try { await call('history:rename', it.id, title.trim()); renderHistoryList(true); }
      catch (err) { add('note err', `✗ ${esc(err.message)}`, true); }
    });
    d.querySelector('[data-a=delete]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!(await askConfirm(`删除对话「${it.title}」？此操作不可恢复。`))) return;
      try { await call('history:delete', it.id); renderHistoryList(true); }
      catch (err) { add('note err', `✗ ${esc(err.message)}`, true); }
    });
    list.appendChild(d);
  }
  makePager(list, '.hitem', 15, hState);
}

// 已经在某个标签里打开的对话直接切过去（同一个会话不能两处同时续写）；当前标签有内容就开新标签载入，不冲掉正在进行的对话
async function resumeHistory(id) {
  $('history').hidden = true;
  const open = await call('tabs:find', id).catch(() => null);
  if (open) { selectTab(open); return; }
  if (cur.el.children.length || cur.running || cur.making) {
    try { await newTab(); } catch (e) { add('note err', `✗ ${esc(e.message)}`, true); return; }
  }
  try {
    await call('history:resume', id, cur.id);
  } catch (e) {
    add('note err', `✗ ${esc(e.message)}`, true);
    // 恢复失败的记录没法通过正常聊天/删除入口清理，这里直接给个删除入口
    if (await askConfirm('这条历史记录恢复失败，要现在把它从历史列表里删除吗？')) {
      try { await call('history:delete', id); add('note', '已删除', true); }
      catch (e2) { add('note err', `✗ ${esc(e2.message)}`, true); }
    }
  }
}

$('btnHistory').addEventListener('click', () => {
  const willShow = $('history').hidden;
  $('settings').hidden = true;
  $('toolbox').hidden = true;
  $('account').hidden = true;
  $('history').hidden = !willShow;
  if (willShow) renderHistoryList();
});

// ---------------------------------------------------------------- 工具箱（自定义工具，直接运行不经过模型）


// 列表分页（工具箱、历史共用）：把 list 里的 itemSel 元素按 size 分页，底部加「首页 / 上一页 / 第 x / y 页 / 下一页 / 末页」。
// state.page 记住当前页，重新渲染列表时可以停在原来那一页。返回 { show(n), pager }
function makePager(list, itemSel, size, state) {
  const items = [...list.querySelectorAll(itemSel)];
  const pages = Math.max(Math.ceil(items.length / size), 1);
  items.forEach((x, i) => { x.dataset.page = Math.floor(i / size); });
  let pager = null;
  if (pages > 1) {
    pager = document.createElement('div');
    pager.className = 'pager';
    pager.innerHTML = `<button class="ghost" data-p="first">首页</button><button class="ghost" data-p="prev">上一页</button>
      <span class="muted"></span><button class="ghost" data-p="next">下一页</button><button class="ghost" data-p="last">末页</button>`;
    pager.addEventListener('click', (e) => {
      const p = e.target.closest('button')?.dataset.p;
      if (p) show({ first: 0, prev: state.page - 1, next: state.page + 1, last: pages - 1 }[p]);
    });
    list.appendChild(pager);
  }
  function show(n) {
    state.page = Math.min(Math.max(n, 0), pages - 1);
    for (const x of items) x.hidden = Number(x.dataset.page) !== state.page;
    if (pager) {
      pager.hidden = false;
      pager.querySelector('span').textContent = `第 ${state.page + 1} / ${pages} 页`;
      pager.querySelector('[data-p=first]').disabled = pager.querySelector('[data-p=prev]').disabled = state.page === 0;
      pager.querySelector('[data-p=next]').disabled = pager.querySelector('[data-p=last]').disabled = state.page === pages - 1;
    }
    list.scrollTop = 0;
    const panel = list.closest('#toolbox, #history');
    if (panel) panel.scrollTop = 0;
  }
  show(state.page);
  return { show, pager };
}

const tbState = { page: 0, q: '', fav: false };
let tbPager = null;
let tbItems = [];

// 收藏的工具（按工具名）：存在本机 localStorage，只影响工具箱里的「常用」筛选
const TB_FAV_KEY = 'cb.toolFavs';
let tbFavs = new Set();
try { tbFavs = new Set(JSON.parse(localStorage.getItem(TB_FAV_KEY) || '[]')); } catch {}
function toggleFav(name) {
  if (tbFavs.has(name)) tbFavs.delete(name); else tbFavs.add(name);
  try { localStorage.setItem(TB_FAV_KEY, JSON.stringify([...tbFavs])); } catch {}
}

async function renderToolboxList() {
  const list = $('tb_list');
  list.innerHTML = '<div class="hempty">加载中…</div>';
  try { tbItems = await call('tools:list'); } catch (e) { list.innerHTML = `<div class="hempty">${esc(e.message)}</div>`; return; }
  refreshToolTitles(tbItems);
  list.innerHTML = `<div class="tbtop">
      <button class="primary tbnewbtn">＋ 新建工具</button>
      <button class="ghost tbimport" title="导入别人做好的工具（一个 .js 文件）">导入</button>
      <button class="ghost tbmarketbtn" title="在 BrowserX 网站的工具市场里找工具、直接安装">工具市场</button>
      <button class="ghost tbfavbtn" title="只显示收藏的工具（在工具卡片上点 ☆ 收藏）">★ 常用</button>
      <input class="tbsearch" type="search" placeholder="搜索工具名或描述" spellcheck="false">
    </div>
    <div class="tbcards"></div>`;
  list.querySelector('.tbnewbtn').addEventListener('click', showNewToolForm);
  list.querySelector('.tbimport').addEventListener('click', pickImportTool);
  list.querySelector('.tbmarketbtn').addEventListener('click', () => renderMarket());
  const favBtn = list.querySelector('.tbfavbtn');
  favBtn.classList.toggle('on', tbState.fav);
  favBtn.addEventListener('click', () => { tbState.fav = !tbState.fav; tbState.page = 0; favBtn.classList.toggle('on', tbState.fav); drawToolCards(); });
  const search = list.querySelector('.tbsearch');
  search.value = tbState.q;
  search.addEventListener('input', () => { tbState.q = search.value; tbState.page = 0; drawToolCards(); });
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; search.dispatchEvent(new Event('input')); } });
  drawToolCards();
}

// 搜索：空格分开的每个词都要在工具名或描述里出现（不分大小写），命中的词高亮；序号保持工具箱里的原始序号
function drawToolCards() {
  const list = $('tb_list');
  const box = list.querySelector('.tbcards');
  const words = tbState.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (t) => words.every((w) => `${t.title} ${t.name} ${t.description}`.toLowerCase().includes(w));
  // 在原文上一次切出所有命中的词再逐段转义，避免后一个词匹配到前一个词加的 <mark> 标签
  const re = words.length ? new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi') : null;
  const mark = (text) => (re ? String(text).split(re).map((part, k) => (k % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('') : esc(text));
  const shown = tbItems.map((t, i) => ({ t, i })).filter(({ t }) => hit(t) && (!tbState.fav || tbFavs.has(t.name)));
  box.innerHTML = !tbItems.length ? '<div class="hempty">工具箱是空的——点上面「＋ 新建工具」让助手帮你做一个</div>'
    : tbState.fav && !tbItems.some((t) => tbFavs.has(t.name)) ? '<div class="hempty">还没有收藏的工具——点工具卡片右上角的 ☆ 收藏，再点「★ 常用」回到全部工具</div>'
    : !shown.length ? `<div class="hempty">没有找到包含「${esc(tbState.q.trim())}」的工具</div>` : '';
  for (const { t, i } of shown) {
    const d = document.createElement('div');
    d.className = 'tbitem';
    d.innerHTML = `<div class="tbhead"><span class="tbname">${i + 1}、${mark(t.title || t.name)}${t.title ? `<small class="tbid">${mark(t.name)}</small>` : ''}</span><span class="tbacts"><button class="ghost tbedit tbfav${tbFavs.has(t.name) ? ' on' : ''}" title="${tbFavs.has(t.name) ? '取消收藏' : '收藏到常用'}">${tbFavs.has(t.name) ? '★' : '☆'}</button>${t.market ? '<span class="tbmk" title="从工具市场安装的别人的工具：不能编辑、导出、发布">市场</span>' : '<button class="ghost tbedit tbeditbtn" title="进入制作模式修改这个工具（改的是草稿，完成前不影响现在的版本）">编辑</button><button class="ghost tbedit tbexport" title="导出成一个 .js 文件，发给别人导入">导出</button><button class="ghost tbedit tbpublish" title="发布到 BrowserX 网站的工具市场（进入审核）">发布</button>'}<button class="ghost tbedit tbdel" title="从工具箱删除（文件移到废纸篓，可以恢复）">删除</button></span></div>
      ${t.description ? `<div class="tbdesc">${mark(t.description)}</div>` : ''}`;
    d.querySelector('.tbeditbtn')?.addEventListener('click', (e) => { e.stopPropagation(); beginMaking({ edit: t.name }); });
    d.querySelector('.tbfav').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFav(t.name);
      // 在「常用」里取消收藏会让这张卡消失，整体重画；否则只改按钮，不打断已展开的表单
      if (tbState.fav && !d.querySelector('.tbform')) { drawToolCards(); return; }
      const on = tbFavs.has(t.name);
      e.currentTarget.classList.toggle('on', on);
      e.currentTarget.textContent = on ? '★' : '☆';
      e.currentTarget.title = on ? '取消收藏' : '收藏到常用';
    });
    d.querySelector('.tbexport')?.addEventListener('click', (e) => { e.stopPropagation(); exportTool(t.name); });
    d.querySelector('.tbpublish')?.addEventListener('click', (e) => { e.stopPropagation(); showPublishForm(t); });
    d.querySelector('.tbdel').addEventListener('click', (e) => { e.stopPropagation(); deleteTool(t); });
    // 点开一个工具只显示它自己（其它工具、搜索栏、分页栏藏起来），再点一次卡片或「全部工具」回到原来那一页
    d.addEventListener('click', (e) => {
      if (e.target.closest('button, .tbform')) return;
      if (t.launch) { launchTool(t); return; } // 自带界面的工具：点一下直接运行，不显示参数表单
      if (d.querySelector('.tbform')) { showAllTools(); return; }
      for (const x of box.querySelectorAll('.tbitem')) x.hidden = x !== d;
      if (tbPager.pager) tbPager.pager.hidden = true;
      list.querySelector('.tbtop').hidden = true;
      const back = document.createElement('button');
      back.className = 'ghost tbback';
      back.textContent = '← 全部工具';
      back.addEventListener('click', showAllTools);
      list.prepend(back);
      d.classList.toggle('tbhaspage', !!t.hasForm); // 自带填表网页时收起描述，把高度留给网页
      d.appendChild(t.hasForm ? buildToolPage(t) : buildToolForm(t));
    });
    box.appendChild(d);
  }
  tbPager = makePager(box, '.tbitem', 5, tbState); // 描述是多行完整显示的，每页放少一点
}

// 自带填表页面的工具：点开显示它的网页（本机小服务），网页上填完点按钮才执行
function buildToolPage(t) {
  const box = document.createElement('div');
  box.className = 'tbform tbpage';
  box.innerHTML = '<div class="muted">正在打开…</div>';
  call('tools:form', t.name).then((url) => {
    const f = document.createElement('iframe');
    f.src = url;
    f.title = t.title || t.name;
    box.replaceChildren(f);
  }).catch((e) => { box.innerHTML = `<div class="tberr">✗ ${esc(e.message)}</div>`; });
  return box;
}

// 工具运行中：对话里一条会动的「运行中 · N 秒」提示 + 「停止」按钮，跑完就去掉
function runningBar(label) {
  const tab = T;
  const d = add('note tbrunbar', `<span class="tbspin" aria-hidden="true"></span><span class="tbruntxt">${esc(label)} 运行中…</span><button class="tbstop">停止</button>`, true);
  const t0 = Date.now();
  const txt = d.querySelector('.tbruntxt');
  const timer = setInterval(() => { txt.textContent = `${label} 运行中 · ${Math.round((Date.now() - t0) / 1000)} 秒`; }, 1000);
  const btn = d.querySelector('.tbstop');
  btn.addEventListener('click', () => {
    btn.disabled = true; btn.textContent = '正在停止…';
    call('tools:stop', tab.id).catch(() => {});
  });
  return { done() { clearInterval(timer); d.remove(); } };
}
const isStopped = (e) => /已手动停止/.test(e?.message || '');

// launch 工具：不填参数直接运行（工具自己会打开界面，比如填表视窗）
async function launchTool(t) {
  const tab = cur;
  if (tab.tbRunning) return;
  tab.tbRunning = true;
  $('toolbox').hidden = true;
  const label = t.title ? `${t.title}（${t.name}）` : t.name;
  add('note', `— 打开工具 ${esc(label)} —`, true);
  const running = runningBar(label);
  try {
    const r = await call('tools:run', t.name, {}, tab.id);
    inTab(tab, () => { running.done(); add('msg ai', md(String(r)), true); });
  } catch (e) {
    inTab(tab, () => { running.done(); add(isStopped(e) ? 'note' : 'note err', isStopped(e) ? `■ 已手动停止 ${esc(label)}` : `✗ ${esc(e.message)}`, true); });
  } finally {
    tab.tbRunning = false;
  }
}

function showAllTools() {
  const list = $('tb_list');
  list.querySelector('.tbback')?.remove();
  list.querySelector('.tbtop').hidden = false;
  for (const x of list.querySelectorAll('.tbitem')) { x.querySelector('.tbform')?.remove(); x.classList.remove('tbhaspage'); }
  tbPager.show(tbState.page);
}

// 按 params 的 kind（agent.js listCustomTools 内省出来的）生成对应表单控件
function buildToolForm(t) {
  const form = document.createElement('div');
  form.className = 'tbform';
  const fieldId = (key) => `tbf_${t.name}_${key}`;
  const fieldsHtml = t.params.map((p) => {
    const req = p.required ? ' <span class="req">*</span>' : '';
    const id = fieldId(p.key);
    let control;
    if (p.kind === 'boolean') control = `<input type="checkbox" id="${id}">`;
    else if (p.kind === 'array') control = `<textarea id="${id}" placeholder="一行一个"></textarea>`;
    else if (p.kind === 'enum') control = `<select id="${id}">${(p.enumValues || []).map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}</select>`;
    else if (p.kind === 'number') control = `<input id="${id}" inputmode="decimal">`;
    else if (p.kind === 'string') control = `<input id="${id}">`;
    else control = `<textarea id="${id}" placeholder="识别不出这个参数的类型，按 JSON 格式填"></textarea>`;
    const hint = p.description ? `<p class="hint">${esc(p.description)}</p>` : '';
    if (p.kind === 'boolean') return `<div class="tbf"><label class="tbcheck">${control}<span>${esc(p.key)}${req}</span></label>${hint}</div>`;
    return `<div class="tbf"><label for="${id}">${esc(p.key)}${req}</label>${hint}${control}</div>`;
  }).join('');
  form.innerHTML = `${fieldsHtml}<div class="tberr" hidden></div><div class="row"><button class="primary tbrun">运行</button></div>`;

  form.querySelector('.tbrun').addEventListener('click', async () => {
    const errEl = form.querySelector('.tberr');
    errEl.hidden = true;
    const tab = cur;
    if (tab.tbRunning) { errEl.hidden = false; errEl.textContent = '这个标签已经有一个工具在运行，等它跑完（或者开个新标签）'; return; }

    const args = {};
    for (const p of t.params) {
      const el = form.querySelector('#' + fieldId(p.key));
      if (p.kind === 'boolean') { args[p.key] = el.checked; continue; }
      const raw = el.value;
      if (!raw.trim()) {
        if (p.required) { errEl.hidden = false; errEl.textContent = `「${p.key}」是必填的`; return; }
        continue; // 选填留空就不传这个参数
      }
      if (p.kind === 'array') args[p.key] = raw.split('\n').map((s) => s.trim()).filter(Boolean);
      else if (p.kind === 'number') {
        const n = Number(raw);
        if (Number.isNaN(n)) { errEl.hidden = false; errEl.textContent = `「${p.key}」不是合法数字`; return; }
        args[p.key] = n;
      } else if (p.kind === 'unknown') {
        try { args[p.key] = JSON.parse(raw); }
        catch (e) { errEl.hidden = false; errEl.textContent = `「${p.key}」不是合法 JSON：${e.message}`; return; }
      } else args[p.key] = raw;
    }

    tab.tbRunning = true;
    form.querySelector('.tbrun').disabled = true;
    $('toolbox').hidden = true;
    const label = t.title ? `${t.title}（${t.name}）` : t.name;
    add('note', t.draft ? `— 试运行草稿 ${esc(label)}（不经过对话） —` : `— 直接运行工具 ${esc(label)}（不经过对话，省 token） —`, true);
    const running = runningBar(label);
    try {
      const r = await (t.draft ? call('making:run', args) : call('tools:run', t.name, args, tab.id));
      T = tab; // 跑的时候用户可能切到了别的标签：结果、按钮都放回发起运行的那个标签（finally 里切回来）
      running.done();
      add('msg ai', md(String(r)), true);
      // 跑完给一个入口：效果不满意就进入修改模式（会开新对话），把这次的参数和结果带过去，用户补一句哪里不好即可
      if (!t.draft && !t.market) {
        const d = add('note', `工具运行完毕，如果感觉效果不好，<button class="tbtweak">点击修改工具功能</button>`, true);
        d.querySelector('.tbtweak').addEventListener('click', async () => {
          const out = String(r);
          if (!(await beginMaking({ edit: t.name }))) return;
          $('input').value = `刚才直接运行这个工具，参数：${JSON.stringify(args)}\n结果：\n${out.length > 1500 ? out.slice(0, 1500) + '\n…（后面省略）' : out}\n\n效果不好的地方：`;
          focusInput();
        });
      }
    } catch (e) {
      T = tab;
      running.done();
      if (isStopped(e)) { add('note', `■ 已手动停止 ${esc(label)}`, true); return; }
      // 直接运行不经过模型，失败了没人会自动修：正式工具直接打开「修改工具」（新对话 + 制作模式），把参数和报错交给助手诊断、改草稿；
      // 草稿试运行失败时本来就在修改中，留在当前对话里让助手接着改
      if (t.market) { add('note err', `✗ ${esc(e.message)}<div class="muted" style="margin-top:4px">这是从工具市场安装的工具，有问题请联系作者，或在工具市场里更新到新版本</div>`, true); return; }
      const d = add('note err', `✗ ${esc(e.message)}<div style="margin-top:6px"><button class="tbfix">${t.draft ? '让助手诊断并修复' : '打开修改工具'}</button></div>`, true);
      d.querySelector('.tbfix').addEventListener('click', async () => {
        if (t.draft) {
          $('input').value = `试运行草稿 ${t.name} 失败了。\n参数：${JSON.stringify(args)}\n错误：${e.message}\n请诊断真正原因（用 mcp__browser__* 实际查一下，不要猜），然后改草稿。`;
          sendMsg();
          return;
        }
        if (!(await beginMaking({ edit: t.name }))) return;
        $('input').value = `刚才直接运行这个工具失败了。\n参数：${JSON.stringify(args)}\n错误：${e.message}\n需要的话先用浏览器手动把这次要做的事做完，再诊断真正原因（用 mcp__browser__* 实际查一下，不要猜），然后改草稿；改好后告诉我改了什么，我来试运行。`;
        sendMsg();
      });
    } finally {
      T = cur;
      tab.tbRunning = false;
      form.querySelector('.tbrun').disabled = false;
    }
  });
  return form;
}

// ---------------------------------------------------------------- 单个工具导入 / 导出（见 agent.js importPreview / importConfirm）

async function deleteTool(t) {
  const label = t.title ? `${t.title}（${t.name}）` : t.name;
  if (!(await askConfirm(`删除工具 ${label}？\n工具文件和它的制作记录会移到废纸篓，需要时可以从废纸篓恢复。已经发布到工具市场的版本不受影响。`))) return;
  try {
    await call('tools:delete', t.name);
    if (tbFavs.has(t.name)) toggleFav(t.name);
    add('note', `— 已删除工具 ${esc(label)}（在废纸篓里） —`, true);
    renderToolboxList();
  } catch (e) {
    add('note err', `✗ 删除失败：${esc(e.message)}`, true);
  }
}

async function exportTool(name) {
  try {
    const { secrets } = await call('tools:exportCheck', name);
    if (secrets.length && !(await askConfirm(`${name} 的代码里可能有不该发给别人的内容：\n${secrets.map((x) => `· ${x.label}（第 ${x.lines.join('、')} 行${x.more ? ` 等` : ''}）`).join('\n')}\n\n建议先点「编辑」让助手改成运行时读取。仍然导出吗？`))) return;
    const file = await call('tools:export', name);
    if (file) add('note', `— 已导出工具 ${esc(name)} 到 ${esc(file)} —`, true);
  } catch (e) {
    add('note err', `✗ 导出失败：${esc(e.message)}`, true);
  }
}

async function pickImportTool() {
  let p;
  try { p = await call('tools:importPick'); } catch (e) { add('note err', `✗ ${esc(e.message)}`, true); return; }
  if (p) showImportPreview(p);
}

// 工具箱顶部的一条成功提示（几秒后自己淡出）；name 给了就把那张工具卡片闪一下
function toolboxTip(text, name) {
  const list = $('tb_list');
  list.querySelector('.tbtip')?.remove();
  const tip = document.createElement('div');
  tip.className = 'tbtip';
  tip.setAttribute('role', 'status');
  tip.textContent = text;
  list.prepend(tip);
  const card = name && [...list.querySelectorAll('.tbitem')].find((d) => d.querySelector('.tbid')?.textContent === name || d.querySelector('.tbname')?.textContent.includes(name));
  card?.classList.add('tbflash');
  setTimeout(() => tip.classList.add('out'), 4000);
  setTimeout(() => { tip.remove(); card?.classList.remove('tbflash'); }, 4600);
}

// 导入前的确认页：本地文件导入和工具市场安装共用（市场安装时 p.market 有值，确认 / 取消后回到市场列表）
function showImportPreview(p) {
  const list = $('tb_list');
  const back = p.market ? renderMarket : renderToolboxList;
  const verb = p.market ? '安装' : '导入';
  const risky = p.risks.filter((r) => r.label !== '访问的网址');
  list.innerHTML = `<button class="ghost tbback">← ${p.market ? '工具市场' : '全部工具'}</button>
    <div class="tbitem tbimp">
      <div class="tbhead"><span class="tbname">${verb}：${esc(p.title || p.name)}${p.title ? `<small class="tbid">${esc(p.name)}</small>` : ''}</span></div>${p.description ? `<div class="tbdesc">${esc(p.description)}</div>` : ''}
      <p class="muted">${p.market ? `来自工具市场，版本 ${esc(p.market.version)}（已通过网站审核）` : `来自 ${esc(p.from)}`}（${Math.ceil(p.size / 1024)} KB）</p>
      <p class="tbimp-warn">⚠ 工具代码在 BrowserX 里运行，权限跟 BrowserX 一样：能读写你电脑上的文件、用右侧浏览器里已登录的账号操作。只导入你信任的人给的工具，导入前最好看一下源代码。</p>
      ${p.risks.length ? `<div class="tbimp-risks"><b>代码里用到的能力</b>${p.risks.map((r) => `<div class="${r.label === '访问的网址' ? '' : 'risk'}">· ${esc(r.label)}（第 ${r.lines.join('、')} 行${r.more ? ` 等 ${r.more + r.lines.length} 处` : ''}）</div>`).join('')}</div>` : '<p class="muted">没有发现执行命令、读写文件之类的敏感能力。</p>'}
      ${p.exists ? `<label class="tbimp-ow"><input type="checkbox" id="imp_ow"> 工具箱里已经有 ${esc(p.name)}，${p.market ? '用这个版本替换' : '覆盖它'}</label>` : ''}
      ${p.market ? '' : `<details><summary>查看源代码</summary><pre class="tbimp-code">${esc(p.code)}</pre></details>`}
      <div class="tberr" hidden></div>
      <div class="row"><button class="primary imp_go">${risky.length ? `我已确认，${verb}` : verb}</button><button class="ghost imp_cancel">取消</button></div>
    </div>`;
  list.querySelector('.tbback').addEventListener('click', back);
  list.querySelector('.imp_cancel').addEventListener('click', back);
  list.querySelector('.imp_go').addEventListener('click', async () => {
    const err = list.querySelector('.tberr');
    err.hidden = true;
    if (p.exists && !$('imp_ow').checked) { err.hidden = false; err.textContent = `工具箱里已经有 ${p.name}：要${p.market ? '替换' : '覆盖'}请勾选上面的选项，不想${p.market ? '替换' : '覆盖'}就取消`; return; }
    try {
      await call('tools:importConfirm', { overwrite: p.exists });
      // 市场安装成功：回到工具箱第 1 页（最新的排第 1，刚装的就在最上面）；清掉搜索 / 常用筛选，免得被筛掉看不到
      if (p.market) {
        Object.assign(tbState, { page: 0, q: '', fav: false });
        await renderToolboxList();
        toolboxTip(`✓ 「${p.title || p.name}」已成功安装`, p.name);
      } else back();
    } catch (e) {
      err.hidden = false;
      err.textContent = e.message;
    }
  });
}

// ---------------------------------------------------------------- 工具市场 / 发布（BrowserX 账号，见 main.js market:* 和 account.js）

// 没登录时市场 / 发布页显示的提示
function loginPrompt(box, what) {
  box.innerHTML = `<div class="hempty">${esc(what)}需要先登录 BrowserX 账号<div class="row" style="justify-content:center;margin-top:10px"><button class="primary lp_go">登录</button></div></div>`;
  box.querySelector('.lp_go').addEventListener('click', () => openAccount(true));
}

// 网站返回「去购买 / 开通会员」之类的错误时，带一个打开网站的按钮
function errWithLink(e) {
  return `✗ ${esc(e.message)}${e.url ? ` <button class="ghost ac_link" data-url="${esc(e.url)}">去网站看看</button>` : ''}`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('.ac_link');
  if (b) call('account:open', b.dataset.url).catch(() => {});
});

// 2026-10-29 这种日期（工具市场的发布 / 更新日期）
const ymd = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const mkState = { q: '', category: '', page: 1 };
let mkMeta = null;
async function renderMarket() {
  const list = $('tb_list');
  list.innerHTML = `<button class="ghost tbback">← 我的工具</button>
    <div class="tbtop mktop"><input class="tbsearch mk_q" type="search" placeholder="搜索工具市场" spellcheck="false"><select class="mk_cat"><option value="">全部行业</option></select></div>
    <div class="mkbody"><div class="hempty">加载中…</div></div>`;
  list.querySelector('.tbback').addEventListener('click', renderToolboxList);
  const body = list.querySelector('.mkbody');
  if (!account.loggedIn) { loginPrompt(body, '浏览和安装工具市场里的工具'); return; }
  try { mkMeta = mkMeta || await call('market:meta'); } catch (e) { if (e.needLogin) loginPrompt(body, '浏览工具市场'); else body.innerHTML = `<div class="tberr">${errWithLink(e)}</div>`; return; }
  const q = list.querySelector('.mk_q'), cat = list.querySelector('.mk_cat');
  cat.innerHTML += Object.entries(mkMeta.categories).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
  q.value = mkState.q; cat.value = mkState.category;
  let timer;
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { mkState.q = q.value.trim(); mkState.page = 1; loadMarket(body); }, 350); });
  cat.addEventListener('change', () => { mkState.category = cat.value; mkState.page = 1; loadMarket(body); });
  loadMarket(body);
}

async function loadMarket(body) {
  body.innerHTML = '<div class="hempty">加载中…</div>';
  let r;
  try { r = await call('market:list', mkState); } catch (e) { if (e.needLogin) loginPrompt(body, '浏览工具市场'); else body.innerHTML = `<div class="tberr">${errWithLink(e)}</div>`; return; }
  body.innerHTML = r.items.length ? '' : `<div class="hempty">${mkState.q || mkState.category ? '没有找到符合条件的工具' : '工具市场里还没有工具'}</div>`;
  for (const t of r.items) {
    const d = document.createElement('div');
    d.className = 'tbitem mkitem';
    const local = t.local.version ? (t.local.version === t.version ? `已安装 ${esc(t.version)}` : `已安装 ${esc(t.local.version)}，有新版本`) : t.local.exists ? '工具箱里有同名工具' : '';
    const action = t.is_demo ? '<span class="muted">示例，不能安装</span>'
      : t.can_download ? `<button class="primary mk_inst">${t.local.version === t.version ? '重新安装' : t.local.version ? `更新到 ${esc(t.version)}` : '安装'}</button>`
      : account.user?.member ? (buying?.id === t.id ? '<span class="mkwait">等待付款…</span>' : `<button class="primary mk_buy">购买 ${esc(t.price_label)}</button>`)
      : `<button class="ghost ac_link" data-url="${esc(account.user?.urls?.packages || t.url)}">开通会员后购买</button>`;
    d.innerHTML = `<div class="tbhead"><span class="tbname">${esc(t.title)}<small class="tbid">${esc(t.name)}</small></span><span class="mkprice${t.price ? ' paid' : ''}">${esc(t.price_label)}</span></div>
      <div class="tbdesc">${esc(t.summary)}</div>
      <div class="mkmeta"><span>${esc(t.category_label)}</span><span>${esc(t.author || '')}${t.mine ? '（我）' : ''}</span>${t.version ? `<span class="mkver">版本 ${esc(t.version)}</span>` : ''}${t.listed_at ? `<span>发布 ${ymd(t.listed_at)}</span>` : ''}${t.version_at && ymd(t.version_at) !== ymd(t.listed_at) ? `<span>更新 ${ymd(t.version_at)}</span>` : ''}<span>${t.downloads} 次安装</span>${local ? `<span class="mklocal">${local}</span>` : ''}</div>
      <div class="row mkact">${action}<button class="ghost ac_link" data-url="${esc(t.url)}">详情</button></div><div class="tberr" hidden></div>`;
    d.querySelector('.mk_buy')?.addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      try { await startBuying(t); loadMarket(body); }
      catch (e) { const err = d.querySelector('.tberr'); err.hidden = false; err.innerHTML = errWithLink(e); ev.target.disabled = false; }
    });
    d.querySelector('.mk_inst')?.addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      try { showImportPreview(await call('market:install', t.id)); }
      catch (e) { const err = d.querySelector('.tberr'); err.hidden = false; err.innerHTML = errWithLink(e); ev.target.disabled = false; }
    });
    body.appendChild(d);
  }
  if (r.pages > 1) {
    const pager = document.createElement('div');
    pager.className = 'pager';
    pager.innerHTML = `<button class="ghost" data-p="-1" ${r.page <= 1 ? 'disabled' : ''}>上一页</button><span class="muted">第 ${r.page} / ${r.pages} 页 · 共 ${r.total} 个</span><button class="ghost" data-p="1" ${r.page >= r.pages ? 'disabled' : ''}>下一页</button>`;
    pager.addEventListener('click', (e) => { const p = e.target.closest('button')?.dataset.p; if (p) { mkState.page = r.page + Number(p); loadMarket(body); } });
    body.appendChild(pager);
  }
}

// 购买付费工具：在系统浏览器里打开 Stripe 付款页，这边每 4 秒问一次网站有没有付款成功（最多等 20 分钟）；
// 付款确认后自动打开安装确认页。同一时间只等一笔
let buying = null; // { id, title, timer, until }
async function startBuying(t) {
  stopBuying();
  await call('market:buy', t.id);
  buying = { id: t.id, title: t.title, until: Date.now() + 20 * 60 * 1000 };
  add('note', `— 已在浏览器里打开「${esc(t.title)}」的付款页（${esc(t.price_label)}），付完款会自动打开安装确认 —`, true);
  const tick = async () => {
    if (!buying || buying.id !== t.id) return;
    if (Date.now() > buying.until) { stopBuying(); add('note', `— 「${esc(t.title)}」等了 20 分钟没有收到付款，已停止等待；付过款的话在工具市场里点「安装」即可 —`, true); return; }
    try {
      const r = await call('market:purchase', t.id);
      if (r.can_download) {
        stopBuying();
        add('note', `— 「${esc(t.title)}」购买成功，打开安装确认 —`, true);
        $('history').hidden = true; $('settings').hidden = true; $('account').hidden = true; $('toolbox').hidden = false;
        showImportPreview(await call('market:install', t.id));
        return;
      }
      if (r.status === 'canceled') { stopBuying(); add('note', `— 已取消「${esc(t.title)}」的付款，没有扣款 —`, true); if (!$('toolbox').hidden) renderMarket(); return; }
    } catch (e) { if (e.needLogin) { stopBuying(); return; } } // 网络临时不通：下次再问
    buying.timer = setTimeout(tick, 4000);
  };
  buying.timer = setTimeout(tick, 4000);
}
function stopBuying() {
  if (buying) clearTimeout(buying.timer);
  buying = null;
}

// 发布到工具市场：网站上已有同名的自己的工具 → 上传新版本（只填版本号和说明）；否则新建（行业、价格、简介）。都要管理员审核后才上架
const bumpVersion = (v) => (/^(\d+)\.(\d+)\.(\d+)$/.test(v || '') ? v.replace(/(\d+)$/, (n) => Number(n) + 1) : '1.0.0');
async function showPublishForm(t) {
  const list = $('tb_list');
  list.innerHTML = `<button class="ghost tbback">← 全部工具</button><div class="tbitem tbpub"><div class="hempty">加载中…</div></div>`;
  list.querySelector('.tbback').addEventListener('click', renderToolboxList);
  const box = list.querySelector('.tbpub');
  if (!account.loggedIn) { loginPrompt(box, '发布工具'); return; }
  let info;
  try { info = await call('market:publishInfo', t.name); } catch (e) { if (e.needLogin) loginPrompt(box, '发布工具'); else box.innerHTML = `<div class="tberr">${errWithLink(e)}</div>`; return; }
  const rm = info.remote;
  const label = t.title ? `${t.title}（${t.name}）` : t.name;
  if (!account.user?.member) {
    box.innerHTML = `<div class="tbhead"><span class="tbname">发布：${esc(label)}</span></div><p class="tbimp-warn">发布工具需要有效的会员授权。</p>
      <div class="row"><button class="primary ac_link" data-url="${esc(account.user?.urls?.packages || '')}">去开通会员</button></div>`;
    return;
  }
  if (rm?.pending) {
    box.innerHTML = `<div class="tbhead"><span class="tbname">发布：${esc(label)}</span></div><p class="muted">网站上这个工具的版本 ${esc(rm.latest_version)} 还在等待审核，审核完再上传新版本。</p>
      <div class="row"><button class="ghost ac_link" data-url="${esc(rm.url)}">在网站上查看</button></div>`;
    return;
  }
  const cats = Object.entries(info.meta.categories).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
  box.innerHTML = `<div class="tbform">
    <div class="tbhead"><span class="tbname">${rm ? '上传新版本' : '发布到工具市场'}：${esc(label)}</span></div>
    <p class="hint">${rm ? `网站上已有这个工具（${esc(rm.status_label)}，${esc(rm.price_label)}，当前对外版本 ${esc(rm.current_version || '无')}）。新版本审核通过后替换旧版本；价格、简介在网站上改。` : `提交后进入审核，管理员通过后才会出现在工具市场。平台抽成 ${info.meta.commission_percent}%，其余归你。`}</p>
    ${info.secrets.length ? `<p class="tbimp-warn">⚠ 代码里可能有不该公开的内容：${info.secrets.map((x) => `${esc(x.label)}（第 ${x.lines.join('、')} 行）`).join('；')}。建议先点「编辑」让助手改成运行时读取，再发布。</p>` : ''}
    <div class="tbf"><label for="pb_version">版本号 <span class="req">*</span></label><input id="pb_version" value="${esc(rm ? bumpVersion(rm.latest_version) : '1.0.0')}" spellcheck="false"></div>
    ${rm ? '' : `
    <div class="tbf"><label for="pb_title">中文名</label><input id="pb_title" value="${esc(t.title || '')}" maxlength="40"></div>
    <div class="tbf"><label for="pb_category">行业 <span class="req">*</span></label><select id="pb_category"><option value="">请选择</option>${cats}</select></div>
    <div class="tbf"><label for="pb_price">价格（元）</label><p class="hint">0 = 免费；付费至少 ¥${info.meta.min_price}</p><input id="pb_price" value="0" inputmode="decimal"></div>
    <div class="tbf"><label for="pb_summary">一句话简介</label><input id="pb_summary" value="${esc((t.description || '').split('\n')[0].slice(0, 120))}" maxlength="120"></div>
    <div class="tbf"><label for="pb_desc">详细说明</label><p class="hint">写清楚用途、需要先登录哪个网站、参数怎么填（支持 Markdown）</p><textarea id="pb_desc" rows="5">${esc(t.description || '')}</textarea></div>`}
    <div class="tbf"><label for="pb_changelog">版本说明</label><textarea id="pb_changelog" rows="2" placeholder="${rm ? '这个版本改了什么' : '可不填'}"></textarea></div>
    <div class="tberr" hidden></div>
    <div class="row"><button class="primary pb_go">${rm ? '上传新版本' : '提交审核'}</button><button class="ghost pb_cancel">取消</button></div></div>`;
  box.querySelector('.pb_cancel').addEventListener('click', renderToolboxList);
  box.querySelector('.pb_go').addEventListener('click', async (ev) => {
    const err = box.querySelector('.tberr');
    err.hidden = true;
    const v = (id) => box.querySelector('#' + id)?.value.trim();
    const form = { version: v('pb_version'), changelog: v('pb_changelog') };
    if (!rm) {
      if (!v('pb_category')) { err.hidden = false; err.textContent = '请选择行业'; return; }
      Object.assign(form, { title: v('pb_title'), category: v('pb_category'), price: Number(v('pb_price') || 0), summary: v('pb_summary'), description: v('pb_desc') });
      if (Number.isNaN(form.price)) { err.hidden = false; err.textContent = '价格不是合法数字'; return; }
    }
    ev.target.disabled = true;
    try {
      const r = await call('market:publish', t.name, form);
      box.innerHTML = `<div class="tbhead"><span class="tbname">已提交：${esc(label)} ${esc(r.version)}</span></div>
        <p class="muted">${r.created ? '新工具已提交' : '新版本已上传'}，等待管理员审核，通过后会出现在工具市场。</p>
        <div class="row"><button class="ghost ac_link" data-url="${esc(r.url)}">在网站上查看 / 修改</button><button class="ghost pb_back">回到工具箱</button></div>`;
      box.querySelector('.pb_back').addEventListener('click', renderToolboxList);
    } catch (e) {
      ev.target.disabled = false;
      err.hidden = false;
      err.innerHTML = errWithLink(e);
    }
  });
}

// ---------------------------------------------------------------- BrowserX 账号面板

let account = { loggedIn: false, user: null, pending: false };
function renderAccountBtn() {
  const b = $('btnAccount');
  const u = account.user;
  b.innerHTML = account.loggedIn
    ? `<span class="acav" aria-hidden="true">${esc((u?.name || '?').slice(0, 1).toUpperCase())}</span><span class="acname">${esc(u?.name || '账号')}</span>`
    : `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5.5" r="2.75"/><path d="M2.75 13.5c.6-2.6 2.75-4 5.25-4s4.65 1.4 5.25 4"/></svg><span class="acname">登录</span>`;
  b.classList.toggle('in', account.loggedIn);
  b.title = account.loggedIn ? `${u?.name || ''} ${u?.email || ''}\n会员授权、工具市场、退出登录` : '登录 BrowserX 账号：会员授权、工具市场、发布工具';
}
function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) : ''; }
function renderAccount() {
  renderAccountBtn();
  if ($('account').hidden) return;
  const box = $('ac_body');
  const u = account.user;
  if (account.pending) {
    box.innerHTML = `<div class="ac_card"><h3>等待网页授权…</h3><p class="hint">已经在系统浏览器里打开 BrowserX 网站。登录后点「授权」，会自动回到这里。</p>
      <div class="row"><button class="ghost ac_cancel">取消</button></div></div>`;
    box.querySelector('.ac_cancel').addEventListener('click', () => call('account:cancel').catch(() => {}));
    return;
  }
  if (!account.loggedIn) {
    box.innerHTML = `<div class="ac_card"><h3>登录 BrowserX 账号</h3>
      <p class="hint">登录后可以查看会员授权、在工具市场里直接安装工具、把自己做的工具一键发布到市场。</p>
      <p class="hint">点下面的按钮会在系统浏览器里打开 ${esc(account.portal || '')}，在网站上登录（没有账号可以注册）并点「授权」。密码只在网站上输入，不经过本软件。</p>
      <div class="tberr" hidden></div>
      <div class="row"><button class="primary ac_login">在浏览器里登录</button></div></div>`;
    box.querySelector('.ac_login').addEventListener('click', async () => {
      try { await call('account:login'); } catch (e) {
        if (/已取消登录/.test(e.message)) return;
        const err = box.querySelector('.tberr'); if (err) { err.hidden = false; err.textContent = e.message; }
      }
    });
    return;
  }
  const lic = u?.license;
  box.innerHTML = `<div class="ac_card">
      <div class="ac_who"><span class="ac_avatar" aria-hidden="true">${esc((u?.name || '?').slice(0, 1).toUpperCase())}</span><div><b>${esc(u?.name || '')}</b><span>${esc(u?.email || '')}</span></div></div>
    </div>
    <div class="ac_card"><h3>会员授权</h3>
      ${!u ? '<p class="hint">正在读取…</p>' : u.is_admin ? '<p><span class="ac_badge ok">管理员</span></p>' : lic ? `<p><span class="ac_badge ok">有效</span> 到期：${esc(fmtDate(lic.expires_at))}</p>` : '<p><span class="ac_badge">没有有效授权</span></p><p class="hint">开通会员后可以安装和发布工具市场里的工具。</p>'}
      <div class="row">${u && !u.member ? `<button class="primary ac_link" data-url="${esc(u.urls.packages)}">开通 / 续期会员</button>` : u ? `<button class="ghost ac_link" data-url="${esc(u.urls.packages)}">续期</button>` : ''}</div>
    </div>
    <div class="ac_card"><h3>工具市场</h3>
      <div class="row"><button class="ghost ac_market">在工具箱里打开工具市场</button>${u ? `<button class="ghost ac_link" data-url="${esc(u.urls.my_tools)}">我发布的工具</button>` : ''}</div>
    </div>
    <div class="row ac_foot">${u ? `<button class="ghost ac_link" data-url="${esc(u.urls.panel)}">打开会员中心</button>` : ''}<button class="ghost ac_refresh">刷新</button><button class="ghost ac_logout">退出登录</button></div>`;
  box.querySelector('.ac_market').addEventListener('click', () => { $('account').hidden = true; $('toolbox').hidden = false; renderMarket(); });
  box.querySelector('.ac_refresh').addEventListener('click', () => call('account:refresh').catch((e) => add('note err', `✗ ${esc(e.message)}`, true)));
  box.querySelector('.ac_logout').addEventListener('click', async () => {
    if (await askConfirm('退出 BrowserX 账号？工具箱里已经安装的工具不受影响。')) call('account:logout').catch(() => {});
  });
}
function openAccount(show) {
  $('history').hidden = true;
  $('settings').hidden = true;
  $('toolbox').hidden = true;
  $('account').hidden = !show;
  if (show) { renderAccount(); if (account.loggedIn) call('account:refresh').catch(() => {}); }
}
$('btnAccount').addEventListener('click', () => openAccount($('account').hidden));
api.on('account', (st) => {
  account = st;
  renderAccount();
});
call('account:state').then((st) => { account = st; renderAccount(); }).catch(() => {});

// ---------------------------------------------------------------- 制作工具模式（见 agent.js startMaking/finishMaking）

// 正在制作工具的标签（同一时间最多一个，主进程也会拦）
const makingTabState = () => [...tabState.values()].find((x) => x.making);

function showNewToolForm() {
  const list = $('tb_list');
  list.innerHTML = `<button class="ghost tbback">← 全部工具</button>
    <div class="tbitem tbnew"><div class="tbform">
      <div class="tbhead"><span class="tbname">新建工具</span></div>
      <div class="tbf"><label for="nt_title">工具名（中文） <span class="req">*</span></label><p class="hint">工具箱里显示的名字，例如「保单查询」</p><input id="nt_title" spellcheck="false" maxlength="40"></div>
      <div class="tbf"><label for="nt_name">工具名（英文）</label><p class="hint">字母、数字、下划线，例如 aes_policy；留空自动分配一个 12 位英文数字代码</p><input id="nt_name" spellcheck="false"></div>
      <div class="tbf"><label for="nt_goal">要做什么</label><p class="hint">越具体越好：在哪个网站、输入什么、输出什么</p><textarea id="nt_goal" placeholder="例如：输入保单号，在保诚 AES 查保单详情，返回状况、保费、受保人"></textarea></div>
      <div class="tberr" hidden></div>
      <div class="row"><button class="primary nt_go">开始制作</button></div>
      <p class="hint">会开一个新对话专门做这个工具（当前对话可以在「历史」里找回）。代码先写在草稿里，试运行没问题后点「完成」才放进工具箱。</p>
    </div></div>`;
  list.querySelector('.tbback').addEventListener('click', renderToolboxList);
  list.querySelector('.nt_go').addEventListener('click', async () => {
    const err = list.querySelector('.tberr');
    const name = $('nt_name').value.trim(), title = $('nt_title').value.trim(), goal = $('nt_goal').value.trim();
    err.hidden = true;
    if (!title) { err.hidden = false; err.textContent = '请填写工具名（中文）'; return; }
    if (name && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) { err.hidden = false; err.textContent = '工具名只能用字母、数字、下划线，不能以数字开头'; return; }
    if (!(await beginMaking({ name, title, goal }))) return;
  });
  $('nt_title').focus();
}

// 开一个新对话进入制作模式；失败时把原因显示出来，返回是否成功
async function beginMaking(opts) {
  const mk = makingTabState();
  if (mk) { add('note err', `✗ ${mk === cur ? '' : '另一个标签'}正在制作工具 ${esc(mk.making.name)}，先${mk === cur ? '' : '切过去'}点横幅上的「完成」或「放弃」`, true); $('toolbox').hidden = true; return false; }
  await clearChat();
  try {
    await call('making:start', opts);
    return true;
  } catch (e) {
    add('note err', `✗ ${esc(e.message)}`, true);
    return false;
  }
}

function renderMaking(m) {
  $('makingBar').hidden = !m;
  document.body.classList.toggle('making', !!m);
  if (!m) return;
  $('mk_verb').textContent = m.editing ? '修改' : '制作';
  $('mk_done').textContent = m.streamlining ? '精简中…' : m.editing ? '完成修改' : '完成制作';
  $('mk_done').disabled = !!m.streamlining;
  $('mk_done').title = m.streamlined ? '检查草稿，通过后放进工具箱' : '先让助手把整个过程精简成最终工具，精简完再点一次放进工具箱';
  $('mk_name').textContent = m.title ? `${m.title}（${m.name}）` : m.name;
  $('mk_tested').textContent = m.tested ? '已试运行 ✓' : '';
}

$('mk_rec').addEventListener('click', () => $('recBtn').click());

$('mk_try').addEventListener('click', async () => {
  let t;
  try { t = await call('making:draft'); } catch (e) { add('note err', `✗ ${esc(e.message)}`, true); return; }
  t.draft = true;
  $('history').hidden = true;
  $('settings').hidden = true;
  $('toolbox').hidden = false;
  const list = $('tb_list');
  list.innerHTML = `<button class="ghost tbback">← 返回对话</button>`;
  list.querySelector('.tbback').addEventListener('click', () => { $('toolbox').hidden = true; });
  const d = document.createElement('div');
  d.className = 'tbitem';
  d.innerHTML = `<div class="tbhead"><span class="tbname">试运行草稿：${esc(t.title || t.name)}${t.title ? `<small class="tbid">${esc(t.name)}</small>` : ''}</span></div>${t.description ? `<div class="tbdesc">${esc(t.description)}</div>` : ''}`;
  d.appendChild(buildToolForm(t));
  list.appendChild(d);
});

$('mk_done').addEventListener('click', async () => {
  const opts = {};
  try {
    for (;;) {
      const r = await call('making:finish', opts);
      if (r.done) break;
      if (r.streamline) return; // 先让助手把过程精简成最终工具，精简完再点一次
      if (!(await askConfirm(r.confirm))) return;
      opts[r.need] = true;
    }
    if (!$('toolbox').hidden) renderToolboxList();
  } catch (e) {
    add('note err', `✗ 还不能完成：${esc(e.message)}`, true);
  }
});

$('mk_cancel').addEventListener('click', async () => {
  const making = cur.making;
  if (!making) return;
  const label = making.title ? `${making.title}（${making.name}）` : making.name;
  const editing = making.editing;
  const verb = editing ? '修改' : '制作';
  if (!(await askConfirm(`放弃${verb}工具 ${label}？草稿会被删除，当前对话也会清空${editing ? '；原来的工具不受影响' : ''}。`))) return;
  try {
    await call('making:cancel');
  } catch (e) {
    add('note err', `✗ ${esc(e.message)}`, true);
    return;
  }
  // 放弃后清空对话（结束当前会话，跟「新对话」一样），只留一条说明
  await clearChat();
  add('note', `— 已放弃${verb}工具 ${esc(label)}${editing ? '，原工具没有改动' : ''} —`, true);
  focusInput();
});

$('btnToolbox').addEventListener('click', () => {
  const willShow = $('toolbox').hidden;
  $('history').hidden = true;
  $('settings').hidden = true;
  $('account').hidden = true;
  $('toolbox').hidden = !willShow;
  if (willShow) renderToolboxList();
});

// ---------------------------------------------------------------- 设置

const MODELS = [
  ['claude-sonnet-5', 'Sonnet 5'],
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-fable-5-1', 'Fable 5.1'],
  ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
];
let cfg = {};
function renderModels() {
  const list = MODELS.some(([id]) => id === cfg.model) || !cfg.model ? MODELS : [...MODELS, [cfg.model, cfg.model]];
  $('model').innerHTML = list.map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
  $('model').value = cfg.model || MODELS[0][0];
}
async function setModel(model) {
  cfg = await call('cfg:set', { model });
  renderCfg();
  add('note', `已切换模型：${(MODELS.find(([id]) => id === model) || [, model])[1]}`, true);
}
$('model').addEventListener('change', () => setModel($('model').value).catch((e) => add('note err', `✗ ${esc(e.message)}`, true)));
const TOP = ['apiKey', 'baseUrl', 'model', 'home'];

function renderCfg() {
  renderModels();
  $('cwd').textContent = (cfg.cwd || '').replace(/^\/Users\/[^/]+/, '~');
  $('cwd').title = cfg.cwd || '';
  $('mode').value = cfg.permissionMode || 'auto';
  document.body.classList.toggle('bypass', cfg.permissionMode === 'bypassPermissions');
}

function openSettings() {
  $('settings').hidden = false;
  for (const k of TOP) $('s_' + k).value = cfg[k] || '';
}

$('btnCwd').addEventListener('click', async () => {
  const before = cfg.cwd;
  cfg.cwd = await call('cwd:pick');
  renderCfg();
  if (cfg.cwd !== before) add('note', `工作目录换成 ${esc(cfg.cwd)}，下一条消息开始新对话（历史列表也换成这个目录下的）`, true);
});
$('mode').addEventListener('change', async () => { cfg = await call('cfg:set', { permissionMode: $('mode').value }); renderCfg(); });
$('btnSettings').addEventListener('click', () => {
  $('history').hidden = true;
  $('toolbox').hidden = true;
  $('account').hidden = true;
  $('settings').hidden ? openSettings() : ($('settings').hidden = true);
});
$('btnCloseSettings').addEventListener('click', () => ($('settings').hidden = true));
$('btnSaveSettings').addEventListener('click', async () => {
  const c = {};
  for (const k of TOP) c[k] = $('s_' + k).value.trim();
  if (!c.model) delete c.model;
  cfg = await call('cfg:set', c);
  $('settings').hidden = true;
  renderCfg();
});
// ---------------------------------------------------------------- 浏览器

let navNow = {};
function renderNav(n) {
  navNow = n;
  renderBmAdd();
  if (document.activeElement !== $('url')) $('url').value = n.url || '';
  $('navBack').disabled = !n.canBack;
  $('navForward').disabled = !n.canForward;
  $('navReload').classList.toggle('loading', n.loading);
  $('navReload').title = n.loading ? '停止' : '刷新';
  document.title = n.title ? `${n.title} — BrowserX` : 'BrowserX';
  renderNavError(n);
}
api.on('nav', renderNav);

// 右侧页面加载失败时的说明（原生视图此时被主进程藏起来了，露出 #stage 里的这块）
const NAV_ERRORS = {
  '-400': '这是提交表单后才出现的结果页（比如查询结果）。刷新、后退或前进回到这种页面时需要重新提交表单，浏览器没有自动重新提交，所以打不开。请回到上一页重新查询。',
  '-21': '加载时网络切换了（比如 VPN 或 Wi-Fi 变了）。网络稳定后点「重试」。',
  '-106': '没有网络连接。',
  '-105': '找不到这个网址的服务器，请检查网址是否正确。',
  '-102': '服务器拒绝了连接。',
  '-101': '连接被重置，可能是网络或代理不稳定。',
  '-7': '连接超时。',
  '-118': '连接超时。',
  '-137': '域名解析失败，可能是网络或代理问题。',
};
function renderNavError(n) {
  const e = n.error;
  $('navError').hidden = !e;
  if (!e) return;
  const cert = e.code <= -200 && e.code > -300;
  $('ne_msg').textContent = NAV_ERRORS[e.code] || (cert ? '网站的安全证书有问题，浏览器拒绝打开。' : '页面加载失败。');
  $('ne_detail').textContent = `${e.desc}（${e.code}） ${e.url}`;
  $('ne_back').disabled = !n.canBack;
  $('ne_retry').hidden = e.code === -400; // 表单结果页重试也一样打不开
}
$('ne_back').addEventListener('click', () => call('nav:back'));
$('ne_retry').addEventListener('click', () => call('nav:reload'));
$('ne_home').addEventListener('click', () => call('nav:go', cfg.home || 'https://www.xingke888.com'));
$('urlForm').addEventListener('submit', (e) => { e.preventDefault(); call('nav:go', $('url').value).catch(() => {}); $('url').blur(); });
$('url').addEventListener('focus', () => $('url').select());
$('navBack').addEventListener('click', () => call('nav:back'));
$('navForward').addEventListener('click', () => call('nav:forward'));
$('navReload').addEventListener('click', () => call($('navReload').classList.contains('loading') ? 'nav:stop' : 'nav:reload'));
$('navBookmarks').addEventListener('click', () => setBookmarksShown($('bookmarks').hidden));
// 收藏夹：工具栏按钮显示 / 隐藏地址栏下面的收藏夹栏（记住上次的状态）；收藏存在主进程的 bookmarks.json，所有标签共用。
// 点一个收藏在当前标签打开；悬停出现 × 删除；「收藏本页」在当前页已收藏时变成「已收藏」，再点取消收藏
let bookmarks = [];
const BM_KEY = 'bookmarksShown';
function setBookmarksShown(on) {
  $('bookmarks').hidden = !on;
  $('navBookmarks').classList.toggle('on', on);
  $('navBookmarks').setAttribute('aria-pressed', on);
  const label = on ? '隐藏收藏夹' : '显示收藏夹';
  $('navBookmarks').title = label; $('navBookmarks').setAttribute('aria-label', label);
  try { localStorage.setItem(BM_KEY, on ? '1' : ''); } catch {}
  if (on) loadBookmarks();
}
async function loadBookmarks() {
  try { bookmarks = await call('bookmarks:list'); } catch { bookmarks = []; }
  renderBookmarks();
}
function renderBmAdd() {
  const saved = !!navNow.url && bookmarks.some((b) => b.url === navNow.url);
  const btn = $('bmAdd');
  btn.classList.toggle('saved', saved);
  btn.querySelector('span').textContent = saved ? '已收藏' : '收藏本页';
  btn.title = saved ? '取消收藏当前页面' : '把当前页面加入收藏夹';
  btn.disabled = !/^https?:/i.test(navNow.url || '');
}
function renderBookmarks() {
  const list = $('bmList');
  list.innerHTML = bookmarks.length ? '' : '<span class="bmempty">还没有收藏，点左边「收藏本页」</span>';
  for (const b of bookmarks) {
    const d = document.createElement('div');
    d.className = 'bm';
    d.title = `${b.title}\n${b.url}`;
    d.innerHTML = `<button class="bmgo">${esc(b.title || b.url)}</button><button class="bmx" title="删除这个收藏" aria-label="删除收藏 ${esc(b.title)}">×</button>`;
    d.querySelector('.bmgo').addEventListener('click', () => call('nav:go', b.url).catch(() => {}));
    d.querySelector('.bmx').addEventListener('click', async () => { bookmarks = await call('bookmarks:remove', b.url).catch(() => bookmarks); renderBookmarks(); });
    list.appendChild(d);
  }
  renderBmAdd();
}
$('bmAdd').addEventListener('click', async () => {
  if (!/^https?:/i.test(navNow.url || '')) return;
  const saved = bookmarks.some((b) => b.url === navNow.url);
  try { bookmarks = await call(saved ? 'bookmarks:remove' : 'bookmarks:add', navNow.url, navNow.title); } catch (e) { add('note err', `✗ ${esc(e.message)}`, true); }
  renderBookmarks();
});
try { if (localStorage.getItem(BM_KEY)) setBookmarksShown(true); } catch {}

// 全屏：按钮切换窗口全屏；系统菜单或绿色按钮进出全屏时也同步图标
const FULL_ICON = { off: 'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10', on: 'M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5' };
function renderFull(on) {
  $('winFull').querySelector('path').setAttribute('d', on ? FULL_ICON.on : FULL_ICON.off);
  const label = on ? '退出全屏' : '全屏';
  $('winFull').title = label; $('winFull').setAttribute('aria-label', label);
}
$('winFull').addEventListener('click', () => call('win:fullscreen'));
api.on('fullscreen', renderFull);

// 左上角 logo / 标题：在右侧浏览器打开门户网站
const PORTAL = 'https://www.xingke888.com';
$('brand').addEventListener('click', () => call('nav:go', PORTAL).catch(() => {}));
$('brand').addEventListener('keydown', (e) => { if (e.key === 'Enter') call('nav:go', PORTAL).catch(() => {}); });

// ---------------------------------------------------------------- 网络录制（见 recorder.js）
// 按钮和对话里的 rec_start/rec_stop 工具共用同一个 Recorder，状态通过 agent 的 'rec' 事件同步

let recTimer = null;
function renderRec(s) {
  const on = !!s?.recording;
  $('recBtn').classList.toggle('on', on);
  $('recBtn').setAttribute('aria-label', on ? '停止录制' : '开始录制');
  $('recText').textContent = on ? `停止 · ${s.requests ?? 0}` : '录制';
  $('recMark').hidden = !on;
  $('mk_rec').textContent = on ? '停止录制' : '录制';
  $('mk_rec').classList.toggle('on', on);
  if (!on) recMarkN = 0;
  clearInterval(recTimer);
  recTimer = on ? setInterval(() => call('rec:status').then((x) => { if (x.recording) $('recText').textContent = `停止 · ${x.requests}`; }).catch(() => {}), 1000) : null;
}

$('recBtn').addEventListener('click', async () => {
  const btn = $('recBtn');
  btn.disabled = true;
  try {
    if (!btn.classList.contains('on')) {
      await call('rec:start', {});
      return;
    }
    const r = await call('rec:stop');
    if (cur.making) {
      add('msg ai', md(`**录制结果**\n\`\`\`\n${r.summary}\n\`\`\``), true);
      await call('agent:send', `我刚在右侧浏览器里手工操作并录下了接口，录制文件：${r.file}\n请读这个文件，分析每个接口的作用、token 从哪来、哪些只读哪些会改服务器数据，然后接着做工具 ${cur.making.name}（写到草稿里）。`, cur.id);
      return;
    }
    const d = add('msg ai', `${md(`**录制结果**\n\`\`\`\n${r.summary}\n\`\`\``)}<div style="margin-top:6px"><button class="ghost recuse">交给助手做成工具</button></div>`, true);
    d.querySelector('.recuse').addEventListener('click', () => {
      $('input').value = `我刚在右侧浏览器里手工操作并录下了接口，录制文件：${r.file}\n请读这个文件，分析每个接口的作用、token 从哪来、哪些是只读哪些会改服务器数据，然后告诉我能做成什么工具；我确认后再写进工具箱。`;
      focusInput();
    });
  } catch (e) {
    add('note err', `✗ ${esc(e.message)}`, true);
  } finally {
    btn.disabled = false;
  }
});

// 不用 askText：弹窗居中在整个窗口上，会被右侧原生浏览器视图挡住。自动编号，对话里会留一条带时间的记录
let recMarkN = 0;
$('recMark').addEventListener('click', () => {
  const label = `第 ${++recMarkN} 步`;
  call('rec:mark', label)
    .then(() => add('note', `录制标记：${label}（${new Date().toLocaleTimeString()}）`, true))
    .catch((e) => add('note err', `✗ ${esc(e.message)}`, true));
});

// 浏览器视图（主进程的 WebContentsView）覆盖在 #stage 上
let dragging = false;
function reportBounds() {
  // 拖动时原生视图会吞掉鼠标事件；设置是盖住整个窗口的浮窗，原生视图会挡在它上面——这两种时候都先把浏览器视图藏起来
  if (dragging || !$('settings').hidden) return api.call('bounds', { x: 0, y: 0, width: 0, height: 0 });
  const r = $('stage').getBoundingClientRect();
  api.call('bounds', { x: r.x, y: r.y, width: r.width, height: r.height });
}
new ResizeObserver(reportBounds).observe($('stage'));
window.addEventListener('resize', reportBounds);
// 设置浮窗：打开 / 关闭时更新浏览器视图；点浮窗外面的遮罩或按 Esc 关闭（同「取消」，不保存）
new MutationObserver(reportBounds).observe($('settings'), { attributes: true, attributeFilter: ['hidden'] });
$('settings').addEventListener('click', (e) => { if (e.target === $('settings')) $('settings').hidden = true; });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('settings').hidden) { e.stopPropagation(); $('settings').hidden = true; }
}, true);

// 拖动分隔条调整左侧宽度
const SIDE_KEY = 'sideWidth';
function setSide(w) {
  w = Math.max(340, Math.min(window.innerWidth - 420, w));
  document.documentElement.style.setProperty('--side', w + 'px');
  try { localStorage.setItem(SIDE_KEY, w); } catch {}
}
try { const w = +localStorage.getItem(SIDE_KEY); if (w) setSide(w); } catch {}
$('splitter').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  dragging = true;
  document.body.classList.add('dragging');
  reportBounds();
  const move = (ev) => setSide(ev.clientX);
  const up = () => {
    dragging = false;
    document.body.classList.remove('dragging');
    removeEventListener('pointermove', move); removeEventListener('pointerup', up);
    reportBounds();
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
});

// 左侧铺满整个窗口（隐藏右侧浏览器），再点一下恢复；跟「收起左侧栏」互斥，记住上次的状态
const WIDE_KEY = 'browserCollapsed';
const WIDE_ICON = { off: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5', on: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' };
function setBrowserCollapsed(on) {
  if (on && document.body.classList.contains('side-collapsed')) setSideCollapsed(false);
  document.body.classList.toggle('browser-collapsed', on);
  $('btnWide').querySelector('path').setAttribute('d', on ? WIDE_ICON.on : WIDE_ICON.off);
  const label = on ? '恢复右侧浏览器' : '左侧铺满整个窗口（隐藏右侧浏览器）';
  $('btnWide').title = label; $('btnWide').setAttribute('aria-label', label);
  try { localStorage.setItem(WIDE_KEY, on ? '1' : ''); } catch {}
  reportBounds();
}
$('btnWide').addEventListener('click', () => setBrowserCollapsed(!document.body.classList.contains('browser-collapsed')));

// 收起 / 展开左侧栏（记住上次的状态）
const SIDE_HIDDEN_KEY = 'sideCollapsed';
function setSideCollapsed(on) {
  if (on && document.body.classList.contains('browser-collapsed')) setBrowserCollapsed(false);
  document.body.classList.toggle('side-collapsed', on);
  const label = on ? '展开左侧栏' : '收起左侧栏';
  $('sideToggle').title = label; $('sideToggle').setAttribute('aria-label', label);
  try { localStorage.setItem(SIDE_HIDDEN_KEY, on ? '1' : ''); } catch {}
  reportBounds();
  if (!on) focusInput();
}
$('sideToggle').addEventListener('click', () => setSideCollapsed(!document.body.classList.contains('side-collapsed')));
try { if (localStorage.getItem(SIDE_HIDDEN_KEY)) setSideCollapsed(true); } catch {}
try { if (localStorage.getItem(WIDE_KEY)) setBrowserCollapsed(true); } catch {}

// ---------------------------------------------------------------- 标签（左侧对话 ↔ 右侧浏览器视图，一一对应）

const tabOrder = () => [...tabState.keys()];
const tabLabel = (t) => t.chatTitle || t.pageTitle || '新标签';

function renderTabs() {
  const box = $('tabs');
  const many = tabState.size > 1;
  box.innerHTML = '';
  for (const t of tabState.values()) {
    const d = document.createElement('div');
    d.className = 'tab' + (t === cur ? ' on' : '') + (t.running ? ' run' : '') + (t.attn ? ' attn' : '') + (t.making ? ' mk' : '');
    d.setAttribute('role', 'tab');
    d.setAttribute('aria-selected', t === cur);
    d.tabIndex = 0;
    d.title = [tabLabel(t), t.pageTitle && t.pageTitle !== tabLabel(t) ? t.pageTitle : '', t.url].filter(Boolean).join('\n');
    d.innerHTML = `<span class="tdot" aria-hidden="true"></span><span class="tl">${esc(tabLabel(t))}</span>${many ? '<button class="tx" title="关闭标签（⌘W）" aria-label="关闭标签">×</button>' : ''}`;
    d.addEventListener('click', (e) => { if (!e.target.closest('.tx')) selectTab(t.id); });
    d.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectTab(t.id); });
    d.addEventListener('auxclick', (e) => { if (e.button === 1 && many) closeTab(t.id); }); // 中键关闭
    d.querySelector('.tx')?.addEventListener('click', () => closeTab(t.id));
    box.appendChild(d);
  }
  const plus = document.createElement('button');
  plus.className = 'ghost tnew';
  plus.title = '新标签（⌘T）：新的对话 + 新的浏览器页面';
  plus.setAttribute('aria-label', '新标签');
  plus.textContent = '＋';
  plus.addEventListener('click', () => newTab().catch((e) => add('note err', `✗ ${esc(e.message)}`, true)));
  box.appendChild(plus);
  box.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// 只切界面这一侧：消息区、运行状态、制作横幅、录制按钮；右侧视图由主进程 tab:switch 切换
function showTab(id) {
  const t = tabOf(id);
  if (cur && cur !== t) { cur.el.hidden = true; cur.el.removeAttribute('id'); }
  cur = T = t;
  t.el.id = 'msgs'; // 样式都写在 #msgs 上，当前标签的消息区拿这个 id
  t.el.hidden = false;
  t.attn = false;
  renderRunning();
  renderMaking(t.making);
  renderTabs();
  call('rec:status').then(renderRec).catch(() => {});
}

async function selectTab(id) {
  if (cur?.id === id) return;
  $('history').hidden = true;
  $('toolbox').hidden = true;
  $('settings').hidden = true;
  $('account').hidden = true;
  await call('tab:switch', id);
  showTab(id);
  focusInput();
}

async function newTab() {
  const id = await call('tab:new');
  await selectTab(id);
  return id;
}

async function closeTab(id) {
  const t = tabState.get(id);
  if (!t || tabState.size < 2) return;
  if ((t.running || t.tbRunning) && !(await askConfirm(`「${tabLabel(t)}」还在运行，关闭会中断它。确定关闭吗？`))) return;
  let next;
  try { next = await call('tab:close', id); } catch (e) { add('note err', `✗ ${esc(e.message)}`, true); return; }
  tabState.delete(id);
  t.el.remove();
  if (cur === t) { cur = null; showTab(next); focusInput(); }
  else renderTabs();
}

// 主进程推送各标签的网页标题 / 网址（没有对话标题时标签上显示网页标题）
api.on('tabs', (list) => {
  for (const x of list) {
    const t = tabState.get(x.id);
    if (t) { t.pageTitle = x.title; t.url = x.url; }
  }
  renderTabs();
});

// ⌘T 新标签、⌘W 关闭当前标签、⌘1…⌘9 切换（⌘9 = 最后一个）、⌘⇧[ / ⌘⇧] 上一个 / 下一个
document.addEventListener('keydown', (e) => { if (e.metaKey && !e.altKey && !e.ctrlKey) tabKey(e); });
api.on('tabkey', (k) => tabKey({ ...k, shiftKey: k.shift, preventDefault() {} })); // 焦点在右侧网页里时由主进程转过来
function tabKey(e) {
  if (!cur) return;
  const ids = tabOrder();
  const i = ids.indexOf(cur.id);
  if (e.key === 't' && !e.shiftKey) { e.preventDefault(); newTab().catch((err) => add('note err', `✗ ${esc(err.message)}`, true)); }
  else if (e.key === 'w' && !e.shiftKey) { e.preventDefault(); closeTab(cur.id); }
  else if (/^[1-9]$/.test(e.key) && !e.shiftKey) { e.preventDefault(); selectTab(e.key === '9' ? ids[ids.length - 1] : ids[Number(e.key) - 1] ?? cur.id); }
  else if (e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
    e.preventDefault();
    selectTab(ids[(i + (e.code === 'BracketRight' ? 1 : ids.length - 1)) % ids.length]);
  }
}

call('cfg:get').then((c) => { cfg = c; renderCfg(); });
// 界面刷新（⌘R）后主进程里的标签还在：照原样建回来（对话内容只在界面里，刷新后就没了，跟以前一样）
call('tabs:list').then(async (list) => {
  for (const x of list) Object.assign(tabOf(x.id), { pageTitle: x.title, url: x.url });
  await Promise.all(list.map((x) => call('making:state', x.id).then((m) => { tabOf(x.id).making = m; }).catch(() => {})));
  showTab((list.find((x) => x.current) || list[0]).id);
  call('nav:state').then(renderNav).catch(() => {});
  focusInput();
});
