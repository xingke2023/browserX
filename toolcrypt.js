// 工具市场里别人的工具在本机加密保存：<tools>/<name>.bxt，AES-256-GCM，每个工具一把随机密钥。
// 密钥用 safeStorage（系统钥匙串）加密后存在 <userData>/tool-keys.json，只有这台电脑上的 BrowserX 解得开；
// 运行时才在内存里解密、编译（agent.js loadToolFile），明文不落盘。直接打开文件、导出、让助手 Read 看到的都是密文，拷到别的电脑也用不了。
// 只是提高门槛：代码终究要在本机运行，懂逆向的人仍然能从运行中的进程里拿到。
const crypto = require('crypto');
const fs = require('fs');
const { safeStorage } = require('electron');

const MAGIC = Buffer.from('BXT1'); // 文件头：格式版本
const EXT = '.bxt';

class ToolVault {
  constructor(keysFile) {
    this.keysFile = keysFile; // () => 路径
  }

  readKeys() {
    try { return JSON.parse(fs.readFileSync(this.keysFile(), 'utf8')); } catch { return {}; }
  }

  writeKeys(keys) {
    fs.writeFileSync(this.keysFile(), JSON.stringify(keys, null, 1));
  }

  // name 作为附加认证数据（AAD）：文件改名、换成别的工具的密文都解不开
  encrypt(name, code) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统钥匙串不可用，没法加密保存工具市场的工具');
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(Buffer.from(name));
    const body = Buffer.concat([c.update(code, 'utf8'), c.final()]);
    const keys = this.readKeys();
    keys[name] = safeStorage.encryptString(key.toString('base64')).toString('base64');
    this.writeKeys(keys);
    return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
  }

  decrypt(name, buf) {
    if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('不是 BrowserX 加密工具文件');
    const enc = this.readKeys()[name];
    if (!enc) throw new Error('找不到这个工具的密钥（是从别的电脑拷过来的？），请在工具市场里重新安装');
    const key = Buffer.from(safeStorage.decryptString(Buffer.from(enc, 'base64')), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(4, 16));
    d.setAAD(Buffer.from(name));
    d.setAuthTag(buf.subarray(16, 32));
    try {
      return Buffer.concat([d.update(buf.subarray(32)), d.final()]).toString('utf8');
    } catch {
      throw new Error('工具文件已损坏或被改动，请在工具市场里重新安装');
    }
  }

  remove(name) {
    const keys = this.readKeys();
    if (!(name in keys)) return;
    delete keys[name];
    this.writeKeys(keys);
  }
}

module.exports = { ToolVault, EXT };
