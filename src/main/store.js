// Tiny JSON-file store with atomic writes (write tmp, then rename).
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }
  file(name) { return path.join(this.dir, name + '.json'); }
  read(name, fallback) {
    try { return JSON.parse(fs.readFileSync(this.file(name), 'utf8')); }
    catch {
      try { return JSON.parse(fs.readFileSync(this.file(name) + '.bak', 'utf8')); } catch { return fallback; }
    }
  }
  write(name, data) {
    const f = this.file(name);
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    try { if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak'); } catch {}
    fs.renameSync(tmp, f);
  }
}

module.exports = { Store };
