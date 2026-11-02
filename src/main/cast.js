// Chromecast / Google Cast support: find Cast devices on the network (mDNS) and
// drive the TV's built-in Default Media Receiver over the Cast v2 protocol
// (TLS on port 8009, length-prefixed protobuf "CastMessage" envelopes carrying
// JSON). Hand-written so HomeCable needs no extra dependencies.
const tls = require('tls');
const os = require('os');
const { EventEmitter } = require('events');

const DEFAULT_RECEIVER = 'CC1AD845'; // Google's Default Media Receiver
const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
};

// ---------- CastMessage protobuf (only the fields Cast uses) ----------
//   1 protocol_version (varint, 0 = CASTV2_1_0)  2 source_id  3 destination_id
//   4 namespace  5 payload_type (varint, 0 = STRING)  6 payload_utf8  7 payload_binary
function varint(n) {
  const out = [];
  while (n > 127) { out.push((n & 127) | 128); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
}
function field(tag, str) { const b = Buffer.from(str, 'utf8'); return Buffer.concat([Buffer.from([tag]), varint(b.length), b]); }
function encode({ source, destination, namespace, data }) {
  const body = Buffer.concat([
    Buffer.from([0x08, 0]), field(0x12, source), field(0x1a, destination), field(0x22, namespace),
    Buffer.from([0x28, 0]), field(0x32, JSON.stringify(data)),
  ]);
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
}
function decode(buf) {
  const msg = {};
  let i = 0;
  const readVarint = () => { let n = 0, shift = 0, b; do { b = buf[i++]; n |= (b & 127) << shift; shift += 7; } while (b & 128); return n >>> 0; };
  while (i < buf.length) {
    const key = readVarint(), fieldNo = key >> 3, wire = key & 7;
    if (wire === 0) { const v = readVarint(); if (fieldNo === 5) msg.payloadType = v; continue; }
    if (wire !== 2) break;
    const len = readVarint(), val = buf.subarray(i, i + len); i += len;
    if (fieldNo === 2) msg.source = val.toString();
    else if (fieldNo === 3) msg.destination = val.toString();
    else if (fieldNo === 4) msg.namespace = val.toString();
    else if (fieldNo === 6) msg.payload = val.toString();
  }
  try { msg.data = JSON.parse(msg.payload || 'null'); } catch { msg.data = null; }
  return msg;
}

// ---------- discovery ----------
// mDNS on every network adapter. With a VPN installed (Radmin, Tailscale, …) Windows
// may send a plain multicast query out of the VPN instead of the home network, and
// the TV never hears it — so ask on each adapter's own address.
function mdnsEverywhere() {
  const mdns = require('multicast-dns');
  const addrs = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) addrs.push(a.address);
  const socks = [];
  for (const ip of addrs.length ? addrs : [undefined]) { try { socks.push(mdns(ip ? { interface: ip } : {})); } catch {} }
  return {
    on(ev, fn) { for (const m of socks) m.on(ev, fn); },
    query(q) { for (const m of socks) { try { m.query(q); } catch {} } },
    destroy() { for (const m of socks) { try { m.destroy(); } catch {} } },
  };
}

function discover(timeout = 3500) {
  return new Promise((resolve) => {
    let m;
    try { m = mdnsEverywhere(); } catch { return resolve([]); }
    const services = new Map(), hosts = new Map();
    m.on('response', (res) => {
      for (const r of [...res.answers, ...(res.additionals || [])]) {
        if (r.type === 'A') hosts.set(r.name, r.data);
        if (!/_googlecast\._tcp/.test(r.name)) continue;
        const s = services.get(r.name) || {};
        if (r.type === 'SRV') { s.port = r.data.port; s.target = r.data.target; }
        if (r.type === 'TXT') {
          const txt = Object.fromEntries([].concat(r.data).map(String).map((kv) => [kv.split('=')[0], kv.slice(kv.indexOf('=') + 1)]));
          s.id = txt.id; s.name = txt.fn; s.model = txt.md;
        }
        services.set(r.name, s);
      }
    });
    m.on('error', () => {});
    const ask = () => { try { m.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] }); } catch {} };
    ask(); const again = setTimeout(ask, 1200);
    setTimeout(() => {
      clearTimeout(again);
      try { m.destroy(); } catch {}
      const out = [];
      for (const s of services.values()) {
        const host = hosts.get(s.target);
        if (s.id && host && !out.some((d) => d.id === s.id)) out.push({ id: s.id, name: s.name || 'Chromecast', model: s.model || '', host, port: s.port || 8009 });
      }
      resolve(out.sort((a, b) => a.name.localeCompare(b.name)));
    }, timeout);
  });
}

// This PC's address on the same network as the Cast device (that's where the TV fetches video from).
function localAddressFor(deviceIp) {
  const toInt = (ip) => ip.split('.').reduce((n, p) => (n << 8) + (+p), 0) >>> 0;
  const target = toInt(deviceIp);
  let fallback = null;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      const mask = toInt(a.netmask);
      if (((toInt(a.address) & mask) >>> 0) === ((target & mask) >>> 0)) return a.address;
      if (!fallback && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(a.address)) fallback = a.address;
    }
  }
  return fallback;
}

// ---------- a session with one Cast device ----------
class CastSession extends EventEmitter {
  constructor(device) {
    super();
    this.device = device;
    this.reqId = 1;
    this.pending = new Map();
    this.transportId = null;
    this.appSessionId = null;
    this.mediaSessionId = null;
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      // Cast devices use self-signed certificates; the connection is still encrypted.
      const sock = tls.connect({ host: this.device.host, port: this.device.port, rejectUnauthorized: false });
      this.sock = sock;
      let buf = Buffer.alloc(0);
      const fail = (err) => { reject(err); this.close('error'); };
      sock.setTimeout(10000, () => fail(new Error('The TV didn’t answer')));
      sock.once('secureConnect', () => {
        sock.setTimeout(0);
        this.send(NS.connection, { type: 'CONNECT' });
        this.ping = setInterval(() => this.send(NS.heartbeat, { type: 'PING' }), 5000);
        resolve();
      });
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 4) {
          const len = buf.readUInt32BE(0);
          if (buf.length < 4 + len) break;
          this.onMessage(decode(buf.subarray(4, 4 + len)));
          buf = buf.subarray(4 + len);
        }
      });
      sock.on('error', (e) => { if (!this.closed) fail(e); });
      sock.on('close', () => this.close('disconnected'));
    });
  }

  send(namespace, data, destination = 'receiver-0') {
    if (this.closed || !this.sock) return;
    this.sock.write(encode({ source: 'sender-0', destination, namespace, data }));
  }

  request(namespace, data, destination, timeout = 15000) {
    const requestId = this.reqId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(requestId); reject(new Error('The TV didn’t answer')); }, timeout);
      this.pending.set(requestId, (d) => { clearTimeout(t); resolve(d); });
      this.send(namespace, { ...data, requestId }, destination);
    });
  }

  onMessage(msg) {
    const d = msg.data;
    if (!d) return;
    if (msg.namespace === NS.heartbeat && d.type === 'PING') return this.send(NS.heartbeat, { type: 'PONG' }, msg.source);
    if (msg.namespace === NS.connection && d.type === 'CLOSE' && msg.source === this.transportId) return this.close('stopped');
    if (d.requestId && this.pending.has(d.requestId)) { this.pending.get(d.requestId)(d); this.pending.delete(d.requestId); }
    if (msg.namespace === NS.receiver && d.type === 'RECEIVER_STATUS') {
      this.emit('receiver', d.status);
      // Someone started another app on the TV (or pressed stop): our session is over.
      const apps = d.status?.applications || [];
      if (this.appSessionId && !apps.some((a) => a.sessionId === this.appSessionId)) this.close('stopped');
    }
    if (msg.namespace === NS.media && d.type === 'MEDIA_STATUS') {
      const st = d.status?.[0];
      if (st) { this.mediaSessionId = st.mediaSessionId; this.emit('media', st); }
      else this.emit('media', { playerState: 'IDLE', idleReason: 'NONE' });
    }
  }

  async launch() {
    const r = await this.request(NS.receiver, { type: 'LAUNCH', appId: DEFAULT_RECEIVER });
    if (r.type !== 'RECEIVER_STATUS') throw new Error('The TV wouldn’t start playback (' + (r.reason || r.type) + ')');
    const app = (r.status?.applications || []).find((a) => a.appId === DEFAULT_RECEIVER);
    if (!app) throw new Error('The TV wouldn’t start playback');
    this.transportId = app.transportId;
    this.appSessionId = app.sessionId;
    this.send(NS.connection, { type: 'CONNECT' }, this.transportId);
    this.volumeBefore = r.status?.volume || null;
  }

  async load({ url, contentType, live, startAt = 0, title, subtitle, image, music }) {
    const media = {
      contentId: url, contentType, streamType: live ? 'LIVE' : 'BUFFERED',
      metadata: music ? { metadataType: 3, title, artist: subtitle || '' } : { metadataType: 0, title, subtitle: subtitle || '' },
    };
    if (image) media.metadata.images = [{ url: image }];
    const r = await this.request(NS.media, { type: 'LOAD', media, autoplay: true, currentTime: Math.max(0, startAt) }, this.transportId, 45000);
    if (r.type !== 'MEDIA_STATUS') throw Object.assign(new Error('The TV couldn’t play this (' + (r.detailedErrorCode || r.reason || r.type) + ')'), { castError: r.type });
    return r.status?.[0] || null;
  }

  control(type, extra = {}) {
    if (!this.mediaSessionId) return;
    this.send(NS.media, { type, mediaSessionId: this.mediaSessionId, requestId: this.reqId++, ...extra }, this.transportId);
  }
  play() { this.control('PLAY'); }
  pause() { this.control('PAUSE'); }
  seek(t) { this.control('SEEK', { currentTime: Math.max(0, t), resumeState: 'PLAYBACK_START' }); }
  status() { if (this.transportId) this.send(NS.media, { type: 'GET_STATUS', requestId: this.reqId++ }, this.transportId); }
  setVolume(v) { this.send(NS.receiver, { type: 'SET_VOLUME', volume: v, requestId: this.reqId++ }); }

  async stop() {
    try { if (this.appSessionId) await this.request(NS.receiver, { type: 'STOP', sessionId: this.appSessionId }, 'receiver-0', 4000); } catch {}
    this.close('stopped');
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ping);
    try { this.sock?.destroy(); } catch {}
    this.emit('closed', reason);
  }
}

// What the TV's built-in player can take as-is. Everything else is converted
// on this PC (remux = repackage only; transcode = re-encode H.264/AAC).
const CAST_CONTAINER = /^(mov|mp4|m4a|3gp|webm|mp3|ogg|flac|wav|aac)/;
const CAST_VIDEO = new Set(['h264', 'vp8', 'vp9']);
const CAST_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
function castMode(item) {
  const pc = item.forceMode || item.mode;
  if (pc === 'transcode') return 'transcode';
  const v = item.kind === 'music' ? null : item.vcodec;
  const videoOk = !v || CAST_VIDEO.has(v);
  if (!videoOk) return v === 'h264' ? 'remux' : 'transcode';
  const containerOk = CAST_CONTAINER.test(item.container || '') && !/matroska/.test(item.container || '');
  const audioOk = !item.acodec || CAST_AUDIO.has(item.acodec);
  if (pc === 'direct' && containerOk && audioOk) return 'direct';
  return v && v !== 'h264' ? 'transcode' : 'remux';
}

// A pretend TV for automated tests (HOMECABLE_FAKE_TV): answers like a cast session
// without any network — it plays, pauses, seeks and ticks time forward.
class FakeSession extends EventEmitter {
  constructor() { super(); this.pos = 0; this.playing = false; }
  async connect() {}
  async launch() {}
  _st(state) { this.emit('media', { playerState: state, currentTime: this.pos, mediaSessionId: 1 }); }
  async load({ startAt = 0 } = {}) { this.pos = startAt || 0; this.playing = true; clearInterval(this._t); this._t = setInterval(() => { if (this.playing) { this.pos += 1; this._st('PLAYING'); } }, 1000); this._st('PLAYING'); return { mediaSessionId: 1 }; }
  play() { this.playing = true; this._st('PLAYING'); }
  pause() { this.playing = false; this._st('PAUSED'); }
  seek(t) { this.pos = Math.max(0, +t || 0); this._st(this.playing ? 'PLAYING' : 'PAUSED'); }
  setVolume() {}
  status() { this._st(this.playing ? 'PLAYING' : 'PAUSED'); }
  async stop() { clearInterval(this._t); this.emit('closed', 'stopped'); }
}

module.exports = { discover, CastSession, FakeSession, castMode, localAddressFor, encode, decode, mdnsEverywhere };
