// A torrent as a source, end to end in the real app. Sintel (Blender
// Foundation, CC-BY) from its public magnet link: it becomes a library item
// while still downloading, plays on a channel through the real player, seeks
// far ahead of what's on disk (direct and through ffmpeg), survives a restart,
// and goes away cleanly. Needs the internet (peers / webseed).
//   npx playwright test tests/torrent.e2e.test.js      (HOMECABLE_NO_NET=1 skips)
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const MAGNET = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.coppersurfer.tk%3A6969&tr=udp%3A%2F%2Ftracker.empire-js.us%3A1337&tr=udp%3A%2F%2Ftracker.leechers-paradise.org%3A6969&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=wss%3A%2F%2Ftracker.fastcast.nz&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fsintel.torrent';

test.describe.configure({ mode: 'serial' });
test.skip(!!process.env.HOMECABLE_NO_NET, 'needs the internet');

let app, page, data, item, serverId;
// HOMECABLE_EXE=dist/win-unpacked/HomeCable.exe runs the packaged build instead of the source.
// HOMECABLE_NO_INSTALL: the real updater must never run an installer from a test (it did once: a
// newer upstream release had been fetched in the background and the packaged build installed it).
const launch = async () => {
  app = await electron.launch({ ...(process.env.HOMECABLE_EXE ? { executablePath: process.env.HOMECABLE_EXE, args: [] } : { args: [path.join(__dirname, '..')] }), env: { ...process.env, HOMECABLE_DATA: data, HOMECABLE_MUTE: '1', HOMECABLE_NO_INSTALL: '1' } });
  page = await app.firstWindow();
  app.process().stderr?.on('data', (d) => { const s = String(d).trim(); if (s) console.log('[main stderr]', s.slice(0, 1500)); });
  page.on('console', (m) => { if (m.type() === 'error') console.log('[renderer]', m.text()); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 860));
};
const torrentStatus = () => page.evaluate((sid) => window.tv.torrents().then((l) => l.find((t) => t.id === sid) || null), serverId);
const libraryItems = () => page.evaluate(() => window.tv.browse().then((b) => b.items)); // full summaries (remote, server…)
const pct = (st) => (st ? `${Math.round(st.progress * 100)}% · ${st.peers} peers · ${Math.round(st.downloadSpeed / 1e3)} kB/s` : 'gone');

// Plays `url` in a fresh <video> and waits until the clock passes `until` seconds.
const playUntil = (url, { seek = 0, until }) => page.evaluate(async ({ url, seek, until }) => {
  const v = document.createElement('video');
  v.muted = true; v.src = url; document.body.appendChild(v);
  const t0 = performance.now();
  try {
    await new Promise((ok, no) => { v.addEventListener('loadedmetadata', ok, { once: true }); v.addEventListener('error', () => no(new Error('video error ' + v.error?.code)), { once: true }); });
    if (seek) v.currentTime = seek;
    await v.play();
    await new Promise((ok, no) => {
      const k = setInterval(() => {
        if (v.error) { clearInterval(k); no(new Error('video error ' + v.error.code)); }
        if (v.currentTime >= until) { clearInterval(k); ok(); }
      }, 100);
      setTimeout(() => { clearInterval(k); no(new Error(`still at ${v.currentTime.toFixed(1)}s after 90s`)); }, 90000);
    });
    return { ms: Math.round(performance.now() - t0), at: +v.currentTime.toFixed(1), width: v.videoWidth, duration: Math.round(v.duration) };
  } finally { v.pause(); v.remove(); }
}, { url, seek, until });

test.beforeAll(async () => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'homecable-torrent-'));
  // No update checks or downloads during a test (the packaged build would also open its updater window first).
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ torrentsOn: true, updateOnStart: false, updateEvery: 'off', torrentVpn: 'off', torrentVpnWarn: false, seedDefault173: true, torrentStopSeeding: false }));
  await launch();
  await expect(page.getByText('Set it all up for me', { exact: true })).toBeVisible({ timeout: 15000 });
});
test.afterAll(async () => { await app?.close(); });

test('a magnet link becomes a library item before the download has finished', async () => {
  test.setTimeout(240000);
  const r = await page.evaluate((m) => window.tv.addSources([{ type: 'torrent', link: m }]), MAGNET);
  expect(r.added).toBe(1); // Sintel.mp4 — the subtitle files and the poster are not media
  const items = await libraryItems();
  item = items.find((i) => i.server && i.server.startsWith('torrent:'));
  expect(item).toBeTruthy();
  serverId = item.server;
  expect(item.remote).toBe(true);
  expect(item.path).toBe('Torrents/Sintel/Sintel.mp4');
  expect(Math.round(item.duration)).toBe(888); // the probe read the index at the tail of the file
  expect(item.mode).toBe('direct');            // H.264 + AAC in MP4: Chromium plays it as-is
  const st = await torrentStatus();
  console.log('after add:', pct(st));
  expect(st.progress).toBeLessThan(1);
});

test('plays on a cable channel through the real player', async () => {
  test.setTimeout(180000);
  await page.evaluate((sid) => window.tv.createChannels([{ name: 'T Torrent', order: 'ordered', align: 0, sources: [{ type: 'server', id: sid }] }]), serverId);
  await page.evaluate(() => window.tv.setSettings({ setupDone: true }));
  await page.reload();
  await page.waitForSelector('.stage video');
  const ch = (await page.evaluate(() => window.tv.state())).channels.find((c) => c.name === 'T Torrent');
  expect(ch).toBeTruthy();
  let tuned = await page.evaluate((id) => window.tv.tune(id), ch.id);
  // Tuned in during a channel bumper (or a break): let it finish, then look again.
  for (let i = 0; i < 5 && tuned.entry && !tuned.play; i++) {
    await page.waitForTimeout(Math.min(12000, Math.max(500, tuned.entry.end - Date.now() + 400)));
    tuned = await page.evaluate((id) => window.tv.tune(id), ch.id);
  }
  expect(tuned.play, 'the channel is airing the torrent').toBeTruthy();
  expect(tuned.entry.itemId).toBe(item.id);
  const res = await page.waitForFunction(({ itemId, mode, offset }) => {
    const v = document.querySelector('.stage video');
    const err = document.querySelector('.error-screen');
    if (err) return { ok: false, why: err.textContent };
    if (!v || !v.currentSrc.includes('/' + itemId + '?')) return null;
    const pos = mode === 'direct' ? v.currentTime : offset + v.currentTime;
    return v.currentTime > (mode === 'direct' ? 1 : 1.5) && !v.paused
      ? { ok: Math.abs(pos - offset) < 20, t: +v.currentTime.toFixed(1), live: Math.round(pos), width: v.videoWidth } : null;
  }, { itemId: item.id, mode: tuned.play.mode, offset: tuned.offset }, { timeout: 60000, polling: 250 }).then((h) => h.jsonValue());
  console.log('on the channel:', res, '| torrent', pct(await torrentStatus()));
  expect(res.ok, res.why).toBe(true);
  expect(res.width).toBeGreaterThan(0);
});

// Big Buck Bunny (Blender Foundation, CC-BY), through the real Library → Add sources dialog.
const MAGNET2 = 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.coppersurfer.tk%3A6969&tr=udp%3A%2F%2Ftracker.empire-js.us%3A1337&tr=udp%3A%2F%2Ftracker.leechers-paradise.org%3A6969&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=wss%3A%2F%2Ftracker.fastcast.nz&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fbig-buck-bunny.torrent';
test('the Add sources dialog takes a magnet link', async () => {
  test.setTimeout(240000);
  await page.keyboard.press('Escape');
  await page.keyboard.press('l');
  await expect(page.getByText('Drag here to add to a channel')).toBeVisible();
  await page.getByRole('button', { name: 'Add sources' }).first().click();
  await page.getByPlaceholder(/Magnet link/).fill(MAGNET2);
  await page.getByRole('button', { name: 'Add torrent' }).click();
  await expect(page.getByText('Big Buck Bunny', { exact: true })).toBeVisible(); // named from the link's dn=
  await expect(page.getByText('Torrent — plays while it downloads')).toBeVisible();
  await expect(page.getByText('1 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Add & scan' }).click();
  await expect(page.getByText('Added 1 new files from 1 source')).toBeVisible({ timeout: 120000 });
  const items = await libraryItems();
  const bunny = items.find((i) => i.path === 'Torrents/Big Buck Bunny/Big Buck Bunny.mp4');
  expect(bunny).toBeTruthy();
  expect(Math.round(bunny.duration)).toBe(635); // 10:35 — read from the file's index while it downloads
  console.log('via the dialog:', bunny.title, '|', pct(await page.evaluate((sid) => window.tv.torrents().then((l) => l.find((t) => t.id === sid)), bunny.server)));
  await page.keyboard.press('Escape');
});

test('seeks far ahead of the download: direct through the media server, and through ffmpeg', async () => {
  test.setTimeout(240000);
  const vod = await page.evaluate((id) => window.tv.vod(id, 0), item.id);
  expect(vod.play.mode).toBe('direct');
  // Direct: the <video> asks the media server for bytes near the end; those pieces arrive first.
  console.log('before the direct seek: torrent', pct(await torrentStatus()));
  const direct = await playUntil(vod.play.url, { seek: 700, until: 702 });
  console.log('direct seek to 700 s:', direct, '| torrent', pct(await torrentStatus()));
  expect(direct.at).toBeGreaterThanOrEqual(702);
  expect(direct.width).toBeGreaterThan(0);
  expect(direct.duration).toBe(888);
  // ffmpeg: a remux from 300 s — how non-native formats, dubs and burned-in subtitles are served.
  const url = await page.evaluate((id) => window.tv.altStreamUrl(id, { t: 300, remux: true }), item.id);
  expect(url).toContain('/stream/');
  const remux = await playUntil(url, { until: 3 });
  console.log('ffmpeg remux from 300 s:', remux, '| torrent', pct(await torrentStatus()));
  expect(remux.at).toBeGreaterThanOrEqual(3);
  expect(remux.width).toBeGreaterThan(0);
});

test('pins torrent traffic to the chosen network interface, and stops when it leads nowhere', async () => {
  test.setTimeout(240000);
  const ifaces = await page.evaluate(() => window.tv.torrentInterfaces());
  const lo = ifaces.find((i) => i.address === '127.0.0.1');
  expect(lo, 'a loopback interface to bind to').toBeTruthy();
  // Loopback can reach nobody: the same situation as a VPN adapter whose tunnel is down.
  await page.evaluate((n) => window.tv.setSettings({ torrentInterface: n }), lo.name);
  await expect.poll(() => page.evaluate(() => window.tv.torrentBound()), { timeout: 30000 }).toMatchObject({ state: 'ready', address: '127.0.0.1' });
  await page.waitForTimeout(15000);
  const pinned = await page.evaluate(() => window.tv.torrents());
  console.log('bound to loopback:', pinned.map((t) => `${t.name}: ${t.peers} peers, ${Math.round(t.downloadSpeed / 1e3)} kB/s`).join(' | '));
  expect(pinned.length).toBe(2);
  expect(pinned.every((t) => t.peers === 0)).toBe(true);
  // Back to any interface: the swarm returns, and every item points at the new stream address.
  await page.evaluate(() => window.tv.setSettings({ torrentInterface: '' }));
  await expect.poll(() => page.evaluate(() => window.tv.torrentBound()), { timeout: 30000 }).toMatchObject({ state: 'ready', address: null });
  await expect.poll(() => page.evaluate(() => window.tv.torrents().then((l) => l.reduce((n, t) => n + t.peers, 0))), { timeout: 90000 }).toBeGreaterThan(0);
  const vod = await page.evaluate((id) => window.tv.vod(id, 0), item.id);
  const play = await playUntil(vod.play.url, { seek: 100, until: 102 });
  console.log('rebound to any interface, seek to 100 s:', play, '|', pct(await torrentStatus()));
  expect(play.at).toBeGreaterThanOrEqual(102);
});

test('the Torrents tab lists, picks files, pauses and forgets', async () => {
  test.setTimeout(240000);
  await page.keyboard.press('Escape');
  await page.keyboard.press('s'); // Settings → Manage torrents opens the Torrents tab, on My torrents
  await page.getByRole('button', { name: /Manage torrents/ }).click();
  await expect(page.locator('.overlay.tor-view')).toBeVisible();
  await page.locator('.tor-tabs button', { hasText: 'My torrents' }).click();
  const card = (name) => page.locator('.tor-card', { hasText: name });
  await expect(card('Sintel')).toBeVisible();
  await expect(card('Big Buck Bunny')).toBeVisible();
  await expect(card('Sintel')).toContainText('%');
  // Files: untick Sintel.mp4 → it leaves the library; tick it again → it's back (probed again).
  await card('Sintel').getByRole('button', { name: /Files \(/ }).click();
  const mp4 = card('Sintel').locator('.tor-file', { hasText: 'Sintel.mp4' });
  await expect(mp4).toBeVisible();
  await expect(card('Sintel').locator('.tor-file')).toHaveCount(11);
  await mp4.locator('input').click();
  await expect.poll(() => libraryItems().then((l) => l.some((i) => i.id === item.id)), { timeout: 20000 }).toBe(false);
  await expect(card('Sintel')).toContainText('0 downloading');
  await mp4.locator('input').click();
  await expect.poll(() => libraryItems().then((l) => l.some((i) => i.id === item.id)), { timeout: 90000 }).toBe(true);
  await expect(card('Sintel')).toContainText('1 downloading');
  // Pause Big Buck Bunny: out of the swarm, its videos off the channels; resume brings it back.
  await card('Big Buck Bunny').getByRole('button', { name: /Pause/ }).click();
  await expect(card('Big Buck Bunny')).toContainText('Paused');
  await expect.poll(() => page.evaluate(() => window.tv.torrents().then((l) => l.length)), { timeout: 20000 }).toBe(1);
  const bunny = (await libraryItems()).find((i) => i.path === 'Torrents/Big Buck Bunny/Big Buck Bunny.mp4');
  expect(bunny, 'a paused torrent keeps its library entry').toBeTruthy();
  await card('Big Buck Bunny').getByRole('button', { name: /Resume/ }).click();
  await expect.poll(() => page.evaluate(() => window.tv.torrents().then((l) => l.length)), { timeout: 90000 }).toBe(2);
  await expect(card('Big Buck Bunny')).not.toContainText('Paused');
  await expect(card('Big Buck Bunny')).not.toContainText('Starting', { timeout: 60000 }); // back in the swarm, files re-selected
  // Forget Big Buck Bunny, files and all.
  await card('Big Buck Bunny').getByRole('button', { name: /Forget/ }).click();
  await page.getByRole('button', { name: 'Remove & delete files' }).click();
  await expect(card('Big Buck Bunny')).toHaveCount(0);
  await expect.poll(() => fs.readdirSync(path.join(data, 'torrents')).length, { timeout: 15000 }).toBe(1);
  expect((await libraryItems()).some((i) => i.path.startsWith('Torrents/Big Buck Bunny'))).toBe(false);
  await page.keyboard.press('Escape');
});

test('comes back after a restart and still plays', async () => {
  test.setTimeout(180000);
  await app.close();
  await launch();
  await page.waitForSelector('.stage video');
  // Saved torrents are re-added at start from the kept .torrent file.
  await page.waitForFunction((sid) => window.tv.torrents().then((l) => l.some((t) => t.id === sid)), serverId, { timeout: 60000 });
  await page.waitForTimeout(1500); // its items get this start's stream address
  const items = await libraryItems();
  expect(items.some((i) => i.id === item.id)).toBe(true);
  expect(items.some((i) => i.path.startsWith('Torrents/Big Buck Bunny')), 'the forgotten torrent stays forgotten').toBe(false);
  const vod = await page.evaluate((id) => window.tv.vod(id, 0), item.id);
  expect(vod.play.mode, 'still played as-is: the start-up race must not make the player fall back to transcoding').toBe('direct');
  const play = await playUntil(vod.play.url, { seek: 60, until: 62 });
  console.log('after restart, seek to 60 s:', play, '| torrent', pct(await torrentStatus()));
  expect(play.at).toBeGreaterThanOrEqual(62);
});

test('forgetting the torrents removes their items and their files', async () => {
  const root = path.join(data, 'torrents');
  expect(fs.readdirSync(root).length).toBe(1); // one folder per torrent (Big Buck Bunny went in the panel test)
  const ids = await page.evaluate(() => window.tv.torrents().then((l) => l.map((t) => t.id)));
  expect(ids).toHaveLength(1);
  for (const id of ids) await page.evaluate((sid) => window.tv.removeServer(sid), id);
  const items = await libraryItems();
  expect(items.some((i) => i.server && i.server.startsWith('torrent:'))).toBe(false);
  expect(await page.evaluate(() => window.tv.torrents())).toEqual([]);
  await expect.poll(() => fs.readdirSync(root).length, { timeout: 10000 }).toBe(0);
});
