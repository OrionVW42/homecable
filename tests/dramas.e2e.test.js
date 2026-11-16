// Short dramas: off and refused until turned on; YouTube series and channels play in YouTube's own
// player, in order, and it remembers where you stopped. Needs the internet (YouTube). Temp data,
// off-screen, muted. No torrents.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

test.skip(!!process.env.HOMECABLE_NO_NET, 'needs the internet');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'homecable-dramas-'));
const vids = path.join(data, 'videos');
fs.mkdirSync(vids);
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ updateOnStart: false, updateEvery: 'off', setupDone: true, tourDone: true, adsOn: false, seedDefault173: true, privacyClean173: true, torrentLock176: true }));
const SERIES = 'https://www.youtube.com/playlist?list=PLjUIVErGlv-QGTgBOIPllJzdqZEZCfTX5';
let app, page;
const call = (fn, ...a) => page.evaluate(([f, args]) => window.tv[f](...args).then((r) => ({ r }), (e) => ({ e: e.message })), [fn, a]);
const nav = () => page.locator('.topbar .drama-nav');
const wake = async () => { await page.mouse.move(300, 300); await page.mouse.move(320, 30); };

test.beforeAll(async () => {
  app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, HOMECABLE_DATA: data, HOMECABLE_VIDEOS: vids, HOMECABLE_MUTE: '1', HOMECABLE_NO_INSTALL: '1', HOMECABLE_OFFSCREEN: '1', HOMECABLE_NO_CAST: '1' } });
  page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.waitForFunction(() => window.tv);
  await page.waitForSelector('.topbar');
});
test.afterAll(async () => { await app?.close().catch(() => {}); try { fs.rmSync(data, { recursive: true, force: true }); } catch {} });

test('off to begin with: no button, and the app refuses it', async () => {
  await expect(nav()).toHaveCount(0);
  expect((await call('dramasHome')).e).toMatch(/turned off/);
  await call('setSettings', { dramasOn: true });
  expect((await call('dramasHome')).e, 'settings alone cannot turn it on').toMatch(/turned off/);
});

test('Settings → Free TV turns it on; the studios’ channels and a starter series are there', async () => {
  await wake();
  await page.locator('.topbar .nav button', { hasText: 'Settings' }).click();
  await page.locator('.settings-jump button', { hasText: 'Free TV' }).click();
  await page.locator('.settings-row', { hasText: 'Short dramas' }).locator('.toggle').click();
  await expect(nav()).toHaveCount(1);
  await nav().click();
  await expect(page.locator('.dramas-view .drama-card').first()).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.dramas-view')).toContainText('Cheer Up Baby!');
  await expect(page.locator('.dramas-view')).toContainText('Latest from DramaBox');
  expect(await page.locator('.drama-ch').first().locator('.drama-card').count(), 'the channel’s newest videos').toBeGreaterThan(3);
});

test('links: a playlist, a video and a channel are understood; anything else is explained', async () => {
  expect((await call('dramasAdd', SERIES)).r).toMatchObject({ already: true });
  expect((await call('dramasAdd', 'https://www.youtube.com/@dramaboxapp')).e).toMatch(/channel ID/);
  expect((await call('dramasAdd', 'https://example.com/watch?v=abc')).e).toMatch(/Only YouTube/);
  expect((await call('dramasAdd', 'https://www.youtube.com/playlist?list=PLnotARealPlaylist000000000000000')).e).toMatch(/private|exist/);
});

test('a series plays in YouTube’s player, lists every episode, and remembers where you are', async () => {
  test.setTimeout(180000);
  await page.locator('.drama-card', { hasText: 'Cheer Up Baby!' }).first().locator('.drama-open').click();
  await expect(page.locator('.drama-ep').nth(15), 'more than the feed’s 15').toBeVisible({ timeout: 60000 });
  await expect(page.locator('.drama-ep').first()).toContainText('Episode 1', { timeout: 30000 });
  // Playing: the bar counts up the episode, and progress is saved.
  await expect(page.locator('.drama-bar')).toContainText(/Episode 1 of \d+/, { timeout: 60000 });
  await page.locator('.drama-ep').nth(2).click();
  await expect(page.locator('.drama-bar')).toContainText(/Episode 3 of/, { timeout: 60000 });
  await expect.poll(async () => {
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'dramas.json'), 'utf8'));
    return saved.progress['pl:PLjUIVErGlv-QGTgBOIPllJzdqZEZCfTX5']?.i;
  }, { timeout: 90000, message: 'progress saved while it plays' }).toBe(2);
  await page.locator('.drama-bar').getByRole('button', { name: 'Back' }).click();
  await expect(page.locator('.dramas-view')).toContainText('Continue watching');
  await expect(page.locator('.drama-card', { hasText: 'Cheer Up Baby!' }).first()).toContainText('Episode 3');
});

test('turned off: the button goes and the app refuses again', async () => {
  await page.keyboard.press('Escape');
  await wake();
  await page.locator('.topbar .nav button', { hasText: 'Settings' }).click();
  await page.locator('.settings-jump button', { hasText: 'Free TV' }).click();
  await page.locator('.settings-row', { hasText: 'Short dramas' }).locator('.toggle').click();
  await expect(nav()).toHaveCount(0);
  expect((await call('dramasHome')).e).toMatch(/turned off/);
});
