// 操作内嵌浏览器里的公众号后台编辑器（host = { webContents, show() }）。
// 精简自 ../app/lib/wechat.js：两个 Electron 项目独立打包，这里保留一份自己的副本而不跨目录 require。
const fs = require('fs');
const { clipboard } = require('electron');
let clipLock = Promise.resolve(); // 所有标签共用（见 pasteHtml）

const HOME = 'https://mp.weixin.qq.com/';
const EDITOR_URL = (token) =>
  `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77&token=${token}&lang=zh_CN`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE_HELPERS = `
  window.__wxap = window.__wxap || {
    visible(e){const r=e.getBoundingClientRect();const s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'},
    find(sel,text){return [...document.querySelectorAll(sel)].find(e=>this.visible(e)&&(!text||e.innerText.includes(text)))},
    body(){const e=document.querySelectorAll('.ProseMirror');return e[e.length-1]},
  };`;

class WeChat {
  constructor(host, log) {
    this.host = host;
    this.log = log || (() => {});
  }

  // 一个对话可以有多个网页标签：每次都操作当前标签（host.webContents 是 getter）
  get wc() { return this.host.webContents; }

  js(code) {
    return this.wc.executeJavaScript(`(()=>{${PAGE_HELPERS}\n${code}})()`, true);
  }

  token() {
    const m = this.wc.getURL().match(/[?&]token=(\d+)/);
    return m && m[1];
  }

  async waitFor(fn, timeoutMs = 30000, step = 400) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = await fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  // 确保已登录；未登录则打开扫码页并等待（最多 5 分钟）
  // quiet：调用方自己已经提示过用户扫码（比如工具箱的公众号发布用红字提示），这里不再发重复的提示
  async ensureLogin({ quiet = false } = {}) {
    if (this.token()) return this.token();
    if (!this.wc.getURL().startsWith(HOME)) {
      await this.wc.loadURL(HOME);
      await sleep(1500);
    }
    if (!this.token()) {
      if (!quiet) this.log('请在右侧浏览器中用微信扫码登录公众号后台…');
      await this.host.show();
    }
    const t = await this.waitFor(() => this.token(), 300000, 1000);
    if (!t) throw new Error('等待登录超时');
    return t;
  }

  // ---- 真实输入事件（悬停菜单等需要真实鼠标）
  async rect(sel, text) {
    return this.js(`const e=__wxap.find(${JSON.stringify(sel)},${JSON.stringify(text || '')});
      if(!e) return null; e.scrollIntoView({block:'center'});
      const r=e.getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2};`).then((r) => {
      const z = this.wc.getZoomFactor();
      return r && { x: Math.round(r.x * z), y: Math.round(r.y * z) };
    });
  }

  async hover(sel, text) {
    const r = await this.rect(sel, text);
    if (!r) throw new Error(`找不到元素 ${sel} ${text || ''}`);
    this.wc.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
    return r;
  }

  async click(sel, text) {
    const r = await this.hover(sel, text);
    await sleep(80);
    this.wc.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    this.wc.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await sleep(200);
  }

  async clickWhenVisible(sel, text, timeoutMs = 10000) {
    const ok = await this.waitFor(() => this.js(`return !!__wxap.find(${JSON.stringify(sel)},${JSON.stringify(text || '')})`), timeoutMs, 300);
    if (!ok) throw new Error(`等待元素超时 ${sel} ${text || ''}`);
    await this.click(sel, text);
  }

  // ---- 编辑器操作
  async openEditor() {
    const token = await this.ensureLogin();
    await this.wc.loadURL(EDITOR_URL(token));
    const ok = await this.waitFor(() => this.js(`return document.querySelectorAll('.ProseMirror').length>=2`), 30000);
    if (!ok) throw new Error(`编辑器未加载（${this.wc.getURL()}），可能登录已过期，请重新登录`);
    await sleep(1500);
  }

  async typeInto(sel, text, first = false) {
    await this.click(sel);
    await this.js(`const e=${first ? `document.querySelector(${JSON.stringify(sel)})` : `__wxap.find(${JSON.stringify(sel)})`};
      e.focus(); if('select' in e) e.select(); else document.execCommand('selectAll');`);
    this.wc.insertText(text);
    await sleep(300);
  }

  async setTitle(title) {
    await this.typeInto('.ProseMirror', title.slice(0, 64), true);
  }

  async toBodyEnd() {
    await this.js(`const b=__wxap.body(); b.focus();
      const r=document.createRange(); r.selectNodeContents(b); r.collapse(false);
      const s=getSelection(); s.removeAllRanges(); s.addRange(r);`);
    await sleep(100);
  }

  async dismissStructureCheck(waitMs = 0) {
    const end = Date.now() + waitMs;
    do {
      const hit = await this.js(`const d=__wxap.find('.weui-desktop-dialog','内容结构检测'); if(!d) return false;
        const b=[...d.querySelectorAll('button,a')].find(x=>x.innerText.includes('继续插入')); b&&b.click(); return true;`);
      if (hit) { await sleep(800); return; }
      if (waitMs) await sleep(300);
    } while (Date.now() < end);
  }

  async pasteHtml(html) {
    await this.toBodyEnd();
    // 注意：会覆盖系统剪贴板。剪贴板全局只有一个，几个标签同时贴会互相覆盖，所以「写剪贴板 + 粘贴」排队做
    const run = clipLock.then(async () => {
      clipboard.write({ html, text: html.replace(/<[^>]+>/g, '') });
      this.wc.paste();
      await sleep(600);
    });
    clipLock = run.catch(() => {});
    await run;
    await this.dismissStructureCheck(1500);
  }

  bodyImgCount() {
    return this.js(`return [...__wxap.body().querySelectorAll('img')].filter(i=>/qpic|mmbiz/.test(i.src)).length`);
  }

  async pasteImage(file) {
    const before = await this.bodyImgCount();
    await this.toBodyEnd();
    const b64 = fs.readFileSync(file).toString('base64');
    await this.js(`const bin=Uint8Array.from(atob(${JSON.stringify(b64)}),c=>c.charCodeAt(0));
      const dt=new DataTransfer(); dt.items.add(new File([bin],'img.jpg',{type:'image/jpeg'}));
      __wxap.body().dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));`);
    return !!(await this.waitFor(async () => (await this.bodyImgCount()) > before, 30000, 500));
  }

  async setCoverFromFirstBodyImage() {
    try {
      await this.host.show(); // 视图不可见时模拟悬停无效
      await this.hover('.js_share_type_none_image');
      await sleep(600);
      const shown = await this.waitFor(() => this.js(`return !!__wxap.find('.js_selectCoverFromContent')`), 2000, 300);
      if (shown) {
        await this.click('.js_selectCoverFromContent');
      } else {
        const ok = await this.js(`const a=document.querySelector('#js_cover_description_area');
          const e=a&&[...a.querySelectorAll('.js_selectCoverFromContent')].pop(); if(!e) return false; e.click(); return true;`);
        if (!ok) throw new Error('找不到「从正文选择」');
      }
      await this.clickWhenVisible('.appmsg_content_img_list li');
      await this.clickWhenVisible('.weui-desktop-dialog .weui-desktop-btn', '下一步');
      await this.clickWhenVisible('.weui-desktop-dialog .weui-desktop-btn_primary', '确认');
      return !!(await this.waitFor(() => this.js(
        `return /background-image/.test(document.querySelector('#js_cover_description_area').innerHTML)`), 8000));
    } catch (e) {
      this.log(`自动设置封面失败：${e.message}`);
      return false;
    }
  }

  // 填写整篇文章（不保存）。blocks: [{kind:'html',html}] 或 [{kind:'img',file}]，第一块若是图片则用作封面来源。
  // 返回问题列表
  async fill(art, blocks, author) {
    const problems = [];
    await this.openEditor();
    this.log('填写标题/作者…');
    await this.setTitle(art.title);
    if (author) await this.typeInto('#author', author.slice(0, 8));

    this.log('写入正文与插图…');
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      this.log(`  [${i + 1}/${blocks.length}] ${b.kind === 'html' ? '正文' : '图片'}`);
      if (b.kind === 'html') await this.pasteHtml(b.html);
      else if (!(await this.pasteImage(b.file))) problems.push(`图片 ${b.file.split(/[\\/]/).pop()} 上传失败`);
    }

    if (art.digest) await this.typeInto('#js_description', art.digest.slice(0, 120));

    const hasCoverSource = blocks.some((b) => b.kind === 'img');
    if (hasCoverSource) {
      this.log('设置封面（取正文第一张图）…');
      if (!(await this.setCoverFromFirstBodyImage())) problems.push('封面未自动设置，请手动设置');
    } else {
      problems.push('没有提供任何图片，封面需要手动设置');
    }
    return problems;
  }

  async saveDraft() {
    await this.dismissStructureCheck();
    await this.click('#js_submit');
    const res = await this.waitFor(() => this.js(`
      const t=[...document.querySelectorAll('.page_tips')].find(e=>__wxap.visible(e)&&e.innerText.trim());
      if(t) return {ok:t.className.includes('success'), msg:t.innerText.trim()};
      const d=[...document.querySelectorAll('.weui-desktop-dialog')].find(e=>__wxap.visible(e));
      if(d) return {ok:false, msg:'弹窗：'+d.innerText.slice(0,200)};
      return null;`), 30000, 500);
    if (!res) return { ok: false, msg: '未确认保存结果，请在浏览器里检查' };
    const m = this.wc.getURL().match(/appmsgid=(\d+)/);
    return { ...res, appmsgid: m && m[1] };
  }

  async publish() {
    await this.host.show();
    await this.click('#js_send');
  }
}

module.exports = { WeChat, HOME };
