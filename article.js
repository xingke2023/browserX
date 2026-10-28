// Markdown 风格文本 -> 公众号排版 HTML。精简自 ../app/lib/content.js + themes.js（同样出于两个项目独立打包的原因单独保留一份）。
//
// 文本格式（段落之间空一行）：
//   # 导语 / # 要点回顾 / # 结语      分区标题
//   ## 小节标题                        新小节
//   - 要点                             列表（要点回顾里每行一条）
//   ```示例 … ```                      可复制示例
//   > 💡 小贴士内容
//   ![插图] 画面描述                    该小节配一张图，实际图片由 images 参数按顺序提供

const THEMES = [
  { id: 'classic', name: '经典蓝紫', main: '#5360b8', soft: '#f2f3fc', text: '#414454', border: '#dfe2f3', heading: 'badge', radius: 8, spacing: 1.9, font: '-apple-system,PingFang SC,sans-serif' },
  { id: 'forest', name: '清新绿', main: '#28765b', soft: '#eff6f1', text: '#3f5147', border: '#d7e6dc', heading: 'line', radius: 12, spacing: 2, font: '-apple-system,PingFang SC,sans-serif' },
  { id: 'paper', name: '暖纸书刊', main: '#906b43', soft: '#f8f3e9', text: '#514b43', border: '#e8decd', heading: 'editorial', radius: 0, spacing: 2.1, font: 'Georgia,Songti SC,SimSun,serif' },
  { id: 'mono', name: '极简黑白', main: '#282828', soft: '#f5f5f5', text: '#414141', border: '#dedede', heading: 'line', radius: 0, spacing: 2.1, font: '-apple-system,PingFang SC,sans-serif' },
  { id: 'rose', name: '玫瑰随笔', main: '#a55d73', soft: '#fbf1f4', text: '#5c4950', border: '#efdce3', heading: 'editorial', radius: 14, spacing: 2, font: 'Georgia,Songti SC,SimSun,serif' },
  { id: 'ocean', name: '深海蓝', main: '#286788', soft: '#edf5f9', text: '#394e5c', border: '#d6e5ee', heading: 'badge', radius: 4, spacing: 1.95, font: '-apple-system,PingFang SC,sans-serif' },
];
const getTheme = (id) => THEMES.find((t) => t.id === id) || THEMES[0];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// text -> { title, digest, intro, sections:[{heading,paragraphs,bullets,example,tip,image_prompt}], takeaways, summary }
function textToArticle(text, base) {
  const art = { ...base, intro: [], sections: [], takeaways: [], summary: [] };
  let zone = 'intro'; // intro | section | takeaways | summary
  let sec = null;
  let para = [];
  const flush = () => {
    if (!para.length) return;
    const p = para.join('').trim();
    para = [];
    if (!p) return;
    if (zone === 'section') sec.paragraphs.push(p);
    else if (zone === 'intro') art.intro.push(p);
    else if (zone === 'summary') art.summary.push(p);
    else art.takeaways.push(p);
  };
  const lines = text.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    let m;
    if (!t) { flush(); continue; }
    if ((m = t.match(/^##\s+(?:\d+[.、]\s*)?(.+)$/))) {
      flush();
      sec = { heading: m[1].trim(), paragraphs: [] };
      art.sections.push(sec);
      zone = 'section';
    } else if ((m = t.match(/^#\s+(.+)$/))) {
      flush();
      zone = /要点|回顾/.test(m[1]) ? 'takeaways' : /结语|总结/.test(m[1]) ? 'summary' : 'intro';
    } else if (t.startsWith('```')) {
      flush();
      const code = [];
      // 模型常把内容写在 ``` 同一行、或把结尾 ``` 接在最后一行末尾；不兼容的话后面整篇都会被吞进示例里
      const head = t.slice(3);
      if (head && !/^[\w+-]+$/.test(head)) code.push(head.replace(/```\s*$/, ''));
      if (!(head.length > 3 && head.trimEnd().endsWith('```'))) {
        while (++i < lines.length && !lines[i].trim().startsWith('```')) {
          const l = lines[i].trimEnd();
          if (l.endsWith('```')) { code.push(l.slice(0, -3)); break; }
          code.push(lines[i]);
        }
      }
      if (sec) sec.example = code.join('\n');
    } else if ((m = t.match(/^>\s*(?:💡\s*)?(.+)$/))) {
      flush();
      if (sec) sec.tip = m[1].trim();
    } else if ((m = t.match(/^!\[[^\]]*\]\s*(.*)$/))) {
      flush();
      if (sec && m[1].trim()) sec.image_prompt = m[1].trim();
    } else if ((m = t.match(/^[-*•]\s+(.+)$/))) {
      flush();
      if (zone === 'takeaways') art.takeaways.push(m[1].trim());
      else if (sec) (sec.bullets = sec.bullets || []).push(m[1].trim());
      else para.push(m[1]);
    } else {
      para.push(t);
    }
  }
  flush();
  if (!art.sections.length) throw new Error('正文里至少需要一个「## 小节标题」');
  return art;
}

function sectionHeading(theme, title, index) {
  const number = String(index + 1).padStart(2, '0');
  const base = `margin:34px 0 20px;font-size:19px;line-height:1.7;color:${theme.main};font-family:${theme.font};`;
  if (theme.heading === 'editorial') return `<h2 style="${base}text-align:center;padding:20px 0;border-top:1px solid ${theme.border};border-bottom:1px solid ${theme.border};"><span style="display:block;font-size:12px;line-height:2;letter-spacing:3px;font-weight:normal;">${number} /</span>${title}</h2>`;
  if (theme.heading === 'line') return `<h2 style="${base}padding-left:14px;border-left:3px solid ${theme.main};"><span style="font-size:13px;margin-right:12px;">${number}</span>${title}</h2>`;
  return `<h2 style="${base}"><span style="display:inline-block;margin-right:10px;padding:2px 10px;background:${theme.main};color:#fff;border-radius:${theme.radius}px;font-size:15px;line-height:1.8;">${number}</span>${title}</h2>`;
}

// art + images({cover,sec0,sec1,...} -> 本地文件路径) -> 按顺序排列的块：{kind:'html',html} 或 {kind:'img',file}
function renderBlocks(art, images, themeId) {
  const theme = getTheme(themeId);
  const C_MAIN = theme.main;
  const FONT = `font-size:15px;line-height:${theme.spacing};letter-spacing:0.5px;color:${theme.text};font-family:${theme.font};overflow-wrap:break-word;`;
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, `<strong style="color:${C_MAIN};">$1</strong>`);
  const para = (t) => `<p style="${FONT}margin:0 0 20px;text-align:justify;">${inline(t)}</p>`;
  const B = [];
  const H = (html) => B.push({ kind: 'html', html });
  if (images.cover) B.push({ kind: 'img', file: images.cover });

  if (art.intro?.length) {
    H(`<section style="margin:8px 0 24px;padding:16px 18px;background:${theme.soft};border-left:3px solid ${C_MAIN};border-radius:${theme.radius}px;">` +
      art.intro.map((t) => `<p style="${FONT}margin:0 0 8px 0;">${inline(t)}</p>`).join('') + '</section>');
  }

  art.sections.forEach((s, i) => {
    const parts = [
      sectionHeading(theme, inline(s.heading), i),
      ...(s.paragraphs || []).map(para),
    ];
    if (s.bullets?.length) {
      parts.push('<section style="margin:0 0 16px 0;">' + s.bullets.map((b) =>
        `<p style="${FONT}margin:0 0 8px 0;padding-left:4px;"><span style="color:${C_MAIN};font-weight:bold;">▸ </span>${inline(b)}</p>`).join('') + '</section>');
    }
    if (s.example) {
      const code = s.example.split('\n').map((l) => esc(l) || '&nbsp;').join('<br>');
      parts.push(`<section style="margin:0 0 18px 0;padding:14px 16px;background:${theme.soft};border:1px solid ${theme.border};border-radius:${theme.radius}px;">` +
        `<p style="margin:0 0 8px 0;font-size:12px;line-height:1.6;color:${theme.main};">✦ 示例 · 可直接复制</p>` +
        `<p style="margin:0;font-size:13px;line-height:1.8;color:${theme.text};overflow-wrap:anywhere;font-family:Menlo,Consolas,monospace;">${code}</p></section>`);
    }
    if (s.tip) {
      parts.push(`<section style="margin:0 0 18px 0;padding:12px 16px;background:${theme.soft};border-radius:${theme.radius}px;">` +
        `<p style="${FONT}margin:0;color:${theme.text};">💡 <strong>小贴士：</strong>${inline(s.tip)}</p></section>`);
    }
    H(parts.join(''));
    if (images[`sec${i}`]) B.push({ kind: 'img', file: images[`sec${i}`] });
  });

  if (art.takeaways?.length) {
    H(`<section style="margin:36px 0 20px;padding:18px;border:1px solid ${theme.border};border-radius:${theme.radius}px;background:${theme.soft};">` +
      `<p style="margin:0 0 12px 0;font-size:16px;line-height:1.75;font-weight:bold;color:${C_MAIN};">本文要点回顾</p>` +
      art.takeaways.map((t) => `<p style="${FONT}margin:0 0 6px 0;"><span style="color:${C_MAIN};">·</span> ${inline(t)}</p>`).join('') + '</section>');
  }
  if (art.summary?.length) H(art.summary.map(para).join(''));
  return B;
}

module.exports = { THEMES, getTheme, textToArticle, renderBlocks };
