import { html, render } from 'htm/preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { tv, Icon, Logo, ChannelLogo, entryText, fmtClock, providerOf } from './util.js';
import { Player, Banner } from './player.js';
import { Guide, guideFilter, guideFilterReset } from './guide.js';
import { ChannelsPanel, ChannelEditor, SettingsPanel } from './panels.js';
import { LibraryPanel, FreeTvDialog } from './libraryview.js';
import { TorrentsView, requestTorrentSearch } from './torrentsview.js';
import { CatalogView, KINDS } from './catalogview.js';
import { ControlsMap } from './controls.js';
import { Setup } from './setup.js';
import { startGamepad, focusDefault, pressButton } from './gamepad.js';
import { Arcade } from './arcade.js';
import { ProfilePicker } from './profiles.js';
import { TermsChanged } from './terms.js';
import { CastMenu, CastGlyph } from './castmenu.js';
import { OnDemandWall } from './ondemand.js';
import { ChannelManager } from './manager.js';
import { TagsPanel } from './tagspanel.js';
import { FreeTvPanel } from './freetv.js';
import { Tour } from './tour.js';
import { startMirror, stopMirror } from './mirror.js';

function App() {
  const [ready, setReady] = useState(false);
  const [channels, setChannels] = useState([]);
  const [settings, setSettingsState] = useState({});
  const [stats, setStats] = useState({ folders: [] });
  const [version, setVersion] = useState('');
  const [tuned, setTuned] = useState(null);
  const [overlay, setOverlay] = useState(null);          // 'guide' | 'channels' | 'manager' | 'tags' | 'library' | 'settings' | 'help'
  const [editMenu, setEditMenu] = useState(false);       // the Edit ▾ dropdown in the top bar
  const [tour, setTour] = useState(false);               // the welcome tour (first run; Settings replays it)
  const [editing, setEditing] = useState(null);
  const [setup, setSetup] = useState(false);
  const [banner, setBanner] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [digits, setDigits] = useState('');
  const [volFlash, setVolFlash] = useState(false);
  const [progress, setProgress] = useState(null);
  const [enrichProgress, setEnrichProgress] = useState(null);
  const [toastMsg, setToastMsg] = useState(null);
  const [updMsg, setUpdMsg] = useState(null); // top-left, once, when an update is found
  const [updDone, setUpdDone] = useState(null); // first start on a new version: "✅ Updated"
  const [updReady, setUpdReady] = useState(null); // "Restart to update" pill once a download is ready
  const [updHidden, setUpdHidden] = useState(null); // …dismissed for this version
  const [bgAdd, setBgAdd] = useState(null); // the slim strip: free TV being added in the background
  const [clock, setClock] = useState(Date.now());
  const [cast, setCast] = useState({ on: false });
  const [tvs, setTvs] = useState([]); // TVs found on the network (kept fresh in the background)
  const [vod, setVod] = useState(null);       // on-demand playback from the library
  const [profile, setProfile] = useState(null); // { list, active, ... }
  const [isAdult, setIsAdult] = useState(true);
  const [termsAsk, setTermsAsk] = useState(false);
  const afterTerms = useRef(null);
  const [picker, setPicker] = useState(false);
  const vodRef = useRef(null);
  vodRef.current = vod;
  const player = useRef({});
  const bufferStart = useRef(Date.now());
  const prevChannel = useRef(null); // for Backspace / L3
  const lastLive = useRef(null); // the last REAL channel — On Demand hands back to it, like a cable box
  const tuneSeq = useRef(0);
  const timers = useRef({});
  const tunedRef = useRef(null);
  tunedRef.current = tuned;

  const toast = (m) => { setToastMsg(m); clearTimeout(timers.current.toast); timers.current.toast = setTimeout(() => setToastMsg(null), 4500); };
  const setSettings = async (patch) => { setSettingsState((s) => ({ ...s, ...patch })); return tv.setSettings(patch); };

  const showBanner = useCallback((secs) => {
    setBanner(true);
    clearTimeout(timers.current.banner);
    timers.current.banner = setTimeout(() => setBanner(false), (secs || 5) * 1000);
  }, []);

  const tune = useCallback(async (id, { quiet, at } = {}) => {
    if (!id) return;
    guideFilterReset(); // picking something ends a remote-set guide filter
    clearTimeout(timers.current.endWait);
    // Changing channels (or going back to On Demand / Stream Demand) leaves on-demand playback:
    // remember where you were first, so the wall shows it and you can pick right back up.
    if (vodRef.current) saveResumeRef.current(vodRef.current);
    setVod(null);
    // Like a cable box, the rewind buffer starts when you land on a channel.
    if (id !== tunedRef.current?.channel?.id) {
      bufferStart.current = Date.now();
      if (tunedRef.current?.channel) prevChannel.current = tunedRef.current.channel.id;
    }
    const seq = ++tuneSeq.current;
    const r = await tv.tune(id, at && Math.max(at, bufferStart.current));
    if (!r || seq !== tuneSeq.current) return; // a newer tune already happened
    // Remember the last REAL channel (from the tune result — the channels list
    // may not be loaded yet at boot): On Demand hands back to it, like cable.
    if (r.channel && !r.channel.ondemand) lastLive.current = r.channel.id;
    setTuned(r);
    if (!quiet) showBanner(settingsRef.current.bannerSeconds);
  }, []);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const tuneRef = useRef(tune); tuneRef.current = tune;

  const surf = useCallback((dir) => {
    if (settingsRef.current.lockChannel) { toast('Single channel mode is on — change it in Settings'); return; }
    // On Demand / Stream Demand open from their own buttons; channels unchecked
    // from being seen are skipped. A 💤 station still surfs — if it answers it
    // plays, if not the player keeps trying; only the USER removes channels.
    const list = channelsRef.current.filter((c) => !c.ondemand && !c.hidden);
    if (!list.length) return;
    lastDir.current = dir;
    const i = list.findIndex((c) => c.id === tunedRef.current?.channel?.id);
    // Surfing out of On Demand / Stream Demand: back to the channel you were
    // on, like a real cable box — not to the top of the dial.
    if (i < 0 && lastLive.current && list.some((c) => c.id === lastLive.current)) { tune(lastLive.current); return; }
    const next = list[(i + dir + list.length) % list.length];
    tune(next.id);
  }, []);
  const channelsRef = useRef(channels);
  const lastDir = useRef(1);
  channelsRef.current = channels;

  const [avMenu, setAvMenu] = useState(false); // Audio & subtitles picker while watching
  const [mini, setMini] = useState(false); // pop-out always-on-top mini player
  const miniDrag = useRef(null); // dragging the pop-out by its top edge
  const [lockAsk, setLockAsk] = useState(false); // the upgrade note's "Turn on…" opens the warning in Settings
  const [torrentDone, setTorrentDone] = useState(null); // { id, name } — the "finished downloading" note up top
  const [miniBig, setMiniBig] = useState(false); // the pop-out grown to guide size while a menu is open
  useEffect(() => {
    if (!mini) { setMiniBig(false); return; }
    tv.miniGuide?.(!!overlay).then((r) => setMiniBig(!!r)).catch(() => {});
  }, [mini, !!overlay]);
  useEffect(() => tv.onMini(setMini), []);
  const [ccAvail, setCcAvail] = useState(false); // the live-captions engine is installed
  useEffect(() => { tv.captionsAvailable().then(setCcAvail).catch(() => {}); }, []);
  // An update that finished downloading last time is ready right away.
  useEffect(() => { const t = setTimeout(() => tv.updateStatus().then((st) => setUpdReady(st?.ready?.version || null)).catch(() => {}), 6000); return () => clearTimeout(t); }, []);
  // The locked section (only shown to grown-up profiles; see main's vault:*).
  const [vault, setVault] = useState({ set: false });
  const loadVault = () => tv.vaultStatus().then(setVault).catch(() => {});
  // Leaving it locks it again (its own videos keep it open while they play).
  useEffect(() => { if (vault.set && tuned?.channel && tuned.channel.id !== vault.channelId) tv.vaultLock(); }, [tuned?.channel?.id, vault.set]);
  // Boot
  useEffect(() => {
    loadVault();
    tv.state().then(async (s) => {
      const ask = !!(await tv.terms().catch(() => null))?.ask;
      setTermsAsk(ask);
      setChannels(s.channels); setSettingsState(s.settings); setStats(s.stats); setVersion(s.version);
      setProfile(s.profile); setIsAdult(s.isAdult); if (s.cast) setCast(s.cast);
      setReady(true);
      if (!s.settings.setupDone && !s.channels.length) setSetup(true);
      // More than one person: ask who's watching before the TV comes on.
      if (s.settings.setupDone && s.profile.needsPick) { setPicker(true); return; }
      const first = s.channels.find((c) => c.id === s.settings.lockChannel) || s.channels.find((c) => c.id === s.settings.lastChannel) || s.channels.find((c) => !c.ondemand) || s.channels[0];
      // The TV waits for an answer. A child's profile isn't asked; the next grown-up is.
      if (first) { if (ask && s.isAdult) afterTerms.current = () => tune(first.id); else tune(first.id); }
    });
    const offs = [
      tv.onScanProgress(setProgress),
      tv.onLibraryChanged((st) => setStats(st)),
      tv.onEnrichProgress((p) => setEnrichProgress(p.n >= p.total ? null : p)),
      tv.onFullscreen(setFullscreen),
      tv.onToast((m) => toast(m)),
      // A torrent finished downloading: say so up top, with a one-press "stop sharing".
      tv.onTorrentDone?.((d) => setTorrentDone(d)),
      // An update was found: a quiet note top-left for a moment. It downloads by
      // itself without touching what's playing, and installs on the next restart.
      tv.onUpdateToast(({ version }) => { setUpdMsg(version); clearTimeout(timers.current.upd); timers.current.upd = setTimeout(() => setUpdMsg(null), 8000); }),
      // A download finished: offer "Restart to update" (it also switches over next start).
      tv.onUpdateStatus((st) => setUpdReady(st?.ready?.version || null)),
      // Hello again: the first start on a freshly installed version.
      tv.onUpdateDone(({ version }) => { setUpdDone(version); clearTimeout(timers.current.updDone); timers.current.updDone = setTimeout(() => setUpdDone(null), 9000); }),
      // "Cast everything": the TV asked for the mirrored screen — record this window.
      tv.onMirror(({ on }) => { if (on) startMirror().catch((e) => { console.error('mirror', e); toast('Couldn’t capture the screen for the TV'); }); else stopMirror(); }),
      tv.onCastDevices(setTvs),
      tv.onCastState((c) => {
        setCast(c);
        if (!c.on && c.reason && c.reason !== 'user' && c.reason !== 'switch') toast('📺 Casting ended — back on this screen');
        // The picture moves to (or back from) the TV: pick up exactly where you are.
        const v = vodRef.current;
        if (v) { const at = player.current.position?.() || 0; playVodRef.current(v.entry.itemId, at, v.from, { queue: v.queue || undefined, seriesKey: v.entry.showKey || undefined, label: v.entry.label || undefined, title: v.entry.title }); }
        else if (tunedRef.current?.channel) {
          const t = tunedRef.current, behind = player.current.behind?.() || 0;
          tuneRef.current(t.channel.id, { quiet: true, at: behind > 4 && !t.channel.iptv ? Date.now() - behind * 1000 : undefined });
        }
      }),
      tv.onChannelsChanged(() => { loadVault(); tv.state().then((s) => setChannels(s.channels)); }),
      // Progress saved anywhere (this window or a phone) — keep ours current.
      tv.onProgressChanged((p) => setSettingsState((s) => ({ ...s, ...p }))),
      tv.onPhonePaired((d) => toast(`📱 ${d.name} is paired`)),
      // The phone app as a remote: controller buttons, keys, or "play this on the PC".
      tv.onRemote(async (r) => {
        if (r.button) pressButton(r.button);
        else if (r.key) window.dispatchEvent(new KeyboardEvent('keydown', { key: r.key, bubbles: true, cancelable: true }));
        else if (r.settings) setSettingsState((s) => ({ ...s, ...r.settings })); // changed from the phone's ⚙ (already saved by the PC)
        else if (r.av) { if ('audio' in r.av) player.current.setAudio?.(r.av.audio); if ('sub' in r.av) player.current.setSubtitle?.(r.av.sub); }
        else if (r.guide) {
          // Search / genre from the phone remote: open the guide right here (on
          // the TV when mirroring) and filter it live.
          guideFilter(r.guide);
          if (ui.current.overlay !== 'guide') { ui.current.overlay = 'guide'; setOverlay('guide'); }
        }
        else if (r.play) {
          setOverlay(null); ui.current.overlay = null; setAvMenu(false);
          if (r.play.channelId) await tuneRef.current(r.play.channelId, { quiet: !!r.play.itemId });
          await new Promise((ok) => setTimeout(ok, 80)); // let the tune land (playVod reads it)
          if (r.play.itemId) playVodRef.current(r.play.itemId, r.play.at || 0, r.play.channelId ? 'ondemand' : null, r.play.opts || {});
        }
      }),
      tv.onNewMedia((m) => toast(m.policy === 'auto' ? `📥 ${m.added} new video${m.added === 1 ? '' : 's'} added to your channels` : m.policy === 'review' ? `📥 ${m.added} new video${m.added === 1 ? '' : 's'} waiting for review in Library` : `📥 ${m.added} new video${m.added === 1 ? '' : 's'} added to your library`)),
      // Free TV arriving in the background: a slim strip up top until it's done.
      tv.onIptvProgress((p) => {
        if (p.running) setBgAdd({ pct: p.total ? p.checked / p.total : null, text: `📡 ${p.recheck ? 'Re-testing stations' : 'Checking free stations'}… ${p.checked}/${p.total}${p.recheck ? '' : ` · ${p.added} added`}${p.name ? ' · ' + p.name : ''}` });
        else { setBgAdd(null); if (!p.recheck && p.added) toast(`📡 ${p.added} free station${p.added === 1 ? '' : 's'} ready — from channel 100 up`); }
      }),
      tv.onFreeProgress((p) => {
        if (p.done) { setBgAdd(null); toast('🏛 Classic movies & shows added'); }
        else setBgAdd({ pct: p.total ? p.n / p.total : null, text: `🏛 Adding ${p.coll || 'classics'}… ${p.n ?? 0}/${p.total ?? '?'}` });
      }),
      tv.onScheduleChanged(() => {
        // If what's on air changed under us (channel edited, content removed), re-tune.
        const t = tunedRef.current;
        // Only if we're still on that channel when the answer comes back (no flipping you back).
        if (t?.channel && !vodRef.current && t.play?.mode !== 'live') tv.tune(t.channel.id).then((r) => { if (r && tunedRef.current === t && (r.entry?.itemId !== t.entry?.itemId || r.entry?.start !== t.entry?.start)) setTuned(r); });
      }),
    ];
    const tvLook = setTimeout(() => tv.castDevices().then(setTvs).catch(() => {}), 4000);
    const ck = setInterval(() => setClock(Date.now()), 10000);
    const stopPad = startGamepad({
      onActivity: () => pokeRef.current(),
      onConnect: (id, on) => toast(on ? `🎮 Controller connected — ${id.replace(/\s*\(.*$/, '')}` : '🎮 Controller disconnected'),
    });
    return () => { offs.forEach((o) => o()); clearInterval(ck); clearTimeout(tvLook); stopPad(); };
  }, []);

  // The first time a TV turns up (after setup), say how to watch on it — once, ever.
  useEffect(() => {
    if (!tvs.length || !settings.setupDone || settings.castHinted || cast.on) return;
    const t = setTimeout(() => { toast(`📺 Found ${tvs[0].name} — press K (or hold View on a controller) to watch on your TV`); setSettings({ castHinted: true }); }, 1500);
    return () => clearTimeout(t);
  }, [tvs.length, settings.setupDone, settings.castHinted]);

  // Live TV: when the current program's slot is over, move on to whatever is
  // airing. Time-shifted viewers move on to what aired next (still delayed).
  const deadRetry = useRef(0);
  useEffect(() => {
    const t = setInterval(() => {
      const cur = tunedRef.current;
      if (!cur?.channel || vodRef.current) return;
      // Tuned but the schedule had nothing at that instant (it was mid-rebuild,
      // or freshly topped up): keep knocking until something airs. A tuned
      // channel must never just sit there dark.
      if (!cur.entry) {
        if (Date.now() - deadRetry.current > 5000) { deadRetry.current = Date.now(); tune(cur.channel.id, { quiet: true }); }
        return;
      }
      // Live stations have no schedule to follow (live blocks inside your
      // channels do). NOTHING is allowed to touch a playing live stream — ads,
      // guide boundaries, nothing. Tried and removed (2026-11-02): a wacky ad in
      // the gap between EPG programmes — free-TV guide times are too sloppy, it
      // interrupted mid-show and the mute-under-the-ad could stick. Do not
      // reintroduce anything that acts on iptv entry boundaries.
      if (cur.channel.iptv) return;
      if (!cur.play) {
        // "Up next" / off-air cards follow the clock, shifted by the tune delay.
        const delay = cur.now - cur.at;
        if (Date.now() - delay >= cur.entry.end) tune(cur.channel.id, { quiet: true, at: delay > 2000 ? cur.entry.end : undefined });
        return;
      }
      if (Date.now() >= cur.entry.end && player.current.isLive?.()) tune(cur.channel.id, { quiet: true });
    }, 500);
    return () => clearInterval(t);
  }, []);

  // A live station froze: say why, briefly, up top — free stations come from
  // servers all over the world (Pluto TV stitches its own breaks), so a short
  // drop is normal and HomeCable is already reconnecting. Once per 3 min per channel.
  const [liveNote, setLiveNote] = useState(null);
  const noteSaid = useRef({});
  const onHiccup = useCallback((t, still) => {
    if (t !== tunedRef.current || !t?.channel?.iptv) return;
    const k = t.channel.id;
    // While it keeps failing to connect the note stays up; a one-off hiccup says so once per 3 min.
    if (!still && Date.now() - (noteSaid.current[k] || 0) < 180e3) return;
    noteSaid.current[k] = Date.now();
    const prov = providerOf(t.channel);
    setLiveNote(still
      ? (prov ? `📡 ${prov} can seem broken sometimes — it’ll be back. Still trying to connect…` : `📡 Still trying to connect — this station’s server may be far away or busy. It’ll keep trying until it plays.`)
      : prov ? `📡 ${prov}’s stream hiccuped — reconnecting. ${prov} stitches its shows and ad breaks together on its own servers, so the picture can stutter at a break.`
        : `📡 The signal dropped — reconnecting. Free stations stream from servers around the world, and far-away ones can lose the connection for a moment.`);
    clearTimeout(timers.current.liveNote);
    timers.current.liveNote = setTimeout(() => setLiveNote(null), still ? 40000 : 9000);
  }, []);
  // It's playing: the next problem starts its retries from scratch, and the note goes.
  const liveTries = useRef({});
  const onPlaying = useCallback((t) => {
    if (!t?.channel?.iptv) return;
    if (liveTries.current[t.channel.id]) { liveTries.current[t.channel.id] = 0; setLiveNote(null); }
  }, []);
  // Live stations that keep dropping get spaced-out retries (never abandoned).
  const liveDrops = useRef({});
  const [hcMenu, setHcMenu] = useState(false);
  const [catalogKind, setCatalogKind] = useState('movie');
  const signalToast = useRef({}); // "lost its signal" said at most every 5 min per channel
  const offAir = (t, why) => setTuned({ ...t, play: null, entry: { ...t.entry, type: 'offair', live: false, title: why || 'This station is off the air', reason: why || null }, next: null });
  const onEnded = useCallback((t) => {
    // Events from something we've already changed away from must not pull us back.
    if (t !== tunedRef.current && t !== vodRef.current) return;
    if (t?.vod) {
      // Finished: forget the resume point.
      saveResumeRef.current(t, true);
      // From an On Demand channel: back to its poster wall.
      // From an On Demand / Stream Demand channel: binge the next episode, else back to the wall.
      if (t.from === 'ondemand') {
        if (t.queue) { const [nx, ...rest] = t.queue; if (nx) playVod(nx.id, 0, 'ondemand', { queue: rest, seriesKey: t.entry.showKey, label: nx.label, title: nx.title }); else exitVod(); return; }
        if (t.next) playVod(t.next.id, 0, 'ondemand'); else exitVod();
        return;
      }
      // From Movies, TV & Anime: on to the next thing in watch order, else back there.
      if (t.from === 'catalog') {
        const [nx, ...rest] = t.queue || [];
        if (nx) playVod(nx.id, 0, 'catalog', { queue: rest, seriesKey: t.entry.showKey, label: nx.label, title: nx.title });
        else { exitVod(); setOverlay('catalog'); }
        return;
      }
      // On demand: roll into the next episode, like a binge; otherwise back to the library.
      if (t.next) playVod(t.next.id);
      else { exitVod(); setOverlay('library'); }
      return;
    }
    if (t?.play?.mode === 'live') {
      // Stream dropped: reconnect, but not forever.
      const id = t.channel.id, now = Date.now();
      const drops = (liveDrops.current[id] || []).filter((x) => now - x < 60e3);
      drops.push(now);
      liveDrops.current[id] = drops;
      // Keeps dropping: try re-encoding once; if that fails too it's flagged off the air.
      if (drops.length > 3) onFailedRef.current(t, 'drops');
      else tune(id, { quiet: true });
      return;
    }
    if (!t?.channel) return;
    const end = t.entry.end, now = Date.now();
    if (now - end > 4000) tune(t.channel.id, { quiet: true, at: end });       // behind live: keep watching as it aired
    else if (end > now) timers.current.endWait = setTimeout(() => tune(t.channel.id, { quiet: true }), end - now + 50); // file ran a hair short
    else tune(t.channel.id, { quiet: true });
  }, []);
  // DVR stepped outside the current program: re-tune at that point on the timeline.
  const onShift = useCallback((wall) => {
    const cur = tunedRef.current;
    if (!cur?.channel) return;
    tune(cur.channel.id, { quiet: true, at: wall >= Date.now() - 2000 ? undefined : wall });
  }, []);
  // A video that froze mid-file (the PC too busy for a moment, a network share
  // hiccup): quietly pick it back up where it was. Channels resume on their own
  // schedule; On Demand resumes at the exact second.
  const fileRetry = useRef({});
  const onStalled = useCallback((t, pos) => {
    if (t !== tunedRef.current && t !== vodRef.current) return;
    if (t?.vod && t.entry?.itemId) { playVod(t.entry.itemId, pos, t.from); return; }
    if (t?.channel) tune(t.channel.id, { quiet: true });
  }, []);
  const onFailed = useCallback(async (t, code) => {
    if (t !== tunedRef.current && t !== vodRef.current) return true; // stale: we've moved on, stay quiet
    const mode = await tv.playbackFailed(t.entry.itemId, code, t.vod ? null : t.channel?.id);
    if (t !== tunedRef.current && t !== vodRef.current) return true;
    // Before ever showing an error card for a FILE, try resuming once — most
    // "errors" are a moment of starvation, not a broken file. Once per half
    // minute per item, so a truly broken file still shows its card.
    if (!mode && t.play?.mode !== 'live' && t.entry?.itemId) {
      const k = (t.channel?.id || 'vod') + ':' + t.entry.itemId;
      if (Date.now() - (fileRetry.current[k] || 0) > 30000) {
        fileRetry.current[k] = Date.now();
        if (t.vod) playVod(t.entry.itemId, player.current.position?.() || 0, t.from);
        else tune(t.channel.id, { quiet: true });
        return true;
      }
    }
    if (!mode && t.play?.mode === 'live') {
      if (t.channel.iptv) {
        // They picked this channel — it NEVER gets abandoned, switched away from,
        // hidden or covered with an "off the air" card. The picture stays on
        // "connecting", a note up top says why, and it keeps retrying (3 s, 6 s…
        // up to every 30 s) until it plays or they change the channel.
        const k = t.channel.id;
        const n = (liveTries.current[k] = (liveTries.current[k] || 0) + 1);
        onHiccup(t, true);
        liveDrops.current[k] = [];
        clearTimeout(timers.current.liveRetry);
        timers.current.liveRetry = setTimeout(() => { const c = tunedRef.current; if (c?.channel?.id === k && !vodRef.current) tune(k, { quiet: true }); }, Math.min(30000, 3000 * n));
      } else offAir(t); // a live block inside your own channel: show off-air until the slot ends
      return true;
    }
    if (mode) { if (t.vod) playVod(t.entry.itemId, player.current.position?.() || 0); else tune(t.channel.id, { quiet: true }); return true; }
    return false;
  }, []);

  const onFailedRef = useRef(onFailed);
  onFailedRef.current = onFailed;

  // opts (from On Demand / Stream Demand): { queue: what plays next, in order; seriesKey; label; title }
  const playVod = useCallback(async (itemId, at = 0, from = null, opts = {}) => {
    // Switching from one video to another: keep your place in the one you're leaving.
    if (vodRef.current && vodRef.current.entry?.itemId !== itemId) saveResumeRef.current(vodRef.current);
    const r = await tv.vod(itemId, at);
    if (!r) return;
    const it = r.item;
    setOverlay(null);
    ui.current.overlay = null;
    // Played from an On Demand channel: it wears that channel's number and name.
    const odCh = from === 'ondemand' ? tunedRef.current?.channel : null;
    setVod({
      vod: true, from, now: r.now, at: r.now, play: r.play, anime: !!r.anime, queue: opts.queue || null,
      next: opts.queue ? (opts.queue[0] ? { id: opts.queue[0].id, title: opts.queue[0].title, show: opts.queue[0].show } : null) : r.next,
      channel: odCh ? { id: 'vod', name: odCh.name, number: odCh.number, color: odCh.color, logo: odCh.logo } : { id: 'vod', name: 'On Demand', number: '▶', color: '#7b61ff', logo: '▶' },
      entry: { start: 0, end: it.duration * 1000, type: 'program', itemId: it.id, title: opts.title || it.title, show: opts.seriesKey ? opts.queue?.[0]?.show || it.show : it.show, showKey: opts.seriesKey || it.showKey || null, label: opts.label || null, season: it.season, episode: it.episode, kind: it.kind, poster: it.poster || null },
    });
    const sk = opts.seriesKey || it.showKey;
    if (from === 'ondemand' && sk) tv.saveProgress({ id: it.id, showKey: sk, started: true });
    showBanner(4);
  }, []);
  const playVodRef = useRef(playVod); playVodRef.current = playVod;
  // Movies remember where you stopped (like a cable box's on-demand "resume").
  const saveResume = (v, finished) => {
    const id = v?.entry?.itemId;
    if (!id || (v.entry.kind !== 'movie' && !v.entry.showKey && v.from !== 'ondemand')) return;
    const pos = finished ? 0 : player.current.position?.() || 0;
    if (pos < 3 && !finished) return; // still loading / barely started: keep whatever was saved before
    // Saved (and merged) on the PC, so phones and this window never overwrite each other.
    tv.saveProgress({ id, pos, len: (v.entry.end - v.entry.start) / 1000, showKey: v.entry.showKey || null, finished: !!finished });
  };
  const saveResumeRef = useRef(saveResume); saveResumeRef.current = saveResume;
  // While something on demand plays, keep its spot saved (closing the app or a crash loses ≤10 s).
  useEffect(() => {
    const t = setInterval(() => { const v = vodRef.current; if (v && !player.current.paused) saveResumeRef.current(v); }, 10000);
    const bye = () => vodRef.current && saveResumeRef.current(vodRef.current);
    window.addEventListener('beforeunload', bye);
    return () => { clearInterval(t); window.removeEventListener('beforeunload', bye); };
  }, []);
  // Tell the PC side what's on (the phone's remote screen shows it).
  useEffect(() => {
    const t = setInterval(() => {
      const v = vodRef.current, cur = tunedRef.current, p = player.current, s = settingsRef.current;
      const e = (v || cur)?.entry;
      const tx = entryText(e);
      tv.remoteNow({ channel: cur?.channel ? { id: cur.channel.id, number: cur.channel.number, name: cur.channel.name, ondemand: !!cur.channel.ondemand } : null,
        title: v ? tx.title : cur?.channel?.ondemand ? 'Choosing what to watch' : e?.live ? cur?.channel?.name : tx.title, sub: cur?.channel?.ondemand && !v ? '' : tx.sub || '', vod: !!v, itemId: e?.itemId || null,
        pos: p.position?.() || 0, len: v ? p.duration?.() || 0 : 0, paused: !!p.paused, muted: !!s.muted, volume: s.volume ?? 0.9, menu: ui.current.overlay || null,
        art: e?.poster || null,
        // What audio/subtitles are on, so the phone's CC menu can show and change them.
        av: (() => { try { const x = p.subtitles?.(); return x && (x.tracks?.length || x.audio?.length) ? { tracks: x.tracks.map(({ id, label }) => ({ id, label })), on: x.on || null, audio: (x.audio || []).map(({ n, label }) => ({ n, label })), audioOn: x.audioOn ?? 0 } : null; } catch { return null; } })() }).catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, []);
  // Next episode now (marks this one watched, like letting it finish).
  const hasNext = (v) => !!v && (v.queue ? v.queue.length > 0 : !!v.next);
  const nextEpisode = () => { const v = vodRef.current; if (hasNext(v)) onEnded(v); };
  const nextRef = useRef(nextEpisode); nextRef.current = nextEpisode;
  const exitVod = useCallback(() => {
    saveResumeRef.current(vodRef.current);
    setVod(null);
    const cur = tunedRef.current;
    if (cur?.channel) tune(cur.channel.id, { quiet: true });
  }, []);

  // Auto-hide the mouse and chrome while watching.
  const poke = useCallback(() => {
    setChrome(true);
    clearTimeout(timers.current.chrome);
    timers.current.chrome = setTimeout(() => setChrome(false), 2800);
  }, []);
  useEffect(() => { poke(); }, []);
  const pokeRef = useRef(poke);
  pokeRef.current = poke;

  const flashLevel = (kind) => { setVolFlash(kind); clearTimeout(timers.current.vol); timers.current.vol = setTimeout(() => setVolFlash(false), 1400); };
  const changeVol = (d) => {
    const v = Math.max(0, Math.min(1, Math.round(((settingsRef.current.volume ?? 0.9) + d) * 20) / 20));
    setSettings({ volume: v, muted: false });
    flashLevel('volume');
  };
  const changeBright = (d) => {
    const b = Math.max(0.4, Math.min(1.6, Math.round(((settingsRef.current.brightness ?? 1) + d) * 20) / 20));
    setSettings({ brightness: b });
    flashLevel('brightness');
  };

  // Keyboard remote. Reads live UI state from a ref: controller presses can
  // arrive faster than effects re-bind, and a stale closure would drop them.
  const ui = useRef({});
  const isAdultRef = useRef(true);
  isAdultRef.current = isAdult;
  ui.current = { overlay, editing, setup: setup || picker, digits };
  window.__torrentsOn = !!settings.torrentsOn;
  window.__moviesOn = !!settings.moviesOn && !!settings.torrentsOn;
  // Controllers cycle these screens with LB/RB (the Edit menu's screens included).
  useEffect(() => {
    window.__overlayCycle = {
      list: () => (isAdultRef.current ? ['channels', 'manager', 'tags', 'library', ...(window.__torrentsOn ? ['torrents'] : []), ...(window.__moviesOn ? ['catalog'] : []), 'arcade', 'settings'] : ['library', 'arcade', 'settings']),
      current: () => ui.current.overlay,
      open: (k) => { ui.current.overlay = k; setOverlay(k); setEditMenu(false); },
    };
    return () => { delete window.__overlayCycle; };
  }, []);
  useEffect(() => {
    const onKey = (e) => {
      if (document.body.classList.contains('in-game')) return; // the game owns the keys
      const { overlay, editing, setup, digits } = ui.current;
      if (e.target.closest?.('input, textarea, select')) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const k = e.key;
      if (k === 'BackToTV') {
        setEditing(null); setOverlay(null); ui.current.editing = null; ui.current.overlay = null;
        if (vodRef.current) exitVod();
        // From an On Demand / Stream Demand wall, "TV" means the channel you were watching.
        else if (tunedRef.current?.channel?.ondemand && lastLive.current) tune(lastLive.current);
        return;
      }
      if (vodRef.current && !overlay && !editing && (k === 'Escape' || k === 'Backspace')) {
        const from = vodRef.current.from;
        exitVod();
        if (from !== 'ondemand') { const back = from === 'catalog' ? 'catalog' : 'library'; setOverlay(back); ui.current.overlay = back; }
        e.preventDefault(); return;
      }
      if (k === 'Dismiss') { setBanner(false); setDigits(''); return; }
      if (k === 'Escape') {
        if (editing) { setEditing(null); ui.current.editing = null; }
        else if (overlay) { setOverlay(null); ui.current.overlay = null; }
        else tv.fullscreen(false).then(setFullscreen);
        e.preventDefault();
        return;
      }
      if (k === 'F11' || (k.toLowerCase() === 'f' && !editing)) { tv.fullscreen().then(setFullscreen); e.preventDefault(); return; }
      if (editing || setup) return;
      const lower = k.toLowerCase();
      const toggle = (name) => { const next = overlay === name ? null : name; ui.current.overlay = next; setOverlay(next); };
      if (lower === 'g') return toggle('guide');
      if (lower === 'c') return isAdultRef.current && toggle('channels');
      if (lower === 'e') return isAdultRef.current && toggle('manager');
      if (lower === 'l') return toggle('library');
      if (lower === 's') return toggle('settings');
      if (lower === 'a') return toggle('arcade');
      if (lower === 'k') return toggle('cast');
      if (k === '?') return setOverlay((o) => (o === 'help' ? null : 'help'));
      if (overlay && overlay !== 'help') return; // panels handle their own keys
      if (k === 'ArrowUp' || k === 'PageUp' || k === 'ChannelUp') { surf(1); e.preventDefault(); }
      else if (k === 'ArrowDown' || k === 'PageDown' || k === 'ChannelDown') { surf(-1); e.preventDefault(); }
      else if (k === 'ArrowRight' || k === 'AudioVolumeUp') { changeVol(0.05); e.preventDefault(); }
      else if (k === 'ArrowLeft' || k === 'AudioVolumeDown') { changeVol(-0.05); e.preventDefault(); }
      else if (k === ',' || k === 'MediaRewind') { player.current.seekBy?.(-10); e.preventDefault(); }
      else if (k === '.' || k === 'MediaFastForward') { player.current.seekBy?.(10); e.preventDefault(); }
      else if (k === 'End' || k === 'GoLive') player.current.goLive?.();
      else if (k === ']' || k === 'BrightnessUp') changeBright(0.05);
      else if (k === '[' || k === 'BrightnessDown') changeBright(-0.05);
      else if (lower === 'm' || k === 'AudioVolumeMute') { setSettings({ muted: !settingsRef.current.muted }); flashLevel('volume'); }
      else if (lower === 'i') showBanner(8);
      else if ((lower === 'n' || k === 'MediaTrackNext') && vodRef.current) nextRef.current();
      else if (lower === 'v') setAvMenu((x) => !x);
      else if (lower === 'p' && !e.shiftKey) tv.miniMode('toggle');
      else if (lower === 't') {  const r = player.current.cycleSubs?.(); if (r) toast(`💬 Subtitles: ${r.label}`); }
      else if (lower === 'z') {
        const modes = ['fit', 'fill', 'stretch'];
        const next = modes[(modes.indexOf(settingsRef.current.fit || 'fit') + 1) % modes.length];
        setSettings({ fit: next });
        toast({ fit: 'Picture: Fit — whole picture, bars if needed', fill: 'Picture: Fill — zoom to fill the screen', stretch: 'Picture: Stretch — fill the screen, no bars' }[next]);
      }
      else if (k === ' ') { player.current.togglePause?.(); showBanner(3); e.preventDefault(); }
      else if (k === 'Backspace') { const p = prevChannel.current || settingsRef.current.prevChannel; if (p && !settingsRef.current.lockChannel) tune(p); }
      else if (/^[0-9]$/.test(k) && !settingsRef.current.lockChannel) {
        setDigits((d) => {
          const nd = (d + k).slice(-3);
          clearTimeout(timers.current.digits);
          const go = () => {
            const ch = channelsRef.current.find((c) => c.number === +nd);
            if (ch?.iptv?.dead) toast(`${ch.name} is off the air right now`);
            else if (ch) tune(ch.id); else toast(`No channel ${nd}`);
            setDigits('');
          };
          timers.current.digits = setTimeout(go, nd.length >= 3 ? 300 : 1500);
          timers.current.digitsGo = go;
          return nd;
        });
      } else if (k === 'Enter' && digits) { clearTimeout(timers.current.digits); timers.current.digitsGo?.(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onWheel = (e) => {
    if (overlay || editing || setup || e.target.closest?.('.ondemand')) return; // the poster wall scrolls, it doesn't flip channels
    const now = Date.now();
    if (now - (timers.current.wheel || 0) < 350) return;
    timers.current.wheel = now;
    surf(e.deltaY < 0 ? 1 : -1);
  };

  const saveChannel = async (c) => {
    const list = c.id ? await tv.updateChannel(c) : await tv.createChannels([c]);
    setChannels(list);
    setEditing(null);
    toast(`Saved “${c.name}”`);
    const id = c.id || list.find((x) => x.name === c.name)?.id;
    if (!tunedRef.current?.channel || tunedRef.current.channel.id === id) tune(id);
  };
  const deleteChannel = async (c) => {
    const list = await tv.deleteChannel(c.id);
    setChannels(list);
    setEditing(null);
    if (settingsRef.current.lockChannel === c.id) setSettings({ lockChannel: null });
    if (tunedRef.current?.channel?.id === c.id) { if (list[0]) tune(list[0].id); else setTuned(null); }
  };
  // Someone else is watching now: reload what they can see and put on a channel they're allowed.
  const onPicked = async () => {
    const s = await tv.state();
    loadVault();
    setChannels(s.channels); setSettingsState(s.settings); setStats(s.stats); setProfile(s.profile); setIsAdult(s.isAdult);
    setPicker(false); setOverlay(null); setEditing(null);
    const first = s.channels.find((c) => c.id === s.settings.lockChannel) || s.channels.find((c) => c.id === s.settings.lastChannel) || s.channels[0];
    if (first) tune(first.id); else setTuned(null);
  };
  const scan = async (what) => { toast('Scanning…'); const r = await tv.scan(what); toast(`Scan done — ${r.added ?? 0} new files`); };

  if (!ready) return html`<div class="app"></div>`;

  const ch = tuned?.channel;
  const idle = !chrome && !overlay && !editing && !setup;
  const live = player.current.isLive ? player.current.isLive() : true;
  const now = entryText(tuned?.entry);
  // Pop-out: drag the top edge to move the window (by hand, so the cursor is a grab hand).
  const miniDragStart = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    const at = { x: e.screenX, y: e.screenY };
    miniDrag.current = { at, from: null, raf: 0 };
    tv.winPos().then(([x, y]) => { if (miniDrag.current) miniDrag.current.from = { x, y }; });
    e.currentTarget.classList.add('dragging');
  };
  const miniDragMove = (e) => {
    const d = miniDrag.current;
    if (!d || !d.from) return;
    const x = d.from.x + e.screenX - d.at.x, y = d.from.y + e.screenY - d.at.y;
    if (d.raf) return;
    d.raf = requestAnimationFrame(() => { d.raf = 0; tv.winMoveTo(x, y); });
  };
  const miniDragEnd = (e) => { miniDrag.current = null; e.currentTarget.classList.remove('dragging'); };
  return html`<div class=${'app' + (idle ? ' idle' : '') + (mini ? ' mini' : '') + (miniBig ? ' mini-big' : '') + (overlay ? ' has-overlay' : '')} onMouseMove=${poke} onMouseDown=${poke} onWheel=${onWheel}>
    ${(channels.length > 0 || vod) && html`<${Player} tuned=${vod || tuned} settings=${settings} transitions=${settings.transitions} pip=${overlay === 'guide'} quiet=${overlay === 'arcade'} covered=${(!!overlay && overlay !== 'guide' && overlay !== 'help') || setup} bufferStart=${bufferStart.current} apiRef=${player} cast=${cast.mode === 'media' ? cast : null} onEnded=${onEnded} onFailed=${onFailed} onShift=${onShift} onCaptionsError=${() => { toast('💬 Live captions couldn’t start on this PC'); setSettings({ liveCaptions: false }); }} onVolume=${(p) => setSettings(p)} onStalled=${onStalled} onHiccup=${onHiccup} onPlaying=${onPlaying}>
      <${Banner} tuned=${vod || tuned} show=${banner && !overlay} live=${live} getBehind=${() => player.current.behind?.() || 0} getPos=${() => player.current.position?.() || 0} paused=${player.current.paused} raised=${chrome} />
      ${digits && html`<div class="number-entry">${digits.padEnd(2, '–')}<small>${channels.find((c) => c.number === +digits)?.name || ''}</small></div>`}
      ${volFlash === 'volume' && html`<div class="osd-level">${settings.muted ? html`<${Icon.mute} />` : html`<${Icon.vol} />`}<div class="meter"><i style=${`width:${settings.muted ? 0 : (settings.volume ?? 0.9) * 100}%`}></i></div><span>${settings.muted ? 'Muted' : Math.round((settings.volume ?? 0.9) * 100)}</span></div>`}
      ${volFlash === 'brightness' && html`<div class="osd-level"><${Icon.sun} /><div class="meter"><i style=${`width:${(((settings.brightness ?? 1) - 0.4) / 1.2) * 100}%`}></i></div><span>${Math.round((settings.brightness ?? 1) * 100)}%</span></div>`}
    <//>`}
    ${tuned?.ondemand && !vod && !overlay && !setup && !editing && !picker && html`<${OnDemandWall} channel=${tuned.channel} isAdult=${isAdult} toast=${toast} onPlay=${(id, at, opts) => playVod(id, at, 'ondemand', opts)} />`}
    <div style="position:absolute;inset:0;z-index:2" onDblClick=${() => !overlay && (mini ? tv.miniMode(false) : tv.fullscreen().then(setFullscreen))} onClick=${() => !overlay && showBanner(settings.bannerSeconds)}></div>
    ${mini && html`<div class=${'mini-top' + (overlay ? ' on-overlay' : '')}>
      <div class="mini-drag" title="Drag to move" onPointerDown=${miniDragStart} onPointerMove=${miniDragMove} onPointerUp=${miniDragEnd} onPointerCancel=${miniDragEnd}><span class="mini-grip">⠿⠿</span></div>
      <button class="mini-btn mini-mute" title=${settings.muted ? 'Unmute (M)' : 'Mute (M)'} onClick=${() => { setSettings({ muted: !settings.muted }); poke(); }}>${settings.muted ? '🔇' : '🔊'}</button>
    </div>`}
    ${mini && !overlay && html`<div class="mini-vol" onClick=${(e) => e.stopPropagation()} onDblClick=${(e) => e.stopPropagation()}>
      <span>${settings.muted || (settings.volume ?? 0.9) === 0 ? '🔇' : '🔊'}</span>
      <input type="range" min="0" max="1" step="0.05" value=${settings.muted ? 0 : settings.volume ?? 0.9} title="Volume" onInput=${(e) => { setSettings({ volume: +e.target.value, muted: false }); poke(); }} />
      <b>${settings.muted ? 0 : Math.round((settings.volume ?? 0.9) * 100)}</b>
    </div>
    <div class="mini-mid">
      <button class="mini-ctl" title="Back 10 seconds" onClick=${() => { player.current.seekBy?.(-10); poke(); }}>⟲10</button>
      <button class="mini-ctl play" title="Pause / play" onClick=${() => { player.current.togglePause?.(); poke(); }}>${player.current.paused ? '▶' : '❚❚'}</button>
      <button class="mini-ctl" title="Forward 10 seconds" onClick=${() => { player.current.seekBy?.(10); poke(); }}>10⟳</button>
      <button class="mini-ctl" title="Back to the full window (P)" onClick=${() => tv.miniMode(false)}>⛶</button>
    </div>`}
    ${isAdult && settings.torrentsLockNote > 0 && !settings.torrentsOn && html`<div class="tor-done" role="status">
      <span>🧲 Torrents are now off until you choose to turn them on. Your ${settings.torrentsLockNote} torrent${settings.torrentsLockNote === 1 ? '' : 's'} and ${settings.torrentsLockNote === 1 ? 'its' : 'their'} files are safe, just hidden and paused.</span>
      <button class="btn sm primary" onClick=${() => { setLockAsk(true); setOverlay('settings'); }}>Turn on…</button>
      <button class="btn sm" onClick=${() => setSettings({ torrentsLockNote: null })}>OK</button>
    </div>`}
    ${torrentDone && settings.torrentsOn && html`<div class="tor-done" role="status">
      <span>✅ <b>${torrentDone.name}</b> finished downloading — it’s still sharing with others.</span>
      <button class="btn sm primary" onClick=${() => { tv.torrentStop(torrentDone.id).then(() => toast('⏹ Stopped sharing — it plays from your PC now')).catch((e) => toast(String(e.message || e))); setTorrentDone(null); }}>⏹ Stop sharing</button>
      <button class="btn sm" onClick=${() => setTorrentDone(null)}>Keep sharing</button>
    </div>`}
    ${settings.muted && !overlay && channels.length > 0 && html`<div class="mute-badge" title="Muted (M / B)"><${Icon.mute} /></div>`}
    ${settings.showClock && !overlay && !chrome && channels.length > 0 && html`<div class="clock">${new Date(clock).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>`}

    ${!channels.length && !setup && !overlay && html`<div class="card-screen" style="z-index:3"><div class="empty">
      <div><${Logo} size=${72} /><h2>No channels yet</h2><p>Let HomeCable suggest channels from your library, or build your own lineup.</p>
      <div class="row" style="justify-content:center"><button class="btn primary big" onClick=${() => setSetup(true)}><${Icon.sparkle} /> Find my videos</button><button class="btn big" onClick=${() => setOverlay('channels')}>Make a channel</button></div></div>
    </div></div>`}

    ${overlay === 'guide' && html`<${Guide} mixTargets=${channels.filter((c) => !c.iptv)} toast=${toast} channels=${settings.lockChannel ? channels.filter((c) => c.id === settings.lockChannel) : channels.filter((c) => !c.ondemand && !c.hidden)} tunedId=${ch?.id} onTune=${(id) => { tune(id); }} onClose=${() => setOverlay(null)}
      onFav=${isAdult ? async (c, on) => { setChannels(await tv.channelFav(c.id, on)); toast(on ? `❤ ${c.name} favorited` : `💔 ${c.name} un-favorited`); } : null}
      onHide=${isAdult ? async (c) => { setChannels(await tv.channelHide(c.id, true)); toast(`🙈 ${c.name} hidden — bring it back in Edit → ${c.iptv ? 'Free TV stations' : 'Channel list'}`); } : null} />`}
    ${overlay === 'channels' && html`<${ChannelsPanel} channels=${channels} setChannels=${setChannels} onTune=${(id) => { tune(id); setOverlay(null); }} onEdit=${setEditing} toast=${toast} />`}
    ${overlay === 'manager' && html`<${ChannelManager} channels=${channels} setChannels=${setChannels} initialId=${ch?.id} toast=${toast} onTune=${(id) => { setOverlay(null); ui.current.overlay = null; tune(id); }} onEdit=${setEditing} />`}
    ${overlay === 'tags' && html`<${TagsPanel} isAdult=${isAdult} toast=${toast} />`}
    ${overlay === 'freetv' && html`<${FreeTvPanel} isAdult=${isAdult} setChannels=${setChannels} toast=${toast} onTune=${(id) => { setOverlay(null); ui.current.overlay = null; tune(id); }} />`}
    ${overlay === 'library' && html`<${LibraryPanel} isAdult=${isAdult} stats=${stats} onScan=${scan} enrichProgress=${enrichProgress} channels=${channels} setChannels=${setChannels} onPlay=${playVod} onEdit=${setEditing} toast=${toast} onOpenTorrents=${() => setOverlay('torrents')} torrentsOn=${!!settings.torrentsOn} />`}
    ${overlay === 'catalog' && settings.moviesOn && settings.torrentsOn && html`<${CatalogView} kind=${catalogKind} setKind=${setCatalogKind} onPlayEpisode=${(r) => playVod(r.itemId, 0, 'catalog', { queue: r.queue, seriesKey: r.seriesKey, label: r.label, title: r.title })} settings=${settings} setSettings=${setSettings} onPlay=${playVod} toast=${toast} onFullSearch=${(title) => { requestTorrentSearch(title, 'all'); setOverlay('torrents'); }} />`}
    ${overlay === 'torrents' && settings.torrentsOn && html`<${TorrentsView} isAdult=${isAdult} settings=${settings} setSettings=${setSettings} onPlay=${playVod} toast=${toast} />`}
    ${overlay === 'settings' && html`<${SettingsPanel} onOpenMovies=${() => setOverlay('catalog')} lockAsk=${lockAsk} onLockAsked=${() => setLockAsk(false)} isAdult=${isAdult} profile=${profile} setProfile=${setProfile} onSwitch=${() => { setOverlay(null); setPicker(true); }} stats=${stats} onOpenLibrary=${() => setOverlay('library')} onOpenTorrents=${() => setOverlay('torrents')} toast=${toast} channels=${channels} onLock=${(id) => { setSettings({ lockChannel: id || null }); if (id) tune(id); }} settings=${settings} setSettings=${setSettings} version=${version} onShowTour=${() => { setOverlay(null); ui.current.overlay = null; setTour(true); }} onRunSetup=${() => { setOverlay(null); setSetup(true); }} onEnrich=${() => { tv.enrich().then((n) => toast(`Looked up ${n} shows`)); }} cast=${cast} tvs=${tvs} onOpenCast=${() => setOverlay('cast')} vault=${vault} setVault=${setVault} onOpenVault=${() => { setOverlay(null); ui.current.overlay = null; tune(vault.channelId, { quiet: true }); }} />`}
    ${overlay === 'cast' && html`<${CastMenu} cast=${cast} tvs=${tvs} setTvs=${setTvs} settings=${settings} setSettings=${setSettings} toast=${toast} onClose=${() => setOverlay(null)} />`}
    ${overlay === 'arcade' && html`<${Arcade} settings=${settings} setSettings=${setSettings} onClose=${() => setOverlay(null)} />`}
    ${overlay === 'help' && html`<div class="modal-bg" onClick=${() => setOverlay(null)}><div class="modal narrow"><div class="modal-head"><h3>Controls</h3></div><div class="modal-body" onClick=${(e) => e.stopPropagation()}><${ControlsMap} /></div></div></div>`}
    ${editing && html`<${ChannelEditor} channel=${editing} onSave=${saveChannel} onDelete=${deleteChannel} onClose=${() => setEditing(null)} />`}

    <div class=${'topbar' + (idle || setup ? ' hide' : '')}>
      <div class="brand"><${Logo} size=${24} /><span>HomeCable</span></div>
      <div class="nav">
        ${[['guide', 'Guide', Icon.guide, 'G'], ['library', 'Library', Icon.library, 'L']].map(([k, l, I, key]) => html`
          <button class=${overlay === k ? 'on' : ''} title=${`${l} (${key})`} onClick=${() => setOverlay((o) => (o === k ? null : k))}><${I} /><span class="l">${l}</span></button>`)}
        ${isAdult && settings.torrentsOn && html`<div class="nav-drop">
          <button class=${['torrents', 'catalog'].includes(overlay) || hcMenu ? 'on' : ''} title="HCtorrents, and Movies, TV shows and anime" onClick=${() => setHcMenu((m) => !m)}><${Icon.magnet} /><span class="l">HCtorrents</span><span class="caret">▾</span></button>
          ${hcMenu && html`<div class="drop-bg" onClick=${() => setHcMenu(false)}></div>
          <div class="drop-menu">
            <button onClick=${() => { setHcMenu(false); setOverlay('torrents'); }}><b>🧲 HCtorrents</b><span>Search for torrents and manage yours</span></button>
            ${settings.moviesOn && html`<div class="drop-sep"></div>${KINDS.map(([k, l]) => html`<button onClick=${() => { setHcMenu(false); setCatalogKind(k); setOverlay('catalog'); }}><b>${k === 'movie' ? '🎬' : k === 'tv' ? '📺' : '🌸'} ${l}</b><span>${k === 'movie' ? 'Browse films' : k === 'tv' ? 'Seasons and episodes' : 'Series, movies and OVAs in watch order'}</span></button>`)}`}
          </div>`}
        </div>`}
        ${isAdult && html`<div class="nav-drop">
          <button class=${['manager', 'channels', 'tags'].includes(overlay) || editMenu ? 'on' : ''} title="Everything that edits lives here (E)" onClick=${() => setEditMenu((m) => !m)}><${Icon.edit} /><span class="l">Edit</span><span class="caret">▾</span></button>
          ${editMenu && html`<div class="drop-bg" onClick=${() => setEditMenu(false)}></div>
          <div class="drop-menu">
            <button onClick=${() => { setEditMenu(false); setOverlay('manager'); }}><b>📝 Manage channels</b><span>Add shows & movies to a channel — plus its name, logo, order and times</span><kbd>E</kbd></button>
            <button onClick=${() => { setEditMenu(false); setOverlay('channels'); }}><b>📡 Channel list</b><span>New channels, numbers, suggestions, live stations</span><kbd>C</kbd></button>
            <button onClick=${() => { setEditMenu(false); setOverlay('tags'); }}><b>🏷 Tags & info</b><span>Edit tags by hand, or auto-tag the whole library</span></button>
            <button onClick=${() => { setEditMenu(false); setOverlay('freetv'); }}><b>📡 Free TV stations</b><span>Every live station — search, add one by one, hide or remove any</span></button>
          </div>`}
        </div>`}
        ${[['arcade', 'Arcade', Icon.game, 'A'], ['settings', 'Settings', Icon.settings, 'S']].map(([k, l, I, key]) => html`
          <button class=${overlay === k ? 'on' : ''} title=${`${l} (${key})`} onClick=${() => setOverlay((o) => (o === k ? null : k))}><${I} /><span class="l">${l}</span></button>`)}
      </div>
      <div class="od-nav">
        ${channels.filter((c) => c.ondemand).sort((a, b) => (a.odStyle === 'series') - (b.odStyle === 'series') || a.number - b.number).map((c) => html`
          <button class=${'od-nav-btn' + (tuned?.channel?.id === c.id && !overlay && !vod ? ' on' : '')} title=${c.odStyle === 'series' ? 'Your shows to binge-watch' : 'Your movies to pick from'}
            onClick=${() => { setOverlay(null); ui.current.overlay = null; tune(c.id, { quiet: true }); }}>${c.odStyle === 'series' ? '📺' : '🎬'}<span class="l"> ${c.odStyle === 'series' ? 'Stream Demand' : 'On Demand'}</span></button>`)}
        ${vault.set && vault.showButton && vault.channelId && html`<button class=${'od-nav-btn' + (tuned?.channel?.id === vault.channelId && !overlay && !vod ? ' on' : '')} title=${vault.name}
          onClick=${() => { setOverlay(null); ui.current.overlay = null; tune(vault.channelId, { quiet: true }); }}>🗂<span class="l"> ${vault.name}</span></button>`}
      </div>
      <div class="spacer"></div>
      ${overlay && html`<button class="btn sm" onClick=${() => setOverlay(null)}>Back to TV <kbd>Esc</kbd></button>`}
      <button class=${'icon-btn cast-btn' + (cast.on ? ' on' : '')} title=${cast.on ? `Casting to ${cast.device} (K)` : 'Cast to a TV (K)'} onClick=${() => setOverlay((o) => (o === 'cast' ? null : 'cast'))}><${CastGlyph} /><span class="l">${cast.on ? cast.device : 'Cast'}</span></button>
      ${profile && html`<button class="who-chip" title="Switch profile" onClick=${() => setPicker(true)}><span>${profile.list.find((p) => p.id === profile.active)?.avatar}</span><span class="l">${profile.list.find((p) => p.id === profile.active)?.name}</span></button>`}
      <button class="icon-btn" title="Keyboard shortcuts (?)" onClick=${() => setOverlay((o) => (o === 'help' ? null : 'help'))}><${Icon.info} /></button>
      <button class="icon-btn" title=${fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen (F)'} onClick=${() => tv.fullscreen().then(setFullscreen)}>${fullscreen ? html`<${Icon.exitFull} />` : html`<${Icon.fullscreen} />`}</button>
      ${!fullscreen && html`<div class="winctl">
        <button onClick=${() => tv.minimize()} title="Minimize"><${Icon.min} /></button>
        <button onClick=${() => tv.maximize()} title="Maximize"><${Icon.max} /></button>
        <button class="x" onClick=${() => tv.close()} title="Close"><${Icon.close} /></button>
      </div>`}
    </div>

    ${vod && !overlay && !setup && html`<${Scrub} player=${player} hide=${idle} />`}
    ${vod && !overlay && !setup && html`<${NextEpisode} vod=${vod} player=${player} hide=${idle} mini=${mini} onNext=${() => onEnded(vodRef.current)} />`}
    ${avMenu && !overlay && !setup && html`<${AvMenu} player=${player} toast=${toast} onClose=${() => setAvMenu(false)} live=${ccAvail} liveOn=${!!settings.liveCaptions} setLive=${(on) => setSettings({ liveCaptions: on })} />`}
    ${vod && !overlay && !setup && html`<${SkipButtons} key=${vod.entry.itemId} player=${player} vod=${vod} hasNext=${hasNext(vod)} onNext=${nextEpisode} />`}
    ${ch && !overlay && !setup && html`<div class=${'controls' + (idle ? ' hide' : '')}>
      <div class="chname"><${ChannelLogo} ch=${ch} size=${36} /><b>${ch.number}</b><div><div class="t">${now.title}</div><div class="small muted">${now.title === ch.name ? (now.sub || 'Live') : ch.name + (now.sub ? ' · ' + now.sub : '')}</div></div></div>
      ${settings.lockChannel ? html`<span class="lock-badge" title="Single channel mode (Settings)">Single channel</span>` : html`
      <button class="icon-btn" title="Channel down (↓)" onClick=${() => surf(-1)}><${Icon.down} /></button>
      <button class="icon-btn" title="Channel up (↑)" onClick=${() => surf(1)}><${Icon.up} /></button>`}
      <button class="icon-btn" title="Back 10 seconds (,)" onClick=${() => player.current.seekBy?.(-10)}><${Icon.back10} /></button>
      <button class="icon-btn" title="Pause (Space)" onClick=${() => player.current.togglePause?.()}>${player.current.paused ? html`<${Icon.play} />` : html`<${Icon.pause} />`}</button>
      <button class="icon-btn" title="Forward 10 seconds (.)" onClick=${() => player.current.seekBy?.(10)}><${Icon.fwd10} /></button>
      ${hasNext(vod) && html`<button class="icon-btn" title="Next episode (N)" onClick=${nextEpisode}><${Icon.next} /></button>`}
      <button class="icon-btn" title="What's on (I)" onClick=${() => showBanner(8)}><${Icon.info} /></button>
      <button class="icon-btn cc-btn" title="Audio & subtitles (V)" onClick=${() => setAvMenu(true)}>CC</button>
      <button class="icon-btn" title="Mute (M)" onClick=${() => setSettings({ muted: !settings.muted })}>${settings.muted ? html`<${Icon.mute} />` : html`<${Icon.vol} />`}</button>
      <input class="vol" type="range" min="0" max="1" step="0.05" value=${settings.muted ? 0 : settings.volume} onInput=${(e) => setSettings({ volume: +e.target.value, muted: false })} />
      <button class="icon-btn" title="Guide (G)" onClick=${() => setOverlay('guide')}><${Icon.guide} /></button>
      <button class=${'icon-btn' + (cast.on ? ' on' : '')} title=${cast.on ? `Casting to ${cast.device} (K)` : 'Cast to a TV (K)'} onClick=${() => setOverlay('cast')}><${CastGlyph} /></button>
      <button class="icon-btn" title="Pop out: a small always-on-top player (P)" onClick=${() => tv.miniMode(true)}><${Icon.pip} /></button>
      <button class="icon-btn" title=${fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen (F)'} onClick=${() => tv.fullscreen().then(setFullscreen)}>${fullscreen ? html`<${Icon.exitFull} />` : html`<${Icon.fullscreen} />`}</button>
    </div>`}

    ${setup && html`<${Setup} settings=${settings} setSettings=${setSettings} progress=${progress} canCancel=${channels.length > 0}
      onCancel=${() => setSetup(false)}
      onDone=${async () => { const s = await tv.state(); setChannels(s.channels); setStats(s.stats); setSettingsState(s.settings); setSetup(false); const f = s.channels.find((c) => c.id === s.settings.lockChannel) || s.channels.find((c) => !c.ondemand) || s.channels[0]; if (f) tune(f.id); if (!s.settings.tourDone) setTour(true); }} />`}
    ${picker && profile && html`<${ProfilePicker} view=${profile} onPicked=${onPicked} onCancel=${settings.setupDone && !profile.needsPick || tuned ? () => setPicker(false) : null} />`}
    ${tour && html`<${Tour} onClose=${() => { setTour(false); setSettings({ tourDone: true }); }} />`}
    ${termsAsk && isAdult && !setup && !picker && html`<${TermsChanged} onAgreed=${() => { setTermsAsk(false); const go = afterTerms.current; afterTerms.current = null; go?.(); }} />`}
    ${bgAdd && !setup && html`<div class="bgjob"><div class="bgjob-bar"><i style=${bgAdd.pct != null ? `width:${Math.round(bgAdd.pct * 100)}%` : 'width:30%;animation:bgslide 1.2s linear infinite'}></i></div><span>${bgAdd.text}</span></div>`}
    ${toastMsg && html`<div class="toast">${toastMsg}</div>`}
    ${liveNote && !overlay && html`<div class="live-note">${liveNote}</div>`}
    ${updMsg && !updReady && html`<div class="upd-toast">⬇ HomeCable v${updMsg} is here — downloading in the background</div>`}
    ${updReady && updHidden !== updReady && settings.updateNotify !== false && !updDone && overlay !== 'settings' && html`<div class="upd-ready">
      <span>⬆ HomeCable v${updReady} is ready</span>
      <button class="btn sm primary" onClick=${() => tv.updateApply().then((r) => { if (!r.ok) toast(r.dev ? 'Running from source — updates install in the real app' : 'The update isn’t ready yet'); })}>Restart to update</button>
      <button class="icon-btn sm" title="Later — it switches over next time HomeCable starts" onClick=${() => setUpdHidden(updReady)}>✕</button>
    </div>`}
    ${updDone && html`<div class="upd-toast done">✅ Updated! You're on HomeCable v${updDone} now.</div>`}
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));

// "Next episode ▶" near the end of an episode (On Demand / Stream Demand), shown
// when you move the mouse — in the full window and the pop-out. Plays what
// would play next anyway (the binge queue, or the show's next episode).
function NextEpisode({ vod, player, hide, mini, onNext }) {
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(i); }, []);
  const nx = vod.from === 'ondemand' ? (vod.queue?.[0] || vod.next) : vod.next;
  if (!nx || hide) return null;
  const len = player.current.duration?.() || 0, pos = player.current.position?.() || 0;
  // The last two minutes (credits), or the last 10% of something short.
  if (!len || len - pos > Math.max(25, Math.min(120, len * 0.1))) return null;
  const label = nx.label || [nx.season != null && `S${nx.season} · E${nx.episode}`, nx.title].filter(Boolean).join(' · ') || 'Next episode';
  return html`<button class=${'next-ep' + (mini ? ' mini' : '')} title=${label} onClick=${(e) => { e.stopPropagation(); onNext(); }}><span>Next episode</span><b>▶</b>${!mini && html`<small>${label}</small>`}</button>`;
}

// Mouse scrub bar for on-demand videos: click or drag anywhere to jump there.
function Scrub({ player, hide }) {
  const [, tick] = useState(0);
  const [drag, setDrag] = useState(null); // seconds under the pointer while dragging
  const [hover, setHover] = useState(null); // { t, x } for the time bubble
  const bar = useRef(null);
  useEffect(() => { const i = setInterval(() => tick((n) => n + 1), 500); return () => clearInterval(i); }, []);
  const len = player.current.duration?.() || 0;
  if (!len) return null;
  const pos = drag ?? Math.min(len, player.current.position?.() || 0);
  const at = (e) => { const r = bar.current.getBoundingClientRect(); const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); return { t: f * len, x: f * 100 }; };
  const down = (e) => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); setDrag(at(e).t); e.stopPropagation(); };
  const move = (e) => { const p = at(e); setHover(p); if (drag != null) setDrag(p.t); };
  const up = (e) => { if (drag == null) return; const t = at(e).t; setDrag(null); player.current.seekTo?.(t); e.stopPropagation(); };
  return html`<div class=${'scrub' + (hide && drag == null ? ' hide' : '')} onClick=${(e) => e.stopPropagation()} onDblClick=${(e) => e.stopPropagation()}>
    <span class="scrub-time">${fmtClock(pos)}</span>
    <div class="scrub-bar" ref=${bar} onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerLeave=${() => drag == null && setHover(null)}>
      <div class="scrub-rail"><i class="scrub-fill" style=${`width:${(pos / len) * 100}%`}></i></div>
      <i class="scrub-knob" style=${`left:${(pos / len) * 100}%`}></i>
      ${hover && html`<span class="scrub-tip" style=${`left:${hover.x}%`}>${(() => { const u = player.current.frameUrl?.(Math.round((drag ?? hover.t) / 5) * 5); return u && html`<img src=${u} alt="" />`; })()}<b>${fmtClock(drag ?? hover.t)}</b></span>`}
    </div>
    <span class="scrub-time">${fmtClock(len)}</span>
  </div>`;
}

// "Skip intro" and "Next episode", Netflix-style. The opening comes from the file's chapters
// when it has them (an "Opening" chapter, or the ~1:30 song after a cold open); otherwise
// episodes get a 1:30 skip during their first five minutes. A on a controller presses it.
function SkipButtons({ player, vod, hasNext, onNext }) {
  const [, tick] = useState(0);
  const [used, setUsed] = useState(false);
  useEffect(() => { const i = setInterval(() => tick((n) => n + 1), 400); return () => clearInterval(i); }, []);
  const p = player.current;
  const len = p.duration?.() || 0;
  if (!len) return null;
  const pos = p.position?.() || 0;
  const { intro, outro, ready } = p.chapters?.() || {};
  const episode = !!(vod.entry.showKey || vod.entry.season != null || vod.queue);
  let btn = null;
  if (intro && pos >= intro.start - 1 && pos < intro.end - 3) btn = { label: 'Skip intro', go: () => p.seekTo(intro.end) };
  // No chapters to go by: the guessed 90-second skip is an anime-OP thing, so only anime gets it.
  else if (ready && !intro && episode && vod.anime && !used && pos > 1 && pos < 300 && len > 600) btn = { label: 'Skip intro · 1:30', go: () => { setUsed(true); p.seekTo(pos + 90); } };
  else if (hasNext && len > 300 && pos >= (outro?.start ?? len - 100) && pos < len - 1) btn = { label: 'Next episode', next: true, go: onNext };
  if (!btn) return null;
  return html`<button class=${'skip-btn' + (btn.next ? ' next' : '')} onClick=${(e) => { e.stopPropagation(); btn.go(); }}>${btn.next ? '▶ ' : '⏭ '}${btn.label}</button>`;
}

// Audio & subtitles, Netflix-style: pick the dub or the original, and the subtitles.
// Your picks are remembered for the show. V / the CC button / LB on a controller opens it.
function AvMenu({ player, toast, onClose, live, liveOn, setLive }) {
  const [, tick] = useState(0);
  const info = player.current.subtitles?.() || { tracks: [], audio: [] };
  const refresh = () => setTimeout(() => tick((n) => n + 1), 60);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'v' || e.key === 'V') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    addEventListener('keydown', onKey, true);
    setTimeout(focusDefault, 40);
    return () => removeEventListener('keydown', onKey, true);
  }, []);
  const audio = info.audio || [];
  return html`<div class="modal-bg av-bg" onClick=${onClose}><div class="modal av-menu" onClick=${(e) => e.stopPropagation()}>
    <div class="av-cols">
      <div class="av-col"><h4>Audio</h4>
        ${audio.length ? audio.map((a) => html`<button class=${'av-opt' + (info.audioOn === a.n ? ' on gp-default' : '')} onClick=${() => { player.current.setAudio(a.n); toast(`🔊 ${a.label}`); refresh(); }}>${info.audioOn === a.n ? '✓ ' : ''}${a.label}</button>`)
          : html`<div class="muted small">One audio track</div>`}</div>
      <div class="av-col"><h4>Subtitles</h4>
        <button class=${'av-opt' + (!info.on && !liveOn ? ' on' : '') + (!audio.length && !info.on && !liveOn ? ' gp-default' : '')} onClick=${() => { setLive(false); player.current.setSubtitle(null); refresh(); }}>${!info.on && !liveOn ? '✓ ' : ''}Off</button>
        ${live && html`<button class=${'av-opt' + (liveOn && !info.on ? ' on' : '') + (!audio.length && liveOn && !info.on ? ' gp-default' : '')} title="Made on this PC from what's being said — a few seconds behind; other languages come out in English"
          onClick=${() => { player.current.setSubtitle(null); setLive(true); toast('💬 Live captions on — made on this PC, a few seconds behind'); refresh(); }}>${liveOn && !info.on ? '✓ ' : ''}Live captions</button>`}
        ${info.tracks.map((t) => html`<button class=${'av-opt' + (info.on === t.id ? ' on' : '') + (!audio.length && info.on === t.id ? ' gp-default' : '')} onClick=${() => { setLive(false); player.current.setSubtitle(t.id); refresh(); }}>${info.on === t.id ? '✓ ' : ''}${t.label}</button>`)}</div>
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" onClick=${onClose}>Done</button></div>
  </div></div>`;
}
