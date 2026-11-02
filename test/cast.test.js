const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { encode, decode, castMode, localAddressFor } = require('../src/main/cast');
const { startServer } = require('../src/main/server');

test('CastMessage round-trips through the protobuf envelope', () => {
  const data = { type: 'LOAD', requestId: 7, media: { contentId: 'http://192.168.0.5:1234/x?k=' + 'a'.repeat(200), title: 'Ünïcode ✓' } };
  const buf = encode({ source: 'sender-0', destination: 'receiver-0', namespace: 'urn:x-cast:com.google.cast.media', data });
  assert.strictEqual(buf.readUInt32BE(0), buf.length - 4);
  const msg = decode(buf.subarray(4));
  assert.strictEqual(msg.source, 'sender-0');
  assert.strictEqual(msg.destination, 'receiver-0');
  assert.strictEqual(msg.namespace, 'urn:x-cast:com.google.cast.media');
  assert.deepStrictEqual(msg.data, data);
});

test('castMode: what the TV takes as-is vs. what this PC converts', () => {
  const mp4 = { container: 'mov,mp4,m4a,3gp,3g2,mj2', vcodec: 'h264', acodec: 'aac', mode: 'direct', kind: 'episode' };
  assert.strictEqual(castMode(mp4), 'direct');
  assert.strictEqual(castMode({ ...mp4, container: 'matroska,webm' }), 'remux');           // MKV + H.264: repackage
  assert.strictEqual(castMode({ ...mp4, acodec: 'ac3', mode: 'remux' }), 'remux');           // AC-3 audio: convert audio only
  assert.strictEqual(castMode({ ...mp4, vcodec: 'hevc' }), 'transcode');                    // the PC plays HEVC, most Chromecasts don't
  assert.strictEqual(castMode({ ...mp4, mode: 'transcode' }), 'transcode');
  assert.strictEqual(castMode({ container: 'mp3', vcodec: null, acodec: 'mp3', mode: 'direct', kind: 'music' }), 'direct');
  assert.strictEqual(castMode({ container: 'mov,mp4,m4a,3gp,3g2,mj2', vcodec: 'png', acodec: 'alac', mode: 'remux', kind: 'music' }), 'remux');
});

test('localAddressFor picks this PC’s address on the TV’s network (or none)', () => {
  const ip = localAddressFor('127.0.0.1');
  assert.ok(ip === null || /^\d+\.\d+\.\d+\.\d+$/.test(ip));
});

test('cast listener: closed until casting, media only, its own key, gone afterwards', async () => {
  const lib = { items: {} };
  const media = await startServer(lib, () => {});
  const get = (url, method = 'GET') => new Promise((resolve) => { const r = http.request(url, { method }, (res) => { res.resume(); resolve(res.statusCode); }); r.on('error', () => resolve('refused')); r.end(); });
  try {
    assert.strictEqual(media.castUrl(media.urlFor('x', { mode: 'direct' }), '127.0.0.1'), null); // not casting yet
    const port = await media.openCast();
    const castUrl = media.castUrl(media.urlFor('x', { mode: 'direct' }), '127.0.0.1');
    assert.ok(castUrl.startsWith(`http://127.0.0.1:${port}/direct/x?k=`));
    assert.ok(!castUrl.includes(media.token), 'the window key never leaves this PC');
    assert.strictEqual(await get(castUrl), 404);                                         // right key, unknown item
    assert.strictEqual(await get(castUrl.replace(/k=\w+/, 'k=' + media.token)), 403);     // window key doesn't work on the LAN
    assert.strictEqual(await get(castUrl.replace('/direct/', '/admin/')), 403);           // media routes only
    media.closeCast();
    assert.strictEqual(media.castUrl(media.urlFor('x', { mode: 'direct' }), '127.0.0.1'), null);
    assert.strictEqual(await get(castUrl), 'refused');
  } finally { media.closeCast(); media.server.close(); }
});
