// Choosing which quality level of a station to read, for the check and for playing.
const test = require('node:test');
const assert = require('node:assert');
const { bestVariant, resolveHls } = require('../src/main/iptv');

const answer = async (text, fn) => {
  const real = global.fetch;
  global.fetch = async () => ({ ok: true, url: 'https://x.test/live/master.m3u8', text: async () => text });
  try { return await fn(); } finally { global.fetch = real; }
};
const ST = { url: 'https://x.test/live/master.m3u8' };
const LADDER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720\nmid.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=3840x2160\nuhd.m3u8\n';
const SPLIT = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",DEFAULT=YES,URI="snd.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="a"\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,AUDIO="a"\nmid.m3u8\n';

test('reads the best quality up to 1080p, as a full address', () => answer(LADDER, async () => {
  assert.deepEqual(await bestVariant(ST), { url: 'https://x.test/live/mid.m3u8', audio: null });
}));

test('sound inside the picture is not treated as separate', () => answer(LADDER, async () => {
  assert.equal(await resolveHls(ST), null);
}));

test('separate picture and sound are both found', () => answer(SPLIT, async () => {
  assert.deepEqual(await bestVariant(ST), { url: 'https://x.test/live/mid.m3u8', audio: 'https://x.test/live/snd.m3u8' });
  assert.deepEqual(await resolveHls(ST), { video: 'https://x.test/live/mid.m3u8', audio: 'https://x.test/live/snd.m3u8' });
}));

test('a playlist with no quality levels, or not HLS at all, reads as it is', async () => {
  await answer('#EXTM3U\n#EXTINF:5,\nseg1.ts\n', async () => assert.equal(await bestVariant(ST), null));
  assert.equal(await bestVariant({ url: 'https://x.test/stream.mp4' }), null);
});

test('with no limit, every station stays a candidate', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /if \(max > 0\) \{\n\s+for \(const st of candidates\) \{ const b = brand\(st\.name\)/);
});

test('only the languages you picked, and unlabelled stations are kept', () => {
  const { keepLanguages } = require('../src/main/iptv');
  const us = [{ url: 'en' }, { url: 'es' }, { url: 'none' }, { url: 'fr' }];
  us.tvgUrls = ['guide'];
  const [out] = keepLanguages([us], [[{ url: 'en' }]], [{ url: 'none' }]);
  assert.deepEqual(out.map((s) => s.url), ['en', 'none']);
  assert.deepEqual(out.tvgUrls, ['guide'], 'its guide links stay');
});

test('a list that fails to download is tried again', async () => {
  const { fetchList } = require('../src/main/iptv');
  const real = global.fetch; let n = 0;
  global.fetch = async () => { if (++n < 2) throw new Error('blip'); return { ok: true, status: 200, text: async () => '#EXTM3U\n#EXTINF:-1,One\nhttps://x.test/a.m3u8\n' }; };
  try { const l = await fetchList('https://x.test/l.m3u'); assert.equal(n, 2); assert.equal(l.length, 1); } finally { global.fetch = real; }
});
