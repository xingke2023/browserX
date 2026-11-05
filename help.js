// 说明页：版本号由 main.js 打开窗口时通过 ?v= 传进来（页面的 CSP 不允许内嵌脚本，所以单独一个文件）
const v = new URLSearchParams(location.search).get('v');
if (v) {
  // 译文页（locales/help/<语言>.html）的 <html lang> 是对应语言
  const word = { en: 'Version', 'zh-TW': '版本', ja: 'バージョン', ko: '버전', fr: 'Version', de: 'Version', es: 'Versión' }[document.documentElement.lang] || '版本';
  document.getElementById('ver').textContent = `${word} ${v}`;
  document.getElementById('ver2').textContent = `v${v}`;
}

// Windows：说明页是按 Mac 写的（⌘、访达、~/Library/…），这里换成 Ctrl、文件资源管理器的地址栏和 %APPDATA%（各语言的译文页都用这一份）
if (!/Mac/i.test(navigator.platform)) {
  for (const k of document.querySelectorAll('kbd')) if (k.textContent === '⌘') k.textContent = 'Ctrl';
  const say = {
    en: 'In File Explorer, type this in the address bar: ',
    'zh-TW': '在「檔案總管」的網址列輸入 ',
    // 下面三种语言的原句在路径后面还有「…と入力します / …을 입력하세요 / … ein」，这里只给前半句
    ja: 'エクスプローラーのアドレスバーに ',
    ko: '파일 탐색기의 주소 표시줄에 ',
    fr: 'Dans l’Explorateur de fichiers, saisissez dans la barre d’adresse : ',
    de: 'Geben Sie im Datei-Explorer in die Adressleiste ',
    es: 'En el Explorador de archivos, escribe en la barra de direcciones: ',
  }[document.documentElement.lang] || '在「文件资源管理器」的地址栏输入 ';
  for (const c of document.querySelectorAll('code')) {
    const m = c.textContent.match(/^~\/Library\/Application Support\/BrowserX\/(.+)$/);
    if (!m) continue;
    c.textContent = `%APPDATA%\\BrowserX\\${m[1]}`;
    while (c.previousSibling) c.parentNode.removeChild(c.previousSibling);
    c.parentNode.insertBefore(document.createTextNode(say), c);
  }
}
