// 微信公众号发布工具。只需要告诉它「要写什么」：标题/摘要/正文由模型（ctx.ask，跟对话同一套 Claude 运行时）
// 按公众号排版要求写好，再复用 agent.js 内置 wx_fill/wx_save_draft/wx_publish 背后那套已经跑通的实现
// （wechat.js 的 WeChat 类 + article.js 的 Markdown -> 公众号 HTML 转换）填入编辑器、存草稿或发表。
const SYSTEM = `你是微信公众号作者。根据用户给的主题写一篇完整的公众号文章，只输出一个 JSON 对象，不要任何其他文字、不要代码块包裹：
{"title": "标题，不超过 30 字", "digest": "摘要，不超过 100 字", "text": "正文"}
正文（text）必须严格使用下面的 Markdown 风格，段落之间空一行：
- 开头 1~2 段导语（不加标题）
- 3~5 个小节，每个小节以「## 小节标题」开头（至少一个，必须有），下面是正文段落，可以用「- 要点」列表
- 需要可复制的示例时，单独一行 \`\`\` 开始、示例内容、再单独一行 \`\`\` 结束（开头结尾的 \`\`\` 都必须独占一行）；小贴士用「> 💡 内容」，每个小节最多一个示例、一个小贴士
- 结尾可以用「# 要点回顾」加若干「- 要点」，再用「# 结语」加一段收尾
- 重点词可以用 **加粗**；不要用其他 Markdown 语法，不要写 ![插图]
- 用简体中文，全文 1200~2000 字`;

function parseArticle(out) {
  const s = String(out).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  let a;
  try {
    a = JSON.parse(s.slice(i, j + 1));
  } catch (e) {
    throw new Error(`模型返回的内容不是合法 JSON：${String(out).slice(0, 200)}`);
  }
  if (!a.title || !a.text) throw new Error(`模型返回的内容缺少标题或正文：${String(out).slice(0, 200)}`);
  return { title: String(a.title).slice(0, 64), digest: String(a.digest || '').slice(0, 120), text: String(a.text) };
}

module.exports = (z) => ({
  name: 'wechat_publish',
  description: '让模型按主题自动写一篇公众号文章（标题、摘要、正文都由模型写并排版），填入微信公众号编辑器后存草稿或发表。只需要填 topic（要写什么）。默认只存草稿，传 publish:true 才会真的推送给所有关注者。未登录时会打开扫码页等待登录。',
  params: {
    topic: z.string().describe('要写什么：主题/要求，例如「写一篇介绍秋季养生的文章，面向上班族」'),
    author: z.string().optional().describe('作者名，最多 8 字'),
    theme: z.string().optional().describe('排版主题：classic(经典蓝紫)/forest(清新绿)/paper(暖纸书刊)/mono(极简黑白)/rose(玫瑰随笔)/ocean(深海蓝)，默认 classic'),
    images: z.string().optional().describe('可选，JSON 对象字符串，例如 {"cover":"/tmp/a.jpg"}，cover 用作封面/正文首图。不给也能存草稿，但发表必须有封面'),
    publish: z.boolean().optional().describe('true 才会点「发表」真的推送给所有关注者（不可撤销）；不传或 false 只存草稿'),
  },
  async run(args, ctx) {
    // 填编辑器 / 存草稿 / 发表：各最多等 3 分钟，超时就报出卡在哪一步（页面卡住时不会一直等下去）
    const within = (p, step, c) => {
      let timer;
      const t = new Promise((_, reject) => { timer = setTimeout(() => { try { c.wc.stop(); } catch {} reject(new Error(`「${step}」3 分钟还没完成，可能页面卡住了：看一下右侧浏览器，刷新后重新运行`)); }, 180000); });
      return Promise.race([p, t]).finally(() => clearTimeout(timer));
    };
    const log = (t) => ctx.log(`[公众号] ${t}`);

    // 先确认登录，免得模型写完了才发现要扫码：未登录时 ensureLogin 会打开扫码页、切出右侧浏览器并最多等 5 分钟
    // 没登录：红字提醒用户去扫码（ctx.warn 旧版本没有就退回普通提示）
    if (!ctx.wx.token()) (ctx.warn || ctx.log)('公众号后台还没登录：请在右侧浏览器用微信扫码登录（最多等 5 分钟，扫完会自动继续；不想等可以点「停止」）');
    try {
      await ctx.wx.ensureLogin({ quiet: true }); // 上面已经红字提示过扫码，不要再发一条重复的
    } catch (e) {
      throw new Error(`公众号后台未登录（${e.message}）：请在右侧浏览器扫码登录后重新运行`);
    }

    log(`模型写作中：${args.topic}`);
    const a = parseArticle(await ctx.ask(`主题：${args.topic}`, { system: SYSTEM }));
    log(`已写好《${a.title}》，生成排版…`);

    // 兜底：模型偶尔没写「## 小节标题」时 textToArticle 会报错，自动把正文包成一个以标题命名的小节
    let text = a.text;
    if (!/^\s*##\s+\S/m.test(text)) {
      const paras = text.replace(/\r/g, '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      const intro = paras.length > 1 ? paras.shift() : null;
      text = `${intro ? `${intro}\n\n` : ''}## ${a.title}\n\n${paras.join('\n\n')}`;
    }
    const art = ctx.article.textToArticle(text, { title: a.title, digest: a.digest });
    const images = args.images ? JSON.parse(args.images) : {};
    const blocks = ctx.article.renderBlocks(art, images, args.theme);

    log('填入编辑器…');
    const problems = await within(ctx.wx.fill(art, blocks, args.author), '填入编辑器', ctx);
    // 没配图/封面没设上不影响存草稿（实测无封面也能存成功），只拦发表；图片上传失败则一律拦下
    const fatal = problems.filter((p) => !/封面/.test(p));
    if (fatal.length) throw new Error(`填入编辑器时有问题，没有继续存草稿/发表：${fatal.join('；')}`);
    const warn = problems.length ? `（注意：${problems.join('；')}）` : '';

    if (!args.publish) {
      log('存草稿…');
      const r = await within(ctx.wx.saveDraft(), '存草稿', ctx);
      if (!r.ok) throw new Error(r.msg);
      return `已存草稿《${a.title}》：${r.msg}${r.appmsgid ? `（appmsgid=${r.appmsgid}）` : ''}${warn}`;
    }
    if (problems.length) throw new Error(`《${a.title}》已填入编辑器但没有发表：${problems.join('；')}。公众号发表必须有封面，请在 images 里提供图片或手动设置封面后再发表`);

    // 发表不可撤销、会推送给所有关注者：跟内置 wx_publish 工具一样，走 guard() 走一遍二次确认
    // （只在权限模式是「每次询问」时才会真的弹确认；auto/全部允许模式下这一步是空操作，跟内置工具行为一致）
    await ctx.guard('发表公众号文章', `《${a.title}》`);
    log('发表…');
    await within(ctx.wx.publish(), '发表', ctx);
    return `已点击「发表」（标题：《${a.title}》），请在右侧浏览器里完成微信的最终确认`;
  },
});
