// Torrents, the native way (1.6.1): a finished download says so up top and stops sharing on
// one press — then plays straight from disk; torrent movies land in On Demand by themselves;
// the Library's Edit button opens the editor (Ctrl + right-click hides); the storage limit clears only
// WATCHED videos and never kept ones; priority and "downloads at once" queue torrents.
// Real app, off-screen, a temp data folder; free Blender films (CC-BY). Needs the internet.
//   npx playwright test tests/torrent-manage.e2e.test.js      (HOMECABLE_NO_NET=1 skips)
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WS = '&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F';
const TR = '&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fexplodie.org%3A6969';
const SINTEL = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel' + TR + WS + '&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fsintel.torrent';
const BUNNY = 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny' + TR + WS + '&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fbig-buck-bunny.torrent';
const STEEL = 'magnet:?xt=urn:btih:209c8226b299b308beaf2b9cd3fb49212dbd13ec&dn=Tears+of+Steel' + TR + WS + '&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Ftears-of-steel.torrent';

test.describe.configure({ mode: 'serial' });
test.skip(!!process.env.HOMECABLE_NO_NET, 'needs the internet');

let app, page, data, sintel, sintelServer;
const list = () => page.evaluate(() => window.tv.torrentsList());
const items = () => page.evaluate(() => window.tv.browse().then((b) => b.items));

test.beforeAll(async () => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'homecable-torrent2-'));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ torrentsOn: true, updateOnStart: false, updateEvery: 'off', setupDone: true, tourDone: true, torrentVpn: 'off', torrentVpnWarn: false, seedDefault173: true, torrentStopSeeding: false }));
  app = await electron.launch({ ...(process.env.HOMECABLE_EXE ? { executablePath: process.env.HOMECABLE_EXE, args: [] } : { args: [path.join(__dirname, '..')] }),
    env: { ...process.env, HOMECABLE_DATA: data, HOMECABLE_MUTE: '1', HOMECABLE_NO_INSTALL: '1', HOMECABLE_OFFSCREEN: '1', HOMECABLE_NO_CAST: '1' } });
  page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.waitForFunction(() => window.tv);
  // An On Demand screen, so torrent movies have somewhere to go.
  const od = fs.mkdtempSync(path.join(os.tmpdir(), 'homecable-od-'));
  await page.evaluate((f) => window.tv.onDemandUseFolder(f), od);
});
test.afterAll(async () => { await app?.close(); });

test('a torrent movie lands in On Demand by itself, looked up and tagged', async () => {
  test.setTimeout(240000);
  const r = await page.evaluate((m) => window.tv.torrentAdd(m), SINTEL);
  expect(r.added).toBe(1);
  sintelServer = r.serverId;
  sintel = (await items()).find((i) => i.server === sintelServer);
  expect(sintel).toBeTruthy();
  const st = await page.evaluate(() => window.tv.state());
  const od = st.channels.find((c) => c.ondemand && (c.odStyle || 'movies') === 'movies');
  expect(od.sources.some((s) => s.type === 'torrent' && s.kind === 'movie'), 'On Demand got a "from torrents" source').toBe(true);
  await expect.poll(async () => (await page.evaluate((id) => window.tv.onDemandList(id), od.id))?.items?.some((m) => m.id === sintel.id), { timeout: 30000 }).toBe(true);
});

test('the Edit button opens the full editor; Ctrl + right-click hides', async () => {
  test.setTimeout(60000);
  await page.keyboard.press('l'); // the Library
  await page.waitForSelector('.lib-card', { timeout: 15000 });
  const card = page.locator('.lib-card', { hasText: 'Sintel' }).first();
  await card.hover();
  await card.locator('.lib-edit').click();
  await expect(page.locator('.od-art')).toBeVisible();
  await expect(page.locator('.od-art h3')).toContainText('Sintel');
  await expect(page.locator('.od-info')).toBeVisible({ timeout: 15000 }); // what it is, where it's from, where it plays
  await expect(page.locator('.od-info')).toContainText('Torrent');
  // What it most probably is (several sources agreeing), and its most likely cover big, with others beside it.
  await expect(page.locator('.od-match')).toContainText('Sintel', { timeout: 20000 });
  await expect(page.locator('.od-art-best img')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.od-art-best')).toContainText(/Most likely|Best guess/);
  expect(await page.locator('.od-art-pick .od-art-cand').count(), 'a few other covers to pick from').toBeGreaterThan(0);
  // "Show it on": the On Demand screen it's on, switchable from here
  const odChip = page.locator('.od-art .chip', { hasText: 'On Demand' }).first();
  await expect(odChip).toHaveClass(/\bon\b/);
  await odChip.click();
  await expect(odChip).not.toHaveClass(/\bon\b/);
  await odChip.click();
  await expect(odChip).toHaveClass(/\bon\b/);
  await expect(page.locator('.od-art').getByRole('button', { name: /Hide it/ })).toBeVisible(); // hiding is a deliberate button
  await expect(page.locator('.od-art').getByRole('button', { name: /Keep/ })).toBeVisible();
  await page.locator('.od-art').getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.od-art')).toHaveCount(0);
  expect((await items()).some((i) => i.id === sintel.id), 'still in the library (not hidden)').toBe(true);
  // A plain right-click does nothing; Ctrl + right-click is the quick "I don't want this".
  await card.click({ button: 'right' });
  await page.waitForTimeout(600);
  expect((await items()).some((i) => i.id === sintel.id), 'a plain right-click hides nothing').toBe(true);
  await card.click({ button: 'right', modifiers: ['Control'] });
  await expect(page.locator('.od-art')).toHaveCount(0); // no editor — it just hides
  await expect(page.locator('.lib-card', { hasText: 'Sintel' })).toHaveCount(0, { timeout: 10000 });
  await page.evaluate((id) => window.tv.itemsHide([id], false), sintel.id); // back for the next tests
  await expect.poll(async () => (await items()).some((i) => i.id === sintel.id), { timeout: 10000 }).toBe(true);
  await page.keyboard.press('Escape');
});

test('a finished download says so up top; "Stop sharing" makes it play from disk', async () => {
  test.setTimeout(420000);
  await expect(page.locator('.tor-done')).toBeVisible({ timeout: 400000 });
  await expect(page.locator('.tor-done')).toContainText('Sintel');
  await page.locator('.tor-done').getByRole('button', { name: /Stop sharing/ }).click();
  await expect.poll(async () => (await list()).find((t) => t.id === sintelServer)?.stopped, { timeout: 20000 }).toBe(true);
  await expect.poll(async () => (await items()).find((i) => i.id === sintel.id)?.remote, { timeout: 20000, message: 'it plays from the file on this PC now' }).toBe(false);
  const v = await page.evaluate((id) => window.tv.vod(id, 30), sintel.id);
  const played = await page.evaluate(async (url) => {
    const x = document.createElement('video'); x.muted = true; x.src = url; document.body.appendChild(x);
    await new Promise((ok, no) => { x.onloadedmetadata = ok; x.onerror = () => no(new Error('video error')); });
    x.currentTime = 60; await x.play(); await new Promise((r) => setTimeout(r, 2500));
    const t = x.currentTime; x.remove(); return t;
  }, v.play.url);
  expect(played).toBeGreaterThan(60);
});

test('the storage limit clears only watched videos — and never kept ones', async () => {
  test.setTimeout(120000);
  await page.evaluate((id) => window.tv.saveProgress({ id, pos: 880, len: 888, finished: true }), sintel.id);
  await page.evaluate((s) => window.tv.torrentKeep(s, true), sintelServer);
  await page.evaluate(() => window.tv.setSettings({ torrentLimitGB: 0.001 })); // 1 MB: way over
  await page.waitForTimeout(4000);
  expect((await items()).some((i) => i.id === sintel.id), 'kept: not removed').toBe(true);
  await page.evaluate((s) => window.tv.torrentKeep(s, false), sintelServer);
  await page.evaluate(() => window.tv.setSettings({ torrentLimitGB: 0.002 }));
  await expect.poll(async () => (await items()).some((i) => i.id === sintel.id), { timeout: 30000 }).toBe(false);
  const folder = path.join(data, 'torrents', sintelServer.replace('torrent:', '').slice(0, 16));
  const left = fs.existsSync(folder) ? fs.readdirSync(folder, { recursive: true }).filter((f) => /\.mp4$/i.test(f)) : [];
  expect(left, 'its file is deleted').toEqual([]);
  await page.evaluate(() => window.tv.setSettings({ torrentLimitGB: 100 }));
});

test('priority and "downloads at once": the rest wait their turn, High goes first', async () => {
  test.setTimeout(300000);
  await page.evaluate(() => window.tv.setSettings({ torrentMaxActive: 1 }));
  const a = await page.evaluate((m) => window.tv.torrentAdd(m), BUNNY);
  const b = await page.evaluate((m) => window.tv.torrentAdd(m), STEEL);
  const state = async () => Object.fromEntries((await list()).map((t) => [t.id, t.queued ? 'queued' : t.done ? 'done' : 'active']));
  await expect.poll(async () => (await state())[b.serverId], { timeout: 60000 }).toBe('queued');
  expect((await state())[a.serverId]).not.toBe('queued');
  await page.evaluate((id) => window.tv.torrentPriority(id, 'high'), b.serverId);
  await expect.poll(async () => (await state())[b.serverId], { timeout: 60000 }).not.toBe('queued');
  await expect.poll(async () => { const s = await state(); return s[a.serverId] === 'queued' || s[a.serverId] === 'done'; }, { timeout: 60000 }).toBe(true);
  for (const id of [a.serverId, b.serverId]) await page.evaluate((x) => window.tv.torrentRemove(x, { keepFiles: false }), id);
});
