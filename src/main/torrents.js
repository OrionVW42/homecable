// Torrents as a media source: a magnet link or a .torrent file becomes library
// items that play while they download.
//
// WebTorrent fetches pieces in order and runs a tiny HTTP server on 127.0.0.1
// (a random path is its key) that answers Range requests the way a finished
// file would: bytes that aren't here yet make those pieces download first. So
// the media server's /direct proxy and ffmpeg behind /stream just work on a
// torrent's URL — the MP4/MKV index at the tail of the file comes in first, a
// seek fetches the piece under the playhead, and a channel can join a show in
// progress as long as the swarm outruns the bitrate.
//
// The client itself lives in its own process (src/main/torrentHost.js), which
// can be pinned to one network interface (Settings → "Torrent network
// interface", like qBittorrent): pick a VPN adapter and every peer, tracker,
// DHT and web-seed socket is bound to it. This side owns the library: items are
// `remote` (like DLNA and Internet Archive ones) under 'torrent:<infohash>';
// the .torrent itself is kept so the next start re-adds it without a tracker
// round-trip and resumes from the pieces already on disk. Each torrent
// downloads into its own folder, so forgetting one removes exactly its files.
// Pausing drops it from the client (files kept) and marks its videos offline —
// off every channel until it resumes. Which files download is yours to pick;
// by default every video does and samples / subtitles / extras never do.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { utilityProcess } = require('electron');
const { probe } = require('./ffmpeg');
const { mediaType } = require('./naming');
const { idFor } = require('./library');

const MIN_BYTES = 2 * 1024 * 1024; // smaller "videos" are samples or extras
const looksLikeLink = (s) => /^magnet:\?/i.test(s) || /^[0-9a-f]{40}$/i.test(s) || /^https?:\/\/\S+\.torrent(\?\S*)?$/i.test(s);
const serverIdOf = (infoHash) => 'torrent:' + infoHash;
const hashOf = (serverId) => String(serverId).replace(/^torrent:/, '');
const size = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);
// Videos worth a place in the library — not the samples, trailers and featurettes release packs carry.
const EXTRA = /(^|[\\/._ \-\[(])(sample|trailer|teaser|featurettes?|behind[ ._-]the[ ._-]scenes|deleted[ ._-]scenes)([\\/._ \-\])]|$)/i;
const isMedia = (f) => !!mediaType(f.name) && f.length >= MIN_BYTES && !EXTRA.test(f.path || f.name);

class Torrents {
  constructor(lib, { dir, store, log = () => {}, iface = () => '', settings = () => ({}), send = () => {}, onNew = () => {}, playing = () => null }) {
    this.lib = lib; this.dir = dir; this.store = store; this.log = log; this.iface = iface;
    this.settings = settings; this.send = send; this.onNew = onNew; this.playing = playing;
    this._cleanT = setInterval(() => this.settings().torrentsOn === false || this.enforceLimit().catch((e) => this.log('torrents: clean-up', e.message)), 5 * 60e3);
    this._cleanT.unref?.();
    this._queueT = setInterval(() => this.settings().torrentsOn === false || this._status().then(() => this._schedule()).catch(() => {}), 15000);
    this._queueT.unref?.();
    // [{ infoHash, name, link, torrentFile (base64), policy, added, length, fileList, files?: [paths picked], paused?, progress? }]
    this.saved = store.read('torrents', []);
    this.child = null; this.base = ''; this.state = 'idle'; this.address = null;
    this._starting = null; this._pending = new Map(); this._seq = 0; this._live = new Map();
    this._busy = new Set(); // torrents being (re)attached right now
  }

  // Start the torrent process (at start only when torrents are saved; otherwise on first use).
  start() {
    if (this._starting) return this._starting;
    this._starting = (async () => {
      const child = utilityProcess.fork(path.join(__dirname, 'torrentHost.js'), [], { serviceName: 'HomeCable torrents' });
      this.child = child;
      const hello = new Promise((resolve) => { this._hello = resolve; });
      child.on('message', (m) => this._onMessage(m));
      child.on('exit', (code) => {
        this.log('torrents: process exited', code);
        for (const p of this._pending.values()) p.reject(new Error('The torrent process stopped'));
        this._pending.clear();
        if (this.child === child) { this.child = null; this._starting = null; this.state = 'idle'; this.base = ''; this._live.clear(); }
      });
      await hello;
      await this._rpc('init', { dir: this.dir, iface: this.iface() || '', secure: this._secure() });
    })();
    this._starting.catch(() => { this._starting = null; });
    return this._starting;
  }

  _onMessage(m) {
    if (!m) return;
    if (m.id) {
      const p = this._pending.get(m.id);
      if (!p) return;
      this._pending.delete(m.id);
      if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error || 'torrent process error'));
      return;
    }
    switch (m.event) {
      case 'hello': this._hello?.(); break;
      case 'log': this.log('torrents:', m.text); break;
      case 'waiting': this.state = 'waiting'; this.address = null; this.base = ''; this._live.clear(); break;
      case 'ready':
        this.state = 'ready'; this.base = m.base; this.address = m.address;
        // A (re)started client has a new stream address: re-add what's saved so every item points at it.
        this._attachPass = this._attachAll().catch((e) => this.log('torrents: resume', e.message));
        break;
      case 'done': {
        this.log('a torrent finished');
        const s = this.lib.servers.find((x) => x.id === serverIdOf(m.infoHash));
        if (s) { s.detail = `Torrent · downloaded · ${size(m.length)}`; this.lib.save(); this.lib.emit('changed'); }
        const rec = this.saved.find((r) => r.infoHash === m.infoHash);
        if (rec) { rec.progress = 1; rec.doneAt = rec.doneAt || Date.now(); this._save(); }
        // "Stop sharing when a download finishes" (on unless you turn it off) — else ask, up top.
        if (this.settings().torrentStopSeeding) this.stop(serverIdOf(m.infoHash)).then(() => this.send('toast', `✅ ${m.name} finished downloading — sharing stopped (Settings → Torrents)`)).catch((e) => this.log('torrent stop', e.message));
        else this.send('torrent-done', { id: serverIdOf(m.infoHash), name: m.name, length: m.length });
        this.enforceLimit().catch(() => {});
        break;
      }
      default: break;
    }
  }

  _rpc(type, payload = {}, timeoutMs = 180000) {
    if (!this.child) return Promise.reject(new Error('Torrents are not running'));
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._pending.delete(id); reject(new Error(`torrent process did not answer (${type})`)); }, timeoutMs);
      this._pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.child.postMessage({ id, type, payload });
    });
  }

  // A magnet link, an info hash, a .torrent link, or a .torrent file on this PC.
  async add(link, { policy = 'auto' } = {}) {
    await this.start();
    link = String(link || '').trim();
    let req = { src: link };
    if (!looksLikeLink(link)) {
      if (!/\.torrent$/i.test(link) || !fs.existsSync(link)) throw new Error('Paste a magnet link or pick a .torrent file');
      req = { b64: fs.readFileSync(link).toString('base64') };
    }
    const t = await this._rpc('add', req);
    const known = this.saved.find((s) => s.infoHash === t.infoHash);
    const rec = known || { link, policy, added: Date.now() };
    this._remember(rec, t);
    if (known?.paused) { known.paused = false; this._save(); }
    const added = await this._register(t, rec);
    return { serverId: serverIdOf(t.infoHash), name: t.name, added, files: t.files.length };
  }

  _remember(rec, t) {
    Object.assign(rec, { infoHash: t.infoHash, name: t.name, torrentFile: t.torrentFile, length: t.length, fileList: t.files.map(({ path: p, name, length }) => ({ path: p, name, length })) });
    if (!this.saved.includes(rec)) this.saved.push(rec);
    this._save();
  }

  async _attach(rec) {
    this._busy.add(rec.infoHash);
    try {
      const t = await this._rpc('add', rec.torrentFile ? { b64: rec.torrentFile } : { src: rec.link });
      this._remember(rec, t);
      return await this._register(t, rec);
    } finally { this._busy.delete(rec.infoHash); }
  }

  async _attachAll() {
    // Library entries for torrents that are no longer saved (a forget that didn't reach disk) go first.
    for (const s of this.lib.servers.filter((x) => x.kind === 'torrent' && !this.saved.some((r) => serverIdOf(r.infoHash) === x.id))) { this.log('torrents: dropping', s.name, '(no longer saved)'); this.lib.removeServer(s.id); }
    for (const rec of this.saved.filter((r) => !r.paused)) {
      try { await this._attach(rec); } catch (e) { this.log('a torrent could not resume'); }
    }
  }

  // Which of a torrent's files are wanted: the ones picked by hand, else every video.
  _chosen(rec, files) { return rec.files ? files.filter((f) => rec.files.includes(f.path)) : files.filter(isMedia); }

  // The wanted videos become library items (the rest are never downloaded). Returns how many are new.
  async _register(t, rec) {
    if (!this.saved.some((s) => s.infoHash === t.infoHash)) return 0; // forgotten while this was in flight
    const serverId = serverIdOf(t.infoHash);
    const chosen = this._chosen(rec, t.files);
    await this._rpc('select', { infoHash: t.infoHash, indexes: chosen.map((f) => f.index) });
    let added = 0;
    for (const f of t.files.filter(isMedia)) {
      const id = idFor(serverId + '|' + f.path);
      if (!chosen.includes(f)) { if (this.lib.items[id]) delete this.lib.items[id]; continue; } // unticked: off the library
      const prev = this.lib.items[id];
      if (prev) { // the stream address changes between starts; a stopped torrent's videos stream from it again
        prev.url = f.url; delete prev.offline;
        if (prev.localPath) { prev.remote = true; prev.path = prev.pseudoPath || prev.path; delete prev.localPath; }
        continue;
      }
      const info = await probe(f.url, 60000); // reads the head and the index at the tail — those pieces come first
      if (!info || !(info.duration >= 5)) { this.log('torrent: no readable video in', f.path); continue; }
      // "Torrents/Show Name/Season 1/…" so the show / season / episode naming rules apply.
      const pseudo = 'Torrents/' + f.path.split(/[\\/]/).join('/');
      const it = this.lib.buildItem({ id, path: pseudo, type: mediaType(f.name), size: f.length, mtime: 0 }, info);
      // Torrents of films rarely put the year in the file name ("Sintel.mp4"), so a video that
      // isn't an episode and runs 10 minutes or more is a movie (year from the torrent's name).
      if (it.kind !== 'episode' && it.kind !== 'music' && it.kind !== 'movie' && (info.duration || 0) >= 600) {
        it.kind = 'movie';
        const y = /\b(19[2-9]\d|20[0-4]\d)\b/.exec(t.name || '');
        if (y && !it.year) it.year = +y[1];
      }
      Object.assign(it, { remote: true, server: serverId, url: f.url, status: this.lib.statusFor(rec.policy || 'auto'), torrent: { infoHash: t.infoHash, file: f.path }, pseudoPath: pseudo, added: Date.now() });
      this.lib.items[id] = it;
      added++;
    }
    if (!this.lib.servers.some((s) => s.id === serverId)) this.lib.servers.push({ id: serverId, name: t.name, kind: 'torrent', detail: `Torrent · ${size(t.length)}` });
    this.log('a torrent was added');
    this.lib.groupShows();
    this.lib.save();
    this.lib.emit('changed');
    if (added) { try { this.onNew(serverId); } catch {} this.enforceLimit().catch(() => {}); }
    rec._queued = false; // just (re)selected its files; the queue decides again
    this._status().then(() => this._schedule()).catch(() => {});
    return added;
  }

  // Live numbers from the torrent process (cached for list()).
  async _status() {
    if (!this.child || this.state !== 'ready') return [];
    const r = await this._rpc('status', {}, 5000).catch(() => null);
    if (!r) return [];
    this._live = new Map(r.torrents.map((t) => [t.infoHash, t]));
    for (const t of r.torrents) {
      const s = this.lib.servers.find((x) => x.id === serverIdOf(t.infoHash));
      if (s && !t.done) s.detail = `Torrent · ${Math.round(t.progress * 100)}% of ${size(t.length)} · ${t.peers} peers`;
    }
    return r.torrents;
  }
  async status() { return (await this._status()).map((t) => ({ ...t, id: serverIdOf(t.infoHash) })); }

  // Everything the Torrents panel shows: saved torrents with their live numbers and files.
  async list() {
    await this._status();
    return this.saved.map((rec) => {
      const live = rec.paused ? null : this._live.get(rec.infoHash);
      const files = live?.files || rec.fileList || [];
      const chosen = new Set(this._chosen(rec, files).map((f) => f.path));
      const serverId = serverIdOf(rec.infoHash);
      return {
        id: serverId, name: rec.name, added: rec.added, paused: !!rec.paused && !rec.stopped, stopped: !!rec.stopped, priority: rec.priority || 'normal', queued: !!rec._queued && !rec.paused, waiting: !rec.paused && this.state !== 'ready', busy: this._busy.has(rec.infoHash), kept: this.isKept({ torrent: { infoHash: rec.infoHash } }),
        length: live?.length ?? rec.length ?? 0, progress: live ? live.progress : rec.progress ?? 0, done: live ? live.done : (rec.progress ?? 0) >= 1,
        downloaded: live?.downloaded ?? Math.round((rec.progress ?? 0) * (rec.length ?? 0)), uploaded: live?.uploaded ?? 0,
        downloadSpeed: live?.downloadSpeed ?? 0, uploadSpeed: live?.uploadSpeed ?? 0, peers: live?.peers ?? 0, encrypted: live?.encrypted ?? 0, webSeeds: live?.webSeeds ?? 0, timeRemaining: live?.timeRemaining ?? 0,
        folder: this.folderOf(serverId),
        files: files.map((f) => {
          const id = idFor(serverId + '|' + f.path);
          const it = this.lib.items[id];
          return { path: f.path, name: f.name, length: f.length, progress: f.progress ?? rec.fileProgress?.[f.path] ?? 0, selected: chosen.has(f.path), media: isMedia(f), itemId: it ? id : null, kept: it ? this.isKept(it) : false, watched: it ? !!this.settings().vodWatched?.[id] : false };
        }),
      };
    });
  }

  // Pick which files download. Videos you untick leave the library; ticked ones join it.
  async setFiles(serverId, paths) {
    const rec = this.saved.find((s) => s.infoHash === hashOf(serverId));
    if (!rec) throw new Error('No such torrent');
    rec.files = [...new Set(paths)];
    this._save();
    if (!rec.paused && this.child && this.state === 'ready') await this._attach(rec);
    return true;
  }

  // Pause: out of the swarm, files kept, its videos off every channel until it resumes.
  async pause(serverId) {
    const rec = this.saved.find((s) => s.infoHash === hashOf(serverId));
    if (!rec || rec.paused) return false;
    const live = (await this._status()).find((t) => t.infoHash === rec.infoHash);
    if (live) { rec.progress = live.progress; rec.fileProgress = Object.fromEntries(live.files.map((f) => [f.path, f.progress])); }
    rec.paused = true;
    this._save();
    if (this.child) await this._rpc('remove', { infoHash: rec.infoHash, destroyStore: false }).catch((e) => this.log('torrent pause', e.message));
    for (const it of Object.values(this.lib.items)) if (it.server === serverId) it.offline = true;
    this.lib.save();
    this.lib.emit('changed');
    return true;
  }
  async resume(serverId) {
    const rec = this.saved.find((s) => s.infoHash === hashOf(serverId));
    if (!rec || !rec.paused) return false;
    rec.paused = false; rec.stopped = false;
    this._save();
    await this.start();
    if (this.state === 'ready') await this._attach(rec);
    return true;
  }

  // Priority between torrents: High / Normal / Low, and how many download at once
  // (Settings → Torrents; 3 unless changed, 0 = all). The rest wait their turn — queued
  // torrents still share what they have, they just don't download. Whatever you're
  // watching right now always downloads.
  async setPriority(serverId, priority) {
    const rec = this.saved.find((s) => s.infoHash === hashOf(serverId));
    if (!rec || !['high', 'normal', 'low'].includes(priority)) return false;
    rec.priority = priority;
    this._save();
    await this._schedule();
    return true;
  }
  async _schedule() {
    if (!this.child || this.state !== 'ready' || this._scheduling) return;
    this._scheduling = true;
    try {
      const rank = { high: 0, normal: 1, low: 2 };
      const max = this.settings().torrentMaxActive ?? 3;
      const playing = this.lib.items[this.playing()]?.torrent?.infoHash || null;
      const want = this.saved.filter((r) => !r.paused && this._live.get(r.infoHash) && !this._live.get(r.infoHash).done)
        .sort((a, b) => (a.infoHash === playing ? -1 : b.infoHash === playing ? 1 : 0) || rank[a.priority || 'normal'] - rank[b.priority || 'normal'] || (a.added || 0) - (b.added || 0));
      for (let i = 0; i < want.length; i++) {
        const rec = want[i];
        const queued = max > 0 && i >= max && rec.infoHash !== playing;
        if (!!rec._queued === queued) continue;
        rec._queued = queued;
        const live = this._live.get(rec.infoHash);
        const indexes = queued ? [] : this._chosen(rec, live.files).map((f) => f.index);
        await this._rpc('select', { infoHash: rec.infoHash, indexes }, 10000).catch((e) => this.log('torrent queue', e.message));
        this.log(`a torrent is ${queued ? 'queued' : 'downloading'}`);
      }
    } finally { this._scheduling = false; }
  }

  // Stop: out of the swarm for good (no downloading, no sharing) — but what's finished keeps
  // playing, straight from the file on disk. Unfinished videos wait (offline) until ▶ Play.
  async stop(serverId) {
    const rec = this.saved.find((s) => s.infoHash === hashOf(serverId));
    if (!rec) return false;
    const live = (await this._status()).find((t) => t.infoHash === rec.infoHash);
    if (live) { rec.progress = live.progress; rec.fileProgress = Object.fromEntries(live.files.map((f) => [f.path, f.progress])); }
    rec.paused = true; rec.stopped = true;
    this._save();
    if (this.child) await this._rpc('remove', { infoHash: rec.infoHash, destroyStore: false }).catch((e) => this.log('torrent stop', e.message));
    const folder = this.folderOf(serverId);
    for (const it of Object.values(this.lib.items)) {
      if (it.server !== serverId || !it.torrent) continue;
      const local = path.join(folder, it.torrent.file);
      if ((rec.fileProgress?.[it.torrent.file] ?? 0) >= 0.999 && fs.existsSync(local)) {
        it.pseudoPath = it.pseudoPath || it.path; it.localPath = local; it.path = local; it.remote = false; delete it.offline;
      } else it.offline = true;
    }
    this.lib.save();
    this.lib.emit('changed');
    return true;
  }

  // "Keep": never cleaned up by the storage limit — a whole torrent, a show, or one video.
  isKept(it) {
    const keep = this.settings().torrentKeep || [];
    return keep.includes(serverIdOf(it?.torrent?.infoHash || '')) || (it?.id && keep.includes(it.id)) || (it?.showKey && keep.includes('show:' + it.showKey));
  }

  // How much the torrents take on disk (what has actually downloaded).
  usage() {
    let bytes = 0;
    for (const rec of this.saved) {
      const live = rec.paused ? null : this._live.get(rec.infoHash);
      const gone = new Set(rec.deleted || []);
      for (const f of live?.files || rec.fileList || []) {
        if (gone.has(f.path)) continue;
        bytes += live ? f.downloaded || 0 : Math.round((rec.fileProgress?.[f.path] ?? (rec.progress || 0)) * (f.length || 0));
      }
    }
    const gb = this.settings().torrentLimitGB ?? 100;
    return { bytes, limitBytes: gb > 0 ? gb * 1e9 : 0 };
  }
  _fileBytes(it) {
    const rec = this.saved.find((s) => s.infoHash === it.torrent?.infoHash);
    const live = rec && this._live.get(rec.infoHash);
    const f = (live?.files || rec?.fileList || []).find((x) => x.path === it.torrent?.file);
    return f ? (live ? f.downloaded || 0 : Math.round((rec.fileProgress?.[f.path] ?? (rec.progress || 0)) * (f.length || 0))) : 0;
  }

  // The storage limit (Settings → Torrents; 100 GB unless changed, or unlimited): over it, the
  // videos you've already WATCHED make room — series and movies each by their own rule
  // ("age": oldest added first, "watched": watched longest ago first). Unwatched videos,
  // anything you've kept, and what's playing right now are never removed.
  async enforceLimit() {
    if (this._cleaning) return;
    const gb = this.settings().torrentLimitGB ?? 100;
    if (!(gb > 0) || !this.saved.length) return;
    this._cleaning = true;
    try {
      await this._status();
      let used = this.usage().bytes;
      const limit = gb * 1e9;
      if (used <= limit) return;
      const watched = this.settings().vodWatched || {};
      const rule = { episode: this.settings().torrentCleanSeries || 'watched', movie: this.settings().torrentCleanMovies || 'watched' };
      const playing = this.playing();
      const keyOf = (it) => ((it.kind === 'episode' ? rule.episode : rule.movie) === 'age' ? it.added || this.saved.find((r) => r.infoHash === it.torrent.infoHash)?.added || 0 : watched[it.id] || 0);
      const cands = Object.values(this.lib.items).filter((it) => it.torrent && watched[it.id] && !this.isKept(it) && it.id !== playing).sort((a, b) => keyOf(a) - keyOf(b));
      const drop = [];
      for (const it of cands) { if (used <= limit) break; used -= this._fileBytes(it); drop.push(it); }
      if (drop.length) {
        await this._dropItems(drop);
        this.send('toast', `🧹 Torrents were over your ${gb >= 1000 ? `${gb / 1000} TB` : `${gb} GB`} limit — removed ${drop.length} watched video${drop.length === 1 ? '' : 's'} (${drop.slice(0, 2).map((x) => x.show || x.title).join(', ')}${drop.length > 2 ? '…' : ''})`);
        this.log('torrents: limit clean-up removed', drop.map((x) => x.torrent.file).join(' | '));
      } else if (!this._warnedAt || Date.now() - this._warnedAt > 3600e3) {
        this._warnedAt = Date.now();
        this.send('toast', `🧲 Torrents use ${size(used)} — over your ${gb >= 1000 ? `${gb / 1000} TB` : `${gb} GB`} limit, with nothing watched to clear yet`);
      }
    } finally { this._cleaning = false; }
  }

  // Take videos out of their torrents for good: never downloaded again, their files deleted.
  async _dropItems(items) {
    const byTorrent = new Map();
    for (const it of items) { const k = it.torrent.infoHash; if (!byTorrent.has(k)) byTorrent.set(k, []); byTorrent.get(k).push(it); }
    for (const [infoHash, its] of byTorrent) {
      const rec = this.saved.find((s) => s.infoHash === infoHash);
      if (!rec) continue;
      const paths = new Set(its.map((x) => x.torrent.file));
      const current = rec.files || (rec.fileList || []).filter(isMedia).map((f) => f.path);
      rec.files = current.filter((p) => !paths.has(p));
      rec.deleted = [...new Set([...(rec.deleted || []), ...paths])];
      this._save();
      for (const it of its) delete this.lib.items[it.id];
      const live = !rec.paused && this.child && this.state === 'ready';
      if (live) await this._rpc('remove', { infoHash, destroyStore: false }).catch(() => {});
      for (const p of paths) await fs.promises.rm(path.join(this.folderOf(serverIdOf(infoHash)), p), { force: true }).catch(() => {});
      if (!rec.files.length) { await this.remove(serverIdOf(infoHash), { keepFiles: false }); continue; }
      if (live) await this._attach(rec).catch((e) => this.log('torrent re-attach', e.message));
    }
    this.lib.groupShows();
    this.lib.save();
    this.lib.emit('changed');
  }

  // Watching a torrent video: its file comes first, and the NEXT episode downloads right
  // behind it — so episode 2 is ready when episode 1 ends.
  async focus(itemId) {
    const it = this.lib.items[itemId];
    if (!it?.torrent || !this.child || this.state !== 'ready') return;
    const want = [[it, 2]];
    if (it.showKey) {
      const eps = this.lib.episodesOf(it.showKey);
      const i = eps.findIndex((e) => e.id === it.id);
      for (const nx of eps.slice(i + 1, i + 3)) if (nx.torrent) want.push([nx, 1]);
    }
    for (const [x, priority] of want) await this._rpc('prioritize', { infoHash: x.torrent.infoHash, path: x.torrent.file, priority }, 5000).catch(() => {});
  }

  // Where a torrent item's bytes come from RIGHT NOW. The stream address changes with every
  // (re)start and rebind, so the media server asks here per request instead of trusting the
  // saved url — and at start it waits a moment for the torrent process to come up, rather
  // than failing the first play (which would make the player give up on direct playback).
  async remoteUrl(it) {
    if (!it?.torrent) return it?.url || null;
    if (!this.child) this.start().catch(() => {});
    await this.ready(15000);
    const live = this.lib.items[it.id];
    return this.state === 'ready' && live?.url?.startsWith(this.base) ? live.url : null;
  }
  // Resolves once the torrent process is up and the saved torrents are (re)attached — or after `ms`.
  ready(ms) {
    const settled = () => this.state === 'ready' && this._attachPass;
    return new Promise((resolve) => {
      const give = setTimeout(resolve, ms);
      const check = () => { if (settled()) { clearTimeout(give); clearInterval(tick); this._attachPass.then(resolve, resolve); } };
      const tick = setInterval(check, 100);
      check();
      setTimeout(() => clearInterval(tick), ms);
    });
  }

  // Where the torrent process is bound right now (for Settings).
  bound() { return { state: this.child ? this.state : 'idle', iface: this.iface() || '', address: this.state === 'ready' ? this.address : null }; }

  // This PC's network interfaces (IPv4), real adapters first.
  interfaces() {
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      const a = (list || []).find((x) => x.family === 'IPv4' || x.family === 4);
      if (a) out.push({ name, address: a.address, internal: !!a.internal });
    }
    return out.sort((x, y) => (x.internal - y.internal) || x.name.localeCompare(y.name));
  }

  _secure() { return { off: 0, prefer: 1 }[this.settings().torrentEncryption] ?? 2; }
  async setEncryption() { if (this.child) await this._rpc('setEncryption', { secure: this._secure() }); }

  // Settings changed the interface: rebind now (its 'ready' re-adds every saved torrent on the new address).
  async setInterface(iface) {
    if (!this.child) return;
    await this._rpc('setInterface', { iface: iface || '' });
  }

  folderOf(serverId) { return path.join(this.dir, hashOf(serverId).slice(0, 16)); }

  // Forget a torrent: its items, and (unless kept) the files it downloaded.
  async remove(serverId, { keepFiles = false } = {}) {
    const infoHash = hashOf(serverId);
    this.saved = this.saved.filter((s) => s.infoHash !== infoHash);
    this._save();
    if (this.child) await this._rpc('remove', { infoHash, destroyStore: !keepFiles });
    else if (!keepFiles) await fs.promises.rm(this.folderOf(serverId), { recursive: true, force: true }).catch(() => {});
    this._live.delete(infoHash);
    this.lib.removeServer(serverId);
    this.lib.flush(); // a forget must survive an immediate quit
  }

  _save() { this.store.write('torrents', this.saved.map(({ _queued, ...r }) => r)); }
  async close() {
    const child = this.child;
    if (!child) return;
    await this._rpc('close', {}, 3000).catch(() => {});
    this.killNow();
  }
  // Quitting: no time for a round-trip (pieces are on disk as they arrive, nothing to flush).
  killNow() {
    const child = this.child;
    if (!child) return;
    try { child.kill(); } catch {}
    this.child = null; this._starting = null; this.state = 'idle'; this.base = ''; this._live.clear();
  }
}

module.exports = { Torrents, looksLikeLink };
