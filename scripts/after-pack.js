// electron-builder 的 afterPack 钩子：打包好 .app、做 dmg 之前执行。
// package.json 的 mac.identity 配了 Developer ID 证书时，签名和公证交给 electron-builder（它会连内嵌的 claude 一起签），这里什么都不做。
// mac.identity 为 null 时（没有证书），给整个 .app 做本机临时签名（ad-hoc）：
// Apple 芯片上没有有效签名的程序会被系统直接杀掉，electron-builder 本身不支持 ad-hoc（identity "-" 会被跳过并留下失效签名）。
// 内嵌的助手运行程序（claude-agent-sdk 平台包）先单独签，再签整个 .app。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Electron Fuses（打包时写进 Electron 程序本身的开关，装好以后改不了）：不让人改软件本身。
// - 不能当普通 Node 程序跑、不认 NODE_OPTIONS 环境变量、不认 --inspect 调试参数：堵住「借 BrowserX 的身份跑任意代码」
// - 只从 app.asar 加载软件代码；macOS 上再校验 app.asar 的哈希（electron-builder 把它写进 Info.plist 的 ElectronAsarIntegrity），
//   代码被改过就拒绝启动。Windows 版这项要 electron-builder 26 才会写校验值，现在开了会打不开，所以只在 macOS 开
// 插件不受影响：插件在用户数据目录（tools/），不在 app.asar 里。Cookie 加密开关不动（一改已有的登录 cookie 就全失效）
// 必须在签名之前改（改了开关签名就失效），所以放在这个钩子最前面；Developer ID 签名由 electron-builder 在这之后做
async function flipFuses(ctx) {
  const { flipFuses: flip, FuseVersion, FuseV1Options } = require('@electron/fuses');
  const mac = ctx.electronPlatformName === 'darwin';
  const exe = mac
    ? path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`)
    : path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.exe`);
  await flip(exe, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: mac && ctx.arch === require('builder-util').Arch.arm64, // arm64：改完先补一个临时签名，后面再正式签
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: mac,
  });
  console.log(`  • Electron Fuses 已设置（${mac ? 'macOS，含 app.asar 完整性校验' : 'Windows'}）`);
}

exports.default = async function afterPack(ctx) {
  await flipFuses(ctx);
  if (ctx.electronPlatformName !== 'darwin') return;
  if (ctx.packager.platformSpecificBuildOptions.identity) return;
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
