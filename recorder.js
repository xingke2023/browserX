// 网络录制：用户在右侧浏览器里手工操作一遍，把页面发出的接口请求（XHR/fetch/页面跳转）录下来存成 JSON，
// 给模型分析接口、写成工具箱里的自定义工具用（思路同 security-plan-maker 各平台的 recon/trace）。
// 走 webContents.debugger 的 Network 域，跟 agent.js 的 cdp() 共用同一个 debugger 连接（attach 只能一次）。
//
// 录制文件只存在本机 <userData>/recon/<域名>/ 下，但里面仍可能有客户资料、单号等真实数据：
// 敏感请求头（Authorization/Cookie/各种 token）、请求体和响应里的密码/token 字段一律打码，
// 打码前先记下这些值最早出现在哪（哪个响应的哪个字段 / localStorage 的哪个 key / 哪个 cookie），
// 模型写工具时要知道「token 从哪来」，但不需要知道 token 本身。
const fs = require('fs');
const path = require('path');

const SENSITIVE_HEADER = /authorization|cookie|token|auth|session|csrf|xsrf|sign|secret|api-?key|password/i;
const SENSITIVE_FIELD = /pass(word)?|pwd|otp|captcha|verif(y|ication)?code|secret|token|session|pin$|cvv|card_?no|credential/i;
const KEEP_TYPES = new Set(['XHR', 'Fetch', 'Document', 'EventSource']);
const BODY_TYPES = new Set(['XHR', 'Fetch', 'EventSource']);
const MAX_BODY = 20000;   // 每个响应体最多保存的字符数
const MAX_POST = 20000;
const MAX_ENTRIES = 3000; // 防止忘了停止时无限增长

const mask = (v) => `«已打码 长度${String(v).length}»`;
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

function hostOf(url) {
  try { return new URL(url).host.replace(/[^\w.-]/g, '_') || 'unknown'; } catch { return 'unknown'; }
}

// 把 JSON 里键名敏感的字段打码；secrets 收集被打码的原值（用于之后找 token 来源），path 记录字段路径
function maskJson(v, secrets, where, p = '') {
  if (Array.isArray(v)) return v.map((x, i) => maskJson(x, secrets, where, `${p}[${i}]`));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const kp = p ? `${p}.${k}` : k;
      if (SENSITIVE_FIELD.test(k) && (typeof x === 'string' || typeof x === 'number')) {
        secrets?.push({ value: String(x), where: `${where} 字段 ${kp}` });
        out[k] = mask(x);
      } else out[k] = maskJson(x, secrets, where, kp);
    }
    return out;
  }
  return v;
}

// 请求体 / 响应体：JSON 按字段打码，表单按参数打码，其它原样（截断）
function maskBody(text, secrets, where, max) {
  if (text == null) return undefined;
  const s = String(text);
  try { return maskJson(JSON.parse(s), secrets, where); } catch { /* 不是 JSON */ }
  if (/^[\w.%[\]-]+=[^&]*(&[\w.%[\]-]+=[^&]*)*$/.test(s.trim())) {
    const params = new URLSearchParams(s);
    const out = {};
    for (const [k, x] of params) {
      if (SENSITIVE_FIELD.test(k)) { secrets?.push({ value: x, where: `${where} 表单参数 ${k}` }); out[k] = mask(x); } else out[k] = x;
    }
    return { '«表单»': out };
  }
  return s.length > max ? `${s.slice(0, max)}…«截断，共 ${s.length} 字符»` : s;
}

function maskHeaders(h, secrets, where) {
  if (!h) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (/^(cookie|set-cookie)$/i.test(k)) {
      // 保留 cookie 名字（写工具时要知道靠哪个 cookie 维持登录），值打码
      out[k] = String(v).split(/;\s*|\n/).map((c) => {
        const i = c.indexOf('=');
        if (i < 0) return c;
        const name = c.slice(0, i).trim();
        if (/^(path|domain|expires|max-age|samesite)$/i.test(name)) return c;
        secrets.push({ value: c.slice(i + 1), where: `cookie ${name}` });
        return `${name}=${mask(c.slice(i + 1))}`;
      }).join('; ');
    } else if (SENSITIVE_HEADER.test(k)) {
      secrets.push({ value: String(v).replace(/^Bearer\s+/i, ''), where: `${where} 请求头 ${k}` });
      out[k] = mask(v);
    } else out[k] = v;
  }
  return out;
}

class Recorder {
  // opts: { webContents, cdp(method, params), dir() -> 录制根目录, emit(text), onChange(status) }
  constructor(opts) {
    this.wc = opts.webContents;
    this.cdp = opts.cdp;
    this.dir = opts.dir;
    this.emit = opts.emit;
    this.onChange = opts.onChange || (() => {});
    this.active = null;
  }

  status() {
    if (!this.active) return { recording: false };
    const a = this.active;
    return { recording: true, since: a.startedAt, requests: a.entries.filter((e) => e.kind === 'request').length, label: a.label };
  }

  async start({ all = false, filter = '', label = '' } = {}) {
    if (this.active) throw new Error('已经在录制中，先 rec_stop');
    let re = null;
    if (filter) { try { re = new RegExp(filter, 'i'); } catch (e) { throw new Error(`filter 不是合法的正则：${e.message}`); } }
    try {
      await this.cdp('Network.enable', { maxPostDataSize: MAX_POST });
    } catch (e) {
      throw new Error(`打开网络监听失败（右侧浏览器的开发者工具开着时无法录制，请先关掉）：${e.message}`);
    }
    const a = this.active = {
      label, all, re,
      startedAt: new Date().toISOString(),
      startUrl: this.wc.getURL(),
      entries: [],
      byId: new Map(),       // requestId -> entry
      extra: new Map(),      // requestId -> 早于 requestWillBeSent 到达的 ExtraInfo
      rawBodies: [],         // 打码前的响应体，只在内存里用来找 token 来源，停止后丢弃
      secrets: [],           // 被打码的原值 + 出现位置
      pending: new Set(),    // 正在取的响应体
      seq: 0,
    };
    const t0 = Date.now();
    const add = (e) => {
      if (a.entries.length >= MAX_ENTRIES) return null;
      e.seq = ++a.seq;
      e.t = Date.now() - t0;
      a.entries.push(e);
      return e;
    };
    a.add = add;

    a.onMessage = (_ev, method, p) => {
      try { this.handle(a, method, p); } catch (err) { /* 单条解析失败不影响整体录制 */ }
    };
    a.onNav = (_ev, url) => add({ kind: 'nav', url });
    a.onDetach = (_ev, reason) => {
      if (this.active !== a) return;
      const file = this.save();
      this.active = null;
      this.emit(`网络录制被中断（${reason}），已保存到 ${file}`);
      this.onChange(this.status());
    };
    this.wc.debugger.on('message', a.onMessage);
    this.wc.debugger.on('detach', a.onDetach);
    this.wc.on('did-navigate', a.onNav);
    this.wc.on('did-navigate-in-page', a.onNav);
    add({ kind: 'nav', url: a.startUrl, note: '录制开始时所在页面' });
    this.emit(`开始网络录制${label ? `：${label}` : ''}。请在右侧浏览器里操作，完成后点「停止录制」或在对话里说「停止录制」`);
    this.onChange(this.status());
    return `已开始录制（${all ? '所有请求' : '只录 XHR/fetch/页面跳转'}${re ? `，URL 过滤 ${filter}` : ''}）。当前页面：${a.startUrl}`;
  }

  keep(a, p) {
    if (/^(data|blob|chrome-extension|devtools):/.test(p.request.url)) return false;
    if (a.re && !a.re.test(p.request.url)) return false;
    return a.all || KEEP_TYPES.has(p.type);
  }

  handle(a, method, p) {
    if (method === 'Network.requestWillBeSent') {
      const prev = a.byId.get(p.requestId);
      // 重定向：同一个 requestId 再发一次，先把上一跳的状态码补上
      if (prev && p.redirectResponse) {
        prev.status = p.redirectResponse.status;
        prev.redirectTo = p.request.url;
      }
      if (!this.keep(a, p)) return;
      const where = `#${a.seq + 1}`;
      const e = a.add({
        kind: 'request',
        method: p.request.method,
        url: p.request.url,
        type: p.type,
        reqHeaders: p.request.headers,
        postData: p.request.postData,
        initiator: p.initiator?.type,
      });
      if (!e) return;
      e._where = where;
      a.byId.set(p.requestId, e);
      const ex = a.extra.get(p.requestId);
      if (ex) { Object.assign(e.reqHeaders, ex); a.extra.delete(p.requestId); }
      // 请求体太大时 requestWillBeSent 里不带，要单独取
      if (p.request.hasPostData && p.request.postData == null) {
        const job = this.cdp('Network.getRequestPostData', { requestId: p.requestId })
          .then((r) => { e.postData = r.postData; }).catch(() => {}).finally(() => a.pending.delete(job));
        a.pending.add(job);
      }
    } else if (method === 'Network.requestWillBeSentExtraInfo') {
      // 带 Cookie 等完整请求头，可能早于 requestWillBeSent 到达
      const e = a.byId.get(p.requestId);
      if (e) Object.assign(e.reqHeaders, p.headers);
      else a.extra.set(p.requestId, p.headers);
    } else if (method === 'Network.responseReceived') {
      const e = a.byId.get(p.requestId);
      if (!e) return;
      e.status = p.response.status;
      e.mime = p.response.mimeType;
      e.resHeaders = p.response.headers;
    } else if (method === 'Network.responseReceivedExtraInfo') {
      const e = a.byId.get(p.requestId);
      const sc = p.headers && (p.headers['set-cookie'] || p.headers['Set-Cookie']);
      if (e && sc) e.setCookie = sc;
    } else if (method === 'Network.loadingFinished') {
      const e = a.byId.get(p.requestId);
      if (!e || !(a.all || BODY_TYPES.has(e.type))) return;
      const job = this.cdp('Network.getResponseBody', { requestId: p.requestId })
        .then((r) => {
          if (r.base64Encoded) { e.resBody = `«二进制，${Math.round(r.body.length * 0.75)} 字节»`; return; }
          a.rawBodies.push({ where: e._where, body: r.body });
          e.resBody = r.body;
        })
        .catch(() => { e.resBody = '«取不到响应体»'; })
        .finally(() => a.pending.delete(job));
      a.pending.add(job);
    } else if (method === 'Network.loadingFailed') {
      const e = a.byId.get(p.requestId);
      if (e) e.failed = p.errorText;
    }
  }

  mark(label) {
    if (!this.active) throw new Error('当前没有在录制');
    this.active.add({ kind: 'mark', label });
    return `已加标记：${label}`;
  }

  // 打码 + 写文件（同步，退出应用时也能调）。返回文件路径
  save() {
    const a = this.active;
    const entries = a.entries.map((e) => {
      if (e.kind !== 'request') return e;
      const { _where, ...r } = e;
      r.reqHeaders = maskHeaders(r.reqHeaders, a.secrets, _where);
      r.resHeaders = maskHeaders(r.resHeaders, a.secrets, _where);
      if (r.setCookie) r.setCookie = maskHeaders({ 'set-cookie': r.setCookie }, a.secrets, _where)['set-cookie'];
      if (r.postData != null) r.postData = maskBody(r.postData, a.secrets, `${_where} 请求体`, MAX_POST);
      if (typeof r.resBody === 'string' && !r.resBody.startsWith('«')) r.resBody = maskBody(r.resBody, a.secrets, `${_where} 响应`, MAX_BODY);
      try { const u = new URL(r.url); for (const [k, v] of u.searchParams) if (SENSITIVE_FIELD.test(k)) { a.secrets.push({ value: v, where: `${_where} URL 参数 ${k}` }); u.searchParams.set(k, '«已打码»'); } r.url = u.toString(); } catch {}
      return r;
    });
    const out = {
      label: a.label,
      startedAt: a.startedAt,
      stoppedAt: new Date().toISOString(),
      startUrl: a.startUrl,
      note: '敏感值已打码；tokenSources 说明每个被打码的值最早出现在哪里（写工具时据此取 token）',
      tokenSources: this.tokenSources(a),
      storage: a.storage,
      entries,
    };
    // 按请求最多的域名归档（常见情况是在别的页面点了录制，再打开目标网站）
    const count = new Map();
    for (const e of a.entries) if (e.kind === 'request' && /^https?:/.test(e.url)) count.set(hostOf(e.url), (count.get(hostOf(e.url)) || 0) + 1);
    const site = [...count].sort((x, y) => y[1] - x[1])[0]?.[0] || hostOf(a.startUrl);
    const dir = path.join(this.dir(), site);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `trace-${stamp()}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 1));
    return file;
  }

  // 每个被打码、长度够长（像 token）的值：最早出现在哪个响应里 / 哪个 storage key / 哪个 cookie，之后在哪些请求里被用到
  tokenSources(a) {
    const seen = new Map();
    for (const s of a.secrets) {
      if (s.value.length < 12) continue;
      if (!seen.has(s.value)) seen.set(s.value, new Set());
      seen.get(s.value).add(s.where);
    }
    const res = [];
    for (const [value, uses] of seen) {
      // 只出现在请求体的密码 / 验证码字段里的，是用户自己输入的，不是 token
      if ([...uses].every((w) => /(请求体|表单参数).*(pass|pwd|otp|captcha|verif|pin)/i.test(w))) continue;
      const origin = [];
      const body = a.rawBodies.find((b) => b.body.includes(value));
      if (body) origin.push(`首次出现在 ${body.where} 的响应体里`);
      for (const [k, v] of Object.entries(a.storageRaw || {})) if (v.includes(value)) origin.push(k);
      res.push({ length: value.length, origin: origin.length ? origin : ['录制期间没找到来源（可能是录制开始前就已存在的 cookie / 内存变量）'], usedIn: [...uses].slice(0, 20) });
    }
    return res;
  }

  async stop() {
    const a = this.active;
    if (!a) throw new Error('当前没有在录制');
    // 等正在取的响应体 / 请求体，最多 5 秒
    await Promise.race([Promise.allSettled([...a.pending]), new Promise((r) => setTimeout(r, 5000))]);
    // storage 快照：只留 key 和长度给模型看，原值只在内存里用来匹配 token 来源
    try {
      const raw = await this.wc.executeJavaScript(`(() => {
        const o = {};
        try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o['localStorage.' + k] = String(localStorage.getItem(k)); } } catch {}
        try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); o['sessionStorage.' + k] = String(sessionStorage.getItem(k)); } } catch {}
        for (const c of document.cookie.split(/;\\s*/)) { const i = c.indexOf('='); if (i > 0) o['document.cookie.' + c.slice(0, i)] = c.slice(i + 1); }
        return { url: location.href, o };
      })()`, true);
      a.storageRaw = raw.o;
      a.storage = { url: raw.url, keys: Object.fromEntries(Object.entries(raw.o).map(([k, v]) => [k, `长度${v.length}`])) };
    } catch { /* 页面不可用时跳过 */ }
    this.detach(a);
    const file = this.save();
    this.active = null;
    this.emit(`网络录制已停止，保存到 ${file}`);
    this.onChange(this.status());
    return { file, summary: this.summary(a, file) };
  }

  detach(a) {
    this.wc.debugger.removeListener('message', a.onMessage);
    this.wc.debugger.removeListener('detach', a.onDetach);
    this.wc.removeListener('did-navigate', a.onNav);
    this.wc.removeListener('did-navigate-in-page', a.onNav);
    this.cdp('Network.disable').catch(() => {});
  }

  // 给模型的简报：按「方法 + 路径（数字/长 id 归一成 :id）」合并的接口清单，加上标记和 token 来源
  summary(a, file) {
    const groups = new Map();
    const timeline = [];
    for (const e of a.entries) {
      if (e.kind === 'mark') { timeline.push(`  #${e.seq} 【标记】${e.label}`); continue; }
      if (e.kind === 'nav') { timeline.push(`  #${e.seq} 跳转 ${e.url.slice(0, 120)}`); continue; }
      let key;
      try {
        const u = new URL(e.url);
        key = `${e.method} ${u.host}${u.pathname.replace(/\/(\d+|[0-9a-f-]{16,})(?=\/|$)/gi, '/:id')}`;
      } catch { key = `${e.method} ${e.url.slice(0, 120)}`; }
      const g = groups.get(key) || { n: 0, status: new Set(), first: e.seq, type: e.type };
      g.n++;
      g.status.add(e.failed ? `失败:${e.failed}` : e.status ?? '?');
      groups.set(key, g);
    }
    const lines = [...groups].map(([k, g]) => `  ${k}  ×${g.n}  [${[...g.status].join(',')}]  ${g.type}  首次 #${g.first}`);
    const tokens = this.tokenSources(a).map((t) => `  长度${t.length}：来源 ${t.origin.join(' / ')}；用在 ${t.usedIn.slice(0, 3).join('、')}`);
    return [
      `录制文件：${file}`,
      `共 ${a.entries.filter((e) => e.kind === 'request').length} 个请求，${groups.size} 个不同接口：`,
      ...lines.slice(0, 80),
      ...(lines.length > 80 ? [`  …还有 ${lines.length - 80} 个，见文件`] : []),
      ...(timeline.length ? ['页面跳转与标记：', ...timeline.slice(0, 40)] : []),
      ...(tokens.length ? ['疑似 token 的值（已打码）：', ...tokens.slice(0, 15)] : []),
      '完整请求/响应（已打码）用 Read 读上面的文件。',
    ].join('\n');
  }
}

module.exports = { Recorder };
