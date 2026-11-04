#!/usr/bin/env python3
# 开发用：把使用说明页 help.html 整页翻成各语言 → locales/help/<语言>.html（main.js 的 openHelp 按当前语言打开对应那份，没有就用中文原版）。
# 用法：GW_KEY=… python3 -I scripts/i18n-help.py [语言…]   （help.html 改了以后重跑；不给语言就全部重翻）
import json, os, re, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
KEY = os.environ['GW_KEY']
URL = os.environ.get('GW_URL', 'https://tokens.xingke888.com/v1/messages')
NAMES = {'en': 'English', 'zh-TW': 'Traditional Chinese (Taiwan)', 'ja': 'Japanese', 'ko': 'Korean', 'fr': 'French', 'de': 'German', 'es': 'Spanish'}
SRC = open(os.path.join(ROOT, 'help.html'), encoding='utf-8').read()

def translate(lang):
    prompt = (f'Translate this HTML help page of a desktop app called BrowserX from Simplified Chinese into {NAMES[lang]}. '
              'Keep every tag, attribute, id, class, href, script and style exactly as they are; translate only human-readable text '
              f'(including <title> and alt/title attributes) and set <html lang="{lang}">. Keep product names (BrowserX, Claude, Chrome, macOS) and keyboard shortcuts unchanged. '
              'Output only the full translated HTML, nothing else.\n\n' + SRC)
    body = json.dumps({'model': 'claude-opus-5-5', 'max_tokens': 32000, 'messages': [{'role': 'user', 'content': prompt}]}).encode()
    req = urllib.request.Request(URL, data=body, headers={'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'User-Agent': 'curl/8.7.1'})
    out = ''.join(b.get('text', '') for b in json.load(urllib.request.urlopen(req, timeout=600))['content'])
    out = re.sub(r'^```(?:html)?\s*|\s*```\s*$', '', out.strip())
    # 结构检查：标签数、id 要跟原文一致，不然不写
    tags = lambda s: re.findall(r'<(/?[a-zA-Z0-9]+)', s)
    ids = lambda s: re.findall(r'\bid="([^"]+)"', s)
    if tags(out) != tags(SRC) or ids(out) != ids(SRC):
        open(f'/tmp/help-bad-{lang}.html', 'w', encoding='utf-8').write(out)
        raise RuntimeError(f'{lang}: 标签或 id 跟原文对不上，没写入（译文在 /tmp/help-bad-{lang}.html）')
    out = out.replace('src="help.js"', 'src="../../help.js"')  # 译文放在 locales/help/ 下
    os.makedirs(os.path.join(ROOT, 'locales', 'help'), exist_ok=True)
    open(os.path.join(ROOT, 'locales', 'help', f'{lang}.html'), 'w', encoding='utf-8').write(out + '\n')
    return f'{lang} ✓ {len(out)} 字'

def translate_retry(lang, tries=3):  # 网关偶尔把长回复截断，结构检查不过就重来
    for i in range(tries):
        try: return translate(lang)
        except Exception as e:
            if i == tries - 1: raise
            print(f'{lang} 第 {i + 1} 次失败，重试：{e}')

langs = sys.argv[1:] or list(NAMES)
with ThreadPoolExecutor(len(langs)) as ex:
    for f in [ex.submit(translate_retry, l) for l in langs]:
        try: print(f.result())
        except Exception as e: print('✗', e)
