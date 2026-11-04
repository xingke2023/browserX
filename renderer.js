const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 界面多语言（见 i18n.js）
// 屏幕上出现的中文（文字、title、placeholder、aria-label）自动按当前语言换成译文；助手的回复、用户输入、操作卡片里的代码不动。
// 换语言（菜单 / 设置）时主进程发 i18n，从记住的原文重新翻
let TR = (s) => s;
let UI_LANG = 'zh-CN';
// 大数字：按界面语言的习惯缩写（Intl 的 compact 写法：简体「22万」、日文「22万」、韩文「22만」、英文「220K」…）
const fmtBig = (n) => (n >= 10000 ? new Intl.NumberFormat(UI_LANG, { notation: 'compact', maximumFractionDigits: 1 }).format(n) : n.toLocaleString(UI_LANG));
const UI_SKIP = '.msg.ai, .msg.user, pre, code, [data-no-i18n]';
const uiTranslator = BXI18N.domTranslator(() => TR, UI_SKIP);
function setUiLang({ dict, lang }) {
  TR = BXI18N.makeT(dict).tr;
  UI_LANG = lang || 'zh-CN';
  document.body.classList.toggle('ui-latin', !/^(zh|ja|ko)/.test(UI_LANG)); // 字母文字：横幅上的圆按钮放不下，改成椭圆
  // 空对话的提示写在 CSS ::before 里（不是网页文字，自动翻译管不到），按语言写进 CSS 变量
  document.documentElement.style.setProperty('--empty-hint', JSON.stringify(TR('试试输入：「打开 baidu.com 搜索 BrowserX」')));
  if (account?.loggedIn) renderAccount(); // 账号面板里的数字格式跟着换
  uiTranslator.retranslate(document.body);
}
api.call('i18n:get').then((r) => { if (r.ok) { setUiLang(r.data); uiTranslator.observe(document.body); } });
api.on('i18n', setUiLang);

async function call(ch, ...a) {
  const r = await api.call(ch, ...a);
  if (!r.ok) throw Object.assign(new Error(r.error), { url: r.url, label: r.label, quota: r.quota, needLogin: r.needLogin }); // url / needLogin 见 main.js handle()
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
  // 每个标签自己的工具箱内容区（跟消息区一样：当前标签的拿 id="tb_list"，其它的藏起来但不销毁，
  // 所以工具自带的填表页面（iframe）切走再切回来还在，填到一半的内容、正在跑的状态都不丢）
  const tb = document.createElement('div');
  tb.className = 'hlist';
  tb.hidden = true;
  $('toolbox').appendChild(tb);
  // 自带填表页面的工具（宏利计划书这类）：页面放在 pages 里一直活着，回到工具列表只是藏起来；
  // 再点那个工具就回到原来的页面（填到一半的内容、正在跑的状态都在）。pageOpen = 正在看的工具名，null = 看列表
  const pages = document.createElement('div');
  pages.className = 'tbpages';
  pages.hidden = true;
  $('toolbox').appendChild(pages);
  // panel：切走时左侧开着的面板（toolbox / history / account），切回来恢复
  t = { id, el, tb, pages, pageOpen: null, panel: null, toolEls: new Map(), permEls: new Map(), qEls: new Map(), textEl: null, skills: null, running: false, making: null, attn: false, chatTitle: '', pageTitle: '', url: '', tbRunning: false };
  tabState.set(id, t);
  return t;
}
function inTab(t, fn) {
  const prev = T;
  T = t;
  try { return fn(); } finally { T = prev || cur; }
}

function add(cls, html, force) {
  const d = document.createElement('div');
  d.className = cls;
  d.innerHTML = html;
  T.el.appendChild(d);
  autoScroll(force);
  return d;
}
// 有新内容就滚到底部；只有在等用户回答问题 / 批准时不动（那时问题卡片已经滚到眼前，见 showWaiting）
function autoScroll(force) {
  if (force || !waitingCard(T)) T.el.scrollTop = T.el.scrollHeight;
}

function setRunning(r) {
  T.running = r;
  if (T === cur) renderRunning();
  renderTabs();
}
// 还没回答的提问卡片 / 批准卡片（第一张）：有的话助手是在等用户，不是在忙
function waitingCard(t) {
  return [...t.qEls.values()][0] || [...t.permEls.values()].find((d) => !d.classList.contains('done')) || null;
}
// 等你回答时：卡片顶部滚进视野（「提交」可能在下面，但先让人看到问题），状态栏换成醒目的「等你回答」
function showWaiting(d) {
  requestAnimationFrame(() => d.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  if (T === cur) renderRunning();
}
function renderRunning() {
  const waiting = cur.running && !!waitingCard(cur);
  $('btnStop').hidden = !cur.running;
  $('status').textContent = !cur.running ? '' : waiting ? '⏳ 等你回答（点这里看问题）' : '执行中…';
  document.body.classList.toggle('running', cur.running);
  document.body.classList.toggle('waiting', waiting);
  $('mk_ask').hidden = !(cur.making && cur.qEls.size); // 制作横幅：有问题等你回答时，在 RUNNING 左边提示
  $('mk_busy').hidden = !(cur.running && cur.making); // 制作工具时，助手在工作：横幅右上角转圈（跟标签上的一样）
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
  autoScroll();
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
  showWaiting(d);
  window.focus();
}

function permissionDone(ev) {
  const d = T.permEls.get(ev.id);
  if (!d) return;
  d.classList.add('done');
  d.querySelectorAll('[data-d]').forEach((b) => (b.disabled = true));
  d.querySelector('.pr').textContent = { allow: '已允许', always: '已允许（本会话）', deny: '已拒绝' }[ev.decision] || '';
  if (T === cur) renderRunning();
}

// Claude 的 AskUserQuestion：画成可点选的卡片，提交后答案交回 agent.js questionHook
function questionCard(ev) {
  const qs = ev.questions;
  const CN = '一二三四五六七八九十';
  const d = add('perm qcard', `<div class="ph">请您回答以下问题</div>
    ${qs.map((q, i) => `<div class="qq" data-i="${i}">
      <div class="qh"><span class="qno">问题${CN[i] || i + 1}：</span>${esc(q.question)}${q.multiSelect ? '<span class="qmulti">（可多选）</span>' : ''}</div>
      <div class="qopts">
        ${(q.options || []).map((o, j) => `<button class="qopt" data-j="${j}"><span class="qn">${j + 1}.</span><span class="qt"><b>${esc(o.label)}</b>${o.description ? `<small>${esc(o.description)}</small>` : ''}</span></button>`).join('')}
        <button class="qopt qother"><span class="qn">${(q.options || []).length + 1}.</span><span class="qt"><b>其他…</b><small>都不合适，自己写</small></span></button>
        <input class="qother-in" hidden placeholder="写下你的回答">
      </div>
      <pre class="qprev" hidden></pre>
    </div>`).join('')}
    <div class="pb"><button class="primary qsubmit" disabled>提交</button><button class="ghost qskip">跳过</button><span class="pr"></span></div>`, true);
  T.qEls.set(ev.id, d);
  showWaiting(d);

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
  if (T === cur) renderRunning();
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
// 逐字显示：收到一小段就追加到「正在写」的那段消息里；渲染 Markdown 合并到下一帧做，避免每个字都重排
function streamText(text) {
  if (!T.streamEl) { T.streamEl = add('msg ai streaming', ''); T.streamEl.dataset.raw = ''; }
  const el = T.streamEl, tab = T;
  el.dataset.raw += text;
  if (el._raf) return;
  el._raf = requestAnimationFrame(() => {
    el._raf = 0;
    if (!el.classList.contains('streaming')) return; // 已经定稿
    el.innerHTML = md(el.dataset.raw);
    inTab(tab, () => autoScroll());
  });
}
function endStream() {
  const el = T.streamEl;
  T.streamEl = null;
  if (!el) return;
  el.classList.remove('streaming');
  if (el.dataset.raw.trim()) el.innerHTML = md(el.dataset.raw); else el.remove();
}
function onAgentEvent(ev) {
  if (ev.type !== 'text' && ev.type !== 'text_delta') T.textEl = null;
  if (ev.type !== 'text' && ev.type !== 'text_delta' && T.streamEl) endStream(); // 正在逐字写的那段被别的事件打断（比如停止）：按已收到的定稿
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
    case 'text_delta': streamText(ev.text); break;
    case 'making_tested': { // 助手自己测试草稿通过（agent.makingTest）：给一个保存按钮，也可以换参数再试
      const args = Object.entries(ev.args || {}).filter(([k]) => k !== '_form').map(([k, v]) => `${k} = ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('，');
      const d = add('note mksave mktested', `<div class="nhd">✓ 助手测试通过${args ? `<span class="muted">（${esc(args.slice(0, 160))}）</span>` : ''}</div>
        <div class="mkres">${esc(String(ev.text).slice(0, 600))}</div>
        <div class="row"><button class="primary mksavebtn">${T.making?.editing ? '保存修改' : '保存到工具箱'}</button><button class="ghost mktrybtn">换个参数试试</button><span class="muted">不满意直接在下面说哪里要改</span></div>`, true);
      d.querySelector('.mksavebtn').addEventListener('click', (e) => { if (!cur.making) { e.currentTarget.disabled = true; return; } $('mk_done').click(); });
      d.querySelector('.mktrybtn').addEventListener('click', () => $('mk_try').click());
      break;
    }
    case 'sched': // 定时任务在这个（后台）对话里跑（见 main.js runScheduled）
      if (!T.chatTitle) { T.chatTitle = '定时任务'; renderTabs(); }
      if (ev.phase === 'start') add('note', `— 定时任务：${esc(ev.title)} 开始运行（${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}，不经过对话） —`, true);
      else if (ev.ok) add('msg ai', md(String(ev.text)), true);
      else add('note err', `✗ 定时任务 ${esc(ev.title)} 失败：${esc(ev.text)}`, true);
      break;
    case 'rec_suggest': if (T === cur && cur.making) showRecAsk(); break;
    case 'rec_result': add('msg ai', md(`**录制结果**\n\`\`\`\n${ev.summary}\n\`\`\``), true); break; // 制作工具时录制停止（见 agent.finishMakingRec）
    case 'text': {
      // 整段写完：逐字显示的那段换成完整文字（以完整消息为准）；跟上一段文字之间没有操作卡片就并成一段
      const el = T.streamEl;
      if (el) { T.streamEl = null; el.classList.remove('streaming'); }
      if (T.textEl) {
        T.textEl.dataset.raw += '\n\n' + ev.text; T.textEl.innerHTML = md(T.textEl.dataset.raw);
        el?.remove();
      } else if (el) {
        el.dataset.raw = ev.text; el.innerHTML = md(ev.text); T.textEl = el;
      } else { T.textEl = add('msg ai', md(ev.text)); T.textEl.dataset.raw = ev.text; }
      autoScroll();
      break;
    }
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
    case 'note': {
      // tone：比如 intro（制作工具的流程说明：正文颜色，第一行当标题、字大一些）
      const tone = (ev.tone || '').replace(/[^\w-]/g, '');
      if (tone === 'intro') { // 第一行当标题；最后一句问用户的话（以「？」结尾）加粗
        const [hd, ...rest] = String(ev.text).split('\n');
        const q = /？\s*$/.test(rest[rest.length - 1] || '') ? rest.pop() : '';
        // 每行单独一个元素：界面翻译按行对词条（整段多行对不上）
        const lines = rest.join('\n').replace(/\n+$/, '').split('\n').map((l) => `<div class="nl">${esc(l) || '&nbsp;'}</div>`).join('');
        add('note intro', `<div class="nhd">${esc(hd)}</div>${lines}${q ? `<div class="nq">${esc(q)}</div>` : ''}`, true);
      }
      else if (ev.file) { // 下载完成：带一个「在访达中显示」
        const d = add('note', `${esc(ev.text)} <button class="ghost dl_show">在访达中显示</button>`, true);
        d.querySelector('.dl_show').addEventListener('click', () => call('downloads:show', ev.file).catch(() => {}));
      }
      else add('note' + (tone ? ` ${tone}` : ''), esc(ev.text), true);
      break;
    }
    case 'tool_done': {
      refreshToolTitles();
      // 工具制作完成：带一个「继续修改」，在当前对话里重新进入编辑（不清空对话）
      const d = add('note', `${esc(ev.text)}<div style="margin-top:6px"><button class="ghost tbcont">继续修改</button></div>`, true);
      d.querySelector('.tbcont').addEventListener('click', () => {
        const mk = makingTabState();
        if (mk) { add('note err', `✗ 正在制作工具「${esc(mk.making.title || '新工具')}」，先点横幅上的「保存」或「不做了」`, true); return; }
        call('making:continue', ev.name).catch((e) => add('note err', `✗ ${esc(e.message)}`, true));
      });
      break;
    }
    case 'quota': quotaNote(T); break;
    case 'done':
      setRunning(false);
      if (ev.quota) break; // 额度用完：上面已经有 quota 提示了
      if (ev.error) add('note err', `✗ ${esc(ev.error)}`);
      else add('note', '✓ 当前命令完成，如有需要请继续输入指令');
      break;
    case 'error': add('note err', `✗ ${esc(ev.text)}`); break;
    case 'reset':
      setRunning(false);
      if (T.quietReset) T.quietReset = false; // 换工具时开的新会话：freshChatForTool 自己加分隔线
      else if (T.el.children.length) add('note', '— 对话已结束，下一条消息将开始新对话 —');
      break;
    case 'making':
      T.making = ev.making;
      if (T === cur) renderMaking(cur.making);
      renderTabs();
      break;
    case 'rec':
      if (T === cur) renderRec(ev);
      break;
    case 'prefill': // 制作工具：表单里填的「要做什么」放进发送框，等用户确认后自己发
      if (T === cur) { $('input').value = ev.text; focusInput(); }
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
  try { await call('agent:send', text, cur.id); } catch (e) { add('note err', errWithLink(e), true); }
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
// 从工具箱换一个工具：让助手从新会话开始（之前的对话不再每次请求都带上，省 token；旧会话在「历史」里），
// 界面上的内容不删（直接运行工具的结果不在「历史」里，删了就找不回来），插一条分隔线；对话区只留最近 MAX_CHAT_ITEMS 条，长时间用也不卡。
// 助手还在回复、有工具在跑、在制作工具时不动（会打断正在做的事）
const MAX_CHAT_ITEMS = 300;
async function freshChatForTool(tool) {
  const t = cur;
  if (t.running || t.tbRunning || t.making) return;
  t.quietReset = true;
  await call('agent:reset', t.id).catch(() => { t.quietReset = false; });
  t.toolEls.clear(); t.permEls.clear(); // 旧会话里的操作卡片不会再有结果回来
  if (!t.el.children.length) return;
  add('note sessionsep', `—— 新会话：${esc(tool.title || tool.name)}（之前的对话不再发给助手，省 token） ——`, true);
  while (t.el.children.length > MAX_CHAT_ITEMS) t.el.firstElementChild.remove();
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
// 市场工具的新版本（main.js checkToolUpdates）：name → { version, from, changelog, can_install, reason, needsConfirm }
let toolUpdates = {};
let autoUpdateTools = true;
call('tools:updates').then((u) => { toolUpdates = u || {}; }).catch(() => {});
call('cfg:get').then((c) => { autoUpdateTools = c.autoUpdateTools !== false; }).catch(() => {});
api.on('toolUpdates', (u) => {
  toolUpdates = u || {};
  if (!$('toolbox').hidden && $('tb_list').querySelector('.tbcards')) drawToolCards();
});
// 点「更新」：直接装新版本；新版本多用了敏感能力时，改走跟安装一样的确认页
async function updateTool(t, btn, batch = false) {
  const u = toolUpdates[t.name];
  if (!u) return;
  btn.disabled = true;
  btn.textContent = '更新中…';
  try {
    const r = await call('tools:update', t.name);
    if (r?.needsConfirm) {
      add('note warn', `「${esc(t.title || t.name)}」的新版本 ${esc(u.version)} 比旧版本多用了这些能力：${esc((r.added || []).join('、'))}，请在确认页上看一下再安装`, true);
      showImportPreview(await call('market:install', u.id), { update: true });
      return; // 工具箱里现在是确认页：不重画列表（会把确认页盖掉）
    }
  } catch (e) { add('note err', errWithLink(e), true); }
  if (batch) return;
  btn.disabled = false;
  btn.textContent = '更新';
  renderToolboxList();
}

// 收藏的工具（按工具名）：存在本机 localStorage，只影响工具箱里的「收藏」筛选
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
  autoUpdateTools = (await call('cfg:get').catch(() => ({}))).autoUpdateTools !== false;
  refreshToolTitles(tbItems);
  list.innerHTML = `<div class="tbtop">
      <button class="primary tbnewbtn">新建工具</button>
      <button class="ghost tbimport" title="导入别人做好的工具（一个 .js 文件）">导入</button>
      <button class="ghost tbmarketbtn" title="在 BrowserX 网站的插件市场里找工具、直接安装">插件市场</button>
      <button class="ghost tbfavbtn" title="只显示收藏的工具（在工具卡片上点 ☆ 收藏）">收藏</button>
      <button class="ghost tbschedbtn" title="查看、暂停、删除定时运行的工具">定时任务</button>
      <input class="tbsearch" type="search" placeholder="搜索工具名或描述" spellcheck="false">
      <label class="tbauto" title="从插件市场装的工具，作者发布的新版本审核通过后自动更新（新版本多用了敏感能力时会先问你）"><input type="checkbox" class="tbautochk"${autoUpdateTools ? ' checked' : ''}> 自动更新工具</label>
    </div>
    <div class="tbupdbar" hidden></div>
    <div class="tbcards"></div>`;
  list.querySelector('.tbnewbtn').addEventListener('click', showNewToolForm);
  list.querySelector('.tbimport').addEventListener('click', pickImportTool);
  list.querySelector('.tbmarketbtn').addEventListener('click', () => renderMarket());
  list.querySelector('.tbschedbtn').addEventListener('click', () => renderSchedules());
  list.querySelector('.tbautochk').addEventListener('change', (e) => { autoUpdateTools = e.target.checked; call('tools:autoUpdate', autoUpdateTools).catch(() => {}); });
  call('tools:checkUpdates').catch(() => {}); // 打开工具箱时顺便查一次新版本（结果通过 toolUpdates 事件回来）
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
  // 有新版本的工具：顶部一行汇总 +「全部更新」，有更新的排在最前面（序号不变）
  const upNames = tbItems.filter((t) => toolUpdates[t.name]).map((t) => t.name);
  const bar = list.querySelector('.tbupdbar');
  bar.hidden = !upNames.length;
  if (upNames.length) {
    const can = upNames.filter((n) => toolUpdates[n].can_install);
    bar.innerHTML = `<span>${upNames.length} 个工具有新版本</span>${can.length ? '<button class="primary tbupdall">全部更新</button>' : ''}`;
    bar.querySelector('.tbupdall')?.addEventListener('click', async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      for (const n of can) { const t = tbItems.find((x) => x.name === n); b.textContent = `正在更新 ${t.title || n}…`; await updateTool(t, b, true); }
      renderToolboxList();
    });
  }
  shown.sort((a, b) => (toolUpdates[b.t.name] ? 1 : 0) - (toolUpdates[a.t.name] ? 1 : 0));
  box.innerHTML = !tbItems.length ? '<div class="hempty">工具箱是空的——点上面「新建工具」让助手帮你做一个</div>'
    : tbState.fav && !tbItems.some((t) => tbFavs.has(t.name)) ? '<div class="hempty">还没有收藏的工具——点工具卡片右上角的 ☆ 收藏，再点「收藏」回到全部工具</div>'
    : !shown.length ? `<div class="hempty">没有找到包含「${esc(tbState.q.trim())}」的工具</div>` : '';
  for (const { t, i } of shown) {
    const d = document.createElement('div');
    d.className = 'tbitem';
    d.dataset.tool = t.name;
    const upd = toolUpdates[t.name];
    const updHtml = upd ? `<span class="tbupd" title="${esc(upd.changelog ? `更新内容：${upd.changelog}` : '作者发布了新版本')}">有新版本 ${esc(upd.version)}</span>${upd.can_install ? '<button class="primary tbedit tbupdbtn" title="更新到新版本">更新</button>' : `<span class="tbupdno" title="${esc(upd.reason || '')}">${esc(upd.reason || '暂时不能更新')}</span>`}` : '';
    d.innerHTML = `<div class="tbhead"><span class="tbname">${i + 1}、${mark(t.title || t.name)}${t.title ? `<small class="tbid">${mark(t.name)}</small>` : ''}${updHtml}</span><span class="tbacts"><button class="ghost tbedit tbfav${tbFavs.has(t.name) ? ' on' : ''}" title="${tbFavs.has(t.name) ? '取消收藏' : '收藏'}">${tbFavs.has(t.name) ? '★' : '☆'}</button>${t.market ? '<span class="tbmk" title="从插件市场安装的别人的工具：不能编辑、导出、发布">市场</span>' : '<button class="ghost tbedit tbeditbtn" title="进入制作模式修改这个工具（改的是草稿，完成前不影响现在的版本）">编辑</button><button class="ghost tbedit tbexport" title="导出成一个 .js 文件，发给别人导入">导出</button><button class="ghost tbedit tbpublish" title="发布到 BrowserX 网站的插件市场（进入审核）">发布</button>'}<button class="ghost tbedit tbdel" title="从工具箱删除（文件移到废纸篓，可以恢复）">删除</button></span></div>
      ${t.description ? `<div class="tbdesc" title="${esc(t.description)}">${mark(t.description)}</div>` : ''}`;
    d.querySelector('.tbeditbtn')?.addEventListener('click', (e) => { e.stopPropagation(); beginMaking({ edit: t.name }); });
    d.querySelector('.tbfav').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFav(t.name);
      // 在「收藏」筛选里取消收藏会让这张卡消失，整体重画；否则只改按钮，不打断已展开的表单
      if (tbState.fav && !d.querySelector('.tbform')) { drawToolCards(); return; }
      const on = tbFavs.has(t.name);
      e.currentTarget.classList.toggle('on', on);
      e.currentTarget.textContent = on ? '★' : '☆';
      e.currentTarget.title = on ? '取消收藏' : '收藏';
    });
    d.querySelector('.tbupdbtn')?.addEventListener('click', (e) => { e.stopPropagation(); updateTool(t, e.currentTarget); });
    d.querySelector('.tbexport')?.addEventListener('click', (e) => { e.stopPropagation(); exportTool(t.name); });
    d.querySelector('.tbpublish')?.addEventListener('click', (e) => { e.stopPropagation(); showPublishForm(t); });
    d.querySelector('.tbdel').addEventListener('click', (e) => { e.stopPropagation(); deleteTool(t); });
    // 点开一个工具只显示它自己（其它工具、搜索栏、分页栏藏起来），再点一次卡片或「全部工具」回到原来那一页
    d.addEventListener('click', (e) => {
      if (e.target.closest('button, .tbform')) return;
      // 换一个工具：助手开新会话（省 token）；回到这个标签里已经开着的同一个工具页面不用
      const reopen = [...cur.pages.children].some((x) => x.dataset.tool === t.name);
      (reopen ? Promise.resolve() : freshChatForTool(t)).then(() => {
        if (t.launch) { launchTool(t); return; } // 自带界面的工具：点一下直接运行，不显示参数表单
        openToolPage(t); // 打开（或回到）这个标签里一直活着的工具页面：自带网页的显示网页，其它的显示标准表单（formSpec 或按 params 自动生成）
      });
    });
    box.appendChild(d);
  }
  tbPager = makePager(box, '.tbitem', 5, tbState); // 描述是多行完整显示的，每页放少一点
  markOpenPages();
}

// 打开工具自带的填表页面：每个标签每个工具一份，建一次就一直留着（藏起来不销毁，iframe 不会重新加载）
function openToolPage(tool) {
  const tab = cur;
  let pg = [...tab.pages.children].find((x) => x.dataset.tool === tool.name);
  if (!pg) {
    pg = document.createElement('div');
    pg.className = 'tbkeep';
    pg.dataset.tool = tool.name;
    pg.dataset.title = tool.title || tool.name;
    pg.innerHTML = `<div class="tbitem tbhaspage"><div class="tbhead tbfoldhead" title="点一下收起 / 展开表单"><span class="tbname">${esc(tool.title || tool.name)}${tool.title ? `<small class="tbid">${esc(tool.name)}</small>` : ''}</span><span class="tbsum"></span><button class="ghost tbfold" type="button">收起 ▴</button></div></div>`;
    pg.querySelector('.tbitem').appendChild(tool.hasForm ? buildToolPage(tool) : buildDynamicForm(tool));
    // 收起：只留标题行（后面一行填了什么的摘要），下面的对话区拿到全部空间；点标题行或「展开」回来，填的都在
    pg.querySelector('.tbfoldhead').addEventListener('click', () => setFolded(pg, !pg.classList.contains('folded')));
    tab.pages.appendChild(pg);
  }
  for (const x of tab.pages.children) x.hidden = x !== pg;
  tab.pageOpen = tool.name;
  tab.tb.hidden = true;
  tab.pages.hidden = false;
  $('toolbox').classList.add('haspage');
  $('toolbox').classList.toggle('folded', pg.classList.contains('folded'));
}

// 收起 / 展开填表页面（每个标签每个工具各记各的）；收起时标题行显示摘要：动态表单里现在选的、填的
function setFolded(pg, on) {
  pg.classList.toggle('folded', on);
  pg.querySelector('.tbfold').textContent = on ? '展开 ▾' : '收起 ▴';
  const f = pg.querySelector('.tbdyn');
  pg.querySelector('.tbsum').textContent = on && f ? formSummary(f) : '';
  if (pg.closest('.tbpages') === cur.pages && !pg.hidden) $('toolbox').classList.toggle('folded', on);
}
function formSummary(form) {
  const out = [];
  for (const d of form.querySelectorAll(':scope > .tbf')) {
    const chip = d.querySelector('.dynchip.on'), sel = d.querySelector('select'), cb = d.querySelector('input[type=checkbox]'), inp = d.querySelector('input:not([type=checkbox])');
    const lb = d.querySelector('label'); // 勾选框的字在 label > span 里；别的 label 里那个 span 是必填的红星
    const label = (lb?.classList.contains('tbcheck') ? lb.querySelector('span') : lb)?.textContent.replace('*', '').trim();
    if (chip) continue; // 分类：产品名已经说明了
    if (sel) out.push(sel.selectedOptions[0]?.textContent || '');
    else if (cb) { if (cb.checked) out.push(label); }
    else if (inp && inp.value !== '') out.push(/^\d/.test(inp.value) && label && !/年齡|歲/.test(label) ? `${label} ${inp.value}` : inp.value);
  }
  // 「金額方式：保額」后面紧跟「保額 500000」：前一项是后一项的开头就省掉
  return out.filter((x, i) => x && !(out[i + 1] || '').startsWith(x + ' ')).join(' · ');
}

// 回到工具列表（填表页面藏起来，不销毁）
function showToolList() {
  cur.pageOpen = null;
  cur.pages.hidden = true;
  cur.tb.hidden = false;
  $('toolbox').classList.remove('haspage', 'folded');
  if ($('tb_list').querySelector('.tbcards')) markOpenPages();
}

// 列表里标出这个标签已经开着页面的工具（再点就回到那个页面）
function markOpenPages() {
  const open = new Set([...cur.pages.children].map((x) => x.dataset.tool));
  for (const d of $('tb_list').querySelectorAll('.tbitem[data-tool]')) {
    d.querySelector('.tbopen')?.remove();
    if (open.has(d.dataset.tool)) d.querySelector('.tbname').insertAdjacentHTML('beforeend', '<span class="tbopen" title="这个标签里已经开着它的页面，点一下回到那个页面">已打开</span>');
  }
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

// 没写 formSpec 的工具：按 params（agent.js listCustomTools 内省出来的）生成标准表单字段。
// 标题取参数说明的第一小段（到第一个冒号 / 逗号 / 括号为止，太长就用参数名），完整说明放悬停提示
const KEY_LABELS = { json: '原始 JSON', open: '打开详情页', csv: '导出 CSV', download: '存成文件', publish: '直接发表', draftOnly: '只存草稿', topics: '话题', tags: '标签', days: '天数', images: '图片', all: '全部年度', limit: '数量', page: '页码', keyword: '关键词', q: '搜索', url: '网址', file: '文件', path: '路径', date: '日期', from: '从', to: '到', start: '开始', end: '结束' };
function paramsToFields(params, values) {
  const short = (p) => {
    // 去掉「true 时 / true 则 / true 才会」「可选，」这类开头，再取第一小段；勾选框的字在框旁边，可以长一点
    const d = String(p.description || '').replace(/^(true|false)\s*(時|时|則|则|才會|才会)?\s*/i, '').replace(/^(可选|選填|选填|可選|必填)[，,：:]?\s*/, '');
    const first = d.split(/[：:，,（(；;。\n]/)[0].trim();
    if (first && first.length <= (p.kind === 'boolean' ? 10 : 8)) return first;
    return KEY_LABELS[p.key] || p.key; // 说明太长：常见参数名用固定的中文名
  };
  return params.map((p) => {
    const f = { key: p.key, label: short(p), title: p.description || '', required: p.required, param: p.kind, value: values[p.key] };
    if (p.kind === 'boolean') return { ...f, kind: 'boolean', value: !!values[p.key] };
    if (p.kind === 'enum') return { ...f, kind: 'enum', options: [...(p.required ? [] : [{ value: '', label: '（不选）' }]), ...(p.enumValues || []).map((v) => ({ value: v, label: v }))] };
    if (p.kind === 'number') return { ...f, kind: 'number' };
    if (p.kind === 'string') return { ...f, kind: 'string' };
    return { ...f, kind: 'text', full: true, placeholder: p.kind === 'array' ? '一行一个' : '按 JSON 格式填' };
  });
}

// 动态表单：字段由工具的 formSpec(当前值, ctx) 算出来（见 agent.js toolFormSpec）。refresh 的字段一改（'input' = 打字时就算），
// 带着全部当前值重新调 formSpec 重画，所以选项依赖、显示隐藏、联动默认值这些逻辑都写在工具里（任意 JS）。
// 值按标签记住（tab.formValues），重画、再次打开都保留；提交时 run(值 + { _form: true })。
// kind 'hidden'：不显示、只记值，工具用它在两次 formSpec 之间记状态
function buildDynamicForm(t) {
  const tab = cur;
  tab.formValues ||= {};
  const values = tab.formValues[t.name] ||= {};
  const form = document.createElement('div');
  form.className = 'tbform tbdyn';
  form.innerHTML = '<div class="muted">正在读取表单…</div>';
  let seq = 0, timer = null, submit = '运行';
  const fid = (key) => `dyn_${tab.id}_${t.name}_${key}`.replace(/[^\w-]/g, '_');

  const readField = (f, el) => {
    if (f.kind === 'boolean') return el.checked;
    if (f.kind === 'number') return el.value.trim() === '' ? null : Number(el.value);
    return el.value;
  };
  async function load() {
    const my = ++seq;
    let spec;
    if (!t.dynamic) { // 没写 formSpec：按 params 生成（标题取说明的第一小段，完整说明放悬停提示）
      submit = t.draft ? '试运行' : '运行';
      draw(paramsToFields(t.params || [], values));
      return;
    }
    try { spec = await (t.draft ? call('making:formSpec', values) : call('tools:formSpec', t.name, values, tab.id)); } // 草稿还不在工具箱里，从草稿读
    catch (e) { if (my === seq) form.innerHTML = `<div class="tberr">✗ ${esc(e.message)}</div><div class="row"><button class="ghost dyn_retry">重试</button></div>`; form.querySelector('.dyn_retry')?.addEventListener('click', load); return; }
    if (my !== seq) return; // 有更新的一次在路上，这次的结果丢掉
    submit = spec.submit || '运行';
    draw(spec.fields);
  }
  const later = (ms) => { clearTimeout(timer); timer = setTimeout(load, ms); };

  function draw(fields) {
    const focus = document.activeElement?.closest?.('.tbdyn') === form ? document.activeElement.id : null;
    const html = fields.map((f) => {
      const id = fid(f.key || ''), req = f.required ? ' <span class="req">*</span>' : '';
      const hint = f.hint ? `<p class="hint">${esc(f.hint)}</p>` : '';
      // 宽度跟着内容：下拉按最长的选项、数字按位数（max 的位数，或 width 指定几个字），一行能放几个放几个；full 占整行
      const cls = `tbf${f.full || f.span === 'full' ? ' full' : ''}`;
      const chars = f.width || (f.kind === 'number' ? Math.max(String(f.max ?? '').length, String(f.value ?? '').length, 3) + 1 : f.kind === 'string' ? 12 : null);
      if (f.kind === 'hidden') return ''; // 不显示，只记住值（工具用来记状态，比如上次选的产品）
      if (f.kind === 'section') return `<div class="dynsec">${esc(f.label || '')}</div>`;
      if (f.kind === 'note') return `<div class="dynnote${f.tone ? ' ' + esc(f.tone) : ''}">${esc(f.text || f.label || '')}</div>`;
      // chips：单选的胶囊按钮（选项不多、想一眼看全时用，比如产品类别）
      if (f.kind === 'chips') return `<div class="tbf full"><label>${esc(f.label || f.key)}${req}</label>${hint}<div class="dynchips" id="${id}" role="radiogroup" aria-label="${esc(f.label || f.key)}">${(f.options || []).map((o) => { const v = typeof o === 'object' ? o.value : o, l = typeof o === 'object' ? (o.label ?? o.value) : o, on = String(v) === String(f.value ?? ''); return `<button type="button" class="dynchip${on ? ' on' : ''}" role="radio" aria-checked="${on}" data-v="${esc(v)}">${esc(l)}</button>`; }).join('')}</div></div>`;
      if (f.kind === 'boolean') return `<div class="${cls}"${f.title ? ` title="${esc(f.title)}"` : ''}><label class="tbcheck"><input type="checkbox" id="${id}"${f.value ? ' checked' : ''}><span>${esc(f.label || f.key)}${req}</span></label>${hint}</div>`;
      let control;
      const attrs = `id="${id}"${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}${f.disabled ? ' disabled' : ''}${chars ? ` style="--w:${chars}"` : ''}`;
      if (f.kind === 'enum') control = `<select ${attrs}>${(f.options || []).map((o) => { const v = typeof o === 'object' ? o.value : o, l = typeof o === 'object' ? (o.label ?? o.value) : o; return `<option value="${esc(v)}"${String(v) === String(f.value ?? '') ? ' selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`;
      else if (f.kind === 'text') control = `<textarea ${attrs}>${esc(f.value ?? '')}</textarea>`;
      else control = `<input ${attrs}${f.kind === 'number' ? ` type="number"${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''}${f.step != null ? ` step="${f.step}"` : ''}` : ''} value="${esc(f.value ?? '')}">`;
      return `<div class="${cls}"${f.title ? ` title="${esc(f.title)}"` : ''}><label for="${id}">${esc(f.label || f.key)}${req}</label>${hint}${control}</div>`;
    }).join('');
    form.innerHTML = `${html}<div class="tberr" hidden></div><div class="row"><button class="primary tbrun"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg><span>${esc(submit)}</span></button>${t.draft ? '' : '<button class="ghost tbsched" title="按表单上现在填的内容，每天 / 工作日定时或每隔一段时间自动运行（BrowserX 开着时）"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg><span>定时运行</span></button>'}</div>`;
    for (const f of fields) {
      if (!f.key || f.kind === 'note' || f.kind === 'section') continue;
      if (f.kind === 'hidden') { values[f.key] = f.value; continue; }
      const el = form.querySelector('#' + fid(f.key));
      if (f.kind === 'chips') {
        values[f.key] = f.value ?? '';
        for (const b of el.querySelectorAll('.dynchip')) b.addEventListener('click', () => {
          for (const x of el.querySelectorAll('.dynchip')) { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); }
          values[f.key] = b.dataset.v;
          if (f.refresh) later(0);
        });
        continue;
      }
      values[f.key] = f.kind === 'boolean' ? !!f.value : f.value ?? (f.kind === 'number' ? null : ''); // 工具给的值（含它算出来的默认值）为准
      el.addEventListener(f.kind === 'boolean' || f.kind === 'enum' ? 'change' : 'input', () => {
        values[f.key] = readField(f, el);
        // 输入框跟着内容变宽：始终放得下现在的内容再多一个字（金额多打几位也看得全）
        if (el.tagName === 'INPUT' && el.type !== 'checkbox') el.style.setProperty('--w', Math.max(Number(el.style.getPropertyValue('--w')) || 0, String(el.value).length + 1));
        if (f.refresh === 'input') later(250);
        else if (f.refresh && (f.kind === 'boolean' || f.kind === 'enum')) later(0);
      });
      if (f.refresh === true && f.kind !== 'boolean' && f.kind !== 'enum') el.addEventListener('change', () => later(0)); // 数字 / 文字：改完离开再算
    }
    if (focus) form.querySelector('#' + focus)?.focus();
    // 把表单上现在的内容变成工具参数（运行、定时运行共用）；不合法时在表单上显示原因，返回 null
    const collect = () => {
      const errEl = form.querySelector('.tberr');
      errEl.hidden = true;
      const fail = (msg) => { errEl.hidden = false; errEl.textContent = msg; return null; };
      for (const f of fields) {
        if (!f.key || !f.required) continue;
        const v = values[f.key];
        if (v == null || v === '' || Number.isNaN(v)) return fail(`「${f.label || f.key}」是必填的`);
      }
      const send = {}; // 只提交现在表单上有的字段（藏起来的字段的旧值不带上）
      for (const f of fields) if (f.key && f.kind !== 'note' && f.kind !== 'section') send[f.key] = values[f.key];
      if (t.dynamic) return { ...send, _form: true };
      // 按 params 生成的表单：转成参数要的类型；选填留空不传
      const args = {};
      for (const f of fields) {
        if (!f.key) continue;
        const v = send[f.key];
        if (f.kind === 'boolean') { args[f.key] = !!v; continue; }
        if (v == null || v === '' || Number.isNaN(v)) continue;
        if (f.param === 'array') args[f.key] = String(v).split('\n').map((x) => x.trim()).filter(Boolean);
        else if (f.param === 'unknown') {
          try { args[f.key] = JSON.parse(v); }
          catch (e) { return fail(`「${f.label}」不是合法 JSON：${e.message}`); }
        } else args[f.key] = v;
      }
      return args;
    };
    form.querySelector('.tbrun').addEventListener('click', async () => {
      if (tab.tbRunning) { const errEl = form.querySelector('.tberr'); errEl.hidden = false; errEl.textContent = '这个标签已经有一个工具在运行，等它跑完（或者开个新标签）'; return; }
      const args = collect();
      if (args) await runToolArgs(t, args, form);
    });
    form.querySelector('.tbsched')?.addEventListener('click', () => { const args = collect(); if (args) scheduleDialog(t, args); });
  }
  load();
  return form;
}

// 运行一个工具（静态表单、动态表单共用）：对话里显示「运行中」和停止按钮，结果 / 报错落回发起运行的那个标签
async function runToolArgs(t, args, form) {
  const tab = cur;
  // 正在修改这个工具时，它的正式版页面跑的是工具箱里的旧版：不跑，提示去横幅上试运行草稿
  if (!t.draft && tab.making?.editing && tab.making.name === t.name) {
    add('note warn', `这是工具箱里的旧版「${esc(t.title || t.name)}」，改过的内容还在草稿里。要测改过的版本，请点横幅上的「试运行」；满意后点「保存工具」才会替换旧版。`, true);
    return;
  }
  tab.tbRunning = true;
  form.querySelector('.tbrun').disabled = true;
  if (!form.closest('.tbkeep')) $('toolbox').hidden = true; // 草稿试运行：收起工具箱看结果
  else setFolded(form.closest('.tbkeep'), true); // 工具页面：点运行后表单自动收起成一行摘要，下面的对话区看结果（点「展开」还能再改）
  const label = t.title ? `${t.title}（${t.name}）` : t.name;
  add('note', t.draft ? `— 试运行草稿 ${esc(label)}（不经过对话） —` : `— 直接运行工具 ${esc(label)}（不经过对话，省 token） —`, true);
  const running = runningBar(label);
  try {
    const r = await (t.draft ? call('making:run', args) : call('tools:run', t.name, args, tab.id));
    T = tab; // 跑的时候用户可能切到了别的标签：结果、按钮都放回发起运行的那个标签（finally 里切回来）
    running.done();
    add('msg ai', md(String(r)), true);
    // 草稿试运行成功：就在对话里给一个「保存插件」按钮（跟横幅上的「完成制作 / 保存工具」一样），不用回头去找横幅
    if (t.draft && tab.making) {
      const verb = saveLabel(tab.making);
      const d = add('note mksave', `试运行完成。效果满意的话 <button class="primary mksavebtn">${verb}</button>，不满意就在下面说哪里要改。`, true);
      d.querySelector('.mksavebtn').addEventListener('click', (e) => {
        if (!cur.making) { e.currentTarget.disabled = true; return; } // 已经保存或退出了
        $('mk_done').click();
      });
    }
    // 跑完给一个入口：效果不满意就进入修改模式（会开新对话），把这次的参数和结果带过去，用户补一句哪里不好即可
    if (!t.draft && !t.market) {
      const d = add('note', `工具运行完毕，如果感觉效果不好，<button class="tbtweak">点击修改工具功能</button>`, true);
      d.querySelector('.tbtweak').addEventListener('click', async () => {
        const out = String(r);
        if (!(await beginMaking({ edit: t.name }))) return;
        // 不往发送框里塞一大段文字：这次运行的参数和结果悄悄记进过程记录（助手进入修改后会先读），用户只要说哪里不好
        call('making:log', `修改前刚直接运行过一次：参数 ${JSON.stringify(args)}；结果：${out.length > 1500 ? out.slice(0, 1500) + '…（后面省略）' : out}`).catch(() => {});
        focusInput();
      });
    }
  } catch (e) {
    T = tab;
    running.done();
    if (isStopped(e)) { add('note', `■ 已手动停止 ${esc(label)}`, true); return; }
    // 直接运行不经过模型，失败了没人会自动修：正式工具直接打开「修改工具」（新对话 + 制作模式），把参数和报错交给助手诊断、改草稿；
    // 草稿试运行失败时本来就在修改中，留在当前对话里让助手接着改
    if (t.market) { add('note err', `✗ ${esc(e.message)}<div class="muted" style="margin-top:4px">这是从插件市场安装的工具，有问题请联系作者，或在插件市场里更新到新版本</div>`, true); return; }
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
}

// ---------------------------------------------------------------- 单个工具导入 / 导出（见 agent.js importPreview / importConfirm）

async function deleteTool(t) {
  const label = t.title ? `${t.title}（${t.name}）` : t.name;
  if (!(await askConfirm(`删除工具 ${label}？\n工具文件和它的制作记录会移到废纸篓，需要时可以从废纸篓恢复。已经发布到插件市场的版本不受影响。`))) return;
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

// 导入前的确认页：本地文件导入和插件市场安装共用（市场安装时 p.market 有值，确认 / 取消后回到市场列表）
function showImportPreview(p, { update = false } = {}) { // update：从「更新」按钮进来，替换旧版本默认勾上
  const list = $('tb_list');
  const back = p.market ? renderMarket : renderToolboxList;
  const verb = p.market ? '安装' : '导入';
  const risky = p.risks.filter((r) => r.label !== '访问的网址');
  list.innerHTML = `<button class="ghost tbback">← ${p.market ? '插件市场' : '全部工具'}</button>
    <div class="tbitem tbimp">
      <div class="tbhead"><span class="tbname">${verb}：${esc(p.title || p.name)}${p.title ? `<small class="tbid">${esc(p.name)}</small>` : ''}</span></div>${p.description ? `<div class="tbdesc">${esc(p.description)}</div>` : ''}
      <p class="muted">${p.market ? `来自插件市场，版本 ${esc(p.market.version)}（已通过网站审核）` : `来自 ${esc(p.from)}`}（${Math.ceil(p.size / 1024)} KB）</p>
      <p class="tbimp-warn">⚠ 工具代码在 BrowserX 里运行，权限跟 BrowserX 一样：能读写你电脑上的文件、用右侧浏览器里已登录的账号操作。只导入你信任的人给的工具，导入前最好看一下源代码。</p>
      ${p.risks.length ? `<div class="tbimp-risks"><b>代码里用到的能力</b>${p.risks.map((r) => `<div class="${r.label === '访问的网址' ? '' : 'risk'}">· ${esc(r.label)}（第 ${r.lines.join('、')} 行${r.more ? ` 等 ${r.more + r.lines.length} 处` : ''}）</div>`).join('')}</div>` : '<p class="muted">没有发现执行命令、读写文件之类的敏感能力。</p>'}
      ${p.exists ? `<label class="tbimp-ow"><input type="checkbox" id="imp_ow"${update ? ' checked' : ''}> 工具箱里已经有 ${esc(p.name)}，${p.market ? '用这个版本替换' : '覆盖它'}</label>` : ''}
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
      // 市场安装成功：回到工具箱第 1 页（最新的排第 1，刚装的就在最上面）；清掉搜索 / 收藏筛选，免得被筛掉看不到
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

// ---------------------------------------------------------------- 插件市场 / 发布（BrowserX 账号，见 main.js market:* 和 account.js）

// 没登录时市场 / 发布页显示的提示
function loginPrompt(box, what) {
  box.innerHTML = `<div class="hempty">${esc(what)}需要先登录 BrowserX 账号<div class="row" style="justify-content:center;margin-top:10px"><button class="primary lp_go">登录</button></div></div>`;
  box.querySelector('.lp_go').addEventListener('click', () => openAccount(true));
}

// 网站返回「去购买 / 开通会员」之类的错误时，带一个打开网站的按钮
// Claude 额度用完的统一提示（开始前检查到 / 对话中途被门户拦下都用这个），措辞跟门户 ClaudeQuota::exceededMessage 一样。
// 每句一个 <span>，界面翻译按句匹配；按钮：充值（开放了充值）、用积分兑换（积分能换额度）、开通会员（非会员）
function quotaHtml() {
  const u = account?.user || {};
  const c = u.claude || {};
  const credit = u.urls?.credit, points = u.tokens_per_point > 0;
  const s = [c.limit ? `今天的 Claude 额度已用完（${fmtBig(c.used || 0)} / ${fmtBig(c.limit)}），明天 0 点恢复。` : '今天的 Claude 额度已用完，明天 0 点恢复。'];
  if (credit && points) s.push('可以充值购买额度，或用邀约积分兑换额度，马上接着用。');
  else if (credit) s.push('可以充值购买额度，马上接着用。');
  else if (points) s.push('可以用邀约积分兑换额度，马上接着用。');
  if (!u.member && !u.is_admin) s.push('开通会员可以提高每天的额度。');
  else if (c.higher_package) s.push('换更高的套餐可以提高每天的额度。');
  const btns = [
    credit ? `<button class="primary ac_link" data-url="${esc(credit)}">充值</button>` : '',
    points ? '<button class="ghost q_points">用积分兑换</button>' : '',
    !u.member && !u.is_admin && u.urls?.packages ? `<button class="ghost ac_link" data-url="${esc(u.urls.packages)}">开通会员</button>` : '',
  ].join('');
  return `✗ ${s.map((x) => `<span>${esc(x)}</span>`).join('')}${btns ? `<div class="row q_btns">${btns}</div>` : ''}`;
}
function quotaNote(tab) {
  // 先读一次最新的账号状态（用量、充值余额），再画提示
  call('account:refresh').catch(() => {}).finally(() => inTab(tab, () => add('note err quota', quotaHtml(), true)));
}
function errWithLink(e) {
  if (e.quota) return quotaHtml();
  return `✗ ${esc(e.message)}${e.url ? ` <button class="${e.label ? 'primary' : 'ghost'} ac_link" data-url="${esc(e.url)}">${esc(e.label || '去网站看看')}</button>` : ''}`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('.ac_link');
  if (b) call('account:open', b.dataset.url).catch(() => {});
  if (e.target.closest('.q_points')) openInvite();
});

// 2026-10-29 这种日期（插件市场的发布 / 更新日期）
const ymd = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const mkState = { q: '', category: '', page: 1 };
let mkMeta = null;
// ---------------------------------------------------------------- 定时运行（见 scheduler.js）
const SCHED_MODES = { daily: '每天', weekdays: '工作日', interval: '每隔' };
const schedRule = (x) => (x.mode === 'interval' ? `每隔 ${x.every} 分钟` : `${SCHED_MODES[x.mode]} ${x.time}`);

// 「定时运行…」：用表单上现在填的内容做参数，选怎么定时
async function scheduleDialog(t, args) {
  const st = { mode: 'daily', time: '09:00', every: 60 };
  const p = modal(`<div class="modal-msg"><b>定时运行：${esc(t.title || t.name)}</b><br><span class="muted">用表单上现在填的内容运行。BrowserX 开着时才会运行；打开软件时今天的时间已过、今天又还没跑过，会补跑一次。</span></div>
    <div class="sc_form">
      <div class="sc_modes">${Object.entries(SCHED_MODES).map(([k, v]) => `<button type="button" class="dynchip${k === st.mode ? ' on' : ''}" data-m="${k}">${v}</button>`).join('')}</div>
      <label class="sc_time">时间 <input type="time" value="${st.time}"></label>
      <label class="sc_every" hidden>间隔 <input type="number" min="5" max="1440" value="${st.every}"> 分钟</label>
    </div>
    <div class="modal-actions"><button class="ghost" data-a="cancel">取消</button><button class="primary" data-a="ok">保存</button></div>`);
  const box = document.querySelector('.modal-overlay:last-child .modal-box');
  for (const b of box.querySelectorAll('[data-m]')) b.addEventListener('click', () => {
    st.mode = b.dataset.m;
    for (const x of box.querySelectorAll('[data-m]')) x.classList.toggle('on', x === b);
    box.querySelector('.sc_time').hidden = st.mode === 'interval';
    box.querySelector('.sc_every').hidden = st.mode !== 'interval';
  });
  box.querySelector('.sc_time input').addEventListener('input', (e) => { st.time = e.target.value; });
  box.querySelector('.sc_every input').addEventListener('input', (e) => { st.every = Number(e.target.value); });
  if (!(await p)) return;
  try {
    const task = await call('schedules:add', { tool: t.name, title: t.title || t.name, args, mode: st.mode, time: st.time, every: st.mode === 'interval' ? st.every : undefined });
    add('note', `已设定时运行：${esc(task.title)}，${esc(schedRule(task))}。在工具箱「定时任务」里可以暂停或删除。`, true);
  } catch (e) { add('note err', `✗ 定时运行没设上：${esc(e.message)}`, true); }
}

async function renderSchedules() {
  const list = $('tb_list');
  list.innerHTML = `<button class="ghost tbback">← 我的工具</button>
    <p class="hint sc_hint">定时任务在后台的「定时任务」对话里直接运行工具（不经过助手、不花 token），跑完发系统通知。只在 BrowserX 开着时运行。要新建，打开一个工具，填好表单后点「定时运行…」。</p>
    <div class="sc_list"><div class="hempty">加载中…</div></div>`;
  list.querySelector('.tbback').addEventListener('click', renderToolboxList);
  drawSchedules(await call('schedules:list').catch(() => []));
}
function drawSchedules(items) {
  const box = $('tb_list').querySelector('.sc_list');
  if (!box) return; // 不在定时任务页面
  const when = (ms) => (ms ? new Date(ms).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-');
  box.innerHTML = items.length ? '' : '<div class="hempty">还没有定时任务</div>';
  for (const x of items) {
    const d = document.createElement('div');
    d.className = `tbitem sc_item${x.enabled ? '' : ' off'}`;
    const args = Object.entries(x.args || {}).filter(([k]) => k !== '_form').map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join('，');
    d.innerHTML = `<div class="tbhead"><span class="tbname">${esc(x.title)}<small class="tbid">${esc(schedRule(x))}</small></span>
        <span class="tbacts"><button class="ghost tbedit sc_toggle">${x.enabled ? '暂停' : '启用'}</button><button class="ghost tbedit sc_run"${x.running ? ' disabled' : ''}>${x.running ? '运行中…' : '立即运行'}</button><button class="ghost tbedit sc_del">删除</button></span></div>
      <div class="tbdesc">${x.enabled ? `下次：${esc(when(x.next))}` : '已暂停'} · 上次：${x.lastRun ? `${esc(when(x.lastRun))} ${x.lastOk ? '✓' : '✗'}` : '还没运行过'}${args ? `<br>参数：${esc(args.slice(0, 200))}` : ''}${x.lastRun && x.lastText ? `<br><span class="${x.lastOk ? 'muted' : 'sc_err'}">${esc(x.lastText.slice(0, 160))}</span>` : ''}</div>`;
    const err = (e) => add('note err', `✗ ${esc(e.message)}`, true);
    d.querySelector('.sc_toggle').addEventListener('click', () => call('schedules:update', x.id, { enabled: !x.enabled }).catch(err));
    d.querySelector('.sc_run').addEventListener('click', () => call('schedules:runNow', x.id).catch(err));
    d.querySelector('.sc_del').addEventListener('click', async () => { if (await askConfirm(`删除定时任务「${x.title}」（${schedRule(x)}）？`)) call('schedules:remove', x.id).catch(err); });
    box.appendChild(d);
  }
}
api.on('schedules', drawSchedules);

async function renderMarket() {
  const list = $('tb_list');
  list.innerHTML = `<button class="ghost tbback">← 我的工具</button>
    <div class="tbtop mktop"><input class="tbsearch mk_q" type="search" placeholder="搜索插件市场" spellcheck="false"><select class="mk_cat"><option value="">全部行业</option></select></div>
    <div class="mkbody"><div class="hempty">加载中…</div></div>`;
  list.querySelector('.tbback').addEventListener('click', renderToolboxList);
  const body = list.querySelector('.mkbody');
  if (!account.loggedIn) { loginPrompt(body, '浏览和安装插件市场里的工具'); return; }
  try { mkMeta = mkMeta || await call('market:meta'); } catch (e) { if (e.needLogin) loginPrompt(body, '浏览插件市场'); else body.innerHTML = `<div class="tberr">${errWithLink(e)}</div>`; return; }
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
  try { r = await call('market:list', mkState); } catch (e) { if (e.needLogin) loginPrompt(body, '浏览插件市场'); else body.innerHTML = `<div class="tberr">${errWithLink(e)}</div>`; return; }
  body.innerHTML = r.items.length ? '' : `<div class="hempty">${mkState.q || mkState.category ? '没有找到符合条件的工具' : '插件市场里还没有工具'}</div>`;
  for (const t of r.items) {
    const d = document.createElement('div');
    d.className = 'tbitem mkitem';
    // 有没有新版本只看内部版本号 build（旧记录没有 build 时退回比 version 字符串）
    const newer = Number.isInteger(t.local.build) && Number.isInteger(t.build) ? t.local.build < t.build : t.local.version !== t.version;
    const local = t.local.version ? (!newer ? `已安装 ${esc(t.version)}` : `已安装 ${esc(t.local.version)}，有新版本 ${esc(t.version)}`) : t.local.exists ? '工具箱里有同名工具' : '';
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
    if (Date.now() > buying.until) { stopBuying(); add('note', `— 「${esc(t.title)}」等了 20 分钟没有收到付款，已停止等待；付过款的话在插件市场里点「安装」即可 —`, true); return; }
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

// 发布到插件市场：网站上已有同名的自己的工具 → 上传新版本（只填版本号和说明）；否则新建（行业、价格、简介）。都要管理员审核后才上架
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
    <div class="tbhead"><span class="tbname">${rm ? '上传新版本' : '发布到插件市场'}：${esc(label)}</span></div>
    <p class="hint">${rm ? `网站上已有这个工具（${esc(rm.status_label)}，${esc(rm.price_label)}，当前对外版本 ${esc(rm.current_version || '无')}）。新版本审核通过后替换旧版本；价格、简介在网站上改。` : `提交后进入审核，管理员通过后才会出现在插件市场。平台抽成 ${info.meta.commission_percent}%，其余归你。`}</p>
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
        <p class="muted">${r.created ? '新工具已提交' : '新版本已上传'}，等待管理员审核，通过后会出现在插件市场。</p>
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
  b.title = account.loggedIn ? `${u?.name || ''} ${u?.email || ''}\n会员授权、插件市场、退出登录` : '登录 BrowserX 账号：会员授权、插件市场、发布工具';
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
      <p class="hint">登录后可以查看会员授权、在插件市场里直接安装工具、把自己做的工具一键发布到市场。</p>
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
  const wan = (n) => fmtBig(n); // 大数字按界面语言缩写（中日「万」、韩「만」、英文 K / M…），一行放得下
  // 会员状态：右上角一个标签 + 开通 / 续期按钮
  const status = !u ? '<span class="ac_badge">读取中…</span>'
    : u.is_admin ? '<span class="ac_badge ok">管理员</span>'
    : lic ? `<span class="ac_badge ok" title="会员到期：${esc(fmtDate(lic.expires_at))}">会员 · ${esc(fmtDate(lic.expires_at))} 到期</span>`
    : '<span class="ac_badge">未开通会员</span>';
  const renew = u && !u.is_admin ? `<button class="${u.member ? 'ghost' : 'primary'} ac_link ac_small" data-url="${esc(u.urls.packages)}">${u.member ? '续期' : '开通会员'}</button>` : '';
  // 今天的 Claude 用量（门户按天限额，见 browserx-portal ClaudeQuota）：一行字 + 一条细进度条
  const c = u?.claude;
  const usage = c?.limit ? (() => {
    const pct = Math.min(100, Math.round(c.used * 100 / c.limit));
    return `<div class="ac_usage" title="每天 0 点重置${c.exceeded && !u.member ? '；开通会员可以提高额度' : ''}">
        <div class="ac_urow"><span>今日 Claude 用量</span><span><b>${wan(c.used)}</b> / ${wan(c.limit)}${c.exceeded ? ' · <em class="ac_over">已用完，明天 0 点恢复</em>' : ''}</span></div>
        <div class="ac_meter"><i style="width:${pct}%" class="${c.exceeded ? 'full' : pct >= 80 ? 'hi' : ''}"></i></div>
        ${u.urls?.credit ? `<div class="ac_urow ac_credit"><span>充值余额 <b>${wan(c.credit || 0)}</b><small>（每天的额度用完后从这里扣）</small></span><button class="${c.exceeded || (c.used >= c.limit && !c.credit) ? 'primary' : 'ghost'} ac_link ac_small" data-url="${esc(u.urls.credit)}">充值</button></div>` : ''}
      </div>`;
  })() : '';
  box.innerHTML = `<div class="ac_card ac_main">
      <div class="ac_head">
        <div class="ac_who"><span class="ac_avatar" aria-hidden="true">${esc((u?.name || '?').slice(0, 1).toUpperCase())}</span><div><b>${esc(u?.name || '')}</b><span>${esc(u?.email || '')}</span></div></div>
        <div class="ac_status">${status}${renew}</div>
      </div>
      ${usage}
      ${u && !u.member && !u.is_admin ? '<p class="hint">开通会员后可以安装、发布插件市场里的工具，Claude 额度也更高。</p>' : ''}
    </div>
    <div class="ac_links">
      <button class="ghost ac_market">插件市场</button>${u ? `<button class="ghost ac_link" data-url="${esc(u.urls.my_tools)}">我发布的工具</button><button class="ghost ac_link" data-url="${esc(u.urls.panel)}">会员中心</button>` : ''}
      <button class="ghost ac_logout">退出登录</button>
    </div>
    ${u ? `<div class="ac_card ac_invite">
      <div><b>邀约有礼</b><span>最高得 <em>${esc(u.max_per_invite ?? 650)} 积分</em>/人 · 我的积分 ${esc(u.points ?? 0)}</span>
        ${u.points_per_day ? `<span class="ac_inv_rule">积分可兑换会员天数（${esc(u.points_per_day)} 积分 = 1 天）</span>` : ''}
        ${u.tokens_per_point ? `<span class="ac_inv_rule">也可兑换 Claude 额度（1 积分 = ${esc(fmtBig(u.tokens_per_point))}）</span>` : ''}</div>
      <button class="primary ac_invite_go">去邀约</button>
    </div>` : ''}`;
  box.querySelector('.ac_market').addEventListener('click', () => { $('account').hidden = true; $('toolbox').hidden = false; renderMarket(); });
  box.querySelector('.ac_invite_go')?.addEventListener('click', openInvite);
  box.querySelector('.ac_logout').addEventListener('click', async () => {
    if (await askConfirm('退出 BrowserX 账号？工具箱里已经安装的工具不受影响。')) call('account:logout').catch(() => {});
  });
}
// 邀约弹窗：二维码 + 链接（复制），奖励规则，邀请人数，积分兑换会员天数
async function openInvite() {
  let d;
  try { d = await call('invite:get'); } catch (e) { add('note err', `✗ ${esc(e.message)}`, true); return; }
  const rules = `好友通过你的链接或二维码注册，你得 ${d.signup_points} 积分；好友第一次买套餐，你再得 ${d.package_points.map((p) => `${esc(p.name)} ${p.points}`).join('、')} 积分。`;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box inv">
    <div class="inv_head"><b>邀约有礼</b><span>最高得 <em>${d.max_per_invite} 积分</em>/人</span></div>
    <div class="inv_main">
      <img class="inv_qr" src="${esc(d.qr)}" alt="邀约二维码">
      <div class="inv_side">
        <p class="inv_rules">${rules}</p>
        <p class="inv_rules">积分可以兑换会员天数：${d.points_per_day} 积分 = 1 天。</p>
        ${d.tokens_per_point ? `<p class="inv_rules">也可以兑换 Claude 额度：1 积分 = ${fmtBig(d.tokens_per_point)}，加进充值余额，不过期。</p>` : ''}
        <div class="inv_stats"><span><b>${d.invited}</b>已邀请</span><span><b>${d.purchased}</b>已购买</span><span><b class="inv_pts">${d.points}</b>我的积分</span></div>
      </div>
    </div>
    <div class="inv_link"><input readonly value="${esc(d.url)}"><button class="primary inv_copy">复制链接</button></div>
    <div class="inv_redeem"><span>兑换</span><input type="number" min="1" class="inv_days"><span>天会员</span><button class="ghost inv_go">兑换</button><span class="inv_msg"></span></div>
    ${d.tokens_per_point ? '<div class="inv_redeem"><span>用</span><input type="number" min="1" class="inv_cpts"><span>积分换 Claude 额度</span><button class="ghost inv_cgo">兑换</button><span class="inv_msg inv_cmsg"></span></div>' : ''}
    <div class="modal-actions"><button class="ghost inv_web">在网站上查看明细</button><button class="primary" data-a="cancel">关闭</button></div>
  </div>`;
  document.body.appendChild(overlay);
  call('view:cover', true).catch(() => {});
  const q = (s) => overlay.querySelector(s);
  const close = () => { overlay.remove(); call('view:cover', false).catch(() => {}); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  q('[data-a=cancel]').addEventListener('click', close);
  q('.inv_web').addEventListener('click', () => call('account:open', account.user?.urls?.invite || d.url).catch(() => {}));
  q('.inv_copy').addEventListener('click', async () => {
    await call('invite:copy', d.url).catch(() => {});
    q('.inv_copy').textContent = '已复制 ✓';
    setTimeout(() => { if (q('.inv_copy')) q('.inv_copy').textContent = '复制链接'; }, 2000);
  });
  const days = q('.inv_days'), msg = q('.inv_msg');
  const maxDays = () => Math.floor(d.points / d.points_per_day);
  const syncRedeem = () => {
    days.max = Math.max(1, maxDays());
    if (!days.value) days.value = Math.max(1, maxDays());
    q('.inv_go').disabled = maxDays() < 1;
    if (maxDays() < 1) { msg.className = 'inv_msg'; msg.textContent = `满 ${d.points_per_day} 积分可兑换`; }
  };
  syncRedeem();
  q('.inv_go').addEventListener('click', async () => {
    const n = parseInt(days.value, 10);
    if (!(n >= 1)) return;
    q('.inv_go').disabled = true;
    try {
      const r = await call('invite:redeem', n);
      d.points = r.points;
      q('.inv_pts').textContent = r.points;
      days.value = '';
      msg.className = 'inv_msg ok';
      msg.textContent = `✓ 已兑换 ${n} 天，到期 ${fmtDate(r.expires_at)}`;
    } catch (e) { msg.className = 'inv_msg err'; msg.textContent = e.message; }
    syncRedeem();
    syncCredit();
  });
  // 积分换 Claude 额度（门户后台设了比例才显示这一行）
  const cpts = q('.inv_cpts'), cmsg = q('.inv_cmsg');
  function syncCredit() {
    if (!cpts) return;
    cpts.max = Math.max(1, d.points);
    cpts.value = d.points >= 1 ? d.points : '';
    q('.inv_cgo').disabled = d.points < 1;
    if (d.points < 1 && !cmsg.classList.contains('ok')) { cmsg.className = 'inv_msg inv_cmsg'; cmsg.textContent = '还没有积分'; }
  }
  syncCredit();
  q('.inv_cgo')?.addEventListener('click', async () => {
    const n = parseInt(cpts.value, 10);
    if (!(n >= 1)) return;
    q('.inv_cgo').disabled = true;
    try {
      const r = await call('invite:redeemCredit', n);
      d.points = r.points;
      q('.inv_pts').textContent = r.points;
      cmsg.className = 'inv_msg inv_cmsg ok';
      cmsg.textContent = `✓ 已换 ${fmtBig(r.tokens)} 额度，充值余额 ${fmtBig(r.credit)}`;
    } catch (e) { cmsg.className = 'inv_msg inv_cmsg err'; cmsg.textContent = e.message; }
    syncRedeem();
    syncCredit();
  });
}
function openAccount(show) {
  $('history').hidden = true;
  $('settings').hidden = true;
  $('toolbox').hidden = true;
  $('account').hidden = !show;
  if (show) { renderAccount(); if (account.loggedIn) call('account:refresh').catch(() => {}); } // 每次打开都重新读一次账号、额度、积分（面板上没有刷新按钮）
}
$('btnAccount').addEventListener('click', () => openAccount($('account').hidden));
$('mk_ask').addEventListener('click', () => waitingCard(cur)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
// 状态栏「等你回答」：点一下滚到那张卡片
$('status').addEventListener('click', () => waitingCard(cur)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
api.on('account', (st) => {
  account = st;
  renderAccount();
});
call('account:state').then((st) => { account = st; renderAccount(); }).catch(() => {});

// ---------------------------------------------------------------- 制作工具模式（见 agent.js startMaking/finishMaking）

// 正在制作工具的标签（同一时间最多一个，主进程也会拦）
const makingTabState = () => [...tabState.values()].find((x) => x.making);

// 新建工具：只问「想做个什么工具」，名字由助手起；写了就直接当第一条消息发给助手
const NT_EXAMPLES = ['输入保单号，在保险公司网站上查保单状态和保费', '每天把续保名单导出成 Excel', '把表格里的客户资料逐条填进网页表单', '保存某个网站最新的一条新闻（文字和图片）'];
function showNewToolForm() {
  const list = $('tb_list');
  list.innerHTML = `<div class="tbitem tbnt"><div class="tbform tbdyn">
      <div class="tbf full"><label for="nt_goal">想做个什么工具？</label><textarea id="nt_goal" placeholder="说清楚在哪个网站、输入什么、要得到什么结果，例如：输入保单号，在宏利网站查保单状态和保费"></textarea></div>
      <div class="nt_examples">${NT_EXAMPLES.map((x) => `<button type="button" class="dynchip">${esc(x)}</button>`).join('')}</div>
      <div class="dynnote">会开一个新对话专门做这个工具（当前对话在「历史」里找得回）。助手需要时会请你在网页上操作一遍，写好后自己测试，你点「保存到工具箱」就行。</div>
      <div class="tberr" hidden></div>
      <div class="row"><button class="primary nt_go">开始制作</button></div>
    </div></div>`;
  const goal = $('nt_goal');
  for (const b of list.querySelectorAll('.nt_examples .dynchip')) b.addEventListener('click', () => { goal.value = b.textContent; goal.focus(); });
  goal.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) list.querySelector('.nt_go').click(); });
  list.querySelector('.nt_go').addEventListener('click', async () => {
    const err = list.querySelector('.tberr');
    err.hidden = true;
    if (!goal.value.trim()) { err.hidden = false; err.textContent = '先说说想做个什么工具'; goal.focus(); return; }
    const btn = list.querySelector('.nt_go');
    if (btn.disabled) return; // 防止连点两次开两次
    btn.disabled = true; btn.textContent = '正在开始…';
    try { await beginMaking({ goal: goal.value.trim() }); } finally { btn.disabled = false; btn.textContent = '开始制作'; }
  });
  goal.focus();
}

// 开一个新对话进入制作模式；失败时把原因显示出来，返回是否成功
async function beginMaking(opts) {
  const mk = makingTabState();
  if (mk) { add('note err', `✗ ${mk === cur ? '' : '另一个标签'}正在制作工具「${esc(mk.making.title || '新工具')}」，先${mk === cur ? '' : '切过去'}点横幅上的「保存」或「不做了」`, true); $('toolbox').hidden = true; return false; }
  await clearChat();
  try {
    await call('making:start', opts);
    $('toolbox').hidden = true;
    if (opts.goal) await call('agent:send', opts.goal, cur.id); // 新建时写了要做什么：直接发出去，助手马上开始
    else focusInput(); // 修改工具：等用户说要改什么
    return true;
  } catch (e) {
    add('note err', errWithLink(e), true);
    return false;
  }
}

const saveLabel = () => '保存工具'; // 横幅上的圆形按钮，跟 agent.js SAVE_LABEL 一致

// 横幅上的进度：✓ 做完的、● 现在这步、○ 还没到的；没录制时「看你示范」显示成跳过
function renderMakingSteps(m) {
  const box = $('mk_steps');
  const step = m.step || 0;
  box.innerHTML = (m.steps || []).map((label, i) => {
    const skipped = i === 2 && step > 2 && !m.recorded;
    const state = skipped ? 'skip' : i < step ? 'done' : i === step ? 'now' : 'todo';
    const text = i === 4 && m.testing ? '测试中' : i === 4 && m.testFails && step === 4 ? `测试（第 ${m.testFails + 1} 轮）` : label;
    return `<span class="mks ${state}">${state === 'done' ? '✓' : state === 'skip' ? '–' : state === 'now' ? '●' : '○'} ${esc(TR(text))}</span>`; // 前面带符号，自动翻译整段对不上：这里先翻
  }).join('<span class="mksep">›</span>');
}

const INPUT_PH = $('input').placeholder;
function renderMaking(m) {
  $('makingBar').hidden = !m;
  $('mk_busy').hidden = !(m && cur?.running);
  document.body.classList.toggle('making', !!m);
  // 制作工具时发送框提示先输入需求
  $('input').placeholder = m ? (m.editing ? '说说要改什么、改成什么样…' : '描述这个工具要做什么：在哪个网站、输入什么、要得到什么结果…') : INPUT_PH;
  if (!m) return;
  $('mk_kind').textContent = m.editing ? '工具修改模式' : '工具制作模式'; // 整句一个词条（拆开翻会变成「Tools Build Mode」这种）
  $('mk_done').textContent = m.streamlining ? '优化并保存中' : saveLabel(m);
  $('mk_done').classList.toggle('primary', m.step >= 5); // 自己测试通过了：保存按钮变成主按钮
  renderMakingSteps(m);
  $('mk_done').disabled = !!m.streamlining;
  $('mk_done').title = '让助手把整个过程精简成最终工具，精简完自动放进工具箱（要不要先试运行你自己决定）';
  $('mk_name').textContent = m.title || '新工具'; // 只显示中文名（英文代码在悬停提示里；还没起名时助手写草稿会起）
  $('mk_name').title = m.name;
  document.querySelector('#makingBar .mk_kind').title = `${m.title || m.name}（${m.name}）`; // 横幅不显示工具名，悬停看
  $('mk_tested').textContent = m.tested ? '已试运行 ✓' : '';
  // 横幅提示：现在在干什么 / 要用户做什么（要用户动手的黄底闪烁）
  $('mk_hint').textContent = m.hint?.text || '';
  $('mk_hint').hidden = !m.hint?.text;
  $('mk_hint').classList.toggle('action', !!m.hint?.action);
  if (m.hint?.action) $('mk_recask').hidden = true; // 已经有要用户做的事了，「要录制吗」不跟它挤在一起
  // 要用户动手、而 BrowserX 不在最前面（用户在别的窗口等）：发一个系统通知，点了回到这里
  const key = m.hint?.action ? m.hint.text : '';
  if (key && key !== renderMaking.notified && !document.hasFocus() && 'Notification' in window) {
    try { const n = new Notification(TR('BrowserX 制作工具：需要你操作'), { body: TR(key), silent: false }); n.onclick = () => window.focus(); } catch { /* 通知被系统关掉了就算了 */ }
  }
  renderMaking.notified = key;
}

$('mk_rec').addEventListener('click', () => $('recBtn').click());

$('mk_try').addEventListener('click', async () => {
  let t;
  try { t = await call('making:draft'); } catch (e) { add('note err', `✗ ${esc(e.message)}`, true); return; }
  t.draft = true;
  $('history').hidden = true;
  $('settings').hidden = true;
  $('toolbox').hidden = false;
  // 先切回列表区域：修改工具时这个标签里往往还开着那个工具（正式版）的页面，不切走的话用户看到、点的是旧版的表单，跑的不是草稿
  showToolList();
  const list = $('tb_list');
  list.innerHTML = `<button class="ghost tbback tbback-strong">← 返回对话</button>`; // 试运行页：显眼的返回按钮
  list.querySelector('.tbback').addEventListener('click', () => { $('toolbox').hidden = true; });
  const d = document.createElement('div');
  d.className = 'tbitem';
  d.innerHTML = `<div class="tbhead"><span class="tbname">试运行草稿：${esc(t.title || t.name)}${t.title ? `<small class="tbid">${esc(t.name)}</small>` : ''}</span></div>${t.description ? `<div class="tbdesc">${esc(t.description)}</div>` : ''}`;
  d.appendChild(buildDynamicForm(t));
  list.appendChild(d);
});

$('mk_done').addEventListener('click', async () => {
  const opts = { force: true }; // 要不要先试运行用户自己决定，不再问「还没试运行过」
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
  // 不弹确认框，直接放弃（草稿移到废纸篓，误点了可以从废纸篓找回）
  try {
    await call('making:cancel');
  } catch (e) {
    add('note err', `✗ ${esc(e.message)}`, true);
    return;
  }
  // 放弃后清空对话（结束当前会话，跟「新对话」一样），只留一条说明
  await clearChat();
  add('note', `— 已退出${verb}工具 ${esc(label)}${editing ? '，原工具没有改动' : ''}（草稿在废纸篓里） —`, true);
  focusInput();
});

// 「工具箱」按钮在「工具列表」和「刚才的页面」之间来回切：
// 在对话（或别的面板）里点 → 工具列表，再点 → 回到对话；在某个工具的填表页面上点 → 工具列表，再点 → 回到那个页面（没重新加载，内容都在）
$('btnToolbox').addEventListener('click', () => {
  const tab = cur;
  const listShown = !$('toolbox').hidden && !tab.pageOpen;
  if (listShown) {
    const prev = tab.prevView;
    tab.prevView = null;
    if (prev && prev !== 'chat' && tab.pages.querySelector(`.tbkeep[data-tool="${CSS.escape(prev)}"]`)) openToolPage({ name: prev });
    else $('toolbox').hidden = true;
    return;
  }
  tab.prevView = $('toolbox').hidden ? 'chat' : tab.pageOpen; // 记下从哪来，再点一次回去
  $('history').hidden = true;
  $('settings').hidden = true;
  $('account').hidden = true;
  $('toolbox').hidden = false;
  showToolList();
  renderToolboxList();
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
  $('s_replyLang').value = cfg.replyLang || 'system';
}
$('s_replyLang').addEventListener('change', async () => { cfg = await call('cfg:set', { replyLang: $('s_replyLang').value }); }); // 选了马上生效
api.on('cfg', (c) => { cfg = c; if (!$('settings').hidden) $('s_replyLang').value = cfg.replyLang || 'system'; }); // 菜单里改了

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
  if (document.activeElement !== $('url')) $('url').value = n.url === 'about:blank' ? '' : n.url || ''; // 空白页地址栏留空
  $('navBack').disabled = !n.canBack;
  $('navForward').disabled = !n.canForward;
  $('navReload').classList.toggle('loading', n.loading);
  $('navReload').title = n.loading ? '停止' : '刷新';
  document.title = n.title ? `${n.title} — BrowserX` : 'BrowserX';
  renderNavError(n);
}
api.on('nav', renderNav);

// 网页标签条（一个对话里的多个网页，见 main.js addPage）：两个以上才显示
function renderPages(list) {
  const bar = $('pagebar');
  bar.hidden = list.length < 2;
  bar.replaceChildren(...list.map((p) => {
    const el = document.createElement('div');
    el.className = `pg${p.active ? ' on' : ''}${p.loading ? ' loading' : ''}`;
    el.title = `${p.title || '(无标题)'}\n${p.url}`;
    el.innerHTML = `<span class="pgn">${p.index}</span><span class="pgt">${esc(p.url === 'about:blank' || !p.url ? '新标签页' : p.title || p.url)}</span><button class="pgx" title="关闭这个标签页" aria-label="关闭">×</button>`;
    el.addEventListener('click', (e) => { if (!e.target.closest('.pgx') && !p.active) call('pages:switch', p.index).catch(() => {}); });
    el.addEventListener('auxclick', (e) => { if (e.button === 1) call('pages:close', p.index).catch(() => {}); }); // 中键关闭
    el.querySelector('.pgx').addEventListener('click', () => call('pages:close', p.index).catch((err) => add('note err', `✗ ${esc(err.message)}`, true)));
    return el;
  }));
  bar.querySelector('.pg.on')?.scrollIntoView({ inline: 'nearest' });
}
api.on('pages', renderPages);
$('pageNew').addEventListener('click', () => call('pages:new').then(() => { $('url').focus(); }).catch((e) => add('note err', `✗ ${esc(e.message)}`, true)));

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
$('ne_home').addEventListener('click', () => call('nav:go', cfg.home || 'https://browserx.xingke888.com/'));
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
// 制作时用户动了右侧网页：横幅上问一句要不要录，点「开始录制」才录；10 秒没点就收起
let recAskTimer = null;
function showRecAsk() {
  if (!$('mk_hint').hidden && $('mk_hint').classList.contains('action')) return; // 横幅上正在提示用户做别的事（扫码、回答问题…），先不问
  $('mk_recask').hidden = false;
  clearTimeout(recAskTimer);
  recAskTimer = setTimeout(() => { $('mk_recask').hidden = true; }, 10000);
}
$('mk_recask').querySelector('.mk_recgo').addEventListener('click', () => {
  $('mk_recask').hidden = true;
  $('mk_rec').click();
});
function renderRec(s) {
  const on = !!s?.recording;
  if (on) $('mk_recask').hidden = true;
  $('recBtn').classList.toggle('on', on);
  $('recBtn').setAttribute('aria-label', on ? '停止录制' : '开始录制');
  $('recText').textContent = on ? `停止录制 · ${s.requests ?? 0}` : '开始录制';
  $('recMark').hidden = !on;
  $('mk_rec').textContent = on ? '停止录制' : '开始录制'; // 圆形按钮里两字一行
  $('mk_rec').classList.toggle('on', on);
  if (!on) recMarkN = 0;
  clearInterval(recTimer);
  recTimer = on ? setInterval(() => call('rec:status').then((x) => { if (x.recording) $('recText').textContent = `停止录制 · ${x.requests}`; }).catch(() => {}), 1000) : null;
}

$('recBtn').addEventListener('click', async () => {
  const btn = $('recBtn');
  btn.disabled = true;
  try {
    if (!btn.classList.contains('on')) {
      await call('rec:start', {});
      return;
    }
    // 制作工具时：停录制、显示结果、交给助手都在 agent.finishMakingRec 里（跟「录制中在对话里发一句话」走同一条路）
    if (cur.making) { await call('making:recStop', cur.id); return; }
    const r = await call('rec:stop');
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

// 标准表单的高度上限 = （工具箱顶 → 发送框顶）的一半；窗口大小、发送框高度变了就重算（见 style.css「表单按自身内容的高度」）
function updateFormMax() {
  // 工具箱藏着时量不到位置，用标签栏下沿（制作横幅开着就用横幅下沿）
  const above = !$('makingBar').hidden ? $('makingBar') : $('tabs');
  const top = above.getBoundingClientRect().bottom, bottom = document.querySelector('#side .composer').getBoundingClientRect().top;
  if (bottom > top) $('side').style.setProperty('--formMax', Math.floor((bottom - top) / 2) + 'px');
}
new ResizeObserver(updateFormMax).observe($('side'));
new ResizeObserver(updateFormMax).observe(document.querySelector('#side .composer'));

// 填表页面和对话上下分割：拖中间那条改对话区高度（像素，记住上次的）；表单至少留 300px，对话至少 80px
const CHAT_H_KEY = 'formChatHeight';
function setChatH(px) {
  // 上限按实际位置算：工具箱顶到发送框之间，减去拖动条，表单（含标题）至少留 300px
  const room = document.querySelector('#side .composer').getBoundingClientRect().top - $('toolbox').getBoundingClientRect().top - 1;
  px = Math.max(80, Math.min(room - 300, px));
  $('side').style.setProperty('--chatH', px + 'px');
  try { localStorage.setItem(CHAT_H_KEY, px); } catch {}
}
try { const h = +localStorage.getItem(CHAT_H_KEY); if (h) $('side').style.setProperty('--chatH', h + 'px'); } catch {}
$('formSplit').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const bottom = document.querySelector('#side .composer').getBoundingClientRect().top; // 对话区下沿 = 发送框上沿
  document.body.classList.add('vdragging');
  const move = (ev) => setChatH(bottom - ev.clientY);
  const up = () => { document.body.classList.remove('vdragging'); removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
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
const PANELS = ['toolbox', 'history', 'account'];
function showTab(id) {
  const t = tabOf(id);
  if (cur && cur !== t) {
    cur.panel = PANELS.find((p) => !$(p).hidden) || null; // 记住这个标签开着哪个面板
    cur.el.hidden = true; cur.el.removeAttribute('id');
    cur.tb.hidden = true; cur.tb.removeAttribute('id');
    cur.pages.hidden = true;
  }
  cur = T = t;
  t.el.id = 'msgs'; // 样式都写在 #msgs 上，当前标签的消息区拿这个 id
  t.el.hidden = false;
  t.tb.id = 'tb_list';
  t.tb.hidden = !!t.pageOpen;
  t.pages.hidden = !t.pageOpen;
  $('toolbox').classList.toggle('haspage', !!t.pageOpen);
  $('toolbox').classList.toggle('folded', !!t.pageOpen && !!t.pages.querySelector('.tbkeep.folded:not([hidden])'));
  // 恢复这个标签上次开着的面板：工具箱原样显示（内容一直在）；历史 / 账号重新拉一次
  for (const p of PANELS) $(p).hidden = t.panel !== p;
  if (t.panel === 'toolbox' && !t.tb.children.length) renderToolboxList();
  if (t.panel === 'history') renderHistoryList();
  if (t.panel === 'account') renderAccount();
  t.attn = false;
  renderRunning();
  renderMaking(t.making);
  renderTabs();
  call('rec:status').then(renderRec).catch(() => {});
}

async function selectTab(id) {
  if (cur?.id === id) return;
  $('settings').hidden = true; // 其它面板跟着标签走（见 showTab）
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
  t.tb.remove();
  t.pages.remove();
  if (cur === t) { cur = null; showTab(next); focusInput(); }
  else renderTabs();
}

// 主进程推送各标签的网页标题 / 网址（没有对话标题时标签上显示网页标题）
api.on('tabs', (list) => {
  for (const x of list) {
    const t = tabOf(x.id); // 主进程自己开的对话（比如定时任务）界面上也要有：没见过的就建起来
    t.pageTitle = x.title; t.url = x.url;
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
call('app:showSettings').then((show) => { if (!show) $('btnSettings').style.display = 'none'; }); // 正式版不给客户看设置（见 main.js SHOW_SETTINGS）；button.icon 是 display:grid，hidden 属性藏不住
// 界面刷新（⌘R）后主进程里的标签还在：照原样建回来（对话内容只在界面里，刷新后就没了，跟以前一样）
call('tabs:list').then(async (list) => {
  for (const x of list) Object.assign(tabOf(x.id), { pageTitle: x.title, url: x.url });
  await Promise.all(list.map((x) => call('making:state', x.id).then((m) => { tabOf(x.id).making = m; }).catch(() => {})));
  showTab((list.find((x) => x.current) || list[0]).id);
  call('nav:state').then(renderNav).catch(() => {});
  focusInput();
});
