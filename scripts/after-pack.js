// electron-builder 的 afterPack 钩子：打包好 .app、做 dmg 之前执行。
// 不用任何证书（不用公司 Developer ID），给整个 .app 做本机临时签名（ad-hoc）：
// Apple 芯片上没有有效签名的程序会被系统直接杀掉，electron-builder 本身不支持 ad-hoc（identity "-" 会被跳过并留下失效签名）。
// 内嵌的助手运行程序（claude-agent-sdk 平台包）先单独签，再签整个 .app。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  const unpacked = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked');
  const bins = [];
  const walk = (d) => { if (!fs.existsSync(d)) return; for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const st = fs.lstatSync(p); if (st.isDirectory()) walk(p); else if (f === 'claude' && st.mode & 0o111) bins.push(p); } };
  walk(unpacked);
  if (!bins.length) throw new Error('打包结果里找不到助手运行程序（claude），检查 asarUnpack 配置');
  for (const b of bins) execFileSync('codesign', ['--force', '--sign', '-', b], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • ad-hoc 签名完成（${bins.length} 个助手运行程序）`);
};
