// TV and anime: seasons in order, movies and OVAs in their place, what can play, and how the index
// helps name what's in your library. Nothing here touches the network.
const test = require('node:test');
const assert = require('node:assert');
const { tvParts, animeParts } = require('../src/main/showguide');
const { findEpisodeSources, episodeOf, showItemSeason } = require('../src/main/sources');
const { Catalog } = require('../src/main/catalog');

const ep = (id, season, number, airdate, type = 'regular', name = `E${number}`) => ({ id, season, number, airdate, type, name });

test('TV: seasons in number order, each special and film right after the season it came during', () => {
  const parts = tvParts('Show', [
    ep(3, 2, 1, '2012-01-01'), ep(1, 1, 1, '2010-01-01'), ep(2, 1, 2, '2010-02-01'),
    ep(9, 1, null, '2011-06-01', 'significant_special', 'Big Special'),
    ep(8, 1, null, '2011-07-01', 'insignificant_special', 'Behind the scenes'),
  ], [{ qid: 'Q1', title: 'Show: The Movie', date: '2013-05-05' }]);
  assert.deepEqual(parts.map((p) => p.key), ['s1', 'x9', 's2', 'fQ1']);
  assert.deepEqual(parts[0].episodes.map((e) => e.key), ['s1e1', 's1e2']);
  assert.equal(parts[1].type, 'special');
  assert.equal(parts[3].type, 'movie');
});

test('anime: everything in the order it came out, and only real seasons are numbered', () => {
  const n = (id, format, y, episodes, title, extra = {}) => ({ id, format, episodes, startDate: { year: y, month: 1, day: 1 }, title: { english: title }, ...extra });
  const parts = animeParts([
    n(3, 'TV', 2012, 12, 'Show II'), n(1, 'TV', 2010, 24, 'Show'), n(2, 'OVA', 2011, 2, 'Show OVA'), n(4, 'MOVIE', 2013, 1, 'Show Movie'),
    n(5, 'SPECIAL', 2014, 1, 'Show Recap'), n(6, 'OVA', 2015, 1, 'Grown-up one', { isAdult: true }), n(7, 'MANGA', 2009, 0, 'The book'),
    n(8, 'TV', 2016, null, 'Show III', { nextAiringEpisode: { episode: 5 } }),
  ]);
  assert.deepEqual(parts.map((p) => [p.type, p.label, p.title]), [['season', 'Season 1', 'Show'], ['ova', 'OVA', 'Show OVA'], ['season', 'Season 2', 'Show II'], ['movie', 'Movie', 'Show Movie'], ['special', 'Special', 'Show Recap'], ['season', 'Season 3', 'Show III']]);
  assert.equal(parts[0].episodes[23].key, 's1e24');
  assert.equal(parts[1].episodes.length, 2);
  assert.equal(parts[5].episodes.length, 4, 'still airing: what has aired so far');
});

test('reading season and episode from names', () => {
  assert.deepEqual(episodeOf('My.Show.S02E03.mp4'), { season: 2, episode: 3 });
  assert.deepEqual(episodeOf('my show 3x07'), { season: 3, episode: 7 });
  assert.deepEqual(episodeOf('Season 4 Episode 9'), { season: 4, episode: 9 });
  assert.deepEqual(episodeOf('Episode 2.mp4', 1), { season: 1, episode: 2 });
  assert.equal(episodeOf('Episode 2.mp4'), null, 'no season to go by');
  assert.equal(episodeOf('Full Movie 1080p'), null);
  assert.deepEqual(showItemSeason('The Show Season 2', 'The Show'), { season: 2 });
  assert.deepEqual(showItemSeason('The Show', 'The Show'), { season: null });
  assert.equal(showItemSeason('The Show Must Go On', 'The Show'), null, 'a lookalike is not the show');
});

const guide = tvParts('The Show', [ep(1, 1, 1, '2010-01-01'), ep(2, 1, 2, '2010-02-01'), ep(3, 2, 1, '2012-01-01')], [{ qid: 'Q1', title: 'The Show Movie', date: '2011-01-01' }]);
const free = false;

test('what can play is your own copy, by exact show, season and episode', async () => {
  const items = () => [
    { id: 'a', kind: 'episode', show: 'The Show', season: 1, episode: 2, height: 1080 },
    { id: 'b', kind: 'episode', show: 'The Show 2', season: 1, episode: 1 },
    { id: 'c', kind: 'episode', show: 'The Show', season: 2, episode: 1, torrent: true },
    { id: 'd', kind: 'movie', title: 'The Show Movie', year: 2011 },
  ];
  const s = await findEpisodeSources({ title: 'The Show' }, guide, { items, free });
  assert.deepEqual(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.itemId])), { s1e2: 'a', fQ1: 'd' });
});

test('season 1 files never stand in for the same episode of a later season; a part with its own name matches by that name', async () => {
  const parts = [{ key: 'a1', type: 'season', season: 1, names: ['Show'], episodes: [{ key: 's1e1', n: 1 }] }, { key: 'a2', type: 'season', season: 2, names: ['Show II'], episodes: [{ key: 's2e1', n: 1 }] }];
  const one = await findEpisodeSources({ title: 'Show' }, parts, { items: () => [{ id: 'x', kind: 'episode', show: 'Show', season: 1, episode: 1 }], free: false });
  assert.deepEqual(Object.keys(one), ['s1e1']);
  const named = await findEpisodeSources({ title: 'Show' }, parts, { items: () => [{ id: 'y', kind: 'episode', show: 'Show II', season: 1, episode: 1 }], free: false });
  assert.deepEqual(Object.keys(named), ['s2e1']);
});

test('with nothing of yours and free copies off, nothing plays, and nothing is asked online', async () => {
  const real = global.fetch; let asked = 0; global.fetch = async () => { asked++; throw new Error('offline'); };
  try {
    assert.deepEqual(await findEpisodeSources({ title: 'The Show' }, guide, { items: () => [], free: false }), {});
    assert.equal(asked, 0);
    const ctx = { items: () => [], free: true };
    assert.deepEqual(await findEpisodeSources({ title: 'The Show', year: 1960 }, guide, ctx), {}, 'an Archive that can’t be reached is no streams, not an error');
    assert.equal(ctx.failed, true, 'and it will be asked again');
  } finally { global.fetch = real; }
});

test('a free copy that comes as a whole season beats a single episode', async () => {
  const real = global.fetch;
  const file = (name) => ({ name, length: '1500', height: '480', format: 'h.264', size: '9' });
  const metas = { pack: [file('The Show S01E01.mp4'), file('The Show S01E02.mp4'), file('The.Show.S01E03.1080p.WEB-DL.x264.mkv')], one: [file('The Show S01E01 alt.mp4')] };
  global.fetch = async (u) => {
    const url = String(u);
    const body = url.includes('advancedsearch')
      ? { response: { docs: [{ identifier: 'one', title: 'The Show S01E01' }, { identifier: 'pack', title: 'The Show Season 1' }, { identifier: 'rip', title: 'The Show Season 2 BluRay x265' }, { identifier: 'other', title: 'The Show Must Go On' }] } }
      : { result: metas[url.split('/metadata/')[1].split('/')[0]] || [] };
    return { ok: true, json: async () => body };
  };
  try {
    const s = await findEpisodeSources({ title: 'The Show', year: 1960 }, guide, { items: () => [] });
    assert.equal(s.s1e1.archive.id, 'pack');
    assert.equal(s.s1e1.pack, true);
    assert.equal(s.s1e2.archive.id, 'pack');
    assert.equal(s.s2e1, undefined, 'a file named like a rip is never believed');
  } finally { global.fetch = real; }
});

test('a current show or anime is never looked for as "free": those labels can’t be trusted', async () => {
  const real = global.fetch; let asked = 0; global.fetch = async () => { asked++; throw new Error('should not ask'); };
  try {
    for (const show of [{ title: 'Breaking Bad', year: 2008, kind: 'tv' }, { title: 'Old Anime', year: 1963, kind: 'anime' }, { title: 'Unknown Year', kind: 'tv' }]) {
      assert.deepEqual(await findEpisodeSources(show, guide, { items: () => [], free: true }), {});
    }
    assert.equal(asked, 0);
  } finally { global.fetch = real; }
});

// The real index files, as they ship.
const cat = () => new Catalog({ store: { read: (_, d) => d, write() {} }, settings: () => ({}), items: () => [], lib: { items: {}, save() {} } });

test('the index ships TV and anime, with no adult titles', () => {
  const c = cat();
  assert.ok(c.meta('tv').total > 5000);
  assert.ok(c.meta('anime').total > 1500);
  assert.ok(c.meta('movie').total > 15000);
  const row = (kind, title) => c.browse({ kind, q: title }).items.find((m) => m.title === title);
  assert.ok(row('tv', 'Breaking Bad'));
  assert.ok(row('anime', 'Cowboy Bebop'));
  assert.ok(!row('tv', 'Cowboy Bebop') || row('tv', 'Cowboy Bebop').year > 2000, 'the anime is only in anime; the live-action remake may be in TV');
  for (const kind of ['tv', 'anime']) assert.ok(!c.meta(kind).genres.some((g) => /hentai|porn|erotic/i.test(g)));
});

test('the front page puts the genres you picked first', () => {
  const titles = cat().home('tv', ['Horror', 'Western']).rows.map((r) => r.title);
  assert.deepEqual(titles.slice(0, 3), ['Horror', 'Western', 'Most known shows']);
  assert.ok(!titles.includes('Soap'), 'a genre you didn’t pick gets no row');
  const anime = cat().home('anime', []).rows.map((r) => r.title);
  assert.ok(anime.includes('Anime movies') && anime.includes('OVAs'));
});

test('the index names what’s in your library, and leaves doubtful names alone', () => {
  const c = cat();
  assert.equal(c.matchShow('breaking bad')?.title, 'Breaking Bad');
  assert.equal(c.matchShow('Cowboy Bebop!')?.kind === undefined, true, 'two shows share this name: left alone');
  assert.equal(c.matchMovie('Rear Window', 1954)?.year, 1954);
  assert.equal(c.matchMovie('Rear Window', 1980), null, 'wrong year');
  assert.equal(c.matchShow('No Such Show Anywhere'), null);
  assert.equal(c.matchMovie(''), null);
});
