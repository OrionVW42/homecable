const test = require('node:test');
const assert = require('node:assert');
const { Scheduler, blockOccurrences } = require('../src/main/scheduler');

// A fake library: shows of fixed-length episodes.
function fakeLib(spec) {
  const items = {};
  for (const [show, n, mins] of spec) for (let e = 1; e <= n; e++) {
    const id = `${show}-${e}`;
    items[id] = { id, show, showKey: show, season: 1, episode: e, kind: show === 'ads' ? 'short' : 'episode', title: `${show} ${e}`, duration: mins * 60, path: id, folder: '/' + show };
  }
  return {
    items,
    list: () => Object.values(items),
    resolve(src) {
      if (src.type === 'show') return Object.values(items).filter((i) => i.showKey === src.key).sort((a, b) => a.episode - b.episode);
      if (src.type === 'kind') return Object.values(items).filter((i) => i.kind === src.kind);
      return [];
    },
  };
}
const seeded = (s = 42) => () => ((s = (s * 16807) % 2147483647) / 2147483647);
const T0 = new Date(2026, 0, 5, 12, 10).getTime(); // a Monday, 12:10 local

test('timeline is continuous with no gaps or overlaps', () => {
  const lib = fakeLib([['A', 10, 22], ['B', 5, 44], ['ads', 6, 0.5]]);
  const s = new Scheduler(null, lib, seeded());
  const ch = { id: 'c', sources: [{ type: 'show', key: 'A' }, { type: 'show', key: 'B' }], filler: [{ type: 'kind', kind: 'short' }], order: 'sequential', align: 30 };
  s.ensure([ch], T0);
  const ps = s.stateOf(ch).programs;
  assert.ok(ps.length > 20);
  for (let i = 1; i < ps.length; i++) assert.strictEqual(ps[i].start, ps[i - 1].end, `gap at ${i}`);
  // Programs start on the half hour.
  for (const p of ps.filter((p) => p.type === 'program')) assert.strictEqual(new Date(p.start).getMinutes() % 30, 0, p.title);
  // Episodes of A air in order.
  const a = ps.filter((p) => p.show === 'A').map((p) => p.episode);
  assert.deepStrictEqual(a.slice(0, 10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(ps.some((p) => p.type === 'filler'), 'uses filler clips');
  // Tuning in mid-program gives an offset.
  const at = s.at(ch, T0);
  assert.ok(at && at.offset > 0 && at.offset < 30 * 60);
});

test('scheduled blocks air on time and the pool never runs into them', () => {
  const lib = fakeLib([['Pool', 30, 25], ['News', 10, 30]]);
  const s = new Scheduler(null, lib, seeded());
  const ch = { id: 'c', sources: [{ type: 'show', key: 'Pool' }], order: 'shuffle', align: 30,
    blocks: [{ id: 'n', name: 'News', days: [0, 1, 2, 3, 4, 5, 6], start: '18:00', end: '19:00', sources: [{ type: 'show', key: 'News' }], order: 'sequential' }] };
  s.ensure([ch], T0);
  const ps = s.stateOf(ch).programs;
  const news = ps.filter((p) => p.show === 'News');
  assert.ok(news.length >= 2);
  assert.strictEqual(new Date(news[0].start).getHours(), 18);
  assert.strictEqual(new Date(news[0].start).getMinutes(), 0);
  for (const p of ps.filter((p) => p.show === 'Pool')) {
    const h = new Date(p.start).getHours();
    assert.ok(h < 18 || h >= 19, 'pool aired during block at ' + new Date(p.start));
  }
});

test('channel with only blocks is off air in between', () => {
  const lib = fakeLib([['Late', 5, 30]]);
  const s = new Scheduler(null, lib, seeded());
  const ch = { id: 'c', sources: [], order: 'sequential', align: 30, blocks: [{ id: 'x', days: [1], start: '23:00', end: '23:30', sources: [{ type: 'show', key: 'Late' }] }] };
  s.ensure([ch], T0);
  assert.strictEqual(s.at(ch, T0).entry.type, 'offair');
  const late = s.stateOf(ch).programs.find((p) => p.show === 'Late');
  assert.strictEqual(new Date(late.start).getHours(), 23);
});

test('ordered block resumes at the imported position', () => {
  const lib = fakeLib([['Seq', 10, 30]]);
  const s = new Scheduler(null, lib, seeded());
  const ch = { id: 'c', sources: [], align: 30, blocks: [{ id: 'x', days: [1], start: '13:00', end: '13:30', order: 'ordered', startAt: 4, sources: [{ type: 'show', key: 'Seq' }] }] };
  s.ensure([ch], T0);
  assert.strictEqual(s.stateOf(ch).programs.find((p) => p.show === 'Seq').episode, 5);
});

test('shuffle does not repeat until the bag empties', () => {
  const lib = fakeLib([['S', 12, 30]]);
  const s = new Scheduler(null, lib, seeded(7));
  const ch = { id: 'c', sources: [{ type: 'show', key: 'S' }], order: 'shuffle', align: 30 };
  s.ensure([ch], T0);
  const first = s.stateOf(ch).programs.filter((p) => p.type === 'program').slice(0, 12).map((p) => p.episode);
  assert.strictEqual(new Set(first).size, 12);
});

test('channels keep airing while the app is closed', () => {
  const lib = fakeLib([['A', 40, 30]]);
  const s = new Scheduler(null, lib, seeded());
  const ch = { id: 'c', sources: [{ type: 'show', key: 'A' }], order: 'sequential', align: 30 };
  s.ensure([ch], T0);
  const before = s.at(ch, T0).entry.episode;
  // Closed for 3 days: 3 days x 48 half-hour episodes later we should be well along,
  // and the timeline must be continuous across the gap.
  const later = T0 + 3 * 24 * 3600e3;
  s.ensure([ch], later);
  const after = s.at(ch, later).entry;
  const aired = Math.round((later - T0) / (30 * 60e3));
  assert.strictEqual(after.episode, ((before - 1 + aired) % 40) + 1, 'episode advanced as if it aired');
  assert.strictEqual(new Date(after.start).getMinutes() % 30, 0);
  const ps = s.stateOf(ch).programs;
  for (let i = 1; i < ps.length; i++) assert.strictEqual(ps[i].start, ps[i - 1].end);
});

test('overnight block occurrences', () => {
  const occ = blockOccurrences([{ days: [1], start: '23:00', end: '02:00' }], T0, T0 + 24 * 3600e3);
  assert.strictEqual(occ.length, 1);
  assert.strictEqual((occ[0].end - occ[0].start) / 3600e3, 3);
});

test('rebuild keeps the program on air', () => {
  const lib = fakeLib([['A', 10, 22]]);
  const s = new Scheduler(null, lib, seeded());
  const ch = { id: 'c', sources: [{ type: 'show', key: 'A' }], order: 'sequential', align: 30 };
  s.ensure([ch], T0);
  const before = s.at(ch, T0).entry;
  ch.order = 'shuffle';
  s.rebuild(ch, T0);
  assert.deepStrictEqual(s.at(ch, T0).entry, before);
});

test('without filler, long gaps are skipped instead of dead air', () => {
  const lib = fakeLib([['A', 10, 22], ['B', 10, 27]]);
  const s = new Scheduler(null, lib, seeded());
  const ch = { id: 'c', sources: [{ type: 'show', key: 'A' }, { type: 'show', key: 'B' }], order: 'sequential', align: 30 };
  s.ensure([ch], T0);
  const ps = s.stateOf(ch).programs;
  for (const p of ps.filter((p) => p.type === 'upnext')) assert.ok(p.end - p.start <= 5 * 60e3, 'dead air ' + (p.end - p.start) / 60e3);
  // 27-minute shows still pad to the half hour.
  assert.ok(ps.some((p) => p.type === 'upnext'));
});

test('commercial breaks fit the chosen length and never exceed 45 s', () => {
  const lib = fakeLib([['A', 10, 27]]);
  const s = new Scheduler(null, lib, seeded());
  const pool = [{ id: 'card:a', card: 'a', title: 'A', duration: 15 }, { id: 'card:b', card: 'b', title: 'B', duration: 10 }, { id: 'card:c', card: 'c', title: 'C', duration: 4 }];
  s.ads = { enabled: true, seconds: 30, every: 'every', pool: () => pool };
  const ch = { id: 'c', sources: [{ type: 'show', key: 'A' }], order: 'sequential', align: 30 };
  s.ensure([ch], T0);
  const ps = s.stateOf(ch).programs;
  for (let i = 1; i < ps.length; i++) assert.strictEqual(ps[i].start, ps[i - 1].end);
  // Group consecutive ads into breaks.
  const breaks = [];
  for (const p of ps) { if (p.type === 'ad') { const last = breaks[breaks.length - 1]; if (last && last.end === p.start) { last.end = p.end; last.n++; } else breaks.push({ start: p.start, end: p.end, n: 1 }); } }
  assert.ok(breaks.length >= 10, 'a break after every show');
  for (const b of breaks) assert.ok(b.end - b.start <= 30e3 && b.end - b.start >= 25e3, 'break length ' + (b.end - b.start));
  // Shows still start on the half hour.
  for (const p of ps.filter((p) => p.type === 'program')) assert.strictEqual(new Date(p.start).getMinutes() % 30, 0);
  // Off = no ads at all.
  const s2 = new Scheduler(null, lib, seeded());
  s2.ads = { enabled: false, seconds: 30, every: 'every', pool: () => pool };
  s2.ensure([{ ...ch, id: 'd' }], T0);
  assert.ok(!s2.stateOf({ id: 'd' }).programs.some((p) => p.type === 'ad'));
});

test('a time block can hand the channel to a live station', () => {
  const lib = fakeLib([['A', 20, 30]]);
  const s = new Scheduler(null, lib, seeded());
  const ch = { id: 'c', sources: [{ type: 'show', key: 'A' }], order: 'sequential', align: 30,
    blocks: [{ id: 'news', name: 'Evening News', days: [0, 1, 2, 3, 4, 5, 6], start: '17:00', end: '18:00', sources: [{ type: 'live', channelId: 'station-1', label: 'News 24' }] }] };
  s.ensure([ch], T0);
  const at5 = new Date(T0); at5.setHours(17, 15, 0, 0);
  const e = s.at(ch, at5.getTime()).entry;
  assert.strictEqual(e.type, 'live');
  assert.strictEqual(e.liveId, 'station-1');
  assert.strictEqual(new Date(e.start).getHours(), 17);
  assert.strictEqual(new Date(e.end).getHours(), 18);
  // Your own programming resumes right after.
  const at6 = new Date(T0); at6.setHours(18, 5, 0, 0);
  assert.strictEqual(s.at(ch, at6.getTime()).entry.show, 'A');
});

test('one-off blocks only happen on their date', () => {
  const day = new Date(T0); day.setDate(day.getDate() + 1);
  const ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const occ = blockOccurrences([{ date: ymd, days: [], start: '20:00', end: '21:00' }], T0, T0 + 4 * 24 * 3600e3);
  assert.strictEqual(occ.length, 1);
  assert.strictEqual(new Date(occ[0].start).getDate(), day.getDate());
});

test('a live block added to an off-air channel starts right away', () => {
  const lib = fakeLib([]);
  const s = new Scheduler(null, lib, seeded());
  const ch = { id: 'c', sources: [], align: 30, blocks: [] };
  s.ensure([ch], T0);
  assert.strictEqual(s.at(ch, T0).entry.type, 'offair');
  const start = new Date(T0); start.setMinutes(0, 0, 0);
  const ymd = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  ch.blocks.push({ id: 'x', date: ymd, days: [], start: `${String(start.getHours()).padStart(2, '0')}:00`, end: `${String(start.getHours() + 1).padStart(2, '0')}:00`, sources: [{ type: 'live', channelId: 'st' }] });
  s.rebuild(ch, T0);
  assert.strictEqual(s.at(ch, T0).entry.type, 'live');
});

// ---- Back-to-back: one continuous network (what a friend's old player did) ----
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const network = (extraBlocks = []) => ({
  id: 'net', sources: [], order: 'sequential', align: 0,
  blocks: [
    { id: 'eve', name: 'Evening', days: ALL_DAYS, start: '18:00', end: '21:00', sources: [{ type: 'show', key: 'Drama' }], order: 'sequential' },
    { id: 'sh', name: 'Shorts', days: ALL_DAYS, start: '21:00', end: '21:30', sources: [{ type: 'show', key: 'Short' }], order: 'sequential' },
    { id: 'mov', name: 'Movie Night', days: ALL_DAYS, start: '21:30', end: '00:00', sources: [{ type: 'show', key: 'Film' }], order: 'sequential' },
    ...extraBlocks,
  ],
});
const at = (h, m = 0, day = 0) => new Date(2026, 0, 5 + day, h, m).getTime();
const blockAtTime = (t) => { const h = new Date(t).getHours() + new Date(t).getMinutes() / 60; return h >= 18 && h < 21 ? 'Evening' : h >= 21 && h < 21.5 ? 'Shorts' : h >= 21.5 ? 'Movie Night' : null; };

test('back-to-back: no waiting, no gaps, never off air — one continuous network', () => {
  const lib = fakeLib([['Drama', 40, 40], ['Short', 60, 5], ['Film', 20, 130]]);
  const s = new Scheduler(null, lib, seeded());
  const ch = network();
  s.ensure([ch], T0);
  const ps = s.stateOf(ch).programs.filter((p) => p.end > T0);
  for (let i = 1; i < ps.length; i++) assert.strictEqual(ps[i].start, ps[i - 1].end, `gap before ${ps[i].title}`);
  assert.ok(ps.every((p) => p.type === 'program'), 'only shows — no "Up next" waits, no off air: ' + [...new Set(ps.map((p) => p.type))]);
  // Each show comes from the block covering the moment it starts — or, between blocks, the last one (Movie Night carries on overnight).
  for (const p of ps) assert.strictEqual(p.block, blockAtTime(p.start) || 'Movie Night', `${p.title} at ${new Date(p.start).toTimeString().slice(0, 5)}`);
});

test('back-to-back: a block whose time comes mid-show takes over the moment that show ends', () => {
  const lib = fakeLib([['Drama', 40, 40], ['Short', 60, 5], ['Film', 20, 130]]);
  const s = new Scheduler(null, lib, seeded());
  const ch = network();
  s.ensure([ch], at(17, 0));
  const ps = s.stateOf(ch).programs;
  // At 18:00 a 2 h 10 min film from last night's Movie Night is still on: Evening begins the
  // moment it ends (not cut off, no waiting), then 40-minute dramas back to back.
  const atSix = ps.find((p) => p.start <= at(18) && at(18) < p.end);
  assert.strictEqual(atSix.block, 'Movie Night');
  const evening = ps.filter((p) => p.block === 'Evening' && p.start >= at(18) && p.start < at(21));
  assert.strictEqual(evening[0].start, atSix.end, 'Evening starts when the film ends');
  for (let i = 1; i < evening.length; i++) assert.strictEqual(evening[i].start, evening[i - 1].end);
  // The last drama started before 21:00 runs past it; Shorts start the moment it ends.
  const lastDrama = evening.at(-1);
  assert.ok(lastDrama.end > at(21));
  const firstShort = ps.find((p) => p.block === 'Shorts' && p.start >= at(21));
  assert.strictEqual(firstShort.start, lastDrama.end, 'shorts start the moment the drama ends — no waiting');
  // Shorts fill until a show starts at/after 21:30, then Movie Night takes over straight away.
  const firstFilm = ps.find((p) => p.block === 'Movie Night' && p.start >= at(21));
  const before = ps[ps.indexOf(firstFilm) - 1];
  assert.strictEqual(before.end, firstFilm.start);
  assert.ok(firstFilm.start >= at(21, 30) && firstFilm.start < at(21, 35), 'movie night starts right after the short playing at 21:30');
});

test('back-to-back: a live block (e.g. the 5 pm news) still starts exactly on time', () => {
  const lib = fakeLib([['Pool', 30, 50], ['Drama', 40, 40], ['Short', 60, 5], ['Film', 20, 130]]);
  const s = new Scheduler(null, lib, seeded());
  const ch = { ...network([{ id: 'news', name: 'News', days: ALL_DAYS, start: '17:00', end: '17:30', sources: [{ type: 'live', channelId: 'st', label: 'News' }] }]), sources: [{ type: 'show', key: 'Pool' }] };
  s.ensure([ch], at(12, 10));
  const ps = s.stateOf(ch).programs;
  const live = ps.find((p) => p.type === 'live');
  assert.strictEqual(live.start, at(17, 0));
  const before = ps[ps.indexOf(live) - 1];
  assert.ok(before.end <= at(17, 0), 'nothing runs into the news');
});
