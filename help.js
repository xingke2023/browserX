// 说明页：版本号由 main.js 打开窗口时通过 ?v= 传进来（页面的 CSP 不允许内嵌脚本，所以单独一个文件）
const v = new URLSearchParams(location.search).get('v');
if (v) {
  document.getElementById('ver').textContent = `版本 ${v}`;
  document.getElementById('ver2').textContent = `v${v}`;
}
