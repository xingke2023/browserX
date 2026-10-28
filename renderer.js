const $ = (id) => document.getElementById(id);

async function call(ch, ...a) {
  const r = await api.call(ch, ...a);
  if (!r.ok) throw new Error(r.error);
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

const msgs = $('msgs');
let running = false;
const toolEls = new Map();  // tool_use id → 卡片
const permEls = new Map();  // 批准请求 id → 卡片
let textEl = null;
let skills = null;           // 当前会话加载的 skills（来自 init）          // 连续文字合并到一个气泡

function nearBottom() { return msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 60; }
function add(cls, html, force) {
  const stick = force || nearBottom();
  const d = document.createElement('div');
  d.className = cls;
  d.innerHTML = html;
  msgs.appendChild(d);
  if (stick) msgs.scrollTop = msgs.scrollHeight;
  return d;
}

function setRunning(r) {
  running = r;
  $('btnStop').hidden = !r;
  $('status').textContent = r ? '执行中…' : '';
  document.body.classList.toggle('running', r);
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
  toolEls.set(ev.id, d);
}

function toolResult(ev) {
  const d = toolEls.get(ev.id);
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
  d.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => call('agent:permit', ev.id, b.dataset.d).catch(() => {})));
  permEls.set(ev.id, d);
  window.focus();
}

function permissionDone(ev) {
  const d = permEls.get(ev.id);
  if (!d) return;
  d.classList.add('done');
  d.querySelectorAll('[data-d]').forEach((b) => (b.disabled = true));
  d.querySelector('.pr').textContent = { allow: '已允许', always: '已允许（本会话）', deny: '已拒绝' }[ev.decision] || '';
}

// Claude 的 AskUserQuestion：画成可点选的卡片，提交后答案交回 agent.js questionHook
const qEls = new Map();
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
  qEls.set(ev.id, d);

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
    call('agent:answer', ev.id, { answers }).catch(() => {});
  });
  d.querySelector('.qskip').addEventListener('click', () => call('agent:answer', ev.id, null).catch(() => {}));
  window.focus();
}

function questionDone(ev) {
  const d = qEls.get(ev.id);
  if (!d) return;
  qEls.delete(ev.id);
  d.classList.add('done');
  d.querySelectorAll('button, input').forEach((b) => (b.disabled = true));
  d.querySelector('.pr').textContent = ev.answered ? `已回答 · ${d.dataset.summary || ''}` : '已跳过';
}

// 把 resume 拿到的历史文字/工具记录一次性铺进消息区（不触发「运行中」状态）
function renderHistoryEvents(events) {
  for (const ev of events) {
    // 单条历史记录格式有问题也不能让整个恢复流程炸掉——那样连「已载入历史对话」的提示都不会显示
    try {
      if (ev.type !== 'text') textEl = null;
      if (ev.type === 'user') add('msg user', esc(ev.text));
      else if (ev.type === 'text') {
        if (textEl) { textEl.dataset.raw += '\n\n' + ev.text; textEl.innerHTML = md(textEl.dataset.raw); }
        else { textEl = add('msg ai', md(ev.text)); textEl.dataset.raw = ev.text; }
      } else if (ev.type === 'tool') toolCard(ev);
      else if (ev.type === 'tool_result') toolResult(ev);
    } catch (e) { console.error('渲染历史消息失败', ev, e); }
  }
  textEl = null;
}

api.on('agent', (ev) => {
  if (ev.type !== 'text') textEl = null;
  switch (ev.type) {
    case 'user': add('msg user', esc(ev.text), true); setRunning(true); break;
    case 'history':
      msgs.innerHTML = '';
      toolEls.clear(); permEls.clear();
      renderHistoryEvents(Array.isArray(ev.events) ? ev.events : []);
      add('note', '— 已载入历史对话，继续输入将接着聊 —', true);
      setRunning(false);
      break;
    case 'init': skills = ev.skills; break;
    case 'text':
      if (textEl) { textEl.dataset.raw += '\n\n' + ev.text; textEl.innerHTML = md(textEl.dataset.raw); }
      else { textEl = add('msg ai', md(ev.text)); textEl.dataset.raw = ev.text; }
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
        if (making) { add('note err', `✗ 正在制作工具 ${esc(making.name)}，先点横幅上的「完成」或「放弃」`, true); return; }
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
      if (msgs.children.length) add('note', '— 对话已结束，下一条消息将开始新对话 —');
      break;
  }
});

async function sendMsg() {
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  // /skills 是终端界面的命令，SDK 会话里不可用，这里用会话初始化时拿到的列表代替
  if (text === '/skills') {
    if (!skills) add('note', '还没有开始会话。发送任意消息后，再输入 /skills 查看已加载的 skills', true);
    else add('msg ai', md(`**当前会话已加载 ${skills.length} 个 skills：**\n${skills.map((s) => `- \`${s}\``).join('\n')}\n\n直接用自然语言描述任务，助手会自动选用；也可以输入 \`/技能名\` 来调用。`), true);
    return;
  }
  const m = text.match(/^\/model(?:\s+(\S+))?$/);
  if (m) {
    if (m[1]) await setModel(MODELS.find(([id, name]) => name.toLowerCase().replace(/\s/g, '') === m[1].toLowerCase())?.[0] || m[1]).catch(() => {});
    else add('note', `当前模型：${(MODELS.find(([id]) => id === cfg.model) || [, cfg.model])[1]}。用法：/model opus5.5（也可以在设置里切换）`, true);
    return;
  }
  try { await call('agent:send', text); } catch (e) { add('note err', `✗ ${esc(e.message)}`, true); }
}
$('btnSend').addEventListener('click', sendMsg);
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMsg(); }
});
$('btnStop').addEventListener('click', () => call('agent:stop').catch(() => {}));
async function clearChat() {
  $('history').hidden = true;
  $('settings').hidden = true;
  $('toolbox').hidden = true;
  await call('agent:reset').catch(() => {});
  msgs.innerHTML = '';
  toolEls.clear(); permEls.clear();
}
$('btnNew').addEventListener('click', async () => {
  await clearChat();
  focusInput();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && running) call('agent:stop').catch(() => {});
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

async function resumeHistory(id) {
  $('history').hidden = true;
  try {
    await call('history:resume', id);
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
  $('history').hidden = !willShow;
  if (willShow) renderHistoryList();
});

// ---------------------------------------------------------------- 工具箱（自定义工具，直接运行不经过模型）

let tbRunning = false;

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

const tbState = { page: 0, q: '' };
let tbPager = null;
let tbItems = [];

async function renderToolboxList() {
  const list = $('tb_list');
  list.innerHTML = '<div class="hempty">加载中…</div>';
  try { tbItems = await call('tools:list'); } catch (e) { list.innerHTML = `<div class="hempty">${esc(e.message)}</div>`; return; }
  refreshToolTitles(tbItems);
  list.innerHTML = `<div class="tbtop">
      <button class="primary tbnewbtn">＋ 新建工具</button>
      <button class="ghost tbimport" title="导入别人做好的工具（一个 .js 文件）">导入工具</button>
      <input class="tbsearch" type="search" placeholder="搜索工具名或描述" spellcheck="false">
    </div>
    <div class="tbcards"></div>`;
  list.querySelector('.tbnewbtn').addEventListener('click', showNewToolForm);
  list.querySelector('.tbimport').addEventListener('click', pickImportTool);
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
  const shown = tbItems.map((t, i) => ({ t, i })).filter(({ t }) => hit(t));
  box.innerHTML = !tbItems.length ? '<div class="hempty">工具箱是空的——点上面「＋ 新建工具」让助手帮你做一个</div>'
    : !shown.length ? `<div class="hempty">没有找到包含「${esc(tbState.q.trim())}」的工具</div>` : '';
  for (const { t, i } of shown) {
    const d = document.createElement('div');
    d.className = 'tbitem';
    d.innerHTML = `<div class="tbhead"><span class="tbname">${i + 1}、${mark(t.title || t.name)}${t.title ? `<small class="tbid">${mark(t.name)}</small>` : ''}</span><span class="tbacts"><button class="ghost tbedit" title="进入制作模式修改这个工具（改的是草稿，完成前不影响现在的版本）">编辑</button><button class="ghost tbedit tbexport" title="导出成一个 .js 文件，发给别人导入">导出</button></span></div>
      ${t.description ? `<div class="tbdesc">${mark(t.description)}</div>` : ''}`;
    d.querySelector('.tbedit').addEventListener('click', (e) => { e.stopPropagation(); beginMaking({ edit: t.name }); });
    d.querySelector('.tbexport').addEventListener('click', (e) => { e.stopPropagation(); exportTool(t.name); });
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

// launch 工具：不填参数直接运行（工具自己会打开界面，比如填表视窗）
async function launchTool(t) {
  if (tbRunning) return;
  tbRunning = true;
  $('toolbox').hidden = true;
  const label = t.title ? `${t.title}（${t.name}）` : t.name;
  add('note', `— 打开工具 ${esc(label)} —`, true);
  try {
    add('msg ai', md(String(await call('tools:run', t.name, {}))), true);
  } catch (e) {
    add('note err', `✗ ${esc(e.message)}`, true);
  } finally {
    tbRunning = false;
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
    if (tbRunning) { errEl.hidden = false; errEl.textContent = '已经有一个工具在运行，等它跑完'; return; }

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

    tbRunning = true;
    form.querySelector('.tbrun').disabled = true;
    $('toolbox').hidden = true;
    const label = t.title ? `${t.title}（${t.name}）` : t.name;
    add('note', t.draft ? `— 试运行草稿 ${esc(label)}（不经过对话） —` : `— 直接运行工具 ${esc(label)}（不经过对话，省 token） —`, true);
    try {
      const r = await (t.draft ? call('making:run', args) : call('tools:run', t.name, args));
      add('msg ai', md(String(r)), true);
      // 跑完给一个入口：效果不满意就进入修改模式（会开新对话），把这次的参数和结果带过去，用户补一句哪里不好即可
      if (!t.draft) {
        const d = add('note', `工具运行完毕，如果感觉效果不好，<button class="tbtweak">点击修改工具功能</button>`, true);
        d.querySelector('.tbtweak').addEventListener('click', async () => {
          const out = String(r);
          if (!(await beginMaking({ edit: t.name }))) return;
          $('input').value = `刚才直接运行这个工具，参数：${JSON.stringify(args)}\n结果：\n${out.length > 1500 ? out.slice(0, 1500) + '\n…（后面省略）' : out}\n\n效果不好的地方：`;
          focusInput();
        });
      }
    } catch (e) {
      // 直接运行不经过模型，失败了没人会自动修：正式工具直接打开「修改工具」（新对话 + 制作模式），把参数和报错交给助手诊断、改草稿；
      // 草稿试运行失败时本来就在修改中，留在当前对话里让助手接着改
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
      tbRunning = false;
      form.querySelector('.tbrun').disabled = false;
    }
  });
  return form;
}

// ---------------------------------------------------------------- 单个工具导入 / 导出（见 agent.js importPreview / importConfirm）

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
  if (!p) return;
  const list = $('tb_list');
  const risky = p.risks.filter((r) => r.label !== '访问的网址');
  list.innerHTML = `<button class="ghost tbback">← 全部工具</button>
    <div class="tbitem tbimp">
      <div class="tbhead"><span class="tbname">导入：${esc(p.title || p.name)}${p.title ? `<small class="tbid">${esc(p.name)}</small>` : ''}</span></div>${p.description ? `<div class="tbdesc">${esc(p.description)}</div>` : ''}
      <p class="muted">来自 ${esc(p.from)}（${Math.ceil(p.size / 1024)} KB）</p>
      <p class="tbimp-warn">⚠ 工具代码在 BrowserX 里运行，权限跟 BrowserX 一样：能读写你电脑上的文件、用右侧浏览器里已登录的账号操作。只导入你信任的人给的工具，导入前最好看一下源代码。</p>
      ${p.risks.length ? `<div class="tbimp-risks"><b>代码里用到的能力</b>${p.risks.map((r) => `<div class="${r.label === '访问的网址' ? '' : 'risk'}">· ${esc(r.label)}（第 ${r.lines.join('、')} 行${r.more ? ` 等 ${r.more + r.lines.length} 处` : ''}）</div>`).join('')}</div>` : '<p class="muted">没有发现执行命令、读写文件之类的敏感能力。</p>'}
      ${p.exists ? `<label class="tbimp-ow"><input type="checkbox" id="imp_ow"> 工具箱里已经有 ${esc(p.name)}，覆盖它</label>` : ''}
      <details><summary>查看源代码</summary><pre class="tbimp-code">${esc(p.code)}</pre></details>
      <div class="tberr" hidden></div>
      <div class="row"><button class="primary imp_go">${risky.length ? '我已确认，导入' : '导入'}</button><button class="ghost imp_cancel">取消</button></div>
    </div>`;
  list.querySelector('.tbback').addEventListener('click', renderToolboxList);
  list.querySelector('.imp_cancel').addEventListener('click', renderToolboxList);
  list.querySelector('.imp_go').addEventListener('click', async () => {
    const err = list.querySelector('.tberr');
    err.hidden = true;
    if (p.exists && !$('imp_ow').checked) { err.hidden = false; err.textContent = `工具箱里已经有 ${p.name}：要覆盖请勾选上面的「覆盖」，不想覆盖就取消`; return; }
    try {
      await call('tools:importConfirm', { overwrite: p.exists });
      renderToolboxList();
    } catch (e) {
      err.hidden = false;
      err.textContent = e.message;
    }
  });
}

// ---------------------------------------------------------------- 制作工具模式（见 agent.js startMaking/finishMaking）

let making = null;

function showNewToolForm() {
  const list = $('tb_list');
  list.innerHTML = `<button class="ghost tbback">← 全部工具</button>
    <div class="tbitem tbnew"><div class="tbform">
      <div class="tbhead"><span class="tbname">新建工具</span></div>
      <div class="tbf"><label for="nt_name">工具名 <span class="req">*</span></label><p class="hint">字母、数字、下划线，例如 aes_policy</p><input id="nt_name" spellcheck="false"></div>
      <div class="tbf"><label for="nt_title">中文名</label><p class="hint">工具箱里显示的名字，例如「保单查询」；留空让助手起一个</p><input id="nt_title" spellcheck="false" maxlength="40"></div>
      <div class="tbf"><label for="nt_goal">要做什么 <span class="req">*</span></label><p class="hint">越具体越好：在哪个网站、输入什么、输出什么</p><textarea id="nt_goal" placeholder="例如：输入保单号，在保诚 AES 查保单详情，返回状况、保费、受保人"></textarea></div>
      <div class="tberr" hidden></div>
      <div class="row"><button class="primary nt_go">开始制作</button></div>
      <p class="hint">会开一个新对话专门做这个工具（当前对话可以在「历史」里找回）。代码先写在草稿里，试运行没问题后点「完成」才放进工具箱。</p>
    </div></div>`;
  list.querySelector('.tbback').addEventListener('click', renderToolboxList);
  list.querySelector('.nt_go').addEventListener('click', async () => {
    const err = list.querySelector('.tberr');
    const name = $('nt_name').value.trim(), title = $('nt_title').value.trim(), goal = $('nt_goal').value.trim();
    err.hidden = true;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) { err.hidden = false; err.textContent = '工具名只能用字母、数字、下划线，不能以数字开头'; return; }
    if (!goal) { err.hidden = false; err.textContent = '请写一下这个工具要做什么'; return; }
    if (!(await beginMaking({ name, title, goal }))) return;
  });
  $('nt_name').focus();
}

// 开一个新对话进入制作模式；失败时把原因显示出来，返回是否成功
async function beginMaking(opts) {
  if (making) { add('note err', `✗ 正在制作工具 ${esc(making.name)}，先点横幅上的「完成」或「放弃」`, true); $('toolbox').hidden = true; return false; }
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
  making = m;
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
api.on('agent', (ev) => { if (ev.type === 'making') renderMaking(ev.making); });
call('making:state').then(renderMaking).catch(() => {});

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

function renderNav(n) {
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
$('navDevtools').addEventListener('click', () => call('nav:devtools'));
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
api.on('agent', (ev) => { if (ev.type === 'rec') renderRec(ev); });

$('recBtn').addEventListener('click', async () => {
  const btn = $('recBtn');
  btn.disabled = true;
  try {
    if (!btn.classList.contains('on')) {
      await call('rec:start', {});
      return;
    }
    const r = await call('rec:stop');
    if (making) {
      add('msg ai', md(`**录制结果**\n\`\`\`\n${r.summary}\n\`\`\``), true);
      await call('agent:send', `我刚在右侧浏览器里手工操作并录下了接口，录制文件：${r.file}\n请读这个文件，分析每个接口的作用、token 从哪来、哪些只读哪些会改服务器数据，然后接着做工具 ${making.name}（写到草稿里）。`);
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
call('rec:status').then(renderRec).catch(() => {});

// 浏览器视图（主进程的 WebContentsView）覆盖在 #stage 上
let dragging = false;
function reportBounds() {
  if (dragging) return api.call('bounds', { x: 0, y: 0, width: 0, height: 0 }); // 拖动时原生视图会吞掉鼠标事件，先隐藏
  const r = $('stage').getBoundingClientRect();
  api.call('bounds', { x: r.x, y: r.y, width: r.width, height: r.height });
}
new ResizeObserver(reportBounds).observe($('stage'));
window.addEventListener('resize', reportBounds);

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

// 收起 / 展开左侧栏（记住上次的状态）
const SIDE_HIDDEN_KEY = 'sideCollapsed';
function setSideCollapsed(on) {
  document.body.classList.toggle('side-collapsed', on);
  const label = on ? '展开左侧栏' : '收起左侧栏';
  $('sideToggle').title = label; $('sideToggle').setAttribute('aria-label', label);
  try { localStorage.setItem(SIDE_HIDDEN_KEY, on ? '1' : ''); } catch {}
  reportBounds();
  if (!on) focusInput();
}
$('sideToggle').addEventListener('click', () => setSideCollapsed(!document.body.classList.contains('side-collapsed')));
try { if (localStorage.getItem(SIDE_HIDDEN_KEY)) setSideCollapsed(true); } catch {}

call('cfg:get').then((c) => { cfg = c; renderCfg(); });
call('nav:state').then(renderNav).catch(() => {});
focusInput();
