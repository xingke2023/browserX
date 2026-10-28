// 保誠 AES：按保單號碼查保單詳情。**纯只读**：只 GET 搜尋頁（拿 broker_code）和保單詳情页，不碰任何写入端点
// （AES 上 POST /saes/ereply/returnMailReply、/saes/eupload/reply 会真的送东西给保誠，永远不碰）。
//
// 移植自 security-plan-maker/aes/lib/policy.mjs + lib/cdp.mjs（那边有完整的踩坑记录，改解析前先看 aes/CLAUDE.md）。
// 区别只在通道：那边是外部 Chrome + CDP，这里是 BrowserX 右侧浏览器里已登录的页面，用 ctx.js 在页面里 fetch
// （AES 挂了 Imperva、session 是 httpOnly cookie，必须在页面上下文里请求，从 Node 直接打会被拦）。
const ORIGIN = 'https://aes.prudential.com.hk';
const SEARCH_URL = '/saes/ereply/searchresult?onsearch=C'; // 「易跟進」搜尋頁；/saes/ereply/search（不带 result）是 404

// 保單號碼是 12 位、前面补零，用户多半只记得后面几位
const padPolicyNo = (s) => {
  const t = String(s ?? '').trim().replace(/\s/g, '');
  return /^\d+$/.test(t) && t.length < 12 ? t.padStart(12, '0') : t;
};

// ---------------------------------------------------------------- 在页面里跑的部分（toString 后注入，不能引用外部变量）

// 从搜尋頁表单读 broker_code（代理人编号，别写死）；顺便当登录态检查
async function pageBrokerCode(url) {
  try {
    const res = await fetch(url, { credentials: 'include' });
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const f = doc.querySelector('form[action*="searchresult"]');
    if (!f) return { ok: false, status: res.status, title: (doc.querySelector('title') || {}).textContent || '' };
    return { ok: true, brokerCode: f.elements.broker_code ? f.elements.broker_code.value : '' };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

// 保單詳情 HTML -> { sections }。全靠三个 class 认：td.result_header 区段标题、td.result_key 标签/列名、td.result_value 值。
// 三种版面按「这一行的 cell 是什么」区分，别按区段名写死：标签值对 -> {}，数据表 -> [{}]，分组对照（客戶資料）-> {组:{}}
function parsePolicyHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // 单元格里藏着嵌套 popup 表和 display:none 的 div，取值前剥掉（嵌套表自己会被当成独立区段解析，不会丢）
  const JUNK = 'table,[style*="display:none"],[style*="display: none"]';
  const txt = (e) => {
    if (!e) return '';
    if (e.querySelector && e.querySelector(JUNK)) {
      const c = e.cloneNode(true);
      c.querySelectorAll(JUNK).forEach((n) => n.remove());
      return (c.textContent || '').replace(/\s+/g, ' ').trim();
    }
    return (e.textContent || '').replace(/\s+/g, ' ').trim();
  };
  const has = (c, cls) => c.classList.contains(cls);
  const sections = {};
  let pending = null; // 有些区段的标题自成一张表，留给下一张用

  for (const t of doc.querySelectorAll('table')) {
    const rows = [...t.rows];
    if (!rows.length) continue;
    let title = null;
    let start = 0;
    const h = rows[0].cells[0];
    if (h && has(h, 'result_header')) { title = txt(h); start = 1; } else if (pending) { title = pending; pending = null; }
    const body = rows.slice(start);
    if (title && !body.length) { pending = title; continue; }
    if (!title) continue;

    const cls = (r) => [...r.cells].map((c) => (has(c, 'result_key') ? 'k' : has(c, 'result_value') ? 'v' : '-'));

    // 分组对照：组标题行全是跨列的 key，组靠 result_key 上的额外 class（polOwner / lifeAssured）区分
    const groups = {};
    for (const r of body) {
      const cs = [...r.cells];
      if (cs.length && cs.every((c) => has(c, 'result_key') && c.colSpan > 1)) {
        for (const c of cs) {
          const extra = [...c.classList].find((x) => x !== 'result_key');
          if (extra) groups[extra] = txt(c);
        }
      }
    }

    // 表头行 = 整行都是 key、不止一个 cell，且都不跨列（跨列的是上面的组标题）
    const headIdx = body.findIndex((r) => {
      const s = cls(r);
      return s.length > 1 && s.every((x) => x === 'k') && [...r.cells].every((c) => c.colSpan === 1);
    });

    let value;
    if (headIdx >= 0) {
      const cols = [...body[headIdx].cells].map(txt);
      value = [];
      for (const r of body.slice(headIdx + 1)) {
        if (!cls(r).some((x) => x === 'v')) continue;
        const cells = [...r.cells].map(txt);
        if (cells.every((x) => !x) || /找不到紀錄|No record/i.test(cells.join(''))) continue;
        const o = {};
        cols.forEach((c, i) => { if (c) o[c] = cells[i] ?? ''; });
        value.push(o);
      }
    } else {
      value = {};
      for (const r of body) {
        const cells = [...r.cells];
        for (let i = 0; i < cells.length - 1; i++) {
          if (has(cells[i], 'result_key') && has(cells[i + 1], 'result_value')) {
            const k = txt(cells[i]);
            if (k) {
              const extra = [...cells[i].classList].find((x) => x !== 'result_key');
              const g = extra && groups[extra];
              if (g) (value[g] = value[g] || {})[k] = txt(cells[i + 1]);
              else value[k] = txt(cells[i + 1]);
            }
            i++;
          }
        }
      }
      if (!Object.keys(value).length) continue;
    }

    // 同名区段（页面上确实有重复的）合并，别互相覆盖
    if (sections[title] === undefined) sections[title] = value;
    else if (Array.isArray(sections[title]) && Array.isArray(value)) sections[title].push(...value);
    else if (!Array.isArray(sections[title]) && !Array.isArray(value)) Object.assign(sections[title], value);
  }
  return { sections, len: html.length };
}

async function pageFetchPolicy(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) return { httpError: `${res.status} ${res.statusText}` };
  // eslint-disable-next-line no-undef
  return parsePolicyHtml(await res.text());
}

// 把若干函数和一次调用拼成注入页面的代码
const inject = (call, arg) => `(async () => {
  ${parsePolicyHtml.toString()}
  ${pageBrokerCode.toString()}
  ${pageFetchPolicy.toString()}
  return ${call}(${JSON.stringify(arg)});
})()`;

// ---------------------------------------------------------------- 输出排版（工具箱面板 / 对话里都是简易 Markdown）

const isEmpty = (v) => (Array.isArray(v) ? !v.length : !Object.keys(v).length);
const kv = (o) => Object.entries(o).map(([k, v]) => `- ${k}：${v || '—'}`).join('\n');

function sectionText(name, v) {
  if (Array.isArray(v)) {
    return `# ${name}（${v.length} 筆）\n${v.map((r, i) => `${i + 1}. ${Object.entries(r).map(([k, x]) => `${k}：${x || '—'}`).join(' ｜ ')}`).join('\n')}`;
  }
  const nested = Object.values(v).some((x) => x && typeof x === 'object');
  if (!nested) return `# ${name}\n${kv(v)}`;
  return `# ${name}\n${Object.entries(v).map(([g, o]) => (o && typeof o === 'object' ? `**${g}**\n${kv(o)}` : `- ${g}：${o || '—'}`)).join('\n\n')}`;
}

module.exports = (z) => ({
  name: 'aes_policy',
  title: '保诚保单查询',
  description: '保誠 AES：輸入保單號碼查保單詳情（狀況、客戶資料、保費、保障、保單更改等，只讀）。需要右側瀏覽器已登入保誠代理人門戶 / AES。保單號碼不足 12 位會自動補零。',
  params: {
    policyNo: z.string().describe('保單號碼，例如 12345678（不足 12 位自動補零）'),
    section: z.string().optional().describe('只看某個區段，例如「保費資料」「保單更改」（模糊匹配）；不填顯示全部有內容的區段'),
    json: z.boolean().optional().describe('true 時返回原始 JSON（給程式/對話分析用）'),
  },
  async run(args, ctx) {
    const no = padPolicyNo(args.policyNo);
    if (!no) throw new Error('請輸入保單號碼');
    const log = (t) => ctx.log(`[保誠 AES] ${t}`);

    // 请求必须从 AES 自己的页面发出（同源 + 带 cookie）。不在 AES 上就打开易跟進搜尋頁（GET，只读）
    if (!ctx.wc.getURL().startsWith(ORIGIN)) {
      log('右側瀏覽器不在 AES，打開「易跟進」頁…');
      await ctx.navigate(ORIGIN + SEARCH_URL);
      await ctx.waitFor(async () => !ctx.wc.isLoading(), 30000, 300).catch(() => {});
      if (!ctx.wc.getURL().startsWith(ORIGIN)) {
        throw new Error(`沒有進到 AES（現在在 ${ctx.wc.getURL()}），多半是還沒登入：請在右側瀏覽器登入保誠代理人門戶，再打開 ${ORIGIN}${SEARCH_URL} 後重試`);
      }
    }

    const info = await ctx.js(inject('pageBrokerCode', SEARCH_URL));
    if (!info.ok) {
      // 「Failed to fetch」= 服务器把搜尋頁 302 去了跨域的 SSO 登录页，即登录态过期（AES 会比 PruQuote 早过期，单独失效）
      throw new Error(`取不到「易跟進」搜尋頁（${info.err || `HTTP ${info.status}，title「${String(info.title || '').trim()}」`}）。多半是登入過期了，請在右側瀏覽器重新登入保誠門戶後再試`);
    }

    log(`查保單 ${no}（保誠那邊渲染約需 5–10 秒）…`);
    const a = encodeURIComponent(info.brokerCode);
    const url = `/saes/proposalpolicy/policyDetails?policy_no=${encodeURIComponent(no)}&agent_cd=${a}&branch_cd=&user_id=${a}&locale=zh`;
    const out = await ctx.js(inject('pageFetchPolicy', url));
    if (out.httpError) throw new Error(`查保單失敗：${out.httpError}`);

    const d = out.sections['保單詳情'] || {};
    if (!d['保單號碼']) {
      // 查不到时服务端回 ~1.4KB 页面而不是 404。最常见的原因是拿「核保」类待办里的投保申請號碼来查
      throw new Error(`保單 ${no} 查不到詳情（回來 ${out.len} bytes）。若這串是待辦清單裡「核保」那幾列的號碼，那是投保申請號碼——保單還沒成立，要等核保通過、保單發出後才查得到；否則請確認號碼是否正確、這張保單是否在你名下。`);
    }

    const result = {
      policyNo: d['保單號碼'],
      planName: d['計劃名稱'] || '',
      owner: d['保單持有人'] || '',
      broker: d['介紹保險經紀'] || '',
      status: out.sections['保單資料']?.['狀況'] || '',
      sections: out.sections,
    };
    if (args.json) return JSON.stringify(result, null, 1);

    let names = Object.keys(result.sections);
    if (args.section) {
      names = names.filter((n) => n.includes(args.section.trim()));
      if (!names.length) throw new Error(`沒有名稱含「${args.section}」的區段。可選：${Object.keys(result.sections).join('、')}`);
    }
    const filled = names.filter((n) => !isEmpty(result.sections[n]));
    // 空区段列出名字，别静默吞掉：分得清「这张保單没有理賠紀錄」和「工具没抓到」
    const empty = names.filter((n) => isEmpty(result.sections[n]));
    return [
      `**保單 ${result.policyNo}** ｜ ${result.planName || '—'} ｜ 狀況：${result.status || '—'} ｜ 持有人：${result.owner || '—'} ｜ 經紀：${result.broker || '—'}`,
      ...filled.map((n) => sectionText(n, result.sections[n])),
      empty.length ? `沒有內容的區段（${empty.length} 個）：${empty.join('、')}` : '',
    ].filter(Boolean).join('\n\n');
  },
});
