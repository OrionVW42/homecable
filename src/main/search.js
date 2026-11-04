// Torrent search, for sources you choose — the part that lives with the app: which engines there are,
// which are on, their settings, installing and updating them, and the searches
// themselves (run in src/main/searchHost.js, pinned to the torrent network
// interface). Engines are JavaScript files, qBittorrent's search-plugin idea:
// the built-in ones in src/main/searchEngines, yours in <userData>/search-engines
// (docs/search-engines.md says how to write one). HomeCable ships only the Internet
// Archive (free items only) and a connector for your own server: never a torrent site,
// and it doesn't list or link to any. Anything else is what you add. A result is added like any
// other torrent (src/main/torrents.js), so it plays while it downloads.
const fs = require('fs');
const path = require('path');
const { utilityProcess } = require('electron');

const IDLE_MS = 10 * 60e3; // the search process leaves when it has had nothing to do for a while
const CATEGORIES = [['all', 'Everything'], ['movies', 'Movies'], ['tv', 'TV shows'], ['anime', 'Anime'], ['music', 'Music'], ['games', 'Games'], ['software', 'Software'], ['books', 'Books']];
const idOf = (name) => String(name || '').replace(/\.js$/i, '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
// "1.2.3" vs "1.10": is a newer than b?
const newer = (a, b) => { const pa = String(a).split(/[.\-]/).map((x) => +x || 0), pb = String(b).split(/[.\-]/).map((x) => +x || 0); for (let i = 0; i < Math.max(pa.length, pb.length); i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); } return String(a) !== String(b) && !pa.some(Boolean) && !pb.some(Boolean); };

class TorrentSearch {
  constructor({ dir, builtinDir, store, settings = () => ({}), save = () => {}, log = () => {}, iface = () => '', send = () => {} }) {
    this.dir = dir; this.builtinDir = builtinDir; this.store = store; this.settings = settings; this.save = save; this.log = log; this.iface = iface; this.send = send;
    // sources: id → the address an engine was installed from (for updates); last: id → how its last search went
    this.meta = store.read('searchEngines', { sources: {}, last: {} });
    this.meta.sources = this.meta.sources || {}; this.meta.last = this.meta.last || {};
    this.child = null; this._starting = null; this._pending = new Map(); this._seq = 0; this._idle = null;
    this.state = 'idle'; this.address = null;
    this._running = new Map(); // searchId → { query, category, at }
  }

  // The search process, started on first use.
  start() {
    if (this._starting) return this._starting;
    this._starting = (async () => {
      const child = utilityProcess.fork(path.join(__dirname, 'searchHost.js'), [], { serviceName: 'HomeCable torrent search' });
      this.child = child;
      const hello = new Promise((resolve) => { this._hello = resolve; });
      child.on('message', (m) => this._onMessage(m));
      child.on('exit', (code) => {
        if (code) this.log('search: process exited', code);
        for (const p of this._pending.values()) p.reject(new Error('The search process stopped'));
        this._pending.clear();
        for (const id of this._running.keys()) this.send('torrent-search', { event: 'search-done', searchId: id, stopped: true });
        this._running.clear();
        if (this.child === child) { this.child = null; this._starting = null; this.state = 'idle'; }
      });
      await hello;
      const b = await this._rpc('init', { iface: this.iface() || '', dirs: [{ dir: this.builtinDir, builtin: true }, { dir: this.dir, builtin: false }] });
      this.state = b.state; this.address = b.address;
    })();
    this._starting.catch(() => { this._starting = null; });
    return this._starting;
  }
  _touch() {
    clearTimeout(this._idle);
    this._idle = setTimeout(() => { if (!this._running.size) this.close().catch(() => {}); else this._touch(); }, IDLE_MS);
    this._idle.unref?.();
  }
  _onMessage(m) {
    if (!m) return;
    if (m.id) {
      const p = this._pending.get(m.id);
      if (!p) return;
      this._pending.delete(m.id);
      if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error || 'search process error'));
      return;
    }
    switch (m.event) {
      case 'hello': this._hello?.(); break;
      case 'log': this.log('search:', m.text); break;
      case 'search': {
        this.meta.last[m.engine] = { count: m.results.length, error: m.error, ms: m.ms, at: Date.now() };
        this._saveMeta();
        this.send('torrent-search', m);
        break;
      }
      case 'search-done': this._running.delete(m.searchId); this.send('torrent-search', m); break;
      default: break;
    }
  }
  _rpc(type, payload = {}, timeoutMs = 60000) {
    if (!this.child) return Promise.reject(new Error('Search is not running'));
    this._touch();
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._pending.delete(id); reject(new Error(`search process did not answer (${type})`)); }, timeoutMs);
      this._pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.child.postMessage({ id, type, payload });
    });
  }

  categories() { return CATEGORIES; }
  bound() { return { state: this.child ? this.state : 'idle', iface: this.iface() || '', address: this.state === 'ready' ? this.address : null }; }
  async setInterface(iface) { if (!this.child) return; const b = await this._rpc('setInterface', { iface: iface || '' }); this.state = b.state; this.address = b.address; }

  // Every engine, with whether it's on, its settings, and how its last search went.
  async engines() {
    await this.start();
    const list = await this._rpc('engines');
    const on = this.settings().searchEngines || {};
    const values = this.settings().searchEngineOptions || {};
    return list.map((e) => ({
      ...e, enabled: on[e.id] ?? !!e.defaultOn, source: this.meta.sources[e.id] || null, values: values[e.id] || {}, last: this.meta.last[e.id] || null,
      ready: !e.error && e.options.every((o) => !o.required || String((values[e.id] || {})[o.key] || '').trim()),
    }));
  }
  async setEnabled(id, on) {
    const s = this.settings();
    s.searchEngines = { ...(s.searchEngines || {}), [idOf(id)]: !!on };
    this.save();
    return true;
  }
  async setOptions(id, patch) {
    const s = this.settings();
    const cur = (s.searchEngineOptions || {})[idOf(id)] || {};
    const next = { ...cur };
    for (const [k, v] of Object.entries(patch || {})) { if (v == null || v === '') delete next[k]; else next[k] = String(v); }
    s.searchEngineOptions = { ...(s.searchEngineOptions || {}), [idOf(id)]: next };
    this.save();
    return next;
  }

  // Search every engine that's on and fits the category. Results arrive as 'torrent-search'
  // events ({ event: 'search', searchId, engine, results, error, ms } per engine, then
  // { event: 'search-done', searchId }); this answers right away with what's running.
  async search(query, { category = 'all' } = {}) {
    query = String(query || '').trim();
    if (!query) throw new Error('Type something to search for');
    if (!CATEGORIES.some(([k]) => k === category)) category = 'all';
    const all = await this.engines();
    const on = all.filter((e) => e.enabled && !e.error);
    if (!on.length) throw new Error('No search sources are on — turn one on under Search engines');
    if (this.state !== 'ready') throw new Error(`Searching waits for “${this.iface()}” — it has no address right now`);
    const fits = on.filter((e) => category === 'all' || e.categories.includes(category));
    const skipped = on.filter((e) => !fits.includes(e));
    const needSetup = fits.filter((e) => !e.ready);
    const run = fits.filter((e) => e.ready);
    const searchId = `s${Date.now().toString(36)}-${++this._seq}`;
    this._running.set(searchId, { query, category, at: Date.now() });
    const s = this.settings();
    s.searchRecent = [query, ...(s.searchRecent || []).filter((q) => q.toLowerCase() !== query.toLowerCase())].slice(0, 20);
    this.save();
    if (run.length) await this._rpc('search', { searchId, query, category, engines: run.map((e) => ({ id: e.id, file: e.file, options: e.values })) });
    // Engines that can't run say so, after the caller has the search id.
    setTimeout(() => {
      for (const e of needSetup) this.send('torrent-search', { event: 'search', searchId, engine: e.id, results: [], error: 'needs its settings filled in (Search engines)', ms: 0 });
      if (!run.length) { this._running.delete(searchId); this.send('torrent-search', { event: 'search-done', searchId }); }
    }, 30);
    return { searchId, engines: run.map((e) => e.id), skipped: skipped.map((e) => e.name), needSetup: needSetup.map((e) => e.name) };
  }
  async cancel(searchId) {
    if (!this.child || !this._running.has(searchId)) return false;
    this._running.delete(searchId);
    await this._rpc('cancel', { searchId }).catch(() => {});
    this.send('torrent-search', { event: 'search-done', searchId, stopped: true });
    return true;
  }
  // The download link for a result: as given, or fetched from the torrent's page.
  async resolve(engineId, result) {
    const e = (await this.engines()).find((x) => x.id === idOf(engineId));
    if (!e) throw new Error('No such search engine');
    return (await this._rpc('resolve', { file: e.file, options: e.values, result })).link;
  }
  // A .torrent file a search found, fetched through the pinned connection, as a file to add.
  async download(url) {
    await this.start();
    const b64 = await this._rpc('fetchBytes', { url });
    const dir = path.join(this.dir, '..', 'search-cache');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now().toString(36)}.torrent`);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    return file;
  }

  // Install an engine from a .js file on this PC or from a link (then it can update itself).
  async install(src) {
    await this.start();
    src = String(src || '').trim();
    if (/^https?:\/\//i.test(src)) {
      const code = await this._rpc('fetchText', { url: src });
      const name = path.basename(new URL(src).pathname).replace(/\?.*$/, '') || 'engine.js';
      return this._installCode(code, name, src);
    }
    if (!/\.js$/i.test(src) || !fs.existsSync(src)) throw new Error('Pick a .js search engine file');
    return this._installCode(fs.readFileSync(src, 'utf8'), path.basename(src), null);
  }
  async _installCode(code, fileName, source, { onlyIfNewerThan = null } = {}) {
    const id = idOf(fileName);
    if (!id) throw new Error('Give the file a simple name, like mysite.js');
    if (fs.existsSync(path.join(this.builtinDir, id + '.js'))) throw new Error(`“${id}” is a built-in engine — name yours differently`);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = path.join(this.dir, `.${id}.${Date.now().toString(36)}.installing`); // not *.js, so it's not an engine yet
    fs.writeFileSync(tmp, code);
    try {
      const d = await this._rpc('validate', { file: tmp });
      if (onlyIfNewerThan != null && !newer(d.version, onlyIfNewerThan)) return { ...d, id, same: true };
      fs.renameSync(tmp, path.join(this.dir, id + '.js'));
      if (source) this.meta.sources[id] = source; else delete this.meta.sources[id];
      this._saveMeta();
      if (onlyIfNewerThan == null) await this.setEnabled(id, true); // you installed it on purpose: it starts on
      this.log('search engine installed:', d.name, d.version || '', source || fileName);
      return { ...d, id, enabled: true, source };
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  async remove(id) {
    const e = (await this.engines()).find((x) => x.id === idOf(id));
    if (!e) throw new Error('No such search engine');
    if (e.builtin) throw new Error('A built-in engine can be turned off, not removed');
    fs.rmSync(e.file, { force: true });
    delete this.meta.sources[e.id]; delete this.meta.last[e.id];
    this._saveMeta();
    const s = this.settings();
    if (s.searchEngines) delete s.searchEngines[e.id];
    if (s.searchEngineOptions) delete s.searchEngineOptions[e.id];
    this.save();
    return true;
  }
  // Engines installed from a link: fetch each again and keep the newer version.
  async checkUpdates() {
    const out = { updated: [], same: [], failed: [] };
    for (const e of (await this.engines()).filter((x) => !x.builtin && x.source)) {
      try {
        const code = await this._rpc('fetchText', { url: e.source });
        const r = await this._installCode(code, path.basename(e.file), e.source, { onlyIfNewerThan: e.version });
        (r.same ? out.same : out.updated).push({ id: e.id, name: e.name, version: r.version, was: e.version });
      } catch (err) { out.failed.push({ id: e.id, name: e.name, error: err.message }); }
    }
    return out;
  }
  folder() { fs.mkdirSync(this.dir, { recursive: true }); return this.dir; }

  _saveMeta() {
    clearTimeout(this._metaT);
    this._metaT = setTimeout(() => this.store.write('searchEngines', this.meta), 500);
    this._metaT.unref?.();
  }
  async close() {
    const child = this.child;
    if (!child) return;
    await this._rpc('close', {}, 2000).catch(() => {});
    this.killNow();
  }
  killNow() {
    clearTimeout(this._idle);
    clearTimeout(this._metaT);
    try { this.store.write('searchEngines', this.meta); } catch {}
    const child = this.child;
    if (!child) return;
    try { child.kill(); } catch {}
    this.child = null; this._starting = null; this.state = 'idle';
  }
}

module.exports = { TorrentSearch, CATEGORIES };
