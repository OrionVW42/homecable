// The phone app: pair with a QR code, then the phone watches from this PC (or works as
// its remote). Nothing is copied to the phone — it streams over the home network, or
// from anywhere through a VPN like Radmin or Tailscale (nothing is opened to the internet).
//
// Security: the listener only runs while "Phone app" is on. Pairing needs a 6-digit code
// that exists only while the pairing screen is open on the PC (10 minutes, 10 tries a
// minute). Each phone then gets its own long random key (only a hash is stored); forget
// a phone in Settings and its key stops working. The locked section stays off phones unless
// its "Also on paired phones" switch is on — grown-up phones only, password every time.
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const DEFAULT_PORT = 47800;

// This PC's addresses a phone could reach: home network first, then VPNs (Radmin, Tailscale).
function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const ip = a.address;
      const kind = /^26\./.test(ip) ? 'radmin' : /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) ? 'tailscale' : /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ? 'home' : 'other';
      if (/vEthernet|VirtualBox|VMware|WSL|Hyper-V/i.test(name)) continue;
      out.push({ ip, kind, name });
    }
  }
  const rank = { home: 0, radmin: 1, tailscale: 2, other: 3 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

function createPhone({ settings, saveSettings, media, call, send, log, profiles, isDenied, allowedIdsFor = () => null, filesRoot, nodeModules, pcName }) {
  const cfg = () => (settings.phone ||= { enabled: false, port: DEFAULT_PORT, devices: [] });
  let pairing = null; // { code, until }
  let tries = [];
  let now = null; // what the PC is showing (pushed by the window every couple of seconds)
  const seen = new Map();
  // The locked section, per phone: open after its password, for 20 minutes of use at most idle.
  const unlocked = new Map();
  const vaultOpenFor = (dev) => { const u = unlocked.get(dev?.id) || 0; if (u > Date.now()) { unlocked.set(dev.id, Date.now() + 20 * 60e3); return true; } unlocked.delete(dev?.id); return false; };
  const lockedItem = (it) => !!it && isDenied(it); // a locked-section video (isDenied: not on phones by default)
  // What a phone may not have: locked videos (unless this grown-up phone unlocked them),
  // and — for a kids/teens phone — anything that isn't on the channels its level can see.
  const deniedFor = (it, dev) => {
    if (!it) return true;
    if (lockedItem(it)) return !(dev && dev.level === 'adults' && vaultOpenFor(dev));
    const allow = dev && allowedIdsFor(dev.level);
    return !!allow && !allow.has(it.id);
  };

  const deviceFor = (key) => {
    if (!key || key.length < 32) return null;
    const h = sha(key);
    const d = cfg().devices.find((x) => x.hash === h);
    if (d && Date.now() - (seen.get(d.id) || 0) > 60e3) { seen.set(d.id, Date.now()); d.lastSeen = Date.now(); saveSettings(); }
    return d || null;
  };

  // Static files: the phone screens, plus the two small libraries they use.
  const VENDOR = { 'vendor/preact.mjs': 'preact/dist/preact.mjs', 'vendor/hooks.mjs': 'preact/hooks/dist/hooks.mjs', 'vendor/htm.mjs': 'htm/dist/htm.module.js', 'vendor/htm-preact.mjs': 'htm/preact/index.module.js' };
  const files = (rel) => {
    if (VENDOR[rel]) return path.join(nodeModules, VENDOR[rel]);
    if (rel === 'icon.svg') return path.join(filesRoot, '..', '..', 'assets', 'icon.svg'); // the same logo as the PC app
    const f = path.resolve(filesRoot, rel);
    return f.startsWith(path.resolve(filesRoot) + path.sep) ? f : null;
  };

  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const body = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 64e3) req.destroy(); }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { ok({}); } }); });

  // Every 127.0.0.1 media link in an answer becomes a path the phone can fetch with its key.
  const relink = (obj, key) => {
    if (typeof obj === 'string') return obj.startsWith(media.base) ? media.phonePath(obj, key) : obj;
    if (Array.isArray(obj)) return obj.map((x) => relink(x, key));
    if (obj && typeof obj === 'object') { const o = {}; for (const [k, v] of Object.entries(obj)) o[k] = relink(v, key); return o; }
    return obj;
  };
  // What this phone may see: its profile's channels, never the locked section.
  const { ALLOWS } = require('./profiles');
  const okChannel = (dev, c) => c && !c.locked && (ALLOWS[dev.level] || ALLOWS.adults).includes(c.rating || 'all');

  async function api(req, res, url) {
    const p = url.pathname.replace(/^\/api\/?/, '');
    if (p === 'hello') return json(res, 200, { app: 'HomeCable', name: pcName() });
    if (p === 'pair' && req.method === 'POST') {
      const b = await body(req);
      tries = tries.filter((t) => Date.now() - t < 60e3);
      if (tries.length >= 10) return json(res, 429, { error: 'Too many tries — wait a minute' });
      tries.push(Date.now());
      if (!pairing || Date.now() > pairing.until || String(b.code || '') !== pairing.code) return json(res, 403, { error: 'That code isn’t right — open Settings → Phone app on the PC and scan again' });
      const key = crypto.randomBytes(32).toString('hex');
      const dev = { id: crypto.randomUUID(), name: String(b.name || 'Phone').slice(0, 40), hash: sha(key), level: profiles.current?.level || 'adults', added: Date.now(), lastSeen: Date.now() };
      cfg().devices.push(dev);
      saveSettings();
      pairing = null;
      send('phone-paired', { name: dev.name });
      log('phone paired:', dev.name);
      return json(res, 200, { key, id: dev.id, pc: pcName() });
    }
    const key = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('k');
    const dev = deviceFor(key);
    if (!dev) return json(res, 401, { error: 'This phone isn’t paired any more — scan the QR code again' });
    const q = (n) => url.searchParams.get(n);
    const out = (obj) => json(res, 200, relink(obj, key));
    // Locked-section lists: their pictures are never kept in the phone's cache.
    const outPrivate = (obj) => json(res, 200, JSON.parse(JSON.stringify(relink(obj, key)).replace(/(\/(?:art|thumb|frame)\/[^"?]+\?k=[0-9a-f]+)/g, '$1&p=1')));

    switch (p) {
      case 'state': {
        const st = await call('state');
        const chans = st.channels.filter((c) => okChannel(dev, c) && !c.iptv?.dead);
        const vinfo = dev.level === 'adults' ? await call('vault:phoneInfo') : null;
        return out({ pc: pcName(), device: { id: dev.id, name: dev.name }, vault: vinfo ? { name: vinfo.name, open: vaultOpenFor(dev) } : null, cast: st.cast || { on: false }, channels: chans.map(({ id, number, name, logo, color, ondemand, odStyle, iptv }) => ({ id, number, name, logo, color, ondemand: !!ondemand, odStyle: odStyle || null, live: !!iptv })),
          settings: { subLang: settings.subLang || 'eng', subMode: settings.subMode || 'auto', audioPref: settings.audioPref || 'orig' }, now });
      }
      case 'guide': {
        const ok = new Set((await call('state')).channels.filter((c) => okChannel(dev, c)).map((c) => c.id));
        const g = await call('guide', +q('from') || Date.now(), +q('to') || Date.now() + 3 * 3600e3);
        return out(g.filter((row) => ok.has(row.id)));
      }
      case 'genres': {
        // Every genre the guide knows (for the remote's dropdown) and which
        // channels carry each one (for the phone's own guide filter).
        const map = await call('channels:genres');
        return out({ all: [...new Set(Object.values(map).flat())].sort(), map });
      }
      case 'tune': {
        const ch = (await call('state')).channels.find((c) => c.id === q('id'));
        if (!okChannel(dev, ch)) return json(res, 404, { error: 'No such channel' });
        return out(await call('tune:phone', q('id')));
      }
      case 'vault/unlock': {
        if (req.method !== 'POST' || dev.level !== 'adults' || !(await call('vault:phoneInfo'))) return json(res, 404, { error: 'Not here' });
        const b = await body(req);
        const r = await call('vault:check', String(b.password || ''));
        if (r.ok) unlocked.set(dev.id, Date.now() + 20 * 60e3);
        return json(res, 200, { ok: !!r.ok, wait: r.wait || 0 });
      }
      case 'vault/lock': unlocked.delete(dev.id); return json(res, 200, { ok: true });
      case 'vault/list': {
        if (!vaultOpenFor(dev) || dev.level !== 'adults' || !(await call('vault:phoneInfo'))) return json(res, 403, { error: 'Locked' });
        if (q('refresh')) await call('vault:phoneRefresh');
        return outPrivate(await call('vault:phoneList'));
      }
      case 'ondemand': {
        const ch = (await call('state')).channels.find((c) => c.id === q('id'));
        if (!okChannel(dev, ch) || !ch.ondemand) return json(res, 404, { error: 'No such screen' });
        if (q('refresh')) await call('ondemand:refresh', ch.id);
        return out(await call('ondemand:list', ch.id));
      }
      case 'vod': {
        const it = media.item(q('id'));
        if (deniedFor(it, dev)) return json(res, 404, { error: 'Not found' });
        return out(await call('vod:play', q('id'), +q('t') || 0, { phone: true, vaultOk: lockedItem(it) }));
      }
      case 'subs': {
        const it = media.item(q('id'));
        if (deniedFor(it, dev)) return json(res, 404, { error: 'Not found' });
        return out(await call('subs:list', q('id')));
      }
      case 'subsurl': if (deniedFor(media.item(q('id')), dev)) return json(res, 404, { error: 'Not found' }); return out({ url: await call('subs:url', q('id'), q('s'), +q('t') || 0) });
      case 'alt': if (deniedFor(media.item(q('id')), dev)) return json(res, 404, { error: 'Not found' }); return out({ url: await call('vod:altUrl', q('id'), { burn: q('burn') || null, audio: +q('audio') || 0, t: +q('t') || 0, phone: true }) });
      case 'progress': {
        if (req.method !== 'POST') break;
        const b = await body(req);
        const it = media.item(b.id);
        if (deniedFor(it, dev)) return json(res, 404, { error: 'Not found' });
        await call('progress:save', b);
        return json(res, 200, { ok: true });
      }
      case 'now': {
        // What the PC is showing — but a locked video's name and picture stay off this phone.
        let n = now;
        if (n?.itemId && deniedFor(media.item(n.itemId), dev)) n = { ...n, title: 'Playing on the PC', sub: '', art: null, av: null, itemId: null };
        return out({ now: n, cast: await call('cast:state') });
      }
      case 'cast/stop': {
        // The remote's "stop casting": the picture comes back to the PC's own screen.
        if (req.method !== 'POST') break;
        await call('cast:stop');
        return json(res, 200, { ok: true });
      }
      case 'tvs': return json(res, 200, { tvs: (await call('cast:devices')).map((d) => ({ id: d.id, name: d.name })) });
      case 'cast': {
        // Play something on a TV: this PC starts casting, then plays it (never the locked section).
        if (req.method !== 'POST') break;
        const b = await body(req);
        if (!b.deviceId) return json(res, 400, { error: 'Which TV?' });
        if (b.play?.itemId) { const it = media.item(b.play.itemId); if (!it || lockedItem(it) || isDenied(it)) return json(res, 404, { error: 'Not found' }); }
        if (b.play?.channelId) { const ch = (await call('state')).channels.find((c) => c.id === b.play.channelId); if (!okChannel(dev, ch)) return json(res, 404, { error: 'No such channel' }); }
        await call('cast:start', String(b.deviceId), 'media');
        await new Promise((r) => setTimeout(r, 400));
        if (b.play) send('remote', { play: b.play, from: dev.name });
        return json(res, 200, { ok: true });
      }
      case 'remote': {
        if (req.method !== 'POST') break;
        const b = await body(req);
        if (b.play) {
          const ch = (await call('state')).channels.find((c) => c.id === b.play.channelId);
          if (b.play.channelId && !okChannel(dev, ch)) return json(res, 404, { error: 'No such channel' });
          if (b.play.itemId && isDenied(media.item(b.play.itemId))) return json(res, 404, { error: 'Not found' });
        }
        // Audio / subtitle picks from the phone's own CC menu (applied by the PC's player).
        const av = b.av && typeof b.av === 'object' ? { ...(typeof b.av.audio === 'number' ? { audio: b.av.audio } : {}), ...('sub' in b.av ? { sub: b.av.sub == null ? null : String(b.av.sub) } : {}) } : null;
        // Guide search / genre typed on the phone: opens and filters the guide on
        // the screen being watched; picking something clears it back to normal.
        const guide = b.guide && typeof b.guide === 'object'
          ? { ...('q' in b.guide ? { q: String(b.guide.q ?? '').slice(0, 80) } : {}), ...('genre' in b.guide ? { genre: String(b.guide.genre ?? '').slice(0, 40) } : {}) } : null;
        send('remote', { button: b.button || null, key: b.key || null, play: b.play || null, av: av && Object.keys(av).length ? av : null, guide: guide && Object.keys(guide).length ? guide : null, from: dev.name });
        return json(res, 200, { ok: true });
      }
    }
    return json(res, 404, { error: 'Unknown' });
  }

  async function enable(on) {
    const c = cfg();
    c.enabled = !!on;
    saveSettings();
    if (!on) { media.closePhone(); pairing = null; return view(); }
    let port = c.port || DEFAULT_PORT;
    for (let i = 0; i < 10; i++) {
      try { await media.openPhone(port, { deviceFor, api, files, deny: deniedFor }); break; }
      catch (e) { if (e.code !== 'EADDRINUSE' || i === 9) { log('phone listener', e.message); c.enabled = false; saveSettings(); throw new Error('Couldn’t start the phone connection'); } port++; }
    }
    if (c.port !== port) { c.port = port; saveSettings(); }
    log('phone app listening on port', port);
    return view();
  }
  const view = () => {
    const c = cfg();
    return { enabled: !!c.enabled && !!media.phonePort(), port: media.phonePort() || c.port, addresses: addresses(), pairing: pairing && Date.now() < pairing.until ? { code: pairing.code, until: pairing.until } : null,
      devices: c.devices.map(({ id, name, added, lastSeen, level }) => ({ id, name, added, lastSeen, level })) };
  };
  async function pairStart() {
    if (!media.phonePort()) await enable(true);
    pairing = { code: String(crypto.randomInt(0, 1e6)).padStart(6, '0'), until: Date.now() + 10 * 60e3 };
    const v = view();
    const hosts = v.addresses.map((a) => a.ip);
    const link = `homecable://pair?v=1&p=${v.port}&c=${pairing.code}&n=${encodeURIComponent(pcName())}&h=${hosts.join(',')}`;
    const qr = await require('qrcode').toDataURL(link, { margin: 1, width: 360, errorCorrectionLevel: 'M' });
    return { ...v, link, qr };
  }
  const pairStop = () => { pairing = null; return view(); };
  const forget = (id) => { const c = cfg(); c.devices = c.devices.filter((d) => d.id !== id); unlocked.delete(id); saveSettings(); return view(); };
  // Whose phone it is: a kid's or teen's phone only gets what its channels allow (and never the locked section).
  const setLevel = (id, level) => { const d = cfg().devices.find((x) => x.id === id); if (d && ['adults', 'teens', 'kids'].includes(level)) { d.level = level; if (level !== 'adults') unlocked.delete(id); saveSettings(); } return view(); };
  const setNow = (n) => { now = n ? { ...n, at: Date.now() } : null; };

  return { enable, view, pairStart, pairStop, forget, setLevel, setNow, addresses };
}

module.exports = { createPhone, addresses, DEFAULT_PORT };
