// The Movies tab lives in Settings → Beta: off and refused until turned on, and free films play
// from the web without touching the torrent lock. Reaches archive.org over plain HTTPS only.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'homecable-movies-'));
const vids = path.join(data, 'videos');
fs.mkdirSync(vids);
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ updateOnStart: false, updateEvery: 'off', setupDone: true, tourDone: true, adsOn: false, seedDefault173: true, privacyClean173: true, torrentLock176: true }));
let app, page;
const FILM = { title: 'Night of the Living Dead', year: 1968 };
const seek = (o) => page.evaluate((x) => window.tv.catalogBrowse(x), o);
const settings = () => page.evaluate(() => window.tv.state().then((s) => s.settings));
const movie = async () => (await seek({ q: FILM.title })).items.find((m) => m.title === FILM.title && m.year === FILM.year);

test.beforeAll(async () => {
  app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, HOMECABLE_DATA: data, HOMECABLE_VIDEOS: vids, HOMECABLE_MUTE: '1', HOMECABLE_NO_INSTALL: '1', HOMECABLE_OFFSCREEN: '1', HOMECABLE_NO_CAST: '1' } });
  page = await app.firstWindow();
  await page.waitForFunction(() => window.tv);
  await page.waitForSelector('.topbar');
});
test.afterAll(async () => { await app?.close().catch(() => {}); fs.rmSync(data, { recursive: true, force: true }); });

test('off to begin with: no tab, and the app refuses to serve it', async () => {
  await expect(page.locator('.topbar .nav button', { hasText: 'Movies' })).toHaveCount(0);
  const err = await page.evaluate(() => window.tv.catalogHome().then(() => '', (e) => e.message));
  expect(err).toMatch(/Movies tab is turned off/);
});

test('Settings → Beta turns it on, and the tab works', async () => {
  await page.locator('.topbar .nav button', { hasText: 'Settings' }).click();
  await page.locator('.settings-jump button', { hasText: 'Beta' }).click();
  const refused = await page.evaluate(async () => { const a = await window.tv.moviesLock(true).then(() => 'on', (e) => e.message); await window.tv.setSettings({ moviesOn: true, moviesAccepted: true }); const b = await window.tv.catalogHome().then(() => 'served', (e) => e.message); return [a, b]; });
  expect(refused[0]).toMatch(/after accepting the warning/);
  expect(refused[1], 'settings can\'t turn it on either').toMatch(/turned off/);
  await page.locator('.settings-row', { hasText: 'Movies tab' }).getByRole('button', { name: 'Turn on…' }).click();
  const yes = page.getByRole('button', { name: 'Turn on the Movies tab' });
  await expect(page.locator('.consent-modal')).toContainText('“Free” isn’t a promise');
  await expect(yes).toBeDisabled();
  await page.locator('.consent-modal .consent-tick input').nth(0).check();
  await expect(yes, 'both boxes are needed').toBeDisabled();
  await page.locator('.consent-modal .consent-tick input').nth(1).check();
  await yes.click();
  await expect(page.locator('.topbar .nav button', { hasText: 'Movies' })).toHaveCount(1);
  await expect(page.locator('.settings-row', { hasText: 'How free films play' })).toHaveCount(1);
  await expect(page.locator('.seg button', { hasText: 'Through torrents' })).toBeDisabled();
  await page.locator('.topbar .nav button', { hasText: 'Movies' }).click();
  await expect(page.locator('.cat-row').first()).toBeVisible({ timeout: 20000 });
  expect((await movie())?.title).toBe(FILM.title);
});

test('free films off: nothing is asked of the Archive, and it says so', async () => {
  await page.evaluate(() => window.tv.setSettings({ moviesFree: false }));
  const m = await movie();
  expect(await page.evaluate((id) => window.tv.catalogSources(id), m.id)).toEqual([]);
  await page.evaluate(() => window.tv.setSettings({ moviesFree: true }));
});

test('with torrents locked, a free film really plays from the web and stays off the channels', async () => {
  test.setTimeout(120000);
  const m = await movie();
  const sources = await page.evaluate((id) => window.tv.catalogSources(id), m.id);
  expect(sources.length, 'the Archive has this film').toBeGreaterThan(0);
  expect(sources.every((s) => s.source === 'archive')).toBe(true);
  // Even asking for torrents can't get past the lock.
  await page.evaluate(() => window.tv.setSettings({ moviesPlayBy: 'torrent' }));
  await page.locator('.cat-search').fill(FILM.title);
  await page.locator('.cat-card', { hasText: FILM.title }).first().click();
  await page.locator('.cat-playbtn').first().click();
  await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.currentTime > 2 && !v.paused; }, null, { timeout: 90000 });
  expect(await page.evaluate(() => window.tv.torrents().then(() => 'ran', (e) => e.message))).toMatch(/Torrents are turned off/);
  const lib = JSON.parse(fs.readFileSync(path.join(data, 'library.json'), 'utf8'));
  const it = Object.values(lib.items).find((x) => x.catalogId === m.id);
  expect(it?.remote).toBe(true);
  expect(it?.url).toMatch(/^https:\/\/archive\.org\/download\//);
  expect(it?.catalogOnly).toBe(true);
  expect(fs.readdirSync(data).filter((f) => /torrent/i.test(f) && fs.statSync(path.join(data, f)).isDirectory() && fs.readdirSync(path.join(data, f)).length)).toEqual([]);
});

test('turned off, the tab leaves and the app refuses again', async () => {
  await page.evaluate(() => window.tv.moviesLock(false));
  expect(await page.evaluate(() => window.tv.catalogHome().then(() => '', (e) => e.message))).toMatch(/Movies tab is turned off/);
  expect((await settings()).moviesOn).toBe(false);
});
