// Adults only: the age check and reading a pasted link.
const test = require('node:test');
const assert = require('node:assert');
const { ageOn, readLink, MAX_STATIONS } = require('../src/main/adult');

test('age in whole years, on the day', () => {
  const now = new Date(2026, 10, 16); // 16 Nov 2026
  assert.equal(ageOn('2008-11-16', now), 18, '18th birthday today');
  assert.equal(ageOn('2008-11-17', now), 17, 'one day short');
  assert.equal(ageOn('1990-05-05', now), 36);
  assert.equal(ageOn('2000-02-29', new Date(2026, 1, 28)), 25, 'leap-day birthday not reached yet');
});

test('anything that is not a real past date gives no age', () => {
  const now = new Date(2026, 10, 16);
  for (const bad of ['', null, '1990-02-30', '1990-13-01', '05/05/1990', '1899-12-31', '2030-01-01', '1990-5-5']) assert.equal(ageOn(bad, now), null, String(bad));
});

test('a playlist becomes its stations; a stream is one station', () => {
  const list = readLink('https://example.test/list.m3u', '#EXTM3U\n#EXTINF:-1 group-title="A",One\nhttps://example.test/1.m3u8\n#EXTINF:-1,Two\nhttps://example.test/2.m3u8\n#EXTINF:-1,Dupe\nhttps://example.test/1.m3u8\n#EXTINF:-1,Local file\nfile:///c:/x.mp4\n');
  assert.deepEqual(list.map((s) => s.name), ['One', 'Two'], 'no doubles, only web links');
  const hls = readLink('https://example.test/live.m3u8', '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg1.ts\n#EXTINF:6.0,\nseg2.ts\n');
  assert.deepEqual(hls.map((s) => [s.name, s.url]), [['example.test', 'https://example.test/live.m3u8']]);
  assert.equal(readLink('https://example.test/v.mp4', '').length, 1, 'a video link with nothing to read');
});

test('a huge playlist is capped', () => {
  const text = '#EXTM3U\n' + Array.from({ length: MAX_STATIONS + 50 }, (_, i) => `#EXTINF:-1,S${i}\nhttps://example.test/${i}.m3u8`).join('\n');
  assert.equal(readLink('https://example.test/l.m3u', text).length, MAX_STATIONS);
});
