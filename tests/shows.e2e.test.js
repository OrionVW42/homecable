// HCtorrents menu, TV shows and anime: hidden unless torrents are on; genres you like; seasons and
// episodes; what you own plays, and everything else says "No streams available".
// Temp data, silent test clips, off-screen. It looks up show facts online but never touches a
// swarm, tracker or torrent site: nothing here adds or searches for a torrent.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'homecable-shows-'));
const vids = data + '-media'; // outside the data folder, which is never scanned
const clip = (rel) => {
  const out = path.join(vids, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=5:d=240', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-shortest', out]);
};
fs.mkdirSync(data, { recursive: true });
clip('Breaking Bad/Season 1/Breaking.Bad.S01E01.mp4');
clip('Breaking Bad/Season 1/Breaking.Bad.S01E02.mp4');
clip('Neon Genesis Evangelion/Season 1/Neon.Genesis.Evangelion.S01E01.mp4');
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ updateOnStart: false, updateEvery: 'off', setupDone: true, tourDone: true, adsOn: false, seedDefault173: true, privacyClean173: true, torrentLock176: true }));

let app, page;
const nav = () => page.locator('.topbar .nav button', { hasText: 'HCtorrents' });
const openKind = async (name) => { await nav().click(); await page.locator('.drop-menu button', { hasText: name }).click(); };
const openTitle = async (title) => {
  await page.locator('.cat-search').fill(title);
  await page.locator('.cat-card', { hasText: title }).first().click();
  await page.locator('.cat-guide .cat-part').first().waitFor({ timeout: 45000 });
};

test.beforeAll(async () => {
  app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, HOMECABLE_DATA: data, HOMECABLE_VIDEOS: vids, HOMECABLE_MUTE: '1', HOMECABLE_NO_INSTALL: '1', HOMECABLE_OFFSCREEN: '1', HOMECABLE_NO_CAST: '1' } });
  page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.waitForFunction(() => window.tv);
  await page.waitForSelector('.topbar');
  await page.evaluate((f) => window.tv.scan([f]), vids);
});
test.afterAll(async () => { await app?.close().catch(() => {}); fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(vids, { recursive: true, force: true }); });

test('all hidden and refused until torrents are on', async () => {
  await expect(nav()).toHaveCount(0);
  await expect(page.locator('.topbar .nav button', { hasText: 'Movies' })).toHaveCount(0);
  expect(await page.evaluate(() => window.tv.catalogGuide('tv:Q1').then(() => '', (e) => e.message))).toMatch(/turned off/);
  expect(await page.evaluate(() => window.tv.moviesLock(true, true).then(() => 'on', (e) => e.message))).toMatch(/Turn on Torrents first/);
});

test('with torrents on, one menu: HCtorrents on top, then Movies, TV shows, Anime', async () => {
  await page.evaluate(async () => { await window.tv.torrentsLock(true, true); await window.tv.moviesLock(true, true); });
  await page.reload();
  await page.waitForSelector('.topbar');
  await nav().click();
  await expect(page.locator('.drop-menu button b')).toHaveText([/HCtorrents/, /Movies/, /TV shows/, /Anime/]);
  await page.locator('.drop-menu button', { hasText: 'HCtorrents' }).click();
  await expect(page.locator('.tor-view h2')).toHaveText('HCtorrents');
  await page.keyboard.press('Escape');
});

test('first visit asks which genres you like; those rows come first', async () => {
  await openKind('TV shows');
  await expect(page.locator('.cat-pick')).toBeVisible({ timeout: 20000 });
  await page.locator('.cat-pick-g', { hasText: 'Horror' }).click();
  await page.locator('.cat-pick-done').click();
  await expect(page.locator('.cat-row h3').first()).toBeVisible({ timeout: 20000 });
  const heads = await page.locator('.cat-row h3').allTextContents();
  expect(heads.filter((h) => h !== 'Ready to play')[0]).toBe('Horror');
  await expect(page.locator('.cat-hero')).toBeVisible();
  const liked = await page.evaluate(() => window.tv.state().then((s) => s.settings.catalogLikes));
  expect(liked.tv).toEqual(['Horror']);
});

test('a TV show has seasons; what you own plays, in order; the rest says no streams', async () => {
  await openTitle('Breaking Bad');
  const parts = await page.locator('.cat-part').allTextContents();
  expect(parts.filter((p) => /Season/.test(p)).length).toBe(5);
  await expect(page.locator('.cat-part').first()).toContainText('Season 1');
  expect(parts.some((p) => /El Camino/.test(p)), parts.join(', ')).toBe(true);
  expect(parts.some((p) => /Breaking Good/.test(p)), 'a parody is not part of the show').toBe(false);
  await expect(page.locator('.cat-ep.plays')).toHaveCount(2);
  await expect(page.locator('.cat-ep').first()).toContainText('Pilot');
  await page.locator('.cat-part', { hasText: 'Season 2' }).click();
  await expect(page.locator('.cat-part-head')).toContainText('No streams available');
  await expect(page.locator('.cat-ep.plays')).toHaveCount(0);
  await page.locator('.cat-part', { hasText: 'Season 1' }).click();
  await page.locator('.cat-part-head .cat-playbtn').click();
  await page.waitForSelector('.stage video', { timeout: 30000 });
  const first = await page.evaluate(() => document.querySelector('.stage video')?.currentSrc || '');
  expect(first).toBeTruthy();
  // The next episode is lined up: N moves on to it, and leaving goes back to the page.
  const src = () => page.evaluate(() => document.querySelector('.stage video')?.currentSrc || '');
  await page.keyboard.press('n');
  await expect.poll(src, { timeout: 20000 }).not.toBe(first);
  await page.keyboard.press('Escape');
  await expect(page.locator('.overlay.cat')).toBeVisible({ timeout: 10000 });
  const lib = await page.evaluate(() => window.tv.state().then((s) => s.settings.catalogSeen));
  const seen = Object.entries(lib).find(([k]) => k.startsWith('tv:'));
  expect(Object.keys(seen[1].eps).sort()).toEqual(['s1e1', 's1e2']);
});

test('anime has the franchise in watch order, with its movies', async () => {
  await page.locator('.cat-kinds button', { hasText: 'Anime' }).click();
  await page.locator('.cat-pick-go button', { hasText: 'Show everything' }).click();
  await page.locator('.cat-row').first().waitFor({ timeout: 20000 });
  await openTitle('Neon Genesis Evangelion');
  const parts = await page.locator('.cat-part').allTextContents();
  expect(parts[0]).toContain('Season 1');
  expect(parts.some((p) => /End of Evangelion/.test(p)), parts.join(', ')).toBe(true);
  await expect(page.locator('.cat-ep.plays')).toHaveCount(1);
  const g = await page.evaluate(async () => { const s = await window.tv.catalogBrowse({ kind: 'anime', q: 'Neon Genesis Evangelion' }); return window.tv.catalogGuide(s.items.find((m) => m.title === 'Neon Genesis Evangelion').id); });
  const dates = g.parts.map((p) => p.date).filter(Boolean);
  expect(dates, 'in the order they came out').toEqual([...dates].sort());
  expect(g.genres).toContain('Anime');
});

test('a show with nothing to play says so, and no torrent is ever started', async () => {
  await page.locator('.cat-back').click();
  await page.locator('.cat-kinds button', { hasText: 'TV shows' }).click();
  await openTitle('Friends');
  await expect(page.locator('.cat-guide-top .cat-nostream')).toHaveText('No streams available');
  await expect(page.locator('.cat-playbtn')).toHaveCount(0);
  await expect(page.locator('.cat-fullsearch')).toHaveCount(0);
  expect(await page.evaluate(() => window.tv.torrentsList?.().then((l) => l.length).catch(() => 0) ?? 0)).toBe(0);
});

test('the index tags what is in your library, and it stays out of your shows', async () => {
  await page.evaluate((f) => window.tv.scan([f]), vids);
  const shows = await page.evaluate(() => window.tv.shows());
  expect(shows.map((s) => s.name).sort(), 'only what you really have').toEqual(['Breaking Bad', 'Neon Genesis Evangelion']);
  expect(shows.find((s) => s.name === 'Neon Genesis Evangelion').genres).toContain('Anime');
  const bb = shows.find((s) => s.name === 'Breaking Bad').genres;
  expect(bb).toContain('Drama');
  expect(bb).not.toContain('Anime');
});
