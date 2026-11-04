// Torrent search, in its own process (an Electron utility process) — for the same
// two reasons as the torrent client: an engine that hangs or throws can't touch
// the TV window, and every request it makes is pinned to the chosen network
// interface, so with a VPN adapter picked searches never leave over the normal
// connection either. Engines are small JavaScript modules: the built-in ones ship with
// the app, yours live
// in the user data folder (see docs/search-engines.md). src/main/search.js is the
// other end (over process.parentPort): it owns the settings, this runs the code.
const fs = require('fs');
const path = require('path');
const { pin, addressOf } = require('./pinSockets');
const { helpersFor } = require('./searchHelpers');

const port = process.parentPort;
const send = (m) => { try { port.postMessage(m); } catch {} };
const log = (...a) => send({ event: 'log', text: a.join(' ') });

const CATEGORIES = ['all', 'movies', 'tv', 'anime', 'music', 'games', 'software', 'books'];
const cfg = { iface: '', dirs: [] }; // dirs: [{ dir, builtin }]
let state = 'ready', address = null;
const loaded = new Map();   // file → { mtime, mod }
const searches = new Map(); // searchId → AbortController
const idOf = (file) => path.basename(file, path.extname(file)).toLowerCase().replace(/[^a-z0-9_-]/g, '');

// Bind to the chosen interface — or wait, with nothing bound, until it has an address.
function bind() {
  const want = cfg.iface || '';
  const addr = want ? addressOf(want) : null;
  if (want && !addr) { pin(null); state = 'waiting'; address = null; }
  else { pin(addr); state = 'ready'; address = addr; }
  return { state, iface: want, address };
}
setInterval(() => { if (!cfg.iface) return; const was = `${state}/${address}`; bind(); if (`${state}/${address}` !== was) log(`"${cfg.iface}": ${state}`); }, 10000).unref();

// An engine module, reloaded when its file changes (an update, or one you're writing).
function load(file) {
  const st = fs.statSync(file);
  const have = loaded.get(file);
  if (have && have.mtime === st.mtimeMs) return have.mod;
  delete require.cache[require.resolve(file)];
  const mod = require(file);
  if (!mod || typeof mod.search !== 'function' || !mod.name) throw new Error('not a search engine — it must export name and search(query, category, helpers)');
  loaded.set(file, { mtime: st.mtimeMs, mod });
  return mod;
}
function describe(file, builtin) {
  const id = idOf(file);
  try {
    const m = load(file);
    return {
      id, file, builtin, defaultOn: !!(builtin && m.defaultOn), name: String(m.name), url: typeof m.url === 'string' ? m.url : '', version: String(m.version || ''), about: typeof m.about === 'string' ? m.about : '',
      categories: Array.isArray(m.categories) && m.categories.length ? m.categories.filter((c) => CATEGORIES.includes(c)) : ['all'],
      options: Array.isArray(m.options) ? m.options.filter((o) => o && o.key).map((o) => ({ key: String(o.key), label: String(o.label || o.key), placeholder: String(o.placeholder || ''), secret: !!o.secret, required: o.required !== false })) : [],
      resolves: typeof m.resolve === 'function',
    };
  } catch (e) { return { id, file, builtin, name: id, error: e.message, categories: [], options: [], version: '', url: '', about: '' }; }
}
function files() {
  const out = [];
  for (const { dir, builtin } of cfg.dirs) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => /\.js$/i.test(f)).sort(); } catch {}
    for (const f of names) out.push({ file: path.join(dir, f), builtin });
  }
  return out;
}

const toMs = (d) => { if (d == null || d === '') return null; if (typeof d === 'number') return isFinite(d) ? (d < 1e12 ? d * 1000 : d) : null; const t = Date.parse(String(d)); return isNaN(t) ? null : t; };
// One result, in the shape the app shows — or null if it can't be used.
const norm = (engine, r, h) => {
  if (!r || typeof r !== 'object') return null;
  const name = h.strip(r.name);
  const link = typeof r.link === 'string' && /^(magnet:\?|https?:\/\/)/i.test(r.link) ? r.link : null;
  const page = typeof r.page === 'string' && /^https?:\/\//i.test(r.page) ? r.page : null;
  if (!name || (!link && !page)) return null;
  return {
    engine, name, link, page, size: r.size == null ? null : h.bytes(r.size),
    seeds: r.seeds == null || r.seeds === '' ? null : Math.max(0, +r.seeds || 0), leech: r.leech == null || r.leech === '' ? null : Math.max(0, +r.leech || 0),
    descLink: typeof r.descLink === 'string' && /^https?:\/\//i.test(r.descLink) ? r.descLink : null, pubDate: toMs(r.pubDate),
  };
};

const handlers = {
  async init({ iface, dirs }) { cfg.iface = iface || ''; cfg.dirs = dirs || []; return bind(); },
  async setInterface({ iface }) { cfg.iface = iface || ''; return bind(); },
  async bound() { return { state, iface: cfg.iface, address }; },
  async engines() { return files().map(({ file, builtin }) => describe(file, builtin)); },
  async validate({ file }) { const d = describe(file, false); if (d.error) throw new Error(d.error); return d; },
  // Fetch text (an engine to install) through the pinned connection.
  async fetchText({ url }) { return helpersFor({}).text(url); },
  // Fetch bytes (a .torrent a search found) through the pinned connection, as base64.
  async fetchBytes({ url }) {
    const r = await helpersFor({}).fetch(url);
    if (!r.ok) throw new Error(`the site answered ${r.status}`);
    return Buffer.from(await r.arrayBuffer()).toString('base64');
  },
  // Run every engine at once; each one's results are sent as soon as it answers.
  async search({ searchId, query, category = 'all', engines, timeoutMs = 45000 }) {
    if (state !== 'ready') throw new Error(`Searching waits for “${cfg.iface}” — it has no address right now`);
    const ctl = new AbortController();
    searches.set(searchId, ctl);
    const jobs = engines.map(async ({ id, file, options }) => {
      const t0 = Date.now();
      let results = [], error = null;
      try {
        const mod = load(file);
        const h = helpersFor({ signal: ctl.signal, options: options || {}, category, log: (...a) => log(`[${id}]`, ...a) });
        const raw = await Promise.race([mod.search(query, category, h), new Promise((_, rej) => setTimeout(() => rej(new Error('took too long')), timeoutMs))]);
        results = (Array.isArray(raw) ? raw : []).map((r) => norm(id, r, h)).filter(Boolean).slice(0, 300);
      } catch (e) { error = ctl.signal.aborted ? 'stopped' : (e?.message || String(e)); }
      if (ctl.signal.aborted) return;
      send({ event: 'search', searchId, engine: id, results, error, ms: Date.now() - t0 });
    });
    Promise.allSettled(jobs).then(() => { searches.delete(searchId); if (!ctl.signal.aborted) send({ event: 'search-done', searchId }); });
    return { searchId };
  },
  async cancel({ searchId }) { const c = searches.get(searchId); if (c) { c.abort(); searches.delete(searchId); } return true; },
  // Some sites only give the magnet link on the torrent's own page — fetched when you add it.
  async resolve({ file, options, result }) {
    if (result?.link) return { link: result.link };
    const mod = load(file);
    if (typeof mod.resolve !== 'function') throw new Error('This engine gives no download link for that result');
    let r;
    try { r = await mod.resolve(result, helpersFor({ options: options || {}, log })); }
    catch (e) { throw new Error(`Couldn’t get the link from the torrent’s page: ${e.message}`); }
    const link = typeof r === 'string' ? r : r?.link;
    if (!link || !/^(magnet:\?|https?:\/\/)/i.test(link)) throw new Error('No download link found on that page');
    return { link };
  },
  async close() { for (const c of searches.values()) c.abort(); setTimeout(() => process.exit(0), 20); return true; },
};

port.on('message', async (e) => {
  const m = e.data;
  if (!m || !m.id || !handlers[m.type]) return;
  try { send({ id: m.id, ok: true, result: await handlers[m.type](m.payload || {}) }); }
  catch (err) { send({ id: m.id, ok: false, error: err?.message || String(err) }); }
});
process.on('uncaughtException', (e) => log('uncaught', e.stack || e.message));
process.on('unhandledRejection', (e) => log('unhandled', e?.stack || e?.message || String(e)));
send({ event: 'hello' });
