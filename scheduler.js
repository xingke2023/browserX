// 工具箱工具的定时运行：<userData>/schedules.json 里一条一个任务，主进程每 30 秒看一次有没有到点的。
// 只在 BrowserX 开着时跑；每天 / 工作日的任务，打开软件时已经过了今天的时间、今天又还没跑过，会补跑一次（不补更早的天）。
// 怎么跑由 main.js 给的 run(task) 决定（在后台的「定时任务」对话里直接调工具，不经过模型）
const fs = require('fs');
const crypto = require('crypto');

const TICK = 30 * 1000;
const MODES = ['daily', 'weekdays', 'interval'];

const todayAt = (hhmm, now = new Date()) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

class Scheduler {
  // opts: { file() -> 路径, run(task) -> Promise<string>, onChange(list) }
  constructor(opts) {
    this.opts = opts;
    this.tasks = [];
    this.busy = new Set(); // 正在跑的任务 id：同一个任务上一次还没跑完就不再开
  }

  load() {
    try { this.tasks = JSON.parse(fs.readFileSync(this.opts.file(), 'utf8')); } catch { this.tasks = []; }
    if (!Array.isArray(this.tasks)) this.tasks = [];
  }

  save() {
    fs.writeFileSync(this.opts.file(), JSON.stringify(this.tasks, null, 2));
    this.opts.onChange?.(this.list());
  }

  list() {
    return this.tasks.map((t) => ({ ...t, running: this.busy.has(t.id), next: this.nextRun(t) }));
  }

  start() {
    this.load();
    setTimeout(() => this.tick(), 15 * 1000); // 别跟启动抢（补跑也从这里开始）
    setInterval(() => this.tick(), TICK);
  }

  static check(t) {
    if (!t.tool) throw new Error('没选工具');
    if (!MODES.includes(t.mode)) throw new Error('定时方式不对');
    if (t.mode === 'interval') {
      const n = Number(t.every);
      if (!Number.isInteger(n) || n < 5 || n > 24 * 60) throw new Error('间隔要在 5 到 1440 分钟之间');
    } else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(t.time || ''))) throw new Error('时间要写成 09:30 这样');
  }

  add(t) {
    const task = { id: crypto.randomUUID(), tool: t.tool, title: t.title || t.tool, args: t.args || {}, mode: t.mode, time: t.time, every: t.every ? Number(t.every) : undefined, enabled: true, createdAt: Date.now(), lastRun: null, lastOk: null, lastText: '' };
    Scheduler.check(task);
    this.tasks.push(task);
    this.save();
    return task;
  }

  update(id, patch) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) throw new Error('定时任务不存在');
    const next = { ...t, ...patch, id: t.id };
    Scheduler.check(next);
    Object.assign(t, next);
    this.save();
    return t;
  }

  remove(id) {
    this.tasks = this.tasks.filter((x) => x.id !== id);
    this.save();
  }

  // 下一次什么时候跑（给界面显示）
  nextRun(t, now = Date.now()) {
    if (!t.enabled) return null;
    if (t.mode === 'interval') return (t.lastRun || t.createdAt) + t.every * 60000;
    if (this.due(t, now)) return now;
    for (let k = 0; k < 8; k++) {
      const day = new Date(now);
      day.setDate(day.getDate() + k);
      const at = todayAt(t.time, day);
      if (t.mode === 'weekdays' && [0, 6].includes(new Date(at).getDay())) continue;
      if (at > now) return at;
    }
    return null;
  }

  due(t, now = Date.now()) {
    if (!t.enabled || this.busy.has(t.id)) return false;
    if (t.mode === 'interval') return now - (t.lastRun || t.createdAt) >= t.every * 60000;
    const at = todayAt(t.time, new Date(now));
    if (t.mode === 'weekdays' && [0, 6].includes(new Date(now).getDay())) return false;
    // 今天的点已经过了、今天还没跑过、而且这个点在任务建好之后（刚建的任务不会因为今天的点已过就马上跑）
    return now >= at && (t.lastRun || 0) < at && at > t.createdAt;
  }

  tick() {
    for (const t of this.tasks) if (this.due(t)) this.runTask(t);
  }

  async runTask(t) {
    if (this.busy.has(t.id)) throw new Error('这个定时任务正在运行');
    this.busy.add(t.id);
    this.opts.onChange?.(this.list());
    try {
      const text = await this.opts.run(t);
      Object.assign(t, { lastRun: Date.now(), lastOk: true, lastText: String(text ?? '').slice(0, 500) });
    } catch (e) {
      // 「对话忙 / 标签满」之类没真正跑起来的情况由 run() 抛 retry，不记成跑过，下一轮再试
      if (e.retry) { this.busy.delete(t.id); this.opts.onChange?.(this.list()); return; }
      Object.assign(t, { lastRun: Date.now(), lastOk: false, lastText: String(e.message).slice(0, 500) });
    } finally {
      this.busy.delete(t.id);
    }
    this.save();
  }
}

module.exports = { Scheduler };
