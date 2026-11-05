// Keeps picture and sound together on HLS services that send them as separate playlists
// (Pluto TV and others). Each clip or ad restarts both clocks. Read as two ffmpeg inputs, each
// side corrected that jump on its own, so at every clip change they could land a little further
// apart: lips in sync at first, then drifting.
//
// The two playlists do share what's needed to stay exact: a sequence number and one clock per
// clip. So we fetch the matching pieces ourselves, move BOTH onto one continuous clock, and hand
// ffmpeg a single MPEG-TS stream with no jumps in it. Anything unusual → null, and the caller
// falls back to the old way.
const crypto = require('crypto');

const TS = 188;
const WRAP = 2 ** 33;
const SEC = 90000;
const VIDEO_PID = 0x100, AUDIO_PID = 0x101, PMT_PID = 0x1000;
const VIDEO_TYPES = new Set([0x02, 0x1b, 0x24]);
const AUDIO_TYPES = new Set([0x03, 0x04, 0x0f, 0x11]);
const wrapped = (t) => ((t % WRAP) + WRAP) % WRAP;
// a − b, the short way round the clock.
const diff = (a, b) => { const d = wrapped(a - b); return d > WRAP / 2 ? d - WRAP : d; };

const readTime = (b, o) => (b[o] & 0x0e) * 2 ** 29 + (b[o + 1] << 22) + ((b[o + 2] & 0xfe) << 14) + (b[o + 3] << 7) + (b[o + 4] >> 1);
function writeTime(b, o, t) {
  b[o] = (b[o] & 0xf1) | (Math.floor(t / 2 ** 30) & 7) << 1 | 1;
  b[o + 1] = Math.floor(t / 2 ** 22) & 0xff;
  b[o + 2] = (Math.floor(t / 2 ** 15) & 0x7f) << 1 | 1;
  b[o + 3] = Math.floor(t / 2 ** 7) & 0xff;
  b[o + 4] = (t & 0x7f) << 1 | 1;
}

// One piece of MPEG-TS → the one wanted track, as timed units of whole packets.
function readTrack(buf, wanted) {
  const types = wanted === 'video' ? VIDEO_TYPES : AUDIO_TYPES;
  let pmtPid = null, pid = null, type = null;
  const units = [];
  let unit = null;
  for (let i = 0; i + TS <= buf.length; i += TS) {
    if (buf[i] !== 0x47) return null;
    const start = !!(buf[i + 1] & 0x40), p = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2], af = (buf[i + 3] >> 4) & 3;
    let o = i + 4;
    if (af & 2) o += 1 + buf[i + 4];
    if (!(af & 1) || o >= i + TS) { if (p === pid && unit) unit.packets.push(i); continue; }
    if (start && (p === 0 || p === pmtPid)) {
      const s = o + 1 + buf[o]; // past the pointer field
      const end = Math.min(i + TS, s + 3 + (((buf[s + 1] & 0x0f) << 8) | buf[s + 2]) - 4);
      if (p === 0) { if (s + 12 <= i + TS) pmtPid = ((buf[s + 10] & 0x1f) << 8) | buf[s + 11]; continue; }
      let e = s + 12 + (((buf[s + 10] & 0x0f) << 8) | buf[s + 11]);
      while (e + 5 <= end) {
        const st = buf[e], ep = ((buf[e + 1] & 0x1f) << 8) | buf[e + 2];
        if (pid === null && types.has(st)) { pid = ep; type = st; }
        e += 5 + (((buf[e + 3] & 0x0f) << 8) | buf[e + 4]);
      }
      continue;
    }
    if (p !== pid) continue;
    if (start && o + 14 <= i + TS && buf[o] === 0 && buf[o + 1] === 0 && buf[o + 2] === 1 && (buf[o + 7] & 0x80)) {
      const pts = readTime(buf, o + 9);
      const dts = buf[o + 7] & 0x40 && o + 19 <= i + TS ? readTime(buf, o + 14) : pts;
      unit = { pts, dts, packets: [i] };
      units.push(unit);
    } else if (unit) unit.packets.push(i);
  }
  if (pid === null || !units.length) return null;
  const times = units.map((u) => u.pts);
  return { type, units, buf, first: units[0].dts, last: times.reduce((m, t) => (diff(t, m) > 0 ? t : m), times[0]) };
}

function crc32(b) {
  let c = 0xffffffff;
  for (const x of b) { c ^= x << 24; for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1; }
  return c >>> 0;
}
function section(pid, cc, table) {
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(table));
  const out = Buffer.alloc(TS, 0xff);
  out[0] = 0x47; out[1] = 0x40 | (pid >> 8); out[2] = pid & 0xff; out[3] = 0x10 | (cc & 15); out[4] = 0;
  table.copy(out, 5); crc.copy(out, 5 + table.length);
  return out;
}
const pat = (cc) => section(0, cc, Buffer.from([0x00, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xe0 | (PMT_PID >> 8), PMT_PID & 0xff]));
const pmt = (cc, vt, at) => section(PMT_PID, cc, Buffer.from([0x02, 0xb0, 23, 0, 1, 0xc1, 0, 0, 0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 0xff, 0xf0, 0,
  vt, 0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 0xff, 0xf0, 0, at, 0xe0 | (AUDIO_PID >> 8), AUDIO_PID & 0xff, 0xf0, 0]));

// Joins matching pieces onto one clock. Feed it pairs in order; it returns MPEG-TS bytes.
class Joiner {
  constructor() { this.cc = {}; this.clock = SEC; this.off = null; this.lastSeq = null; this.end = null; this.clips = 0; }
  _next(pid) { this.cc[pid] = ((this.cc[pid] ?? -1) + 1) & 15; return this.cc[pid]; }
  // video, audio: from readTrack. newClip: the playlists marked a discontinuity here.
  join(video, audio, seq, newClip = false) {
    const skipped = this.lastSeq !== null && seq !== this.lastSeq + 1;
    // A clock jump the playlists didn't mention counts as a new clip too.
    const jumped = this.end && (Math.abs(diff(video.first, this.end.v)) > 2 * SEC || Math.abs(diff(audio.first, this.end.a)) > 2 * SEC);
    if (!this.off || newClip || skipped || jumped) {
      // Both sides share a clock within a clip, and keep that exact relation. Ones that really
      // are far apart are lined up by where the piece starts.
      const shared = Math.abs(diff(audio.first, video.first)) < 2 * SEC;
      const base = diff(audio.first, video.first) < 0 && shared ? audio.first : video.first;
      const v = this.clock - base;
      this.off = { v, a: shared ? v : this.clock - audio.first };
      this.clips++;
    }
    this.lastSeq = seq;
    const merged = [
      ...video.units.map((u) => ({ u, kind: 'v', at: wrapped(u.dts + this.off.v) })),
      ...audio.units.map((u) => ({ u, kind: 'a', at: wrapped(u.dts + this.off.a) })),
    ].sort((a, b) => diff(a.at, b.at));
    const out = [pat(this._next(0)), pmt(this._next(PMT_PID), video.type, audio.type)];
    for (const { u, kind } of merged) {
      const src = kind === 'v' ? video : audio, off = this.off[kind], pid = kind === 'v' ? VIDEO_PID : AUDIO_PID;
      u.packets.forEach((i, n) => {
        const pk = Buffer.from(src.buf.subarray(i, i + TS));
        const af = (pk[3] >> 4) & 3;
        pk[1] = (pk[1] & 0xe0) | (pid >> 8); pk[2] = pid & 0xff;
        if (af & 1) pk[3] = (pk[3] & 0xf0) | this._next(pid);
        let o = 4;
        if (af & 2) {
          const len = pk[4];
          if (len > 0 && pk[5] & 0x10) {
            if (kind === 'v') { // the timing reference moves with the picture
              const base = wrapped(pk[6] * 2 ** 25 + (pk[7] << 17) + (pk[8] << 9) + (pk[9] << 1) + (pk[10] >> 7) + off);
              pk[6] = Math.floor(base / 2 ** 25) & 0xff; pk[7] = Math.floor(base / 2 ** 17) & 0xff; pk[8] = Math.floor(base / 2 ** 9) & 0xff; pk[9] = Math.floor(base / 2) & 0xff;
              pk[10] = (pk[10] & 0x7f) | ((base & 1) << 7);
            } else pk[5] &= ~0x10; // only the picture carries it
          }
          o = 5 + len;
        }
        if (n === 0 && pk[1] & 0x40 && o + 14 <= TS) {
          writeTime(pk, o + 9, wrapped(u.pts + off));
          if (pk[o + 7] & 0x40 && o + 19 <= TS) writeTime(pk, o + 14, wrapped(u.dts + off));
        }
        out.push(pk);
      });
    }
    // The next clip starts after whichever side ran longer, so neither overlaps.
    const step = (t) => { const a = t.units; return a.length > 1 ? Math.max(1, Math.abs(diff(a[a.length - 1].pts, a[a.length - 2].pts))) : 3000; };
    this.end = { v: wrapped(video.last + step(video)), a: wrapped(audio.last + step(audio)) };
    const nv = wrapped(this.end.v + this.off.v), na = wrapped(this.end.a + this.off.a);
    this.clock = diff(nv, na) > 0 ? nv : na;
    return Buffer.concat(out);
  }
}

function parsePlaylist(text) {
  let seq = +(text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1] || 0;
  let key = null, clip = false;
  const segments = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (l.startsWith('#EXT-X-DISCONTINUITY') && !l.includes('SEQUENCE')) clip = true;
    else if (l.startsWith('#EXT-X-KEY')) {
      const method = (l.match(/METHOD=([\w-]+)/) || [])[1];
      key = !method || method === 'NONE' ? null : { method, uri: (l.match(/URI="([^"]+)"/) || [])[1], iv: (l.match(/IV=0x([0-9a-f]+)/i) || [])[1] };
    } else if (l && !l.startsWith('#')) { segments.push({ seq, url: l, key, clip }); seq++; clip = false; }
  }
  return {
    segments, ended: /#EXT-X-ENDLIST/.test(text),
    plain: !/#EXT-X-MAP/.test(text) && segments.every((s) => !s.key || s.key.method === 'AES-128'),
    target: +(text.match(/#EXT-X-TARGETDURATION:(\d+)/) || [])[1] || 5,
  };
}

// Returns a started feed, or null when this stream isn't one we can join (the caller falls back).
async function openPair(st, hls, { log = () => {}, startBack = 3, fetch: get = fetch } = {}) {
  const headers = { 'User-Agent': st.userAgent || 'Mozilla/5.0 HomeCable' };
  if (st.referer) headers.Referer = st.referer;
  const ask = async (url, ms) => {
    const r = await get(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(ms) });
    if (!r.ok) throw new Error('answered ' + r.status);
    return r;
  };
  const list = async (url) => { const r = await ask(url, 10000); return { ...parsePlaylist(await r.text()), base: r.url || url }; };
  const keys = new Map();
  const piece = async (s, base, wanted) => {
    let body = Buffer.from(await (await ask(new URL(s.url, base).href, 20000)).arrayBuffer());
    if (s.key) {
      const uri = new URL(s.key.uri, base).href;
      if (!keys.has(uri)) { if (keys.size > 32) keys.clear(); keys.set(uri, Buffer.from(await (await ask(uri, 10000)).arrayBuffer())); }
      const iv = Buffer.alloc(16);
      if (s.key.iv) Buffer.from(s.key.iv.padStart(32, '0'), 'hex').copy(iv); else iv.writeUInt32BE(s.seq, 12);
      const d = crypto.createDecipheriv('aes-128-cbc', keys.get(uri), iv);
      body = Buffer.concat([d.update(body), d.final()]);
    }
    const t = readTrack(body, wanted);
    if (!t) throw new Error('unreadable ' + wanted);
    return t;
  };
  const both = async (v, a, vb, ab) => {
    const [video, audio] = await Promise.all([piece(v, vb, 'video'), piece(a, ab, 'audio')]);
    return { video, audio };
  };

  let v, a, first;
  try {
    [v, a] = await Promise.all([list(hls.video), list(hls.audio)]);
    if (!v.plain || !a.plain || !v.segments.length) return null;
    const am = new Map(a.segments.map((s) => [s.seq, s]));
    const common = v.segments.filter((s) => am.has(s.seq));
    if (!common.length) return null;
    // The same clip boundaries on both sides, or they aren't really paired.
    if (common.some((s) => s.clip !== am.get(s.seq).clip)) return null;
    first = common[Math.max(0, common.length - startBack)];
    var firstPair = await both(first, am.get(first.seq), v.base, a.base);
  } catch (e) { log('paired stream: can’t join (' + e.message + ')'); return null; }

  let stopped = false, wake = null;
  const stop = () => { stopped = true; if (wake) wake(); };
  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; });

  // Runs until the stream ends or nobody's watching. `onEnd` lets the player reconnect as usual.
  const pipeTo = async (out, onEnd = () => {}) => {
    const joiner = new Joiner();
    const write = (b) => new Promise((res) => {
      if (stopped || out.destroyed) return res();
      if (out.write(b)) return res();
      const go = () => { out.off('drain', go); out.off('close', go); wake = null; res(); };
      out.once('drain', go); out.once('close', go);
      wake = go;
    });
    let next = first.seq, idle = Date.now();
    await write(joiner.join(firstPair.video, firstPair.audio, first.seq, false));
    firstPair = null;
    next++;
    try {
      while (!stopped) {
        const am = new Map(a.segments.map((s) => [s.seq, s]));
        const todo = v.segments.filter((s) => s.seq >= next && am.has(s.seq));
        for (const s of todo) {
          if (stopped) break;
          let pair = null;
          for (let tries = 0; tries < 3 && !pair && !stopped; tries++) {
            try { pair = await both(s, am.get(s.seq), v.base, a.base); } catch (e) { if (tries === 2) log(`paired stream: piece ${s.seq} lost (${e.message})`); else await sleep(400); }
          }
          next = s.seq + 1;
          if (!pair) continue; // the join notices the gap and carries on from the next piece
          await write(joiner.join(pair.video, pair.audio, s.seq, s.clip));
          idle = Date.now();
        }
        if (stopped) break;
        if (v.ended && a.ended && next > (v.segments.at(-1)?.seq ?? 0)) break;
        if (Date.now() - idle > 30000) { log('paired stream: nothing new for 30 s'); break; }
        await sleep(Math.max(1000, (v.target * 1000) / 2));
        if (stopped) break;
        try { [v, a] = await Promise.all([list(hls.video), list(hls.audio)]); } catch (e) { log('paired stream: playlist (' + e.message + ')'); }
      }
    } catch (e) { log('paired stream stopped: ' + e.message); }
    onEnd(joiner);
  };
  return { pipeTo, stop };
}

module.exports = { openPair, Joiner, readTrack, parsePlaylist };
