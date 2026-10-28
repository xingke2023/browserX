// npm start / npm run debug 之前执行（见 package.json 的 prestart / predebug）。
// 不打包直接跑时，macOS 菜单栏和 Dock 显示的应用名读的是 node_modules 里那个通用 Electron.app 的 Info.plist（"Electron"），
// main.js 里的 app.setName() 改不了它。这里把显示名改成 BrowserX：只改 CFBundleName / CFBundleDisplayName，
// 不动 CFBundleExecutable（那是可执行文件名，改了就启动不了）。重装依赖后会被还原，下次启动前这里会再改一次。
// 打包（electron-builder）出来的正式应用用 package.json 的 productName，不需要这一步。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NAME = 'BrowserX';
if (process.platform !== 'darwin') process.exit(0);

const app = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app');
const plist = path.join(app, 'Contents', 'Info.plist');
if (!fs.existsSync(plist)) process.exit(0);

const get = (key) => { try { return execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim(); } catch { return ''; } };
let changed = false;
for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
  if (get(key) === NAME) continue;
  execFileSync('plutil', ['-replace', key, '-string', NAME, plist]);
  changed = true;
}
if (changed) {
  // 让 Launch Services 重新读这个 .app 的信息，否则菜单栏可能还显示旧名字
  try { execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', app]); } catch {}
  try { const now = new Date(); fs.utimesSync(app, now, now); } catch {}
  console.log(`[dev-app-name] 开发用 Electron.app 的显示名已改成 ${NAME}`);
}
