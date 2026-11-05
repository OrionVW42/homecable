// The torrent client, in its own process (an Electron utility process) — for
// two reasons. The swarm's DHT and peer traffic can't jank the TV window, and
// the whole process can be pinned to ONE network interface, like qBittorrent's
// "Network interface" setting: every connection, listening socket and UDP
// socket this process opens is bound to that interface's address — peers,
// trackers, the DHT, web seeds, .torrent downloads — so with a VPN adapter
// chosen nothing leaks over the normal connection, and if the VPN drops,
// torrenting stops instead of falling back. Only the little media HTTP server
// stays on 127.0.0.1 for the TV window. src/main/torrents.js is the other end
// (over process.parentPort); it owns the library, this owns the sockets.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const port = process.parentPort;
const send = (m) => { try { port.postMessage(m); } catch {} };
const log = (...a) => send({ event: 'log', text: a.join(' ') });

// Every socket this process opens is bound to the chosen interface (pinSockets.js).
const { pin, addressOf } = require('./pinSockets');
let bound = null; // the address everything is bound to right now (null = any interface)

// ---- the client ----
const MIN_FILE = 1; // main decides which files matter; here every file is listed
const METADATA_MS = 90000;
const cfg = { dir: '', iface: '' };
let client = null, server = null, base = '', state = 'idle';
let WebTorrent = null, parseTorrent = null;
const inflight = new Map(); // infoHash → promise of a torrent being added

const view = () => ({ state, base, iface: cfg.iface, address: bound });

async function tearDown() {
  const c = client, s = server;
  client = null; server = null; base = ''; state = 'idle';
  if (s) { try { await new Promise((r) => s.destroy(r)); } catch {} }
  if (c) { await new Promise((r) => c.destroy(r)); }
}

// (Re)create the client, bound to the chosen interface — or wait for it to have an address.
async function bringUp() {
  await tearDown();
  const want = cfg.iface || '';
  const addr = want ? addressOf(want) : null;
  if (want && !addr) { bound = pin(null); state = 'waiting'; log(`waiting for "${want}" — it has no address right now`); send({ event: 'waiting', iface: want }); return view(); }
  bound = pin(addr);
  if (!WebTorrent) [{ default: WebTorrent }, { default: parseTorrent }] = await Promise.all([import('webtorrent'), import('parse-torrent')]);
  fs.mkdirSync(cfg.dir, { recursive: true });
  // No UPnP / NAT-PMP (never asks the router to open a port); uTP off (TCP peers are plenty and need no
  // native addon); local discovery off while bound (it's multicast, which can't be pinned to an address).
  // secure: 0 = plain, 1 = encrypt when the other side can, 2 = encrypted connections only (BitTorrent's RC4 standard).
  client = new WebTorrent({ natUpnp: false, natPmp: false, utp: false, lsd: !bound, secure: cfg.secure ?? 1 });
  client.on('error', (e) => log('client', e.message));
  server = client.createServer({ pathname: '/t-' + crypto.randomBytes(12).toString('hex') }, 'node');
  await new Promise((resolve, reject) => { server.server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  state = 'ready';
  log(`ready${bound ? ' · bound to the chosen adapter' : ''}`);
  send({ event: 'ready', ...view() });
  return view();
}

// Every 10 s: did the bound interface change its address, or come (back) up?
setInterval(() => {
  if (!cfg.iface) return;
  const now = addressOf(cfg.iface);
  if (state === 'ready' && now !== bound) { log(`"${cfg.iface}" changed its address`); bringUp().catch((e) => log('rebind', e.message)); }
  else if (state === 'waiting' && now) bringUp().catch((e) => log('rebind', e.message));
}, 10000).unref();

const describe = (t) => ({
  infoHash: t.infoHash, name: t.name, length: t.length, torrentFile: Buffer.from(t.torrentFile).toString('base64'),
  files: t.files.map((f, index) => ({ index, path: f.path, name: f.name, length: f.length, url: base + f.streamURL })).filter((f) => f.length >= MIN_FILE),
});

async function add({ src, b64, deselect }) {
  if (state !== 'ready') throw new Error(cfg.iface ? `Torrents are waiting for “${cfg.iface}” to come up — it has no address right now` : 'Torrents are not running');
  let id = b64 ? Buffer.from(b64, 'base64') : src;
  if (typeof id === 'string' && /^https?:/i.test(id)) {
    // Fetched here, so it goes through the bound interface like everything else.
    const r = await fetch(id, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'HomeCable (home media player)', Connection: 'close' } });
    if (!r.ok) throw new Error(`Couldn’t fetch that .torrent (${r.status})`);
    id = Buffer.from(await r.arrayBuffer());
  }
  const { infoHash } = await parseTorrent(id);
  const have = await client.get(infoHash);
  if (have) return describe(have);
  if (inflight.has(infoHash)) return describe(await inflight.get(infoHash));
  const p = (async () => {
    // deselect: nothing downloads until it is asked for (Watch without keeping).
    const t = client.add(id, { path: path.join(cfg.dir, infoHash.slice(0, 16)), strategy: 'sequential', deselect: !!deselect });
    t.on('error', (e) => log('a torrent had an error:', String(e.message).replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '(address)').slice(0, 120)));
    await new Promise((resolve, reject) => {
      if (t.metadata) return resolve();
      const timer = setTimeout(() => { t.destroy(); reject(new Error('Nobody answered for this torrent — is the link right, and does it still have seeds?')); }, METADATA_MS);
      t.once('metadata', () => { clearTimeout(timer); resolve(); });
      t.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
    t.once('done', () => send({ event: 'done', infoHash: t.infoHash, name: t.name, length: t.length }));
    return t;
  })();
  inflight.set(infoHash, p);
  try { return describe(await p); } finally { inflight.delete(infoHash); }
}

const handlers = {
  async init({ dir, iface, secure }) { cfg.dir = dir; cfg.iface = iface || ''; cfg.secure = secure ?? 1; return bringUp(); },
  async setEncryption({ secure }) { cfg.secure = secure ?? 1; return bringUp(); },
  async setInterface({ iface }) { cfg.iface = iface || ''; return bringUp(); },
  add,
  // Which files to download: the rest never are.
  async select({ infoHash, indexes }) {
    const t = client && await client.get(infoHash);
    if (!t) throw new Error('No such torrent');
    const want = new Set(indexes);
    t.files.forEach((f, i) => (want.has(i) ? f.select() : f.deselect()));
    return true;
  },
  // Watching: this file (and the next episode right behind it) downloads first.
  async prioritize({ infoHash, path: p, priority = 1 }) {
    const t = client && await client.get(infoHash);
    const f = t && t.files.find((x) => x.path === p);
    if (!f) return false;
    f.select(priority);
    return true;
  },
  // Drop a torrent from the client — pausing keeps its files, forgetting can delete them.
  async remove({ infoHash, destroyStore = true }) {
    if (client && await client.get(infoHash)) await new Promise((r) => client.remove(infoHash, { destroyStore }, r));
    if (destroyStore) await fs.promises.rm(path.join(cfg.dir, infoHash.slice(0, 16)), { recursive: true, force: true }).catch(() => {});
    return true;
  },
  async status() {
    return { ...view(), torrents: (client?.torrents || []).filter((t) => t.infoHash).map((t) => ({
      infoHash: t.infoHash, name: t.name, progress: t.progress, done: t.done, length: t.length, downloaded: t.downloaded, uploaded: t.uploaded,
      downloadSpeed: t.downloadSpeed, uploadSpeed: t.uploadSpeed, timeRemaining: t.timeRemaining,
      // "peers" are people; a web seed (plain HTTP mirror named in the torrent) is counted separately.
      peers: t.wires.filter((w) => w.type !== 'webSeed').length, encrypted: t.wires.filter((w) => w.type !== 'webSeed' && w._encryptionMethod === 2).length, webSeeds: t.wires.filter((w) => w.type === 'webSeed').length,
      files: t.files.map((f, index) => ({ index, path: f.path, name: f.name, length: f.length, progress: f.progress, downloaded: f.downloaded })),
    })) };
  },
  async close() { await tearDown(); setTimeout(() => process.exit(0), 50); return true; },
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
