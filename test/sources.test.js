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

test('free films: only titles from before 1978, only in the Archive\'s film collections', async () => {
  const real = global.fetch; const asked = [];
  global.fetch = async (u) => { asked.push(decodeURIComponent(String(u))); return { ok: true, status: 200, json: async () => ({ response: { docs: [] } }) }; };
  try {
    assert.deepEqual(await findSources({ title: 'Avatar', year: 2009 }, { items: () => [] }), []);
    assert.equal(asked.length, 0, 'a recent film is never looked up');
    await findSources({ title: 'Night of the Living Dead', year: 1968 }, { items: () => [] });
    assert.equal(asked.length, 1);
    assert.match(asked[0], /collection:\(feature_films/);
    asked.length = 0;
    await findSources({ title: 'No Date', year: null }, { items: () => [] });
    assert.equal(asked.length, 0, 'no year, no lookup');
  } finally { global.fetch = real; }
});

test('free films remembered from before the limit are forgotten, once', () => {
  const { Catalog } = require('../src/main/catalog');
  const saved = {}; let stored = { sources: { x: { at: 1, list: [{ source: 'archive' }] } }, freeAt: 5, art: { x: 'a.jpg' } };
  const store = { read: () => stored, write: (k, v) => { saved[k] = v; } };
  const c = new Catalog({ store, settings: () => ({}) });
  assert.deepEqual(c.cache.sources, {});
  assert.equal(c.cache.art.x, 'a.jpg', 'covers stay');
  assert.ok(saved.catalogCache);
  c.cache.sources.y = { at: 2, list: [] };
  stored = c.cache;
  assert.ok(new Catalog({ store, settings: () => ({}) }).cache.sources.y, 'only the once');
});

test('nothing but the built-in sources can supply a stream', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'main', 'sources.js'), 'utf8');
  assert.match(src, /const SOURCES = \[library, archive\];/);
  assert.doesNotMatch(src, /searchEngines|TorrentSearch|require\('\.\/search'\)/);
  const cat = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'main', 'catalog.js'), 'utf8');
  assert.doesNotMatch(cat, /TorrentSearch|require\('\.\/search'\)/);
  const guide = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'main', 'showguide.js'), 'utf8');
  assert.doesNotMatch(guide, /TorrentSearch|require\('\.\/(search|torrents)'\)|magnet:/);
});

// Playing a free film: from the web unless you chose torrents AND torrents are on.
const { openSource, onePerQuality } = require('../src/main/sources');
const FREE = { source: 'archive', quality: '480p', size: 9, duration: 5400, h264: true, archive: { id: 'a film', file: 'dir/the film.mp4' } };
const openWith = (over) => {
  const added = [];
  const lib = { items: {}, save() {} };
  const torrents = { add: async (link, o) => { added.push([link, o]); return { items: ['from-torrent'] }; } };
  return openSource(FREE, { lib, torrents, ...over }).then((id) => ({ id, added, lib }));
};

test('a free film plays from the web, as one item that resume can follow', async () => {
  const { id, added, lib } = await openWith({});
  assert.equal(added.length, 0, 'no torrent');
  const it = lib.items[id];
  assert.equal(it.url, 'https://archive.org/download/a%20film/dir/the%20film.mp4');
  assert.ok(it.remote && it.catalogOnly);
  assert.equal(it.mode, 'direct');
  assert.equal(await openSource(FREE, { lib }), id, 'the same film, the same item');
  const other = await openSource({ ...FREE, h264: false }, { lib: { items: {}, save() {} } });
  assert.equal(other, id);
});

test('the torrent lock beats the choice to use torrents', async () => {
  assert.equal((await openWith({ playBy: 'torrent', torrentsOn: false })).added.length, 0);
  assert.equal((await openWith({ playBy: 'web', torrentsOn: true })).added.length, 0);
  const both = await openWith({ playBy: 'torrent', torrentsOn: true });
  assert.equal(both.id, 'from-torrent');
  assert.equal(both.added.length, 1);
  assert.equal(both.added[0][1].watchOnly, true, 'cleared after watching');
});

test('with free films off the Archive is never asked; a failed lookup is flagged', async () => {
  const real = global.fetch; let calls = 0;
  global.fetch = async () => { calls++; throw new Error('offline'); };
  try {
    await findSources({ title: 'Anything', year: 1950 }, { items: () => [], free: false });
    assert.equal(calls, 0);
    const ctx = { items: () => [] };
    await findSources({ title: 'Anything', year: 1950 }, ctx);
    assert.equal(calls, 1);
    assert.equal(ctx.failed, true, 'so it isn\'t remembered as having nothing');
  } finally { global.fetch = real; }
});

test('a film played from the web is not mistaken for one you own', async () => {
  const items = [{ id: 'w', kind: 'movie', title: 'Rear Window', year: 1954, catalogOnly: true, remote: true }];
  assert.deepEqual(await findSources({ title: 'Rear Window', year: 1954 }, { items: () => items, free: false }), []);
  assert.deepEqual(onePerQuality([{ quality: 'SD', source: 'library' }, { quality: 'SD', source: 'archive' }]).map((x) => x.source), ['library']);
});
