const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { buildSeries, cleanName } = require('../src/main/series');

const ROOT = path.resolve('/videos/HomeStreamer');
let n = 0;
const it = (rel, extra = {}) => ({ id: 'i' + ++n, path: path.join(ROOT, ...rel.split('/')), kind: 'episode', duration: 1400, title: path.basename(rel), ...extra });

test('series names lose release tags', () => {
  assert.strictEqual(cleanName('[Doutei] Kodomo no Jikan Compete v2 [DVD]'), 'Kodomo no Jikan');
  assert.strictEqual(cleanName('Loveless [v2][DVD][Soldado]'), 'Loveless');
  assert.strictEqual(cleanName('Kanamemo 01-13 (complete) HD ('), 'Kanamemo');
  assert.strictEqual(cleanName('OniAi +SP 10 bits DD -EMBER'), 'OniAi');
  assert.strictEqual(cleanName('The Office (US) Season 1-9 1080p'), 'The Office');
  assert.strictEqual(cleanName('The Middle'), 'The Middle'); // "dd" inside a word stays
});

test('one series per folder; subfolders are seasons; specials and extras last; episodes in order', () => {
  const items = [
    it('[Doutei] Show A [DVD]/OADs/[Doutei] Show A OAD - Two.mkv', { title: 'Two', season: 1, episode: 2 }),
    it('[Doutei] Show A [DVD]/Nigakki/[Doutei] Show A Nigakki 02.mkv', { season: 1, episode: 2 }),
    it('[Doutei] Show A [DVD]/1st Season/[Doutei] Show A 10.mkv', { season: 1, episode: 10 }),
    it('[Doutei] Show A [DVD]/1st Season/[Doutei] Show A 02.mkv', { season: 1, episode: 2 }),
    it('[Doutei] Show A [DVD]/Nigakki/[Doutei] Show A Nigakki 01.mkv', { season: 1, episode: 1 }),
    it('[Doutei] Show A [DVD]/Nigakki/Show A Nigakki 03 Omake - Creditless Ending.mkv', { kind: 'short', duration: 100 }),
    it('[Doutei] Show A [DVD]/OADs/[Doutei] Show A OAD - One.mkv', { title: 'One', season: 1, episode: 1 }),
    it('[Doutei] Show A [DVD]/OADs/[Doutei] Show A OAD - Movie.mkv', { kind: 'movie', duration: 5000 }),
    it('Loveless [v2][DVD][Soldado]/[Soldado]_Loveless_02v3_[DVD].mkv', { season: 1, episode: 2 }),
    it('Loveless [v2][DVD][Soldado]/[Soldado]_Loveless_01v3_[DVD].mkv', { season: 1, episode: 1 }),
    it('Loveless [v2][DVD][Soldado]/Extras/[Soldado]_Loveless_NCED_(Episode_01).mkv', { kind: 'short', duration: 90 }),
    it('Loose Movie (2001).mp4', { kind: 'movie', duration: 6000 }),
  ];
  const { series, loose } = buildSeries(items, [ROOT]);
  const byId = Object.fromEntries(items.map((x) => [x.id, x]));
  const shape = Object.fromEntries(series.map((s) => [s.name, s.seasons.map((se) => [se.label, se.ids.map((id) => path.basename(byId[id].path))])]));
  assert.deepStrictEqual(Object.keys(shape), ['Loveless', 'Show A']);
  assert.deepStrictEqual(shape['Show A'].map(([l]) => l), ['Season 1', 'Nigakki', 'OADs', 'Extras']);
  assert.deepStrictEqual(shape['Show A'][0][1], ['[Doutei] Show A 02.mkv', '[Doutei] Show A 10.mkv']);       // 2 before 10
  assert.deepStrictEqual(shape['Show A'][1][1], ['[Doutei] Show A Nigakki 01.mkv', '[Doutei] Show A Nigakki 02.mkv']);
  assert.strictEqual(shape['Show A'][2][1].length, 3, 'OADs keep the long special too');
  assert.deepStrictEqual(shape['Show A'][3][1], ['Show A Nigakki 03 Omake - Creditless Ending.mkv'], 'short clips go to Extras');
  assert.deepStrictEqual(shape.Loveless.map(([l, f]) => [l, f.length]), [['Season 1', 2], ['Extras', 1]]);
  assert.deepStrictEqual(shape.Loveless[0][1], ['[Soldado]_Loveless_01v3_[DVD].mkv', '[Soldado]_Loveless_02v3_[DVD].mkv']);
  assert.deepStrictEqual(loose.map((x) => x.title), ['Loose Movie (2001).mp4'], 'a loose file in the root is not a series');
});

test('shows from elsewhere in the library group by show and season number', () => {
  const items = [
    { id: 'x2', path: path.resolve('/other/Show B/Season 2/Show.B.S02E01.mkv'), kind: 'episode', show: 'Show B', showKey: 'showb', season: 2, episode: 1, duration: 1300 },
    { id: 'x1', path: path.resolve('/other/Show B/Season 1/Show.B.S01E01.mkv'), kind: 'episode', show: 'Show B', showKey: 'showb', season: 1, episode: 1, duration: 1300 },
  ];
  const { series } = buildSeries(items, [ROOT]);
  assert.deepStrictEqual(series.map((s) => [s.name, s.seasons.map((se) => se.label)]), [['Show B', ['Season 1', 'Season 2']]]);
});
