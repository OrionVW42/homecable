// Picking what a film can play: exact names and years only, one file per quality, best first.
const test = require('node:test');
const assert = require('node:assert');
const { bestFiles, findSources } = require('../src/main/sources');

test('one file per quality, best first, MP4 preferred, no doubles', () => {
  const r = bestFiles([
    { name: 'a.mkv', height: '1080', size: '9' }, { name: 'a.mp4', height: '1080', format: 'h.264', size: '5' },
    { name: 'b.mp4', height: '720', size: '3' }, { name: 'c_512kb.mp4', height: '360', size: '1' }, { name: 'd.ogv', height: '300', size: '1' },
    { name: 'poster.jpg', height: '1080' }, { name: 'info.xml' },
  ]);
  assert.deepEqual(r.map((f) => [f.quality, f.name]), [['1080p', 'a.mp4'], ['720p', 'b.mp4'], ['SD', 'c_512kb.mp4']]);
});

test('a rip or a short clip is never treated as the film', () => {
  const r = bestFiles([{ name: 'Film.1080p.BluRay.x265.mkv', height: '1080', length: '6000' }, { name: 'clip.mp4', height: '720', length: '30' }, { name: 'film.mp4', height: '480', length: '01:30:00' }]);
  assert.deepEqual(r.map((f) => f.name), ['film.mp4']);
});

test('your own copy plays, an exact name and year only', async () => {
  const realFetch = global.fetch; global.fetch = async () => { throw new Error('offline'); };
  try {
    const items = [{ id: 'x', kind: 'movie', title: 'Rear Window', year: 1954, height: 1080 }, { id: 'y', kind: 'movie', title: 'Rear Window 2', year: 1954, height: 720 }, { id: 'z', kind: 'movie', title: 'Rear Window', year: 1998, height: 480 }];
    const r = await findSources({ title: 'Rear Window', year: 1954 }, { items: () => items });
    assert.deepEqual(r.map((s) => [s.source, s.itemId, s.quality]), [['library', 'x', '1080p']]);
    const none = await findSources({ title: 'Nothing Like It', year: 2001 }, { items: () => items });
    assert.deepEqual(none, [], 'no streams, and no error');
  } finally { global.fetch = realFetch; }
});

test('nothing but the built-in sources can supply a stream', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'main', 'sources.js'), 'utf8');
  assert.match(src, /const SOURCES = \[library, archive\];/);
  assert.doesNotMatch(src, /searchEngines|TorrentSearch|require\('\.\/search'\)/);
  const cat = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'main', 'catalog.js'), 'utf8');
  assert.doesNotMatch(cat, /TorrentSearch|require\('\.\/search'\)/);
});
