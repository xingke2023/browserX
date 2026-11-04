#!/usr/bin/env node
// 开发用：把界面上的中文原文收集成翻译用的键 → locales/_keys.json（再用 scripts/i18n-translate.py 翻成各语言）。
//   index.html：标签之间的文字、title / placeholder / aria-label
//   renderer.js：含中文的字符串和模板字符串；${…} 换成 {0} {1}…，按 HTML 标签切开，每段文字一个键（标签里的提示属性也收）
//   main.js / updater.js：L('…') / this.t('…') 的第一个参数
// 跟运行时 i18n.js 的匹配方式一一对应：屏幕上的一个文字节点 = 这里切出来的一段
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const ROOT = path.join(__dirname, '..');
const HAS_ZH = /[一-鿿]/;
const ATTR_RE = /\b(title|placeholder|aria-label)="([^"]*)"/g;
const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const keys = new Set();

// 一段可能带 {n} 的文字：去掉首尾空白，{n} 按出现顺序重新编号成 {0} {1}…，只收含中文、而且不只是占位符的
function addText(raw) {
  let n = 0;
  const map = {};
  const t = decode(raw).trim().replace(/\{(\d+)\}/g, (_, i) => `{${(map[i] ??= n++)}}`);
  if (t && HAS_ZH.test(t) && t.length <= 300) keys.add(t);
}
// 一段 HTML（可能带 {n}）：标签里的提示属性单独收，标签之间的文字一段一个
function addHtml(s) {
  for (const tag of s.match(/<[^>]*>/g) || []) for (const m of tag.matchAll(ATTR_RE)) addText(m[2]);
  for (const part of s.split(/<[^>]*>/)) addText(part);
}

// index.html：去掉 script / style 后按 HTML 处理
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, '');
addHtml(html);

// renderer.js
const parse = (file) => acorn.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'), { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
walk.simple(parse('renderer.js'), {
  Literal(n) { if (typeof n.value === 'string' && HAS_ZH.test(n.value)) addHtml(n.value.replace(/[{}]/g, (c) => (c === '{' ? '｛' : '｝'))); },
  TemplateLiteral(n) {
    if (!n.quasis.some((q) => HAS_ZH.test(q.value.cooked || ''))) return;
    let s = '';
    n.quasis.forEach((q, i) => { s += (q.value.cooked || '').replace(/[{}]/g, (c) => (c === '{' ? '｛' : '｝')); if (i < n.expressions.length) s += `{${i}}`; });
    addHtml(s);
  },
});

// main.js / updater.js：L('…') / this.t('…') / t('…')
for (const f of ['main.js', 'updater.js']) {
  walk.simple(parse(f), {
    CallExpression(n) {
      const c = n.callee;
      const name = c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' && !c.computed ? c.property.name : '';
      if (!['L', 't'].includes(name)) return;
      const a = n.arguments[0];
      if (a && a.type === 'Literal' && typeof a.value === 'string' && HAS_ZH.test(a.value)) keys.add(a.value);
      if (a && a.type === 'ConditionalExpression') for (const b of [a.consequent, a.alternate]) if (b.type === 'Literal' && HAS_ZH.test(b.value)) keys.add(b.value);
    },
  });
}

// agent.js：制作横幅的进度步骤（MAKING_STEPS，界面直接显示这些字）
walk.simple(parse('agent.js'), {
  VariableDeclarator(n) {
    if (n.id.name !== 'MAKING_STEPS' || n.init?.type !== 'ArrayExpression') return;
    for (const e of n.init.elements) if (e.type === 'Literal' && HAS_ZH.test(e.value)) keys.add(e.value);
  },
});

// 第二期：程序发到对话里的提示、横幅提示、报错（agent.js 等模块里的中文字符串）。
// 跳过给模型看的：*_PROMPT 常量、REPLY_LANGS、MCP 工具定义 tool(…) 和参数说明 .describe(…)、发给模型的消息 send(…)、
// 过程记录 logMaking(…)、askModel(…)，以及 400 字以上的长文。多行的整段收一份，每一行也各收一份（开场说明按行显示）
const MODEL_CALLS = new Set(['tool', 'describe', 'send', 'logMaking', 'askModel', 'userSend']);
const calleeName = (c) => (c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' && !c.computed ? c.property.name : '');
function forModel(ancestors) {
  return ancestors.some((a) => (a.type === 'CallExpression' && MODEL_CALLS.has(calleeName(a.callee)))
    || (a.type === 'VariableDeclarator' && /PROMPT|^REPLY_LANGS$|^BUILTIN_TOOLS$/.test(a.id.name || ''))
    || (a.type === 'Property' && !a.computed && /^(rule|description|system)$/.test(a.key.name || a.key.value || '')));
}
function addMessage(s) {
  if (s.length > 400) return;
  addText(s);
  if (s.includes('\n')) for (const line of s.split('\n')) addText(line);
}
const tplText = (n) => n.quasis.map((q, i) => (q.value.cooked || '').replace(/[{}]/g, (c) => (c === '{' ? '｛' : '｝')) + (i < n.expressions.length ? `{${i}}` : '')).join('');
for (const f of ['agent.js', 'recorder.js', 'wechat.js', 'account.js', 'main.js', 'scheduler.js', 'toolcrypt.js']) {
  walk.ancestor(parse(f), {
    Literal(n, _s, anc) { if (typeof n.value === 'string' && HAS_ZH.test(n.value) && !forModel(anc)) addMessage(n.value.replace(/[{}]/g, (c) => (c === '{' ? '｛' : '｝'))); },
    TemplateLiteral(n, _s, anc) { if (n.quasis.some((q) => HAS_ZH.test(q.value.cooked || '')) && !forModel(anc)) addMessage(tplText(n)); },
  });
}

// 原文里本来就有的全角大括号还原（上面为了不跟 {n} 混，临时换掉了）
const out = [...keys].map((k) => k.replace(/｛/g, '{').replace(/｝/g, '}')).sort();
fs.mkdirSync(path.join(ROOT, 'locales'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'locales', '_keys.json'), `${JSON.stringify(out, null, 1)}\n`);
console.log(`收集到 ${out.length} 条界面文字 → locales/_keys.json`);
