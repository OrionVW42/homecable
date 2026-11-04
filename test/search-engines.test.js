// The built-in search engines, on saved answers — so a parser that stops matching is
// caught without the internet — and the rule that no torrent site ever ships.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { helpersFor, bytes, decode, strip, magnet } = require('../src/main/searchHelpers');

const h = helpersFor({});
const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'search', n), 'utf8');
const eng = (n) => require(`../src/main/searchEngines/${n}`);
const SINTEL = '08ada5a7a6183aae1e09d831df6748d566095a10';

test('helpers: sizes, entities, magnet links', () => {
  assert.equal(bytes('1.2 GB'), Math.round(1.2 * 1024 ** 3));
  assert.equal(bytes('523.5 MiB'), Math.round(523.5 * 1024 ** 2));
  assert.equal(bytes('700MB'), 700 * 1024 ** 2);
  assert.equal(bytes('1,234 bytes'), 1234);
  assert.equal(bytes(4096), 4096);
  assert.equal(bytes('n/a'), null);
  assert.equal(decode('Tom &amp; Jerry &#39;s &quot;day&quot; &#x3D; fun'), 'Tom & Jerry \'s "day" = fun');
  assert.equal(strip('  <b>Big</b>\n  <i>Buck</i>  Bunny &ndash; 4K '), 'Big Buck Bunny – 4K');
  assert.match(magnet(SINTEL.toUpperCase(), 'Sintel (2010)'), /^magnet:\?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel%20\(2010\)&tr=udp/);
  assert.equal(magnet('not a hash'), null);
});

test('every built-in engine says what the app needs', () => {
  const dir = path.join(__dirname, '..', 'src', 'main', 'searchEngines');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.deepEqual(files.sort(), ['internetarchive.js', 'jackett.js'], 'only these ship: no torrent sites, ever');
  for (const f of files) {
    const m = require(path.join(dir, f));
    assert.ok(m.name && typeof m.name === 'string', `${f}: name`);
    assert.match(m.version, /^\d+(\.\d+)*$/, `${f}: version`);
    assert.equal(typeof m.search, 'function', `${f}: search`);
    assert.ok(Array.isArray(m.categories) && m.categories.length, `${f}: categories`);
    for (const c of m.categories) assert.ok(['all', 'movies', 'tv', 'anime', 'music', 'games', 'software', 'books'].includes(c), `${f}: category ${c}`);
    if (m.url) assert.match(m.url, /^https?:\/\//, `${f}: url`);
  }
});

test('the app and its docs never name, list or link a torrent site', () => {
  const root = path.join(__dirname, '..');
  const banned = /pirate ?bay|apibay|\beztv|\bnyaa\b|1337x|torlock|bitsearch|solid ?torrents|torrentproject|torrents-csv|rarbg\.|yts\.|flaresolverr/i;
  const dir = path.join(root, 'src', 'main', 'searchEngines');
  const files = ['README.md', 'NOTICES.md', 'build/license.txt', 'docs/search-engines.md', 'src/renderer/torrentsview.js', 'src/main/search.js', 'src/main/searchHelpers.js', ...fs.readdirSync(dir).map((f) => 'src/main/searchEngines/' + f)];
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(root, f), 'utf8'), banned, f);
});

test('the Internet Archive engine only ever asks for free items', async () => {
  let asked = '';
  const fake = { json: async (url) => { asked = decodeURIComponent(url); return { response: { docs: [] } }; } };
  await eng('internetarchive').search('sintel', 'movies', fake);
  assert.match(asked, /licenseurl:\(\*publicdomain\* OR \*creativecommons\*\)/);
  assert.equal(eng('internetarchive').defaultOn, true);
});

test('Internet Archive: a search answer → web-seeded torrents', () => {
  const r = eng('internetarchive').parse(JSON.parse(fx('internetarchive.json')), h);
  assert.equal(r.length, 5);
  const s = r.find((x) => x.name === 'Sintel (2010)');
  assert.ok(s);
  assert.equal(s.link, 'https://archive.org/download/sintel_202604/sintel_202604_archive.torrent');
  assert.equal(s.descLink, 'https://archive.org/details/sintel_202604');
  assert.equal(s.size, 370588657);
  assert.equal(s.seeds, null); // web-seeded: always available
});

test('Jackett / Prowlarr: Torznab items, and its errors in its own words', () => {
  const j = eng('jackett');
  const r = j.parse(fx('torznab.xml'), h);
  assert.equal(r.length, 2);
  assert.equal(r[0].name, 'Sintel.2010.1080p.BluRay.x264');
  assert.match(r[0].link, /^magnet:\?xt=urn:btih:08ada5a7/); // magneturl beats link
  assert.equal(r[0].size, 1234567890);
  assert.equal(r[0].seeds, 12); assert.equal(r[0].leech, 8); // peers 20 - seeders 12
  assert.equal(r[0].descLink, 'https://indexer.example/details/1');
  assert.equal(r[1].link, 'http://127.0.0.1:9117/dl/x/?jackett_apikey=k&path=abc&file=Big+Buck+Bunny.torrent'); // no magnet: the .torrent link, entities decoded
  assert.equal(r[1].size, 276445467); // from the enclosure
  assert.throws(() => j.parse('<?xml version="1.0"?><error code="100" description="Invalid API Key" />', h), /Invalid API Key/);
  assert.rejects(() => j.search('x', 'all', helpersFor({ options: {} })), /needs its address and API key/);
});
