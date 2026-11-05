// Torrent search: a Torrents tab next to Library. Only the Internet Archive (free items)
// and a connector for your own server ship; you add anything else yourself, from a file
// or a link. A notice comes first; an engine installed from a link updates itself;
// searches go through the torrent network interface. Real app, off-screen, a temp data
// folder; an engine of our own plus two tiny local servers (an engine host, a Torznab
// indexer) make everything but the last live-sites test work without the internet.
//   npx playwright test tests/torrent-search.e2e.test.js      (HOMECABLE_NO_NET=1 skips the live test)
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const WS = '&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F';
const TR = '&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fexplodie.org%3A6969';
const SINTEL = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel' + TR + WS + '&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fsintel.torrent';
const BUNNY = 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny' + TR + WS + '&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fbig-buck-bunny.torrent';
// An engine of our own: one result with a link, one that gives its link from "its page" (resolve), one broken row.
const ENGINE = (version) => `module.exports = {
  name: 'Test engine', url: 'http://example.test', about: 'Made for the tests', version: '${version}', categories: ['all', 'movies'],
  async search(q, cat, h) {
    if (!/sintel|bunny/i.test(q)) return [];
    return [
      { name: 'Sintel (2010) &amp; friends', size: '129.3 MB', seeds: 42, leech: 3, link: ${JSON.stringify(SINTEL)}, descLink: 'http://example.test/sintel', pubDate: '2023-04-30' },
      { name: 'Big Buck Bunny test', size: 276445467, seeds: 7, leech: 1, page: 'http://example.test/bunny', descLink: 'http://example.test/bunny', pubDate: 1701325597 },
      { name: 'a row with no link at all' },
    ];
  },
  async resolve(r, h) { return { link: ${JSON.stringify(BUNNY)} }; },
};
`;
const TORZNAB = (q) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Local</title>
<item><title>Sintel via Torznab (${q})</title><guid>http://127.0.0.1/sintel</guid><comments>http://127.0.0.1/sintel</comments><pubDate>Sun, 30 Apr 2023 16:58:51 +0000</pubDate><size>129302391</size>
<link>http://127.0.0.1/dl/sintel.torrent</link><torznab:attr name="seeders" value="12" /><torznab:attr name="peers" value="20" /><torznab:attr name="magneturl" value="${SINTEL.replace(/&/g, '&amp;')}" /></item>
</channel></rss>`;

test.describe.configure({ mode: 'serial' });

let app, page, data, engineDir, engineVersion = '1.0', hits = [];
let engineSrv, torznabSrv, enginePort, torznabPort;
const settings = () => page.evaluate(() => window.tv.state().then((s) => s.settings));
const engines = () => page.evaluate(() => window.tv.searchEngines());
const torrents = () => page.evaluate(() => window.tv.torrentsList());
const TAB = { Search: '🔍 Search', 'My torrents': '🧲 My torrents', 'Search engines': '⚙ Search engines' };
const openTab = async (which) => {
  if (!(await page.locator('.overlay.tor-view').count())) await page.locator('.nav button', { hasText: 'Torrents' }).click();
  await expect(page.locator('.overlay.tor-view')).toBeVisible();
  await page.locator('.tor-tabs').getByRole('button', { name: TAB[which], exact: true }).click();
};
const row = (name) => page.locator('.eng-row', { hasText: name });
const results = () => page.locator('.sr-row:not(.head)');
const searchFor = async (q) => {
  await openTab('Search');
  await page.locator('.sr-bar input.q').fill(q);
  await page.locator('.sr-bar input.q').press('Enter');
  await expect(page.locator('.sr-status')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.sr-status')).not.toContainText('Searching…', { timeout: 90000 });
};
const statusOf = async (engine) => (await page.locator('.sr-status span', { hasText: engine }).first().textContent()).trim();

test.beforeAll(async () => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'homecable-search-'));
  engineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homecable-engine-'));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ torrentsOn: true, updateOnStart: false, updateEvery: 'off', setupDone: true, tourDone: true, torrentVpn: 'off', torrentVpnWarn: false, seedDefault173: true, torrentStopSeeding: false }));
  fs.writeFileSync(path.join(engineDir, 'testengine.js'), ENGINE('1.0'));
  // The engine, served over HTTP (install from a link, then an update).
  engineSrv = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/javascript'); res.end(req.url.startsWith('/test-engine.js') ? ENGINE(engineVersion) : 'not here'); });
  await new Promise((r) => engineSrv.listen(0, '127.0.0.1', r));
  enginePort = engineSrv.address().port;
  // A Torznab indexer of our own, like Jackett's.
  torznabSrv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    hits.push(Object.fromEntries(u.searchParams));
    res.setHeader('Content-Type', 'application/xml');
    if (u.searchParams.get('apikey') !== 'secret') return res.end('<?xml version="1.0"?><error code="100" description="Invalid API Key" />');
    res.end(TORZNAB(u.searchParams.get('q')));
  });
  await new Promise((r) => torznabSrv.listen(0, '127.0.0.1', r));
  torznabPort = torznabSrv.address().port;
  app = await electron.launch({ ...(process.env.HOMECABLE_EXE ? { executablePath: process.env.HOMECABLE_EXE, args: [] } : { args: [path.join(__dirname, '..')] }),
    env: { ...process.env, HOMECABLE_DATA: data, HOMECABLE_MUTE: '1', HOMECABLE_NO_INSTALL: '1', HOMECABLE_OFFSCREEN: '1', HOMECABLE_NO_CAST: '1' } });
  app.process().stderr.on('data', (d) => { const s = String(d); if (/search|torrent/i.test(s)) process.stdout.write('[main] ' + s); });
  page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.waitForFunction(() => window.tv);
});
test.afterAll(async () => { await app?.close(); engineSrv?.close(); torznabSrv?.close(); });

test('a Torrents tab next to Library: a notice first, then only the Internet Archive and the connector ship', async () => {
  const nav = page.locator('.nav button');
  await expect(nav.nth(1)).toHaveText(/Library/);
  await expect(nav.nth(2)).toHaveText(/Torrents/);
  await nav.nth(2).click();
  await expect(page.locator('.overlay.tor-view')).toBeVisible();
  await expect(page.locator('.tor-tabs button')).toHaveText([/Search/, /My torrents/, /Search engines/]);
  // The notice stands in front of Search and Search engines, once; My torrents doesn't need it.
  await expect(page.locator('.sr-terms')).toContainText('have the right to');
  await expect(page.locator('.sr-bar')).toHaveCount(0);
  await page.locator('.tor-tabs').getByRole('button', { name: TAB['My torrents'], exact: true }).click();
  await expect(page.locator('.sr-terms')).toHaveCount(0);
  await page.locator('.tor-tabs').getByRole('button', { name: TAB.Search, exact: true }).click();
  await page.getByRole('button', { name: 'I understand' }).click();
  await expect(page.locator('.sr-terms')).toHaveCount(0);
  expect((await settings()).searchTermsOk).toBe(true);
  await expect(page.locator('.sr-bar input.q')).toBeEnabled();
  await openTab('Search engines');
  const list = await engines();
  expect(list.map((e) => e.name).sort(), 'exactly these ship').toEqual(['Internet Archive', 'Jackett / Prowlarr']);
  expect(list.every((e) => e.builtin && !e.error), 'built in, and they load').toBe(true);
  expect(list.find((e) => e.id === 'internetarchive').enabled, 'the free archive is on').toBe(true);
  expect(list.find((e) => e.id === 'jackett').enabled, 'the connector is off until you set it up').toBe(false);
  await expect(page.locator('.eng-row')).toHaveCount(list.length);
  await expect(page.locator('.eng-row .toggle.on')).toHaveCount(1);
  await expect(page.locator('.tor-engines')).not.toContainText(/pirate|1337x|torlock/i);
  // Only your own engine during the offline tests below.
  await page.evaluate(() => window.tv.searchEnable('internetarchive', false));
  await expect(row('Jackett')).toContainText('Address'); // its settings, right in the row
  // Escape leaves; the Library's 🧲 button and Settings → Manage torrents both come here.
  await page.keyboard.press('Escape');
  await expect(page.locator('.overlay.tor-view')).toHaveCount(0);
  await page.keyboard.press('l');
  await page.getByRole('button', { name: '🧲 Torrents' }).click();
  await expect(page.locator('.overlay.tor-view')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('an engine of your own installs from a file, lands under Search engines, and starts on', async () => {
  const r = await page.evaluate((f) => window.tv.searchInstall(f), path.join(engineDir, 'testengine.js'));
  expect(r.id).toBe('testengine');
  expect(r.enabled).toBe(true);
  expect(fs.existsSync(path.join(data, 'search-engines', 'testengine.js')), 'copied into the user data folder').toBe(true);
  await openTab('Search engines');
  await expect(row('Test engine')).toBeVisible();
  await expect(row('Test engine')).toContainText('yours');
  await expect(row('Test engine')).toContainText('v1.0');
  await expect(row('Test engine').locator('.toggle')).toHaveClass(/\bon\b/);
  expect((await settings()).searchEngines.testengine).toBe(true);
  // Off and on again, from the row.
  await row('Test engine').locator('.toggle').click();
  await expect.poll(async () => (await settings()).searchEngines.testengine).toBe(false);
  await row('Test engine').locator('.toggle').click();
  await expect.poll(async () => (await settings()).searchEngines.testengine).toBe(true);
});

test('a search lists results as sites answer; Add makes a torrent that plays while it downloads', async () => {
  test.setTimeout(240000);
  await searchFor('sintel');
  await expect(results()).toHaveCount(2); // the row with no link is dropped
  await expect(page.locator('.sr-status')).toContainText('Test engine: 2');
  await expect(results().nth(0)).toContainText('Sintel (2010) & friends'); // most seeds first, entities decoded
  await expect(results().nth(0)).toContainText('42');
  await expect(results().nth(0)).toContainText('136 MB'); // "129.3 MB" the way sites mean it (1024-based), shown in MB
  await expect(results().nth(0).locator('.sr-eng')).toHaveText('Test engine');
  await expect(results().nth(1)).toContainText('Big Buck Bunny test');
  // Sort by name flips the order; the filter narrows.
  await page.locator('.sr-row.head button', { hasText: 'Name' }).click();
  await expect(results().nth(0)).toContainText('Big Buck Bunny');
  await page.getByPlaceholder('Narrow these results…').fill('sintel');
  await expect(results()).toHaveCount(1);
  await page.getByPlaceholder('Narrow these results…').fill('');
  // Add Sintel: a torrent in the library, the row says so, and My torrents has it.
  await results().filter({ hasText: 'Sintel' }).getByRole('button', { name: /Add/ }).click();
  await expect(results().filter({ hasText: 'Sintel' })).toContainText('Added', { timeout: 120000 });
  expect((await torrents()).some((t) => /sintel/i.test(t.name))).toBe(true);
  await results().filter({ hasText: 'Sintel' }).getByRole('button', { name: /Added/ }).click(); // → My torrents
  await expect(page.locator('.tor-card', { hasText: 'Sintel' })).toBeVisible();
  // Back to Search: the results are still there (the search lives on while you look elsewhere).
  await openTab('Search');
  await expect(results()).toHaveCount(2);
  // Add Big Buck Bunny: its link comes from "its page" (the engine's resolve).
  await results().filter({ hasText: 'Bunny' }).getByRole('button', { name: /Add/ }).click();
  await expect(results().filter({ hasText: 'Bunny' })).toContainText('Added', { timeout: 120000 });
  expect((await torrents()).some((t) => /bunny/i.test(t.name))).toBe(true);
  // A kind of thing the engine can't narrow to: it's skipped and says so.
  await page.locator('.sr-bar select').selectOption('tv');
  await searchFor('sintel');
  await expect(page.locator('.sr-status')).toContainText('Test engine: not for TV shows');
  await expect(page.locator('.sr-empty')).toContainText('Nothing found');
  await page.locator('.sr-bar select').selectOption('all');
  for (const t of await torrents()) await page.evaluate((id) => window.tv.torrentRemove(id, { keepFiles: false }), t.id);
});

test('Jackett / Prowlarr: asks for its settings, then searches your own Torznab indexer', async () => {
  await openTab('Search engines');
  await row('Jackett').locator('.toggle').click();
  await expect(row('Jackett').locator('.toggle')).toHaveClass(/\bon\b/);
  await searchFor('sintel');
  expect(await statusOf('Jackett')).toMatch(/needs its settings/);
  await openTab('Search engines');
  await row('Jackett').getByPlaceholder(/127\.0\.0\.1:9117/).fill(`http://127.0.0.1:${torznabPort}/api`);
  await row('Jackett').getByPlaceholder(/127\.0\.0\.1:9117/).press('Tab');
  await row('Jackett').locator('input[type=password]').fill('wrong');
  await row('Jackett').locator('input[type=password]').press('Tab');
  await expect.poll(async () => (await settings()).searchEngineOptions.jackett?.apiKey).toBe('wrong');
  await searchFor('sintel');
  expect(await statusOf('Jackett')).toMatch(/Invalid API Key/); // the indexer's own words
  await openTab('Search engines');
  await expect(row('Jackett')).toContainText('Invalid API Key'); // remembered on the engine, too
  await row('Jackett').locator('input[type=password]').fill('secret');
  await row('Jackett').locator('input[type=password]').press('Tab');
  await expect.poll(async () => (await settings()).searchEngineOptions.jackett?.apiKey).toBe('secret');
  await searchFor('sintel');
  await expect(page.locator('.sr-status')).toContainText('Jackett / Prowlarr: 1');
  const r = results().filter({ hasText: 'Sintel via Torznab' });
  await expect(r).toHaveCount(1);
  await expect(r.locator('.sr-eng')).toHaveText('Jackett / Prowlarr');
  await expect(r).toContainText('12'); // seeders from torznab:attr
  const last = hits[hits.length - 1];
  expect(last.t).toBe('search');
  expect(last.q).toBe('sintel');
  expect(last.apikey).toBe('secret');
});

test('an engine installed from a link checks for updates and can be removed', async () => {
  const r = await page.evaluate((u) => window.tv.searchInstall(u), `http://127.0.0.1:${enginePort}/test-engine.js`);
  expect(r.id).toBe('test-engine');
  expect(r.source).toContain('/test-engine.js');
  await openTab('Search engines');
  await expect(row('Test engine')).toHaveCount(2);
  await page.getByRole('button', { name: /Check for updates/ }).click();
  await expect(page.locator('.toast').last()).toContainText('up to date', { timeout: 15000 });
  engineVersion = '1.1';
  await page.getByRole('button', { name: /Check for updates/ }).click();
  await expect(page.locator('.toast').last()).toContainText('Updated Test engine to 1.1', { timeout: 15000 });
  const linked = page.locator('.eng-row', { hasText: '127.0.0.1' });
  await expect(linked).toContainText('v1.1');
  await expect(linked).toContainText('updates from 127.0.0.1');
  expect(fs.readFileSync(path.join(data, 'search-engines', 'test-engine.js'), 'utf8')).toContain("version: '1.1'");
  // Remove both of ours: two presses (the second confirms), the files and settings go with them.
  for (const x of [linked, row('Test engine')]) {
    await x.getByRole('button', { name: 'Remove' }).click();
    await x.getByRole('button', { name: 'Sure? Remove' }).click();
    await expect(x).toHaveCount(0);
  }
  await expect(row('Test engine')).toHaveCount(0);
  expect(fs.readdirSync(path.join(data, 'search-engines')).filter((f) => f.endsWith('.js'))).toEqual([]);
  const s = await settings();
  expect(s.searchEngines.testengine).toBeUndefined();
  expect(s.searchEngines['test-engine']).toBeUndefined();
  await row('Jackett').locator('.toggle').click(); // off again
});

test('live: the Internet Archive answers with free items', async () => {
  test.skip(!!process.env.HOMECABLE_NO_NET, 'needs the internet');
  test.setTimeout(240000);
  await page.evaluate(() => window.tv.searchEnable('internetarchive', true));
  await searchFor('big buck bunny');
  const report = async () => (await page.locator('.sr-status span').allTextContents()).map((s) => s.trim()).filter((s) => s && s !== 'Searching…');
  console.log('"big buck bunny":', (await report()).join(' | '));
  expect(await results().count(), 'results').toBeGreaterThan(0);
  for (const r of await page.locator('.sr-row:not(.head) .name b').allTextContents()) expect(r.trim().length).toBeGreaterThan(0);
  expect(await statusOf('Internet Archive'), 'the Internet Archive answers').toMatch(/Internet Archive: [1-9]/);
});

test('searches go through the torrent network interface', async () => {
  test.setTimeout(120000);
  for (const e of await engines()) await page.evaluate(([id, on]) => window.tv.searchEnable(id, on), [e.id, e.id === 'jackett' || e.id === 'internetarchive']);
  // Pinned to the loopback adapter: our local indexer (on 127.0.0.1) answers, the internet can't be reached.
  const lo = (await page.evaluate(() => window.tv.torrentInterfaces())).find((i) => i.internal && i.address === '127.0.0.1');
  expect(lo, 'a loopback interface').toBeTruthy();
  await page.evaluate((name) => window.tv.setSettings({ torrentInterface: name }), lo.name);
  await expect.poll(() => page.evaluate(() => window.tv.searchBound()), { timeout: 15000 }).toMatchObject({ state: 'ready', address: '127.0.0.1' });
  await searchFor('sintel');
  console.log('bound to loopback:', (await page.locator('.sr-status span').allTextContents()).join(' | '));
  await expect(page.locator('.sr-status')).toContainText('Jackett / Prowlarr: 1');
  expect(await statusOf('Internet Archive')).toMatch(/unreachable through the torrent network interface|site not found|no answer in time/);
  await page.evaluate(() => window.tv.setSettings({ torrentInterface: '' }));
  await expect.poll(() => page.evaluate(() => window.tv.searchBound()), { timeout: 15000 }).toMatchObject({ state: 'ready', address: null });
  for (const e of await engines()) await page.evaluate((id) => window.tv.searchEnable(id, false), e.id);
});
