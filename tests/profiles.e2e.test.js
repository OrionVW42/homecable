// Profiles: kids/teens/grown-ups, locks (PIN, controller combo), what each sees.
//   HOMECABLE_TEST_MEDIA=<folder of videos> npx playwright test profiles
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const MEDIA = process.env.HOMECABLE_TEST_MEDIA;
const SHOTS = path.join(__dirname, '..', 'test-results');
test.describe.configure({ mode: 'serial' });
test.skip(!MEDIA || !fs.existsSync(MEDIA), 'set HOMECABLE_TEST_MEDIA');

let app, page, data;
const launch = async () => {
  app = await electron.launch({ ...(process.env.HOMECABLE_EXE ? { executablePath: process.env.HOMECABLE_EXE, args: [] } : { args: [path.join(__dirname, '..')] }), env: { ...process.env, HOMECABLE_DATA: data, HOMECABLE_MUTE: '1' } });
  page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 860));
};
const state = () => page.evaluate(() => window.tv.state());

test.beforeAll(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'homecable-profiles-'));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ setupDone: true }));
  await launch();
  await page.evaluate((m) => window.tv.scan([m]), MEDIA);
  const shows = await page.evaluate(() => window.tv.shows());
  await page.evaluate((shows) => window.tv.createChannels([
    { name: 'Cartoons', rating: 'all', sources: [{ type: 'show', key: shows[0].key, label: shows[0].name }] },
    { name: 'Teen Stuff', rating: 'teen', sources: [{ type: 'show', key: shows[1].key, label: shows[1].name }] },
    { name: 'Grown-up Movies', rating: 'adult', sources: [{ type: 'kind', kind: 'movie', label: 'All movies' }] },
  ]), shows);
});
test.afterAll(async () => { await app?.close(); });

test('add a kid and lock the grown-up with a PIN (through the screens)', async () => {
  await page.keyboard.press('s');
  await page.getByRole('button', { name: 'Add someone' }).click();
  await page.locator('.modal input.big-input').fill('Sam');
  await page.locator('.modal .opt-choice', { hasText: 'Kid' }).click();
  await page.locator('.modal').getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.person', { hasText: 'Sam' })).toBeVisible();
  await page.locator('.person', { hasText: 'Me' }).getByRole('button', { name: 'Add lock' }).click();
  for (const round of [1, 2]) {
    for (const d of '2468') await page.locator('.modal .pin-key', { hasText: new RegExp(`^${d}$`) }).click();
    await page.locator('.modal .pin-key.go').click();
    if (round === 1) await expect(page.getByText('Once more to be sure')).toBeVisible();
  }
  await expect(page.locator('.person', { hasText: 'Me' })).toContainText('🔒 PIN');
  await page.screenshot({ path: path.join(SHOTS, 'profiles-01-people.png') });
  await page.keyboard.press('Escape');
});

test('the kid only sees channels for everyone and cannot change things', async () => {
  await page.locator('.who-chip').click();
  await expect(page.getByText('Who’s watching?')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'profiles-02-whos-watching.png') });
  await page.locator('.who-card', { hasText: 'Sam' }).click();
  await expect(page.locator('.who-chip')).toContainText('Sam');
  const s = await state();
  expect(s.channels.map((c) => c.name)).toEqual(['Cartoons']);
  expect(s.isAdult).toBe(false);
  await expect(page.locator('.topbar .nav button', { hasText: 'Channels' })).toHaveCount(0);
  await page.keyboard.press('s');
  await expect(page.getByText('Ask a grown-up to change settings')).toBeVisible();
  await page.keyboard.press('Escape');
  const err = await page.evaluate(() => window.tv.createChannels([{ name: 'Sneaky' }]).then(() => null, (e) => e.message));
  expect(err).toMatch(/grown-up/);
  // Library only offers what's on the kid's channels.
  const lib = await page.evaluate(() => window.tv.browse());
  expect(lib.items.every((i) => i.kind === 'episode')).toBe(true);
});

test('back to the grown-up: wrong PIN refused, right PIN works', async () => {
  await page.locator('.who-chip').click();
  await page.locator('.who-card', { hasText: 'Me' }).click();
  await expect(page.locator('.pin-pad')).toBeVisible();
  for (const d of '1111') await page.keyboard.press(d);
  await page.keyboard.press('Enter');
  await expect(page.locator('.lock-msg')).toContainText('not it');
  for (const d of '2468') await page.keyboard.press(d);
  await page.keyboard.press('Enter');
  await expect(page.locator('.who-chip')).toContainText('Me');
  expect((await state()).channels.length).toBe(3);
});

test('controller combo lock', async () => {
  await page.evaluate(() => window.tv.setLock('me', 'combo', ['UP', 'UP', 'DOWN', 'A']));
  await page.evaluate(async () => { const v = await window.tv.profiles(); await window.tv.switchProfile(v.list.find((p) => p.name === 'Sam').id); });
  await page.reload();
  await expect(page.getByText('Who’s watching?')).toBeVisible();
  await page.locator('.who-card', { hasText: 'Me' }).click();
  await expect(page.locator('.combo-row')).toBeVisible();
  for (const b of ['UP', 'DOWN', 'UP', 'A']) await page.evaluate((b) => window.__gamepadPress(b), b); // wrong
  await expect(page.locator('.lock-msg')).toContainText('not it');
  for (const b of ['UP', 'UP', 'DOWN', 'A']) await page.evaluate((b) => window.__gamepadPress(b), b);
  await page.screenshot({ path: path.join(SHOTS, 'profiles-03-combo.png') });
  await expect(page.locator('.who-chip')).toContainText('Me');
  expect((await state()).isAdult).toBe(true);
});

test('opening HomeCable asks who is watching', async () => {
  await app.close();
  await launch();
  await expect(page.getByText('Who’s watching?')).toBeVisible({ timeout: 15000 });
});
