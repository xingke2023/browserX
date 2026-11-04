#!/usr/bin/env python3
# 开发用：把 locales/_keys.json（scripts/i18n-extract.js 收集的中文原文）翻成各语言 → locales/<语言>.json
# 用法：GW_KEY=… python3 -I scripts/i18n-translate.py [语言…]   （不给就全部；已经译好的条目不重译，只补新的）
# 检查：{0} {1} 这类占位符一个不少一个不多；Markdown 符号（** ` ```）和换行原样保留。没过检查的自动重试
import json, os, re, sys, urllib.request, concurrent.futures as cf
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
KEY = os.environ['GW_KEY']
URL = os.environ.get('GW_URL', 'https://tokens.xingke888.com/v1/messages')
LANGS = {'en': 'English', 'zh-TW': '繁體中文（香港 / 台灣用語，不是簡體逐字轉繁體）', 'ja': '日本語', 'ko': '한국어', 'fr': 'Français', 'de': 'Deutsch', 'es': 'Español'}
CONTEXT = ('BrowserX 是一个 Mac 桌面软件：左边是 AI 助手（Claude）的对话，右边是内置浏览器，助手可以替用户操作网页。'
           '界面里有：对话标签、网页标签、工具箱（用户自己做的自动化工具，可以直接运行、定时运行、发布到插件市场）、'
           '「制作工具」模式（助手写工具草稿、录制网页的网络请求、试运行、保存）、账号（会员、Claude 额度、充值、邀约积分）、收藏夹、设置、自动更新。')
keys = json.load(open(os.path.join(ROOT, 'locales', '_keys.json'), encoding='utf-8'))
ph = lambda s: sorted(re.findall(r'\{\d+\}', s))
marks = lambda s: (s.count('```'), s.count('**'), s.count('\n'))

def call(lang, batch):
    items = [{'id': i, 'zh': k} for i, k in batch]
    prompt = (f'{CONTEXT}\n\n把下面这些界面文字从中文翻译成 {LANGS[lang]}。要求：像正规软件的界面文字，简短自然；'
              f'按钮、菜单用该语言软件里的习惯说法；BrowserX、Claude、Stripe、skills 等专有名词不译；'
              f'{{0}} {{1}} 这样的占位符原样保留（数量、编号都不能变，位置按语序调整）；Markdown 符号（** ` ```）和换行原样保留；'
              f'「」这类引号换成该语言的习惯引号。只输出一个 JSON 对象：键是 id（字符串），值是译文，不要别的文字。\n\n'
              + json.dumps(items, ensure_ascii=False))
    body = json.dumps({'model': 'claude-opus-5-5', 'max_tokens': 32000, 'messages': [{'role': 'user', 'content': prompt}]}).encode()
    req = urllib.request.Request(URL, data=body, headers={'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'User-Agent': 'curl/8.7.1'})  # Cloudflare 1010 会拦 Python 默认的 User-Agent
    with urllib.request.urlopen(req, timeout=600) as r:
        text = ''.join(c.get('text', '') for c in json.load(r)['content'])
    return json.loads(text[text.index('{'): text.rindex('}') + 1])

def good(k, v):
    return isinstance(v, str) and v.strip() and ph(v) == ph(k) and marks(v)[:2] == marks(k)[:2]

def do_lang(lang):
    out_file = os.path.join(ROOT, 'locales', f'{lang}.json')
    done = {}
    try: done = {k: v for k, v in json.load(open(out_file, encoding='utf-8')).items() if k in keys and good(k, v)}
    except Exception: pass
    todo = [(i, k) for i, k in enumerate(keys) if k not in done]
    for attempt in range(4):
        if not todo: break
        nxt = []
        for b in [todo[i:i + 100] for i in range(0, len(todo), 100)]:
            try: res = call(lang, b)
            except Exception as e: print(f'{lang} 一批失败（{e}），稍后重试', flush=True); nxt += b; continue
            for i, k in b:
                v = res.get(str(i))
                if good(k, v): done[k] = v
                else: nxt.append((i, k))
        todo = nxt
        print(f'{lang} 第 {attempt + 1} 轮后：{len(done)}/{len(keys)}', flush=True)
    json.dump({k: done[k] for k in keys if k in done}, open(out_file, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    return lang, len(done), [k for _, k in todo]

langs = sys.argv[1:] or list(LANGS)
with cf.ThreadPoolExecutor(len(langs)) as ex:
    for lang, n, miss in ex.map(do_lang, langs):
        print(f'== {lang}：{n}/{len(keys)}' + (f'，没译好 {len(miss)} 条：{miss[:3]}' if miss else ' ✓'), flush=True)
