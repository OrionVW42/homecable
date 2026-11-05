// Joining separate picture and sound playlists onto one clock. Built from made-up MPEG-TS, no media.
const test = require('node:test');
const assert = require('node:assert');
const { Joiner, readTrack, parsePlaylist } = require('../src/main/hlsPair');

const TS = 188;
const putTime = (b, o, t, tag) => {
  b[o] = (tag << 4) | (Math.floor(t / 2 ** 30) & 7) << 1 | 1;
  b[o + 1] = Math.floor(t / 2 ** 22) & 0xff;
  b[o + 2] = (Math.floor(t / 2 ** 15) & 0x7f) << 1 | 1;
  b[o + 3] = Math.floor(t / 2 ** 7) & 0xff;
  b[o + 4] = (t & 0x7f) << 1 | 1;
};
const getTime = (b, o) => (b[o] & 0x0e) * 2 ** 29 + (b[o + 1] << 22) + ((b[o + 2] & 0xfe) << 14) + (b[o + 3] << 7) + (b[o + 4] >> 1);
function psi(pid, table) {
  const p = Buffer.alloc(TS, 0xff);
  p[0] = 0x47; p[1] = 0x40 | (pid >> 8); p[2] = pid & 0xff; p[3] = 0x10; p[4] = 0;
  Buffer.from(table).copy(p, 5);
  return p;
}
function pes(pid, id, pts, dts) {
  const p = Buffer.alloc(TS, 0xff);
  p[0] = 0x47; p[1] = 0x40 | (pid >> 8); p[2] = pid & 0xff; p[3] = 0x10;
  p[4] = 0; p[5] = 0; p[6] = 1; p[7] = id; p[8] = 0; p[9] = 0; p[10] = 0x80; p[11] = dts != null ? 0xc0 : 0x80; p[12] = dts != null ? 10 : 5;
  putTime(p, 13, pts, dts != null ? 3 : 2);
  if (dts != null) putTime(p, 18, dts, 1);
  return p;
}
// One piece: PAT, PMT, then frames.
function piece(kind, times) {
  const es = kind === 'video' ? [0x1b, 0xe0 | 1, 0, 0xf0, 0] : [0x0f, 0xe0 | 1, 1, 0xf0, 0];
  const pat = psi(0, [0x00, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00]);
  const pmt = psi(0x1000, [0x02, 0xb0, 18, 0, 1, 0xc1, 0, 0, 0xe1, 0, 0xf0, 0, ...es]);
  return Buffer.concat([pat, pmt, ...times.map((t) => (kind === 'video' ? pes(0x100, 0xe0, t + 3000, t) : pes(0x101, 0xc0, t)))]);
}
// What came out: per stream, its first and last times.
function outTimes(buf) {
  const v = [], a = [];
  for (let i = 0; i < buf.length; i += TS) {
    assert.equal(buf[i], 0x47);
    const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
    if (!(buf[i + 1] & 0x40) || (pid !== 0x100 && pid !== 0x101)) continue;
    const dtsToo = buf[i + 11] & 0x40;
    (pid === 0x100 ? v : a).push(dtsToo ? getTime(buf, i + 18) : getTime(buf, i + 13));
  }
  return { v, a };
}
const frames = (start, n, step) => Array.from({ length: n }, (_, i) => start + i * step);
const pair = (vStart, aStart) => [readTrack(piece('video', frames(vStart, 10, 3003)), 'video'), readTrack(piece('audio', frames(aStart, 10, 3003)), 'audio')];

test('reads just the wanted track from a piece', () => {
  const t = readTrack(piece('video', [90000, 93003]), 'video');
  assert.equal(t.type, 0x1b);
  assert.deepEqual(t.units.map((u) => u.dts), [90000, 93003]);
  assert.equal(readTrack(piece('audio', [90000]), 'video'), null, 'no picture in a sound piece');
  assert.equal(readTrack(Buffer.alloc(TS * 3), 'video'), null, 'not MPEG-TS');
});

test('a clip change restarts both clocks and they stay exactly together', () => {
  const j = new Joiner();
  const offsets = [];
  const clips = [[8100000, 8100000 - 6000, 1, false], [96000, 90000, 2, true], [93000000, 92995000, 3, true], [96000, 90000, 4, true]];
  let lastEnd = 0;
  for (const [vs, as, seq, clip] of clips) {
    const [v, a] = pair(vs, as);
    const { v: ov, a: oa } = outTimes(j.join(v, a, seq, clip));
    // Exactly the relation the source had: the clip change never adds any error.
    offsets.push(oa[0] - ov[0] - (as - vs));
    assert.ok(Math.min(ov[0], oa[0]) >= lastEnd, 'time only moves forward across clips');
    lastEnd = Math.max(ov[ov.length - 1], oa[oa.length - 1]);
  }
  assert.deepEqual(offsets, [0, 0, 0, 0]);
});

test('pieces in the same clip continue on the same clock', () => {
  const j = new Joiner();
  const [v1, a1] = pair(90000, 90000);
  const one = outTimes(j.join(v1, a1, 10, false));
  const [v2, a2] = pair(90000 + 10 * 3003, 90000 + 10 * 3003);
  const two = outTimes(j.join(v2, a2, 11, false));
  assert.equal(two.v[0] - one.v[0], 10 * 3003);
  assert.equal(two.a[0] - one.a[0], 10 * 3003);
});

test('a lost piece or an unannounced jump starts cleanly, still together', () => {
  const j = new Joiner();
  const [v1, a1] = pair(90000, 90000);
  j.join(v1, a1, 1, false);
  const [v2, a2] = pair(900000, 900000);
  const lost = outTimes(j.join(v2, a2, 5, false));
  assert.equal(lost.a[0], lost.v[0]);
  const [v3, a3] = pair(5000000, 5000000);
  const jump = outTimes(j.join(v3, a3, 6, false));
  assert.equal(jump.a[0], jump.v[0]);
  assert.ok(jump.v[0] > lost.v[0]);
});

test('sides on really different clocks are lined up by where the piece starts', () => {
  const j = new Joiner();
  const [v, a] = pair(90000, 90000 + 16 * 90000);
  const { v: ov, a: oa } = outTimes(j.join(v, a, 1, false));
  assert.equal(oa[0], ov[0]);
});

test('time survives the 33-bit clock wrapping', () => {
  const j = new Joiner();
  const top = 2 ** 33 - 12000;
  const [v, a] = pair(top, top);
  const { v: ov, a: oa } = outTimes(j.join(v, a, 1, false));
  assert.deepEqual(oa, ov);
  assert.equal(ov[9] - ov[0], 9 * 3003);
});

test('continuity counters and stream ids are its own, and it declares both streams', () => {
  const j = new Joiner();
  const [v, a] = pair(90000, 90000);
  const out = j.join(v, a, 1, false);
  const seen = {};
  for (let i = 0; i < out.length; i += TS) {
    const pid = ((out[i + 1] & 0x1f) << 8) | out[i + 2], cc = out[i + 3] & 15;
    if (pid in seen) assert.equal(cc, (seen[pid] + 1) & 15);
    seen[pid] = cc;
  }
  assert.deepEqual(Object.keys(seen).map(Number).sort((x, y) => x - y), [0, 0x100, 0x101, 0x1000]);
});

test('reads the playlist facts the pairing depends on', () => {
  const p = parsePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:40\n#EXT-X-KEY:METHOD=AES-128,URI="k",IV=0x0A\n#EXTINF:5,\na.ts\n#EXT-X-DISCONTINUITY\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:5,\nb.ts\n');
  assert.deepEqual(p.segments.map((s) => [s.seq, s.clip, !!s.key]), [[40, false, true], [41, true, false]]);
  assert.equal(p.segments[0].key.iv, '0A');
  assert.equal(p.plain, true);
  assert.equal(parsePlaylist('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"\n#EXTINF:5,\na.ts').plain, false, 'a kind of encryption we can’t read');
  assert.equal(parsePlaylist('#EXT-X-MAP:URI="i.mp4"\n#EXTINF:5,\na.m4s').plain, false, 'not MPEG-TS pieces');
  assert.equal(parsePlaylist('#EXT-X-DISCONTINUITY-SEQUENCE:9\n#EXTINF:5,\na.ts').segments[0].clip, false, 'the sequence header isn’t a clip change');
});
