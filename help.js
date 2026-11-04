// 说明页：版本号由 main.js 打开窗口时通过 ?v= 传进来（页面的 CSP 不允许内嵌脚本，所以单独一个文件）
const v = new URLSearchParams(location.search).get('v');
if (v) {
  // 译文页（locales/help/<语言>.html）的 <html lang> 是对应语言
  const word = { en: 'Version', 'zh-TW': '版本', ja: 'バージョン', ko: '버전', fr: 'Version', de: 'Version', es: 'Versión' }[document.documentElement.lang] || '版本';
  document.getElementById('ver').textContent = `${word} ${v}`;
  document.getElementById('ver2').textContent = `v${v}`;
}
