// BrowserX 账号（门户网站 browserx.xingke888.com）：登录、账号 / 授权状态、调用网站接口。
// 登录走「本机回调 + PKCE」：在 127.0.0.1 开一个临时端口，用系统浏览器打开网站的授权页，用户在网站上登录并点「授权」后，
// 网站带一次性 code 跳回 http://127.0.0.1:端口/callback，这里再用 code + verifier 换长期 token。密码只在网站上输入。
// token 由 main.js 用 safeStorage（系统钥匙串）加密存进 config.json，不发给界面。
const http = require('http');
const crypto = require('crypto');
const os = require('os');

const PORTAL = (process.env.CB_PORTAL || 'https://browserx.xingke888.com').replace(/\/+$/, '');
const LOGIN_TIMEOUT = 10 * 60 * 1000;
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// 授权完成后浏览器里显示的页面（用户切回软件就行）
const donePage = (ok, msg) => `<!doctype html><meta charset="utf-8"><title>BrowserX</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#fafafa;font:16px/1.6 -apple-system,'PingFang SC',sans-serif">
<div style="text-align:center;padding:24px"><div style="font-size:40px">${ok ? '✓' : '✕'}</div><h1 style="font-size:22px;font-weight:600;margin:8px 0">${msg}</h1>
<p style="color:#a1a1a1;margin:0">可以关闭这个页面，回到 BrowserX。</p></div></body>`;

class Account {
  // ctx: { getToken(), setToken(token|null), open(url), focus(), emit(state) }
  constructor(ctx) {
    this.ctx = ctx;
    this.user = null;
    this.pending = null; // 正在等浏览器授权：{ server, reject }
  }

  state() {
    return { portal: PORTAL, loggedIn: !!this.ctx.getToken(), user: this.user, pending: !!this.pending };
  }

  changed() { this.ctx.emit(this.state()); }

  async login() {
    if (this.pending) throw new Error('已经在浏览器里打开了授权页，完成授权或点「取消」');
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    let finish;
    const result = new Promise((resolve, reject) => { finish = { resolve, reject }; });
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(donePage(!!ok, ok ? '已连接 BrowserX' : u.searchParams.get('error') === 'denied' ? '已取消授权' : '授权没有完成'));
      if (u.searchParams.get('state') !== state) return; // 不是这次登录发起的回调，忽略
      if (ok) finish.resolve(u.searchParams.get('code'));
      else finish.reject(new Error(u.searchParams.get('error') === 'denied' ? '你在网页上取消了授权' : '授权没有完成'));
    });
    await new Promise((r, j) => server.once('error', j).listen(0, '127.0.0.1', r));
    const timer = setTimeout(() => finish.reject(new Error('等了 10 分钟还没授权，已取消；要登录请再点一次')), LOGIN_TIMEOUT);
    this.pending = { server, reject: (e) => finish.reject(e) };
    this.changed();
    try {
      const device = os.hostname().replace(/\.local$/, '').slice(0, 60);
      const q = new URLSearchParams({ port: server.address().port, state, challenge, device });
      await this.ctx.open(`${PORTAL}/desktop/authorize?${q}`);
      const code = await result;
      const r = await this.request('/api/desktop/token', { method: 'POST', body: { code, verifier }, auth: false });
      this.ctx.setToken(r.token);
      await this.refresh();
      this.ctx.focus();
      return this.state();
    } finally {
      clearTimeout(timer);
      server.close();
      this.pending = null;
      this.changed();
    }
  }

  cancel() {
    this.pending?.reject(new Error('已取消登录'));
  }

  async logout() {
    if (this.ctx.getToken()) await this.api('/logout', { method: 'POST' }).catch(() => {}); // 网站上的 token 也作废；网络不通也照样退出本机
    this.ctx.setToken(null);
    this.user = null;
    this.changed();
  }

  // 账号和授权状态；token 失效（网站上删了 / 过期）时自动退出登录
  async refresh() {
    if (!this.ctx.getToken()) { this.user = null; return this.state(); }
    this.user = await this.api('/me');
    this.changed();
    return this.state();
  }

  async request(path, { method = 'GET', body, auth = true } = {}) {
    const headers = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (auth) {
      const token = this.ctx.getToken();
      if (!token) throw Object.assign(new Error('请先登录 BrowserX 账号'), { needLogin: true });
      headers.Authorization = `Bearer ${token}`;
    }
    let res;
    try {
      res = await fetch(PORTAL + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    } catch (e) {
      throw new Error(`连不上 ${PORTAL}：${e.cause?.code || e.message}`);
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && auth) {
      this.ctx.setToken(null);
      this.user = null;
      this.changed();
      throw Object.assign(new Error('登录已失效，请重新登录'), { needLogin: true });
    }
    if (!res.ok) {
      // 422 校验错误：取第一条；402 / 403 带上网站地址（去购买 / 开通会员）
      const first = data.errors && Object.values(data.errors)[0]?.[0];
      throw Object.assign(new Error(first || data.message || `请求失败（${res.status}）`), { status: res.status, url: data.url });
    }
    return data;
  }

  api(path, opts) { return this.request(`/api/desktop${path}`, opts); }
}

module.exports = { Account, PORTAL };
