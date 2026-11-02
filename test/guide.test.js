'use strict';
// Program guide matching (src/main/epg.js) and free-TV service detection (src/main/iptv.js).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const zlib = require('zlib');
const epg = require('../src/main/epg');
const iptv = require('../src/main/iptv');

const t = (d) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
const H = 3600e3, now = Date.now();
const xml = (chs, progs) => `<?xml version="1.0"?><tv>${chs.map(([id, n]) => `<channel id="${id}"><display-name>${n}</display-name></channel>`).join('')}${progs.map(([ch, s, e, title, extra = '']) => `<programme channel="${ch}" start="${t(new Date(s))}" stop="${t(new Date(e))}"><title>${title}</title>${extra}</programme>`).join('')}</tv>`;

let srv, base;
const files = {};
test.before(async () => {
  srv = http.createServer((req, res) => { const f = files[req.url]; if (!f) { res.statusCode = 404; return res.end(); } res.end(req.url.endsWith('.gz') ? zlib.gzipSync(f) : f); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(() => srv.close());

test('Pluto links are recognised, with their channel id', () => {
  const p = iptv.providerOf('https://jmp2.uk/plu-62ba60f059624e000781c436.m3u8');
  assert.strictEqual(p.name, 'Pluto TV');
  assert.strictEqual(p.id, '62ba60f059624e000781c436');
  assert.strictEqual(p.service, 'PlutoTV');
  assert.strictEqual(iptv.providerOf('https://ntv1.akamaized.net/hls/live/x/master.m3u8'), null);
});

test('guide ids match without the iptv-org feed suffix', () => {
  assert.strictEqual(epg.idKey('OnePiece.us@BR'), 'onepiece.us');
  assert.strictEqual(epg.countryOf('Tosh0.se@SD'), 'se');
});

test('provider schedule by id, no mixing, no name-borrowing, titles split', async () => {
  // A Pluto-style file (on the same mock path shape as i.mjh.nz)
  files['/i.mjh.nz/PlutoTV/us.xml.gz'] = xml([['62ba60f059624e000781c436', '00s Replay'], ['aaaaaaaaaaaaaaaaaaaaaaaa', 'NASA TV']], [
    ['62ba60f059624e000781c436', now - H / 2, now + 1234e3, 'Friends: The One With the Thumb', '<episode-num system="onscreen">S01E03</episode-num>'],
    ['62ba60f059624e000781c436', now + 1234e3, now + 2 * H, 'Friends: The One With George'],
    ['aaaaaaaaaaaaaaaaaaaaaaaa', now - H / 2, now + H, 'Pluto NASA show'],
  ]);
  // A generic country file that would ALSO list 00s Replay, at other times
  files['/epg_US.xml.gz'] = xml([['00sReplay.us', '00s Replay'], ['NASA.us', 'NASA TV'], ['StarTrek.us', 'Trek']], [
    ['00sReplay.us', now - H / 2, now + H / 2, 'Wrong times'],
    ['NASA.us', now - H / 2, now + H, 'Official NASA'],
    ['StarTrek.us', now - H / 2, now + H, 'Star Trek: The Next Generation', '<sub-title>Encounter</sub-title>'],
  ]);
  const stations = [
    { id: 'p', name: '00s Replay', tvgId: '00sReplay.us@SD', altId: '62ba60f059624e000781c436', service: 'PlutoTV' },
    { id: 'n', name: 'NASA TV', tvgId: 'NASA.us@HD' },
    { id: 's', name: 'Trek', tvgId: 'StarTrek.us' },
  ];
  const sources = {};
  // the mock URL needs the i.mjh.nz/<Service>/ shape to count as a provider file
  const g = await epg.buildGuide(stations, [`${base}/i.mjh.nz/PlutoTV/us.xml.gz`, `${base}/epg_US.xml.gz`], { sources });
  assert.deepStrictEqual(g.p.map((x) => [x.title, x.sub]), [['Friends', 'S1 · E3 · The One With the Thumb'], ['Friends', 'The One With George']]);
  assert.ok(!g.p.some((x) => x.title === 'Wrong times'), 'a later file never mixes into a filled station');
  assert.strictEqual(g.n[0].title, 'Official NASA', 'Pluto’s NASA TV is not handed to the official stream by name');
  assert.strictEqual(g.s[0].title, 'Star Trek: The Next Generation', 'titles with colons elsewhere stay whole');
  assert.match(sources.p, /Pluto TV/);
});

test('overlapping programmes (same channel listed twice) are dropped', () => {
  const out = epg.tidyList([{ start: 0, end: 30 * 60e3, title: 'A' }, { start: 10 * 60e3, end: 40 * 60e3, title: 'B' }, { start: 30 * 60e3, end: 60 * 60e3, title: 'C' }]);
  assert.deepStrictEqual(out.map((x) => x.title), ['A', 'C']);
});

test('split picture/sound playlists are read as two inputs', () => {
  const a = iptv.liveArgs({ url: 'https://x/master.m3u8' }, 'copy', { video: 'https://x/v.m3u8', audio: 'https://x/a.m3u8' });
  const i = a.map((x, k) => (x === '-i' ? a[k + 1] : null)).filter(Boolean);
  assert.deepStrictEqual(i, ['https://x/v.m3u8', 'https://x/a.m3u8']);
  assert.ok(a.includes('1:a:0') && a.includes('-max_interleave_delta'));
  const plain = iptv.liveArgs({ url: 'https://x/s.m3u8' }, 'copy');
  assert.strictEqual(plain.filter((x) => x === '-i').length, 1);
});
