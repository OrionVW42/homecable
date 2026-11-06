// Terms that changed since you last agreed are asked about once, and the TV waits for the answer.
// Temp data, off-screen, silent.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'homecable-terms-'));
const vids = path.join(data, 'videos');
fs.mkdirSync(vids);
const seed = (more) => fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ updateOnStart: false, updateEvery: 'off', setupDone: true, tourDone: true, adsOn: false, seedDefault173: true, privacyClean173: true, torrentLock176: true, ...more }));
const launch = async (dir = data) => {
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, HOMECABLE_NO_TERMS_ASK: '', HOMECABLE_DATA: dir, HOMECABLE_VIDEOS: vids, HOMECABLE_MUTE: '1', HOMECABLE_NO_INSTALL: '1', HOMECABLE_OFFSCREEN: '1', HOMECABLE_NO_CAST: '1' } });
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.tv);
  await page.waitForFunction(() => document.querySelector('.topbar, .terms-tick'));
  return { app, page };
};
const gate = (page) => page.locator('.terms-changed');
test.afterAll(() => { try { fs.rmSync(data, { recursive: true, force: true }); } catch {} });

test('agreed to older terms: asked, must tick, then never again', async () => {
  seed({ termsAccepted: '2026-11' });
  let { app, page } = await launch();
  await expect(gate(page)).toBeVisible();
  await expect(gate(page)).toContainText('play films through torrents');
  const go = page.getByRole('button', { name: 'Continue' });
  await expect(go).toBeDisabled();
  await gate(page).click({ position: { x: 5, y: 5 } });
  await expect(gate(page), 'clicking away does not dismiss it').toBeVisible();
  await page.locator('.terms-tick a').click();
  await expect(page.locator('.terms-text')).toContainText('opening a film you do not own');
  await page.locator('.modal-head .icon-btn').last().click();
  await page.locator('.terms-tick input').check();
  await go.click();
  await expect(gate(page)).toHaveCount(0);
  await app.close();
  ({ app, page } = await launch());
  await page.waitForTimeout(1500);
  await expect(gate(page), 'once only').toHaveCount(0);
  const s = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
  expect(s.termsAccepted).not.toBe('2026-11');
  await app.close();
});

test('never agreed in the app: asked; settings alone cannot answer', async () => {
  seed({});
  const { app, page } = await launch();
  await expect(gate(page)).toBeVisible();
  await page.evaluate(() => window.tv.setSettings({ termsAccepted: '2026-11-05' }));
  expect(await page.evaluate(() => window.tv.terms().then((t) => t.ask))).toBe(true);
  await app.close();
});

test('closing instead of agreeing leaves it unanswered', async () => {
  seed({ termsAccepted: '2026-11' });
  const { app, page } = await launch();
  const closed = new Promise((r) => page.once('close', r));
  await page.getByRole('button', { name: 'Close HomeCable' }).click();
  await closed;
  await app.close().catch(() => {});
  const s = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
  expect(s.termsAccepted).toBe('2026-11');
});

test('a child is not asked and cannot answer; the next grown-up is asked', async () => {
  seed({ termsAccepted: '2026-11' });
  const { app, page } = await launch();
  await expect(gate(page)).toBeVisible();
  await page.evaluate(async () => { await window.tv.saveProfile({ name: 'Sam', level: 'kids' }); const v = await window.tv.profiles(); await window.tv.switchProfile(v.list.find((x) => x.name === 'Sam').id); });
  await page.reload(); await page.waitForFunction(() => document.querySelector('.topbar, .picker, .modal'));
  await page.waitForTimeout(1000);
  await expect(gate(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.tv.termsAccept(true).then(() => 'took it', (e) => e.message))).toMatch(/grown-up/);
  await page.evaluate(async () => { const v = await window.tv.profiles(); await window.tv.switchProfile(v.list.find((x) => x.level === 'adults').id); });
  expect(await page.evaluate(() => window.tv.terms().then((t) => t.ask)), 'still unanswered').toBe(true);
  await app.close();
});

test('a brand new install answers in setup, with no second question', async () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'homecable-terms-new-'));
  const { app, page } = await launch(fresh);
  await expect(page.locator('.terms-tick')).toBeVisible();
  await expect(gate(page)).toHaveCount(0);
  await app.close();
  try { fs.rmSync(fresh, { recursive: true, force: true }); } catch {}
});
