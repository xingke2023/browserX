// 保誠 AES「易跟進」待辦清單（eReply / eSuspense / eUpload：客戶名下待回覆、待上傳、保費暫存戶口等未结事项）。
// **纯只读**：只 GET 搜尋頁（拿 broker_code）和 POST 搜索表单，绝不碰写入端点：
//   POST /saes/ereply/returnMailReply   回覆客戶
//   POST /saes/eupload/reply            上傳文件
// 这两个会真的把东西送去保誠。
//
// 移植自 security-plan-maker/aes/lib/ereply.mjs + cli.mjs（改解析前先看那边 aes/CLAUDE.md 的踩坑记录）。
// 通道换成 BrowserX 右侧已登录的页面（ctx.js 在页面里 fetch），同 aes_policy.js。
const fs = require('fs');
const os = require('os');
const path = require('path');

const ORIGIN = 'https://aes.prudential.com.hk';
const SEARCH_URL = '/saes/ereply/searchresult?onsearch=C';

const pad = (n) => String(n).padStart(2, '0');
const ddmmyyyy = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
// 日期是 DD/MM/YYYY，字符串排序会错；没有限期的（显示 -）给 99999999
const dueKey = (s) => {
  const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}${m[2]}${m[1]}` : '99999999';
};
const dueText = (s) => (dueKey(s) === '99999999' ? '無限期' : s);

// 搜索表单的默认值，字段名照抄页面表单，别改
function defaultFilters(brokerCode) {
  const now = new Date();
  const from = new Date(now); from.setFullYear(from.getFullYear() - 2);
  return {
    boolShowInfo: '',
    viewFlag: 'I',            // I = 只看自己（下屬檢視是另一条路，不做）
    broker_code: brokerCode,
    prop_pol_no: '',
    ereplyCategory: 'A',      // A = 全部類別
    ownerSurname: '', ownerFirstName: '',
    surname_encode: '', first_name_encode: '',
    ereplyStatus: 'P',        // P = 待處理
    laSurname: '', laFirstName: '',
    response_dt_from: '', response_dt_to: '',
    issue_date_from: ddmmyyyy(from),
    issue_date_to: ddmmyyyy(now),
    due_dt_from: '', due_dt_to: '',
    pendingStatus: 'ALL',
    e_ref_no: '',
    sorting: 'E',             // E = 按最早回覆限期
    normalSearch: '搜尋',
  };
}

// ---------------------------------------------------------------- 在页面里跑的部分（toString 后注入，不能引用外部变量）

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

// 一次 POST 就把清单和明细全拿回来：#resultTable 里客戶行 tr#basicRecord_N 和明細行 tr#basicRecord_NExpand 交替，
// 明細行里多张 table#expandtable（id 重复，要 querySelectorAll），每张一个类别分区：标题行「尚待批核項目 (5)」→ 列名行 → 数据行
async function pageFetchPending(params) {
  const res = await fetch('/saes/ereply/searchresult?onsearch=C', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) return { httpError: `${res.status} ${res.statusText}` };
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const rt = doc.querySelector('#resultTable');
  if (!rt) return { noTable: true, title: ((doc.querySelector('title') || {}).textContent || '').trim(), len: html.length };

  const txt = (el) => (el ? el.textContent : '').replace(/\s+/g, ' ').trim();
  const NO_RECORD = /找不到紀錄|No record/i;
  const clients = [];
  // 每个客戶占 3 行（客戶行 + 间隔行 + 明細行），rows.length 不是客戶数；数 basicRecord_ 且排除 Expand
  for (const tr of rt.querySelectorAll('tr[id^="basicRecord_"]')) {
    if (/Expand$/.test(tr.id)) continue;
    const cells = [...tr.cells].map(txt);
    const expand = rt.querySelector(`tr[id="${tr.id}Expand"]`);
    const sections = [];
    for (const t of expand ? expand.querySelectorAll('table[id="expandtable"]') : []) {
      // 有些分区表最前面多一行全空的 spacer 行，不扔掉的话标题读成空、列名读成标题，整张表错位
      const rows = [...t.rows];
      while (rows.length && txt(rows[0]) === '') rows.shift();
      if (rows.length < 2) continue;
      const title = txt(rows[0]);
      const columns = [...rows[1].cells].map(txt); // 各类别列名不一样，按每张表自己的列名映射
      const data = [];
      for (const r of rows.slice(2)) {
        const vals = [...r.cells].map(txt);
        if (!vals.length || NO_RECORD.test(vals.join('')) || !vals.some((v) => v)) continue;
        const o = {};
        columns.forEach((c, i) => { if (c) o[c] = vals[i] ?? ''; });
        data.push(o);
      }
      const m = title.match(/\((\d+)\)/);
      sections.push({
        title: title.replace(/\s*\*?註\s*[:：][\s\S]*$/, '').replace(/\s*\*+\s*$/, '').trim(), // 砍掉标题后的「*註: …」
        count: m ? Number(m[1]) : data.length,
        rows: data,
      });
    }
    clients.push({
      policyholder: cells[0] || '',
      phone: cells[1] || '',
      email: (cells[2] || '').split(' ')[0],
      pendingCount: Number(cells[3]) || 0,
      earliestDue: cells[4] || '',
      sections: sections.filter((s) => s.rows.length || s.count),
    });
  }
  return { clients };
}

const inject = (call, arg) => `(async () => {
  ${pageBrokerCode.toString()}
  ${pageFetchPending.toString()}
  return ${call}(${JSON.stringify(arg)});
})()`;

// ---------------------------------------------------------------- 输出

function flatten(clients) {
  const items = [];
  for (const c of clients) for (const s of c.sections) for (const r of s.rows) {
    items.push({ 保單持有人: c.policyholder, 聯絡電話: c.phone, 電郵地址: c.email, 類別分區: s.title, ...r });
  }
  return items;
}

function toCsv(items) {
  if (!items.length) return '';
  const cols = [...new Set(items.flatMap(Object.keys))];
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...items.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

module.exports = (z) => ({
  name: 'aes_ereply',
  title: '保诚易跟进待办',
  description: '保誠 AES「易跟進」待辦清單：客戶名下待回覆、待上傳、保費暫存戶口等未結事項（只讀，不回覆、不上傳）。默認按客戶摘要、按最早回覆限期排；可逐件列出、只看 N 天內到期、匯出 CSV。需要右側瀏覽器已登入保誠代理人門戶 / AES。查一次約 15–25 秒。',
  params: {
    view: z.enum(['摘要', '逐件']).optional().describe('摘要＝按客戶匯總；逐件＝每件待辦一行。默認摘要'),
    days: z.number().optional().describe('只看 N 天內到期的（沒有回覆限期的待辦一律保留，不會被篩掉）'),
    from: z.string().optional().describe('發單日期起，DD/MM/YYYY，默認兩年前'),
    to: z.string().optional().describe('發單日期止，DD/MM/YYYY，默認今天'),
    category: z.string().optional().describe('類別代碼，默認 A（全部）'),
    csv: z.boolean().optional().describe('true 時把逐件清單匯出成 CSV 存到「下載」資料夾（含客戶個資，注意保管）'),
    json: z.boolean().optional().describe('true 時返回原始 JSON（給程式/對話分析用）'),
  },
  async run(args, ctx) {
    const log = (t) => ctx.log(`[保誠 AES] ${t}`);
    const DATE = /^\d{2}\/\d{2}\/\d{4}$/;
    for (const k of ['from', 'to']) if (args[k] && !DATE.test(args[k].trim())) throw new Error(`${k} 要用 DD/MM/YYYY 格式，例如 01/01/2026`);

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
      throw new Error(`取不到「易跟進」搜尋頁（${info.err || `HTTP ${info.status}，title「${String(info.title || '').trim()}」`}）。多半是登入過期了（AES 會比 PruQuote 早過期），請在右側瀏覽器重新登入保誠門戶後再試`);
    }

    const filters = defaultFilters(info.brokerCode);
    if (args.from) filters.issue_date_from = args.from.trim();
    if (args.to) filters.issue_date_to = args.to.trim();
    if (args.category) filters.ereplyCategory = args.category.trim();
    log(`查待辦：代理人 ${info.brokerCode}，發單日期 ${filters.issue_date_from} – ${filters.issue_date_to}，類別 ${filters.ereplyCategory}（約 15–25 秒）…`);
    const out = await ctx.js(inject('pageFetchPending', filters));
    if (out.httpError) throw new Error(`搜尋請求失敗：${out.httpError}`);
    if (out.noTable) throw new Error(`回來的頁面裡沒有待辦表格（title「${out.title}」，${out.len} bytes），多半是登入過期了，請重新登入保誠門戶後再試`);

    let items = flatten(out.clients).sort((a, b) => dueKey(a['回覆限期']).localeCompare(dueKey(b['回覆限期'])));
    const notes = [];
    // days：没有回覆限期的待辦（如「請盡快繳付保費」）一律保留并提示——没限期不等于不急，静默消失最危险
    if (args.days > 0) {
      const limit = new Date(); limit.setDate(limit.getDate() + args.days);
      const key = `${limit.getFullYear()}${pad(limit.getMonth() + 1)}${pad(limit.getDate())}`;
      const before = items.length;
      let undated = 0;
      items = items.filter((i) => {
        const k = dueKey(i['回覆限期']);
        if (k === '99999999') { undated++; return true; }
        return k <= key;
      });
      notes.push(`只看 ${args.days} 天內到期：略過 ${before - items.length} 件${undated ? `；另有 ${undated} 件沒有回覆限期，一併保留` : ''}`);
    }

    // 对账：待辦事項總數合計必须等于解析出的明細数，不相等就是分区表解析错位了
    const total = out.clients.reduce((n, c) => n + c.pendingCount, 0);
    const parsed = flatten(out.clients).length;
    const check = `客戶 ${out.clients.length} 位 ｜ 待辦事項合計 ${total} 件 ｜ 解析出明細 ${parsed} 件${total === parsed ? '' : ' ⚠️ 兩者不一致，解析可能錯位，請以 AES 頁面為準'}`;

    if (args.csv) {
      const dir = path.join(os.homedir(), 'Downloads');
      const file = path.join(dir, `易跟進_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.csv`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, '﻿' + toCsv(items)); // BOM，Excel 开中文才不乱码
      notes.push(`CSV 已存到 ${file}`);
    }
    if (args.json) return JSON.stringify({ brokerCode: info.brokerCode, filters, clients: out.clients, items }, null, 1);

    const lines = [`**易跟進待辦** ｜ 代理人 ${info.brokerCode} ｜ 發單日期 ${filters.issue_date_from} – ${filters.issue_date_to}`, check, ...notes.map((n) => `（${n}）`)];
    if (!items.length) return [...lines, '沒有待辦事項。'].join('\n\n');

    if (args.view === '逐件') {
      lines.push(items.map((i) => `- **${dueText(i['回覆限期'])}** ${i['保單持有人']} ｜ ${i['投保申請 / 保單號碼'] || i['保單號碼'] || '—'} ｜ ${i['類別'] || i['類別分區']} ｜ ${i['待辦事項詳情'] || i['文件詳情'] || ''} ｜ ${i['狀態'] || ''}`).join('\n'));
    } else {
      // 摘要：按客戶，客戶按最早回覆限期排；days 过滤后只保留还有待辦的客戶
      const keep = new Set(items.map((i) => i['保單持有人']));
      const clients = out.clients.filter((c) => c.pendingCount && keep.has(c.policyholder))
        .sort((a, b) => dueKey(a.earliestDue).localeCompare(dueKey(b.earliestDue)));
      lines.push(clients.map((c) => `**${dueText(c.earliestDue)}** ${c.policyholder}（${c.pendingCount} 件）${c.phone ? ` ｜ ${c.phone}` : ''}\n${c.sections.filter((s) => s.rows.length).map((s) => `- ${s.title.replace(/\s*\([\d-]+\)\s*$/, '')}：${s.rows.length} 件`).join('\n')}`).join('\n\n'));
      lines.push('（view 選「逐件」可看每件待辦的詳情）');
    }
    return lines.join('\n\n');
  },
});
