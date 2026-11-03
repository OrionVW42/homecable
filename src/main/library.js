// Media library: finds files, probes them with ffmpeg, groups them into shows,
// movies, music and short clips, and watches the folders for new content.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { probe, playMode } = require('./ffmpeg');
const { parsePath, mediaType, showKey, naturalCompare } = require('./naming');

const SKIP_DIRS = new Set(['windows', 'program files', 'program files (x86)', 'programdata', '$recycle.bin', 'system volume information',
  'appdata', 'node_modules', '.git', '.svn', 'recovery', 'perflogs', 'msocache', 'intel', 'amd', 'nvidia', 'drivers', 'steamapps',
  'steamlibrary', 'epic games', 'riot games', 'origin games', 'xboxgames', 'windowsapps', '$windows.~bt', '$windows.~ws', 'config.msi',
  'onedrivetemp', 'cache', 'caches', 'temp', 'tmp', '.cache', '.vscode', '.npm', 'site-packages', 'venv', '.venv', 'obs-studio',
  'sample', 'samples', 'android', 'sdk',
  // Big tool/AI/dev folders that never hold someone's TV library — a ComfyUI or
  // Claude install can be hundreds of thousands of files; walking it helps no one.
  'comfyui', 'comfyui_windows_portable', 'stable-diffusion-webui', 'automatic1111', 'invokeai', 'text-generation-webui',
  'ollama', 'huggingface', 'claude', 'claude code', 'anaconda3', 'miniconda3', 'envs', 'scoop', 'chocolatey',
  'jetbrains', 'github', 'repos', 'rustup', 'virtualbox vms', 'vms']);
// A folder that *is* a software project (repo, package, python env) — spotted by
// its own files, whatever it's named. Never someone's video library; skipped whole
// unless the user explicitly picked it as a source.
const CODE_MARKERS = new Set(['package.json', '.git', 'pyproject.toml', 'requirements.txt', 'cargo.toml', 'go.mod',
  'composer.json', 'gemfile', 'pipfile', 'yarn.lock', 'pnpm-lock.yaml', '.venv', 'venv', 'node_modules', '.gitignore']);
const MIN_VIDEO_BYTES = 2 * 1024 * 1024;
const MIN_AUDIO_BYTES = 200 * 1024;

// How long to wait before re-checking a new file's size (still being copied?).
const SETTLE_MS = +process.env.HOMECABLE_SETTLE_MS || 2500;
// A file another program still has open for writing can't be opened for writing by us (Windows).
function stillWriting(p) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => fs.open(p, 'r+', (err, fd) => {
    // Only "in use" counts: read-only files (common from DVDs) also refuse writing, but they're finished.
    if (err) return resolve(err.code === 'EBUSY');
    fs.close(fd, () => resolve(false));
  }));
}
const idFor = (p) => crypto.createHash('sha1').update(p.toLowerCase()).digest('hex').slice(0, 12);

function quickScanRoots() {
  const home = os.homedir();
  const roots = ['Videos', 'Downloads', 'Desktop', 'Music', 'Movies', 'OneDrive\\Videos', 'OneDrive\\Desktop']
    .map((d) => path.join(home, d)).filter((p) => fs.existsSync(p));
  if (process.platform === 'win32') {
    const sys = (process.env.SystemDrive || 'C:').toUpperCase();
    for (const d of listDrives()) if (!d.toUpperCase().startsWith(sys)) roots.push(d);
    // Common media folders at the root of the system drive.
    for (const n of ['Videos', 'Movies', 'TV', 'TV Shows', 'Media', 'Video', 'Plex', 'Jellyfin'])
      if (fs.existsSync(`${sys}\\${n}`)) roots.push(`${sys}\\${n}`);
  } else {
    for (const d of ['/media', '/mnt', '/Volumes']) if (fs.existsSync(d)) roots.push(d);
  }
  return [...new Set(roots)];
}

function listDrives() {
  if (process.platform !== 'win32') return ['/'];
  const out = [];
  for (let c = 67; c <= 90; c++) { // C..Z
    const d = String.fromCharCode(c) + ':\\';
    try { fs.accessSync(d); out.push(d); } catch {}
  }
  return out;
}

function deepScanRoots() {
  return process.platform === 'win32' ? listDrives() : [os.homedir(), '/media', '/mnt'].filter((p) => fs.existsSync(p));
}

class Library extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    const data = store.read('library', { items: {}, folders: [], meta: {} });
    this.items = data.items || {};
    this.folders = data.folders || [];   // user-confirmed library folders (watched)
    this.meta = data.meta || {};          // per-show extra info (genres, poster) keyed by showKey
    this.servers = data.servers || [];    // DLNA media servers the user picked
    this.scanning = false;
    this.watchers = new Map();
    this._saveTimer = null;
  }

  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.store.write('library', { items: this.items, folders: this.folders, meta: this.meta, servers: this.servers }), 300);
  }

  // Everything except what's in the locked section's folders (see setPrivateFolders)
  // and what was hidden by hand (right-click in the Library; hiddenList shows those).
  list() { const all = Object.values(this.items).filter((it) => !it.hiddenUser); return this.private?.length ? all.filter((it) => it.remote || !this.isPrivate(it.path)) : all; }
  hiddenList() { const all = Object.values(this.items).filter((it) => it.hiddenUser); return this.private?.length ? all.filter((it) => it.remote || !this.isPrivate(it.path)) : all; }
  listAll() { return Object.values(this.items); }
  // The locked section: its videos never show up in lists, channels, shows or searches.
  setPrivateFolders(list) { this.private = (list || []).filter(Boolean).map((f) => path.resolve(f).toLowerCase()); }
  isPrivate(p) {
    if (!p || !this.private?.length) return false;
    const lp = path.resolve(p).toLowerCase();
    return this.private.some((q) => lp === q || lp.startsWith(q + path.sep));
  }

  // Walk folders and collect candidate media files.
  // On Demand folders are "quiet": never watched or swept up by other folders' scans —
  // they're only read when someone opens the On Demand screen (or asks by name).
  setQuietFolders(list) {
    this.quiet = (list || []).map((f) => path.resolve(f).toLowerCase());
    for (const [f, w] of this.watchers) if (this.isQuiet(f)) { try { w.close(); } catch {} this.watchers.delete(f); }
  }
  isQuiet(p, roots = []) {
    const lp = path.resolve(p).toLowerCase();
    return (this.quiet || []).some((q) => (lp === q || lp.startsWith(q + path.sep)) && !roots.some((r) => path.resolve(r).toLowerCase() === q));
  }

  async findFiles(roots, onFound) {
    const found = [];
    const stack = [...roots];
    const seen = new Set();
    const rootSet = new Set(roots.map((r) => path.resolve(r).toLowerCase()));
    while (stack.length) {
      const dir = stack.pop();
      const key = dir.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      let dh;
      try { dh = await fsp.opendir(dir); } catch { continue; }
      // Read the whole directory first: if it turns out to be a software project
      // (ComfyUI, a repo, a python env — whatever it's named), skip it entirely.
      // A folder the user picked as a source themselves is always honored.
      const dirs = [], files = [];
      try {
        for await (const ent of dh) (ent.isDirectory() ? dirs : ent.isFile() ? files : []).push(ent.name);
      } catch { /* permission errors mid-iteration */ }
      if (!rootSet.has(path.resolve(dir).toLowerCase())
        && (files.some((n) => CODE_MARKERS.has(n.toLowerCase())) || dirs.some((n) => CODE_MARKERS.has(n.toLowerCase())))) continue;
      for (const name of dirs) {
        const n = name.toLowerCase();
        if (SKIP_DIRS.has(n) || n.startsWith('.') || n.startsWith('$')) continue;
        const full = path.join(dir, name);
        if (this.isQuiet(full, roots)) continue; // an On Demand folder inside this one
        stack.push(full);
      }
      for (const name of files) {
        const type = mediaType(name);
        if (!type) continue;
        found.push({ path: path.join(dir, name), type });
        if (found.length % 50 === 0) onFound?.(found.length, dir);
      }
    }
    return found;
  }

  // New media policy: 'auto' = straight onto channels, 'review' = wait in the
  // inbox for approval, 'library' = keep in the library only (no prompts).
  statusFor(policy) { return !policy || policy === 'auto' ? 'active' : 'pending'; }

  async scan(roots, { remember = true, prune = false, policy = this.defaultPolicy || 'auto', minBytes = null } = {}) {
    if (this.scanning) return { busy: true };
    this.scanning = true;
    this._policy = policy;
    try {
      roots = roots.filter((r) => fs.existsSync(r));
      if (remember) {
        for (const r of roots) if (!this.folders.some((f) => f.toLowerCase() === r.toLowerCase())) this.folders.push(r);
      }
      this.emit('progress', { phase: 'finding', found: 0, probed: 0, total: 0 });
      const files = await this.findFiles(roots, (n, dir) => this.emit('progress', { phase: 'finding', found: n, current: dir }));

      let todo = [];
      const presentIds = new Set();
      for (const f of files) {
        let st;
        try { st = await fsp.stat(f.path); } catch { continue; }
        const id = idFor(f.path);
        const cur = this.items[id];
        // Too small for now — but a file that's still copying in keeps its place.
        if (st.size < (minBytes ?? (f.type === 'audio' ? MIN_AUDIO_BYTES : MIN_VIDEO_BYTES))) { if (cur) presentIds.add(id); continue; }
        presentIds.add(id);
        if (cur && cur.size === st.size && cur.mtime === st.mtimeMs) continue;
        todo.push({ ...f, id, size: st.size, mtime: st.mtimeMs });
      }
      // A movie still being copied in: its size keeps growing (Windows keeps the original
      // file date when copying, so the date can't tell). Leave it for a moment and look again.
      let unsettled = 0;
      if (todo.length && todo.length <= 400) {
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        const ready = [];
        for (const f of todo) {
          let st2;
          try { st2 = await fsp.stat(f.path); } catch { continue; }
          if (st2.size !== f.size || await stillWriting(f.path)) unsettled++;
          else ready.push(f);
        }
        todo = ready;
      }

      let probed = 0, added = 0;
      const total = todo.length;
      this.emit('progress', { phase: 'probing', found: files.length, probed, total });
      const workers = Math.max(2, Math.min(8, os.cpus().length - 1));
      let next = 0;
      const work = async () => {
        while (next < todo.length) {
          const f = todo[next++];
          const info = await probe(f.path);
          probed++;
          if (info && info.duration >= 5) {
            const prev = this.items[f.id];
            this.items[f.id] = this.buildItem(f, info);
            // A changed file keeps its status; a brand-new one follows the policy.
            this.items[f.id].status = prev?.status || this.statusFor(this._policy);
            if (prev?.added) this.items[f.id].added = prev.added;
            if (!prev) added++;
          }
          if (probed % 5 === 0 || probed === total) this.emit('progress', { phase: 'probing', found: files.length, probed, total, current: f.path });
        }
      };
      await Promise.all(Array.from({ length: workers }, work));

      let removed = 0;
      if (prune) {
        // Folder boundary, not a string prefix: "…\TV" must not match "…\TV Shows".
        const under = (p) => { const lp = p.toLowerCase(); return roots.some((r) => { const lr = path.resolve(r).toLowerCase(); return lp === lr || lp.startsWith(lr + path.sep); }); };
        for (const [id, it] of Object.entries(this.items)) {
          if (!it.remote && under(it.path) && !presentIds.has(id) && !this.isQuiet(it.path, roots)) {
            // Its cached poster goes too (only HomeCable's own cache file, never your pictures).
            if (it.poster && path.basename(it.poster) === id + '.jpg') fs.rm(it.poster, { force: true }, () => {});
            delete this.items[id]; removed++;
          }
        }
      }
      this.groupShows();
      this.save();
      this.emit('progress', { phase: 'done', found: files.length, probed, total, added, removed });
      this.emit('changed');
      this.watch();
      if (unsettled) this.scanSoon(roots, 15000); // finish the ones that were still copying
      return { found: files.length, added, removed, total: this.list().length, pending: this.pendingCount() };
    } finally {
      this.scanning = false;
    }
  }

  buildItem(f, info) {
    const p = parsePath(f.path);
    const isAudio = f.type === 'audio' || !info.video;
    let kind;
    if (isAudio) kind = 'music';
    else if (info.duration < 180) kind = 'short';
    else if (p.show) kind = 'episode';
    else if (p.isMovieLike || info.duration >= 60 * 60) kind = 'movie';
    else kind = 'clip';
    return {
      id: f.id, path: f.path, size: f.size, mtime: f.mtime, added: Date.now(),
      kind, title: info.title && kind === 'movie' && info.title.length < 80 ? info.title : p.title,
      show: p.show, season: p.season, episode: p.episode, year: p.year, dirShow: p.dirShow, dirSeason: p.dirSeason,
      duration: info.duration, width: info.width, height: info.height,
      container: info.container, vcodec: info.video, acodec: info.audio, mode: playMode(info),
      folder: path.dirname(f.path),
    };
  }

  // Loose clips that share a folder with several siblings become a series named
  // after the folder (e.g. "Bobs Burgers/1 Monday/*.mp4" with no SxxEyy).
  groupShows() {
    const byFolder = new Map();
    for (const it of this.listAll()) {
      if (it.kind === 'music') continue;
      if (!byFolder.has(it.folder)) byFolder.set(it.folder, []);
      byFolder.get(it.folder).push(it);
    }
    for (const [, list] of byFolder) {
      const loose = list.filter((it) => (it.kind === 'clip' || (it.kind === 'movie' && !it.year && it.duration < 75 * 60)) && it.dirShow && !it.autoShow);
      const reset = list.filter((it) => it.autoShow);
      if (loose.length + reset.length >= 3) {
        const all = [...loose, ...reset].sort((a, b) => naturalCompare(path.basename(a.path), path.basename(b.path)));
        all.forEach((it, i) => {
          it.kind = 'episode'; it.show = it.dirShow; it.season = it.dirSeason ?? 1; it.episode = i + 1; it.autoShow = true;
        });
      }
    }
    for (const it of this.listAll()) if (it.show) it.showKey = showKey(it.show);
  }

  shows() {
    const map = new Map();
    for (const it of this.list()) {
      if (it.kind !== 'episode' || !it.showKey || !it.show) continue;
      let s = map.get(it.showKey);
      if (!s) { s = { key: it.showKey, name: it.show, count: 0, duration: 0, seasons: new Set(), folders: new Set(), meta: this.meta[it.showKey] || null }; map.set(it.showKey, s); }
      s.count++; s.duration += it.duration; s.seasons.add(it.season); s.folders.add(it.folder);
    }
    return [...map.values()].map((s) => ({ ...s, seasons: s.seasons.size, folders: [...s.folders], avg: s.duration / s.count }))
      .sort((a, b) => naturalCompare(a.name, b.name));
  }

  episodesOf(key) {
    return this.list().filter((it) => it.showKey === key && it.kind === 'episode')
      .sort((a, b) => (a.season - b.season) || (a.episode - b.episode) || naturalCompare(a.path, b.path));
  }

  // Resolve a channel source to an ordered list of items. Folder/show/kind
  // sources re-resolve on each call, so new downloads join channels automatically.
  resolve(src) {
    // Items waiting for review only play where you picked them by hand.
    const every = src.private ? this.listAll() : this.list(); // private: the locked section's own folder
    const all = src.type === 'item' ? every : every.filter((it) => it.status !== 'pending' && it.kind !== 'ad' && !it.offline); // offline: a paused torrent's videos
    const ordered = (list) => list.sort((a, b) =>
      ((a.show || '') === (b.show || '') ? 0 : naturalCompare(a.show || a.title, b.show || b.title))
      || ((a.season ?? 0) - (b.season ?? 0)) || ((a.episode ?? 0) - (b.episode ?? 0)) || naturalCompare(a.path, b.path));
    switch (src.type) {
      case 'show': return this.episodesOf(src.key);
      case 'folder': {
        const pre = src.path.toLowerCase().replace(/[\\/]+$/, '') + path.sep;
        // includePending: a folder you picked for On Demand plays everything in it, no review step.
        return ordered((src.includePending ? every.filter((it) => it.kind !== 'ad') : all).filter((it) => it.path.toLowerCase().startsWith(pre) && (src.includeShorts || it.kind !== 'short')));
      }
      // mine: only your own files (this PC, USB, network) — not the free archive classics.
      case 'kind': return ordered(all.filter((it) => it.kind === src.kind && (!src.mine || !String(it.server || '').startsWith('archive:'))));
      case 'genre': return ordered(all.filter((it) => it.kind === 'episode' && (this.meta[it.showKey]?.genres || []).includes(src.genre)));
      case 'item': return this.items[src.id] && (src.private || !this.isPrivate(this.items[src.id].path)) ? [this.items[src.id]] : [];
      case 'recent': {
        const since = Date.now() - (src.days || 14) * 86400e3;
        return ordered(all.filter((it) => it.added >= since && it.kind !== 'music' && it.kind !== 'short'));
      }
      case 'server': return ordered(all.filter((it) => it.server === src.id));
      // Everything that came from torrents, by kind (On Demand: 'movie'; Stream Demand: 'episode').
      case 'torrent': return ordered(all.filter((it) => it.torrent && (!src.kind || it.kind === src.kind)));
      default: return [];
    }
  }

  // Watch library folders so new files show up without a manual rescan.
  watch() {
    for (const f of this.folders) {
      if (this.watchers.has(f) || !fs.existsSync(f) || this.isQuiet(f)) continue;
      try {
        const w = fs.watch(f, { recursive: true }, (ev, name) => {
          // Videos, pictures (posters) — and folders: deleting or renaming a movie's
          // folder removes the files inside it without an event for each one.
          const n = String(name || '');
          if (n && !mediaType(n) && path.extname(n) && !/\.(jpe?g|png|webp|bmp)$/i.test(n)) return;
          this.scanSoon([f], 8000);
        });
        w.on('error', () => { this.watchers.delete(f); });
        this.watchers.set(f, w);
      } catch {}
    }
  }

  // Rescan a folder shortly; changes that arrive while a scan is running are kept, not dropped.
  scanSoon(roots, delay = 8000) {
    this._soon = this._soon || new Map();
    for (const r of roots) {
      clearTimeout(this._soon.get(r));
      this._soon.set(r, setTimeout(async () => {
        this._soon.delete(r);
        const res = await this.scan([r], { remember: false, prune: true }).catch(() => null);
        if (res?.busy) this.scanSoon([r], 3000);
      }, delay));
    }
  }

  removeFolder(folder) {
    this.folders = this.folders.filter((f) => f.toLowerCase() !== folder.toLowerCase());
    this.watchers.get(folder)?.close();
    this.watchers.delete(folder);
    const pre = path.resolve(folder).toLowerCase() + path.sep;
    for (const [id, it] of Object.entries(this.items)) if (!it.remote && it.path.toLowerCase().startsWith(pre)) delete this.items[id];
    this.save();
    this.emit('changed');
  }

  // A save still waiting on its debounce is written now — for a quit, or a change that must not be lost.
  flush() {
    if (!this._saveTimer) return;
    clearTimeout(this._saveTimer); this._saveTimer = null;
    this.store.write('library', { items: this.items, folders: this.folders, meta: this.meta, servers: this.servers });
  }
  close() { for (const w of this.watchers.values()) w.close(); this.flush(); }

  pendingCount() { return this.list().filter((it) => it.status === 'pending').length; }
  approve(ids) {
    const set = ids === 'all' ? null : new Set(ids);
    let n = 0;
    for (const it of this.list()) if (it.status === 'pending' && (!set || set.has(it.id))) { it.status = 'active'; it.added = Date.now(); n++; }
    this.save();
    this.emit('changed');
    return n;
  }

  // ---------- DLNA media servers ----------
  async scanServer(server, { policy = this.defaultPolicy || 'auto' } = {}) {
    if (this.scanning) return { busy: true };
    this.scanning = true;
    const { crawlDlna } = require('./network');
    try {
      if (!this.servers.some((s) => s.id === server.id)) this.servers.push(server);
      else Object.assign(this.servers.find((s) => s.id === server.id), server);
      this.emit('progress', { phase: 'finding', found: 0, current: server.name });
      const entries = await crawlDlna(server, { onProgress: (n, where) => this.emit('progress', { phase: 'finding', found: n, current: where }) });
      const present = new Set();
      let added = 0, probed = 0;
      for (const e of entries) {
        const id = idFor(server.id + '|' + e.path);
        present.add(id);
        const prev = this.items[id];
        if (prev) { prev.url = e.url; continue; } // URLs can change between server restarts
        let duration = e.duration;
        let info = null;
        if (!duration) { info = await probe(e.url, 15000); duration = info?.duration || 0; }
        probed++;
        if (probed % 5 === 0) this.emit('progress', { phase: 'probing', probed, total: entries.length, current: e.path });
        if (duration < 5) continue;
        const it = this.buildItem({ id, path: e.path, type: e.audio ? 'audio' : 'video', size: e.size, mtime: 0 },
          info || { duration, video: e.audio ? null : '?', audio: '?', container: e.mime, width: +(e.resolution?.split('x')[0] || 0), height: +(e.resolution?.split('x')[1] || 0) });
        it.remote = true;
        it.server = server.id;
        it.url = e.url;
        it.art = e.art || null;
        it.vcodec = info?.video || null;
        it.acodec = info?.audio || null;
        // Without codec info: let the browser try MP4/WebM/MKV/MP3, fall back to ffmpeg if it can't.
        it.mode = info ? it.mode : /mp4|webm|matroska|mkv|mpeg$|mp3|aac|flac|ogg/i.test(e.mime) ? 'direct' : 'transcode';
        if (e.movie && it.kind === 'clip') it.kind = 'movie';
        it.status = this.statusFor(policy);
        this.items[id] = it;
        added++;
      }
      let removed = 0;
      for (const [id, it] of Object.entries(this.items)) if (it.server === server.id && !present.has(id)) { delete this.items[id]; removed++; }
      this.groupShows();
      this.save();
      this.emit('progress', { phase: 'done', added, removed });
      this.emit('changed');
      return { found: entries.length, added, removed, total: this.list().length, pending: this.pendingCount() };
    } finally {
      this.scanning = false;
    }
  }

  removeServer(id) {
    this.servers = this.servers.filter((s) => s.id !== id);
    for (const [k, it] of Object.entries(this.items)) if (it.server === id) delete this.items[k];
    this.save();
    this.emit('changed');
  }

  // Periodic check of every source (folders + media servers).
  async rescanAll({ policy } = {}) {
    const res = { added: 0, removed: 0 };
    const loud = this.folders.filter((f) => !this.isQuiet(f));
    if (loud.length) { const r = await this.scan(loud, { remember: false, prune: true, policy }); res.added += r.added || 0; res.removed += r.removed || 0; }
    // (archive and torrent sources look after themselves)
    for (const s of this.servers.filter((x) => x.kind !== 'archive' && x.kind !== 'torrent')) { const r = await this.scanServer(s, { policy }); res.added += r.added || 0; res.removed += r.removed || 0; }
    res.pending = this.pendingCount();
    return res;
  }
}

module.exports = { Library, quickScanRoots, deepScanRoots, listDrives, idFor };
