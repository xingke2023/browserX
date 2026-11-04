#!/usr/bin/env node
// 开发用：把 BrowserX 最近一个会话（默认就是正在制作工具的那个）实际发给模型的内容整理成网页，每 3 秒重新生成一次（网页本身不自动刷新，手动刷新看最新内容）。
//   node scripts/show-making.js            # 跟踪 ~/.claude/projects/-Users-mi-BrowserX/ 下最新的会话
//   node scripts/show-making.js <x.jsonl>  # 看指定会话
// 网页写到 /tmp/browserx-making.html。系统提示里 Claude Code 自带的那部分不在会话记录里，看不到；
// BrowserX 追加的部分（浏览器 / 工具箱 / 制作模式）按当前 agent.js 重建。
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const OUT = '/tmp/browserx-making.html';
const cfgFile = path.join(os.homedir(), 'Library/Application Support/BrowserX/config.json');
const cfg = (() => { try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { return {}; } })();
const projDir = path.join(os.homedir(), '.claude/projects', (cfg.cwd || path.join(os.homedir(), 'BrowserX')).replace(/[^a-zA-Z0-9]/g, '-'));
const toolsDir = path.join(os.homedir(), 'Library/Application Support/BrowserX/tools');
const drafts = path.join(toolsDir, '_drafts');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const latest = () => fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl'))
  .map((f) => path.join(projDir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];

// 从 agent.js 里取出四段提示词的源码，在沙箱里求值（不加载整个 agent.js，免得拉起 electron 依赖）
function prompts(draftName) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
  const a = src.indexOf('const LANG_PROMPT');
  const b = src.indexOf('// 工具的制作记录');
  const ctx = { THEMES: require('../article').THEMES }; // WECHAT_PROMPT 里列了排版主题
  vm.runInNewContext(`${src.slice(a, b)}\nthis.r = { LANG_PROMPT, BROWSER_PROMPT, WECHAT_PROMPT, TOOLBOX_PROMPT, MAKING_PROMPT };`, ctx);
  const { LANG_PROMPT, BROWSER_PROMPT, WECHAT_PROMPT, TOOLBOX_PROMPT, MAKING_PROMPT } = ctx.r;
  const parts = [['回复语言 LANG_PROMPT（首尾各一次，这里按简体中文显示）', LANG_PROMPT('zh-CN')], ['浏览器规则 BROWSER_PROMPT', BROWSER_PROMPT], ['工具箱规则 TOOLBOX_PROMPT', TOOLBOX_PROMPT(toolsDir)]];
  if (draftName) {
    const draft = path.join(drafts, `${draftName}.js`);
    const code = fs.existsSync(draft) ? fs.readFileSync(draft, 'utf8') : '';
    const title = (code.match(/title:\s*['"`]([^'"`]+)/) || [])[1] || '';
    const m = { name: draftName, title, goal: '', goalGiven: false, editing: false, resumed: false, draft,
      notes: draft.replace(/\.js$/, '.notes.md'), process: draft.replace(/\.js$/, '.process.md') };
    if (/公众号|微信|wechat|weixin/i.test(`${draftName} ${title}`)) parts.splice(1, 0, ['公众号规则 WECHAT_PROMPT', WECHAT_PROMPT]);
    parts.push([`制作模式规则 MAKING_PROMPT（工具 ${draftName}）`, MAKING_PROMPT(m)]);
  }
  return parts;
}

function blockHtml(b) {
  if (b.type === 'text') return `<div class="b text"><span class="tag">文字</span><pre>${esc(b.text)}</pre></div>`;
  if (b.type === 'thinking') return `<div class="b think"><span class="tag">思考</span><pre>${esc(b.thinking || '（内容已加密，看不到）')}</pre></div>`;
  if (b.type === 'tool_use') return `<div class="b use"><span class="tag">调用 ${esc(b.name)}</span><pre>${esc(JSON.stringify(b.input, null, 2))}</pre></div>`;
  if (b.type === 'tool_result') {
    const c = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content ?? '') }];
    const body = c.map((x) => (x.type === 'image' ? '［截图］' : x.text || '')).join('\n');
    return `<div class="b res${b.is_error ? ' err' : ''}"><span class="tag">${b.is_error ? '工具报错' : '工具结果'}</span><pre>${esc(body.length > 6000 ? `${body.slice(0, 6000)}\n…（共 ${body.length} 字，后面省略）` : body)}</pre></div>`;
  }
  if (b.type === 'image') return '<div class="b res"><span class="tag">图片</span></div>';
  return `<div class="b"><span class="tag">${esc(b.type)}</span></div>`;
}

function render(file) {
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  // 草稿名：从写草稿的工具调用或会话内容里找 _drafts/<name>.js
  const draftName = (fs.readFileSync(file, 'utf8').match(/_drafts\/([a-zA-Z_][a-zA-Z0-9_]*)\.js/) || [])[1]
    || (fs.existsSync(drafts) ? fs.readdirSync(drafts).filter((f) => f.endsWith('.js')).map((f) => path.join(drafts, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).map((f) => path.basename(f, '.js'))[0] : '');

  // 一次 API 请求 = 同一个 message.id 的几条 assistant 记录；它前面那些 user / attachment 就是这次请求新增的输入
  const turns = [];
  let pending = [], cur = null, prevTs = null;
  for (const o of rows) {
    if (o.type === 'assistant') {
      const id = o.message.id;
      if (!cur || cur.id !== id) { cur = { id, ts: o.timestamp, model: o.message.model, usage: o.message.usage, input: pending, out: [], prevTs }; turns.push(cur); pending = []; }
      cur.out.push(...(o.message.content || []));
      cur.usage = o.message.usage || cur.usage;
      cur.end = o.timestamp;
      prevTs = o.timestamp;
    } else if (o.type === 'user') {
      const c = o.message.content;
      pending.push(...(typeof c === 'string' ? [{ type: 'text', text: c, user: true }] : c.map((x) => ({ ...x, user: x.type === 'text' }))));
      cur = null;
      pending.ts = o.timestamp;
    } else if (o.type === 'attachment' && o.rendered?.length) {
      pending.push({ type: 'attach', kind: o.attachment?.type, text: o.rendered.map((r) => r.content).join('\n') });
    }
  }

  let total = { in: 0, cr: 0, cw: 0, out: 0 };
  const turnHtml = turns.map((t, i) => {
    const u = t.usage || {};
    total.in += u.input_tokens || 0; total.cr += u.cache_read_input_tokens || 0; total.cw += u.cache_creation_input_tokens || 0; total.out += u.output_tokens || 0;
    const startRef = t.input.ts || t.prevTs;
    const secs = startRef ? ((new Date(t.end) - new Date(startRef)) / 1000).toFixed(1) : '?';
    const inputs = t.input.map((x) => {
      if (x.type === 'attach') return `<details class="b att"><summary><span class="tag">系统附加 ${esc(x.kind)}</span> ${x.text.length} 字</summary><pre>${esc(x.text)}</pre></details>`;
      if (x.user) return `<div class="b user"><span class="tag">用户 / BrowserX 发的消息</span><pre>${esc(x.text)}</pre></div>`;
      return blockHtml(x);
    }).join('');
    return `<section class="turn"><h3>第 ${i + 1} 次请求 <small>${new Date(t.ts).toLocaleTimeString('zh-CN', { hour12: false })} · ${esc(t.model)} · 约 ${secs} 秒</small></h3>
      <div class="usage">新输入 ${u.input_tokens || 0} · 读缓存 ${u.cache_read_input_tokens || 0} · 写缓存 ${u.cache_creation_input_tokens || 0} · 输出 ${u.output_tokens || 0}${u.output_tokens_details?.thinking_tokens ? `（思考 ${u.output_tokens_details.thinking_tokens}）` : ''}</div>
      ${inputs ? `<div class="col"><div class="lbl">这次新增的输入</div>${inputs}</div>` : ''}
      <div class="col"><div class="lbl">模型输出</div>${t.out.map(blockHtml).join('')}</div></section>`;
  }).join('');

  let sys = '';
  try {
    sys = prompts(draftName).map(([k, v]) => `<details class="b sys"><summary><span class="tag">${esc(k)}</span> ${v.length} 字</summary><pre>${esc(v)}</pre></details>`).join('');
  } catch (e) { sys = `<div class="b err">重建提示词失败：${esc(e.message)}</div>`; }

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>制作工具请求</title><style>
:root{--bg:#fafafa;--fg:#1d1d1f;--mut:#6e6e73;--card:#fff;--line:#e3e3e8;--user:#e8f1ff;--use:#fff6e5;--res:#eef8ee;--think:#f3eefc;--err:#fdecec;--sys:#f2f2f5}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#161618;--fg:#e8e8ea;--mut:#9a9aa0;--card:#1f1f22;--line:#333338;--user:#1c2a40;--use:#3a2f18;--res:#1b301d;--think:#2a2140;--err:#401c1c;--sys:#26262a}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,"PingFang SC",sans-serif}
main{max-width:1100px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:8px 0}h2{font-size:16px;margin:24px 0 8px}h3{font-size:15px;margin:0 0 4px}small,.usage,.meta{color:var(--mut);font-weight:400}
.turn{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin:12px 0}
.lbl{font-size:12px;color:var(--mut);margin:10px 0 4px}
.b{border-radius:6px;padding:6px 8px;margin:4px 0;background:var(--sys)}
.user{background:var(--user)}.use{background:var(--use)}.res{background:var(--res)}.think{background:var(--think)}.err{background:var(--err)}
.tag{font-size:12px;font-weight:600}summary{cursor:pointer}
pre{white-space:pre-wrap;word-break:break-word;margin:4px 0 0;font:12px/1.5 ui-monospace,Menlo,monospace;max-height:420px;overflow:auto}
.bar{position:sticky;top:0;background:var(--bg);padding:8px 0;border-bottom:1px solid var(--line);display:flex;gap:16px;flex-wrap:wrap;align-items:center}
</style></head><body><main>
<div class="bar"><h1>制作工具：实际发给模型的内容</h1><span class="meta">按 ⌘R 刷新看最新内容</span></div>
<p class="meta">会话 ${esc(path.basename(file))} · 草稿 ${esc(draftName || '（没找到）')} · ${turns.length} 次请求 · 合计：新输入 ${total.in}，读缓存 ${total.cr}，写缓存 ${total.cw}，输出 ${total.out} · 生成于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}</p>
<h2>系统提示</h2>
<p class="meta">每次请求都会带上整段系统提示。开头是 Claude Code 自带的部分（会话记录里没有，这里看不到），后面是 BrowserX 追加的这几段（按当前 agent.js 重建）。第 1 次请求的「写缓存」数大致就是系统提示加工具定义的总量。</p>
${sys}
<h2>每次请求</h2>
<p class="meta">每次请求都会把之前的全部对话再发一遍（大部分走缓存）；下面只列每次新增的部分。</p>
${turnHtml}
<div id="end"></div></main></body></html>`;
  fs.writeFileSync(OUT, html);
}

const arg = process.argv[2];
const tick = () => { try { render(arg || latest()); } catch (e) { console.error(e.message); } };
tick();
console.log(`已生成 ${OUT}`);
if (!arg || process.argv.includes('--watch')) setInterval(tick, 3000);
