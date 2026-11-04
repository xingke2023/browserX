// 界面多语言：中文原文就是键（跟门户网站一样），locales/<语言>.json 里是 { "中文原文": "译文" }。
// 原文里程序拼进去的部分写成 {0} {1}…（见 scripts/i18n-extract.js），翻译时按位置配对，被拼进去的那段如果本身也是原文（比如「每天 09:00」）也会再翻一次。
// 主进程（菜单、系统弹窗）用 t()；界面（renderer.js）用 translateTree() 自动翻屏幕上出现的文字。简体中文是原文，不用翻。
(function (root) {
  const LANGS = { 'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English', ja: '日本語', ko: '한국어', fr: 'Français', de: 'Deutsch', es: 'Español' };
  const HAS_ZH = /[一-鿿]/;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function makeT(dict) {
    dict = dict || {};
    const exact = new Map();
    const patterns = [];
    for (const [k, v] of Object.entries(dict)) {
      if (!v) continue;
      if (/\{\d+\}/.test(k)) {
        // 「已下载：{0}（{1}）」→ /^已下载：(.+?)（(.+?)）$/，记下每个 {n} 在原文里的顺序
        const order = [];
        const re = new RegExp(`^${k.split(/(\{\d+\})/).map((p) => { const m = p.match(/^\{(\d+)\}$/); if (m) { order.push(m[1]); return '([\\s\\S]*?)'; } return esc(p); }).join('')}$`);
        const fixed = k.replace(/\{\d+\}/g, '').length; // 固定文字越长越具体，先试
        patterns.push({ re, order, v, fixed });
      } else exact.set(k, v);
    }
    patterns.sort((a, b) => b.fixed - a.fixed);
    const fill = (tpl, vals) => tpl.replace(/\{(\d+)\}/g, (_, n) => (vals[n] ?? ''));

    function tr(text, depth = 0) {
      if (!text || depth > 3 || !HAS_ZH.test(text)) return text;
      const lead = text.match(/^\s*/)[0], tail = text.match(/\s*$/)[0];
      const core = text.trim();
      if (exact.has(core)) return lead + exact.get(core) + tail;
      for (const p of patterns) {
        const m = core.match(p.re);
        if (!m) continue;
        const vals = {};
        p.order.forEach((n, i) => { vals[n] = tr(m[i + 1], depth + 1); });
        // 拼进去的是另起的一句英文时补个空格（「…tomorrow.Upgrade…」→「…tomorrow. Upgrade…」）
        return lead + fill(p.v, vals).replace(/([a-z0-9)][.!?])(?=[A-Z][a-z])/g, '$1 ') + tail;
      }
      // 前后带符号的整段（「✗ 报错」「— 已退出 —」「● 已开始录制…」「1. 说说要做什么；」）：去掉符号再查，查到了把符号补回去
      const w = core.match(/^([\s✗✓●○–—·•▶⚠✔️]+|\d+[.、)）]\s*)?([\s\S]*?)([\s—…]*)$/u);
      if (w && (w[1] || w[3]) && w[2] && w[2] !== core) {
        const mid = tr(w[2], depth + 1);
        if (mid !== w[2]) return lead + (w[1] || '') + mid + (w[3] || '') + tail;
      }
      // 程序把几句话拼在一起（「…明天恢复。开通会员可以提高额度。也可以点「充值」…」）：按句号拆开逐句翻，有一句翻到就算
      const parts = core.match(/[^。！？]+[。！？]?/g);
      if (parts && parts.length > 1) {
        const out = parts.map((p) => tr(p, depth + 1));
        if (out.some((x, i) => x !== parts[i])) return lead + out.join(/[a-z]/i.test(out.join('')) ? ' ' : '').replace(/ +/g, ' ').trim() + tail;
      }
      return text;
    }
    // 主进程用：t('已下载：{0}', [file])
    const t = (key, vals = []) => {
      const v = dict[key];
      return v ? fill(v, vals.map((x) => tr(String(x), 1))) : fill(key, vals);
    };
    return { t, tr, size: exact.size + patterns.length };
  }

  // ---------------------------------------------------------------- 界面：自动翻译屏幕上的文字
  // 记住每个文字节点 / 属性的中文原文，换语言时从原文重新翻（换回简体中文就是还原）
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  function domTranslator(getTr, skip) {
    const origText = new WeakMap(); // 文字节点 → 原文
    const origAttr = new WeakMap(); // 元素 → { 属性: 原文 }
    const mine = new WeakMap(); // 我们刚写进去的值：MutationObserver 看到它就别再处理
    const skipped = (el) => el && skip && el.closest && el.closest(skip);

    function doText(node) {
      const cur = node.nodeValue;
      if (mine.get(node) === cur) return;
      if (!HAS_ZH.test(cur) && !origText.has(node)) return;
      if (skipped(node.parentElement)) return;
      if (mine.has(node) && mine.get(node) !== cur) origText.delete(node); // 程序改了这段文字：新的原文
      if (!origText.has(node)) origText.set(node, cur);
      const out = getTr()(origText.get(node));
      mine.set(node, out);
      if (out !== cur) node.nodeValue = out;
    }
    function doAttrs(el) {
      if (skipped(el)) return;
      let o = origAttr.get(el); // { 属性: { orig: 原文, out: 我们写进去的 } }
      for (const a of ATTRS) {
        if (!el.hasAttribute(a)) continue;
        const cur = el.getAttribute(a);
        const rec = o && o[a];
        if (rec && rec.out === cur) continue; // 我们刚写的
        if (!HAS_ZH.test(cur) && !rec) continue;
        if (!o) origAttr.set(el, (o = {}));
        const orig = rec && rec.out !== cur ? cur : rec ? rec.orig : cur; // 程序改过这个属性：用新的当原文
        const out = getTr()(orig);
        o[a] = { orig, out };
        if (out !== cur) el.setAttribute(a, out);
      }
    }
    // 换语言：所有记住原文的地方按新语言重翻
    function retranslate(rootNode) {
      const w = document.createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let n = w.currentNode; n; n = w.nextNode()) {
        if (n.nodeType === 3 && origText.has(n)) { const out = getTr()(origText.get(n)); mine.set(n, out); n.nodeValue = out; }
        else if (n.nodeType === 1 && origAttr.has(n)) {
          const o = origAttr.get(n);
          for (const a of Object.keys(o)) { const out = getTr()(o[a].orig); o[a].out = out; n.setAttribute(a, out); }
        }
      }
      walk(rootNode); // 之前没翻过的（比如原来是简体中文时出现的）
    }
    function walk(rootNode) {
      if (rootNode.nodeType === 3) return doText(rootNode);
      if (rootNode.nodeType !== 1 || skipped(rootNode)) return;
      doAttrs(rootNode);
      const w = document.createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.nodeType === 1 && skipped(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      for (let n = w.nextNode(); n; n = w.nextNode()) (n.nodeType === 3 ? doText(n) : doAttrs(n));
    }
    function observe(target) {
      new MutationObserver((ms) => {
        for (const m of ms) {
          if (m.type === 'characterData') doText(m.target);
          else if (m.type === 'attributes') doAttrs(m.target);
          else for (const n of m.addedNodes) walk(n);
        }
      }).observe(target, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    }
    return { walk, observe, retranslate };
  }

  const api = { LANGS, makeT, domTranslator };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BXI18N = api;
})(this);
