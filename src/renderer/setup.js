import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { tv, Icon, Logo } from './util.js';
import { SourcesPicker, FreeTvPicker, DEFAULT_FREE, freeFromSettings, applyFreeTv } from './sources.js';
import { ProfilesSettings } from './profiles.js';
import { SetupBoard, initialPlan, planToChannels } from './setupboard.js';
import { VaultFields, vaultReady, newVault } from './vault.js';
import { TorrentConsent, consentDone } from './torrentlock.js';

// First run, one clear thing at a time. Three ways through it:
//   Set it up for me: a few easy questions, sensible choices for the rest (all listed at the end).
//   Walk me through it: one screen for each topic, already filled in with good choices.
//   I'll do it myself: the same screens, but you place everything by hand.
// Nothing is created until the last screen, which says in plain words what will happen, and any
// line there can be changed. Plain words first; "Tell me more" holds the details for those who want them.
const QUICK = ['people', 'sources', 'found', 'free', 'summary'];
const FULL = ['people', 'sources', 'folders', 'locked', 'online', 'found', 'free', 'showtime', 'channels', 'newvideos', 'subs', 'watching', 'devices', 'updates', 'torrents', 'summary'];
const TITLES = { people: 'Who watches', sources: 'Your videos', folders: 'Movie and show folders', locked: 'Private videos', online: 'Posters and privacy', found: 'What we found', free: 'Free TV', showtime: 'Between the shows', channels: 'How channels play', newvideos: 'New videos', subs: 'Subtitles and sound', watching: 'The picture', devices: 'Other screens', updates: 'Updates', torrents: 'Torrents', summary: 'Check and go' };
// These decide what gets scanned, so changing one means looking through your videos again.
const BEFORE_SCAN = ['sources', 'folders', 'locked', 'online'];

function Seg({ value, options, onChange }) {
  return html`<div class="seg">${options.map(([k, l]) => html`<button class=${value === k ? 'on' : ''} onClick=${() => onChange(k)}>${l}</button>`)}</div>`;
}
function Choice({ on, title, desc, onClick }) {
  return html`<button class=${'opt-choice' + (on ? ' on' : '')} onClick=${onClick}><b>${title}</b><span>${desc}</span></button>`;
}
// The extra detail: closed unless you want it.
function More({ children }) {
  return html`<details class="tell-more"><summary>Tell me more</summary><div>${children}</div></details>`;
}
function Toggle({ on, onClick }) {
  return html`<button class=${'toggle' + (on ? ' on' : '')} aria-pressed=${!!on} onClick=${onClick}></button>`;
}
const LANG = (c) => { try { return new Intl.DisplayNames([navigator.language], { type: 'language' }).of(c.length === 3 ? ({ eng: 'en', spa: 'es', fra: 'fr', deu: 'de', por: 'pt', ita: 'it', jpn: 'ja', kor: 'ko', zho: 'zh', ara: 'ar', hin: 'hi', rus: 'ru' }[c] || c) : c); } catch { return c; } };

// While HomeCable works, the screen mutters nonsense from the same dimension the
// ads come from. Pure decoration — the real status line stays right above it.
const SCAN_JOKES = [
  'Untangling 400 light-years of coaxial cable…',
  'Bribing the scheduling gnomes (3 Fleebles each)…',
  'Asking the one-eyed salesman for directions…',
  'Convincing channel 3 it is not channel 4…',
  'Polishing the static until it sparkles…',
  'Warming up the tubes. The TV has tubes now. Don’t ask…',
  'Negotiating broadcast rights with your toaster…',
  'Counting your pixels. All of them. By hand…',
  'Teaching the TV guide to read…',
  'Do not adjust your set. We are adjusting it for you…',
  'Feeding the hamsters that power channel surfing…',
  'Translating the static from the original Static…',
  'Checking behind the couch for the remote…',
  'Aligning your antenna with Dimension 7-B…',
  'Applying a fresh coat of ultraviolet to the reds…',
  'Asking the moon to stop interfering. It knows what it did…',
  'Rolling the vertical hold back up the hill…',
  'Installing couch gravity…',
  'Signal tested on three dimensions. Yours came highly recommended…',
  'Reticulating channel splines…',
];

export function Setup({ settings, setSettings, progress, onDone, onCancel, canCancel }) {
  const [step, setStep] = useState('welcome');
  const [back, setBack] = useState(null); // changing one thing from the last screen: return there after
  // One joke at a time while scanning or applying, a new one every few seconds.
  const [joke, setJoke] = useState(() => Math.floor(Math.random() * SCAN_JOKES.length));
  useEffect(() => {
    if (step !== 'scanning' && step !== 'applying') return;
    const t = setInterval(() => setJoke((j) => (j + 1) % SCAN_JOKES.length), 3800);
    return () => clearInterval(t);
  }, [step]);
  const [auto, setAuto] = useState(true);
  const [quick, setQuick] = useState(true);
  const [sources, setSources] = useState([]);
  const [odFolder, setOdFolder] = useState('');
  const [seriesFolder, setSeriesFolder] = useState('');
  useEffect(() => { tv.onDemandDefaultFolder('movies').then(setOdFolder); tv.onDemandDefaultFolder('series').then(setSeriesFolder); }, []);
  const [torTicks, setTorTicks] = useState(() => (settings.torrentsOn ? { legal: true, own: true } : {}));
  const [opts, setOpts] = useState({ onDemand: true, series: true, newMedia: 'auto', scanInterval: '6h', timing: 'cable', newArrivals: true, lockOne: false, startFullscreen: !!settings.startFullscreen, transitions: settings.transitions !== false, showClock: settings.showClock !== false, fit: settings.fit || 'fit', onlineMeta: settings.onlineMeta !== false, ads: true, bumpers: true, subMode: settings.subMode || 'auto', subLang: settings.subLang || 'eng', audioPref: settings.audioPref || 'orig', updateOnStart: settings.updateOnStart !== false, updateEvery: settings.updateEvery === 'start' ? '24h' : settings.updateEvery || '24h', updateNotify: settings.updateNotify !== false, torrents: !!settings.torrentsOn });
  const [adPrev, setAdPrev] = useState(null); // one of the shipped wacky ads, for the Showtime page
  useEffect(() => {
    let stop = false; // the shipped ads register a moment after a fresh start — keep asking
    const ask = () => tv.adsPreview().then((a) => { if (stop) return; if (a) setAdPrev(a); else setTimeout(ask, 1500); }).catch(() => {});
    ask();
    return () => { stop = true; };
  }, []);
  const [free, setFree] = useState(DEFAULT_FREE);
  useEffect(() => { if (settings.live) setFree(freeFromSettings(settings.live, { classics: DEFAULT_FREE.classics })); }, []);
  const [status, setStatus] = useState('');
  const [inv, setInv] = useState(null);
  const [plan, setPlan] = useState(null);
  const [made, setMade] = useState(0);
  const [people, setPeople] = useState(null);
  const [vault, setVault] = useState(newVault);
  const [vaultOn, setVaultOn] = useState(false);
  useEffect(() => { tv.profiles().then(setPeople); }, []);
  const set = (p) => setOpts((o) => ({ ...o, ...p }));
  // Posters that arrive while you're arranging things fill in on the board.
  useEffect(() => (step === 'found' ? tv.onLibraryChanged(() => tv.setupInventory().then((x) => setInv((cur) => (cur ? { ...cur, movies: x.movies, shows: x.shows } : cur)))) : undefined), [step]);

  // Look through every source and the two on-demand folders, look up show info (so genre
  // channels can be guessed), then go on: to what was found, or back to the last screen.
  const scan = async (after = 'found') => {
    setStep('scanning');
    setStatus('Looking for your videos…');
    await tv.setSettings({ onlineMeta: opts.onlineMeta });
    // The locked section first: its folder is hidden before anything is read, so nothing in
    // it ever shows up on the next screen.
    if (vaultOn && vaultReady(vault)) { setStatus('Setting up your locked section…'); await tv.vaultCreate({ name: vault.name, password: vault.password, folder: vault.folder }).catch(() => {}); }
    if (sources.length) await tv.addSources(sources);
    if (opts.onDemand && odFolder) { setStatus('Reading your On Demand folder…'); await tv.onDemandUseFolder(odFolder, { kind: 'movies', makeChannel: false }).catch(() => {}); }
    if (opts.series && seriesFolder) { setStatus('Reading your Stream Demand folder…'); await tv.onDemandUseFolder(seriesFolder, { kind: 'series', makeChannel: false }).catch(() => {}); }
    if (opts.onlineMeta) {
      setStatus('Getting show info and posters…');
      await tv.enrich().catch(() => {});
      // Posters: give them a moment; any still coming fill in on the next screen.
      await Promise.race([tv.findPosters().catch(() => {}), new Promise((r) => setTimeout(r, 20000))]);
    }
    setStatus('Sorting it out…');
    const found = await tv.setupInventory();
    setInv(found);
    setPlan(withFolders(initialPlan(found, auto, { odFolder: opts.onDemand ? odFolder : null, seriesFolder: opts.series ? seriesFolder : null }), found));
    setStep(after);
  };
  // The On Demand / Stream Demand channels exist whenever their folders are on — even
  // if they're empty today, so there's somewhere to drop movies and shows later.
  const withFolders = (p, found) => {
    const dests = [...p.dests], members = { ...p.members };
    if (opts.onDemand && !dests.some((d) => d.id === 'od')) { dests.unshift({ id: 'od', kind: 'ondemand', name: 'Movies On Demand', logo: '🎬', color: '#7b61ff', number: 1 }); members.od = []; }
    if (opts.series && !dests.some((d) => d.id === 'hs')) { dests.splice(dests[0]?.id === 'od' ? 1 : 0, 0, { id: 'hs', kind: 'series', name: 'Stream Demand', logo: '📺', color: '#e0558a', number: 2 }); members.hs = []; }
    return { ...p, dests: dests.filter((d) => (d.id !== 'od' || opts.onDemand) && (d.id !== 'hs' || opts.series)), members };
  };

  const apply = async () => {
    setStep('applying');
    setStatus('Saving your settings…');
    await tv.setSettings({ newMedia: opts.newMedia, scanInterval: opts.scanInterval, onlineMeta: opts.onlineMeta, startFullscreen: opts.startFullscreen, transitions: opts.transitions, showClock: opts.showClock, fit: opts.fit, adsOn: !!opts.ads, bumpersOn: opts.bumpers !== false, newArrivals: false, defaultAlign: opts.timing === 'backtoback' ? 0 : 30, subMode: opts.subMode, subLang: opts.subLang, audioPref: opts.audioPref, updateOnStart: opts.updateOnStart, updateEvery: opts.updateEvery, updateNotify: opts.updateNotify });
    // Torrents: on only if they ticked the boxes on that screen.
    const wantTor = !!opts.torrents && consentDone(torTicks);
    if (wantTor !== !!settings.torrentsOn) await tv.torrentsLock(wantTor, wantTor);
    let list = planToChannels(plan, inv, { odFolder: opts.onDemand ? odFolder : null, seriesFolder: opts.series ? seriesFolder : null });
    // Re-running setup: the On Demand / Stream Demand channels already exist (their
    // folders were re-pointed above) — don't make duplicates of them.
    const existing = (await tv.state()).channels;
    list = list.filter((c) => !(c.ondemand && existing.some((x) => x.ondemand && !x.locked && (x.odStyle || 'movies') === (c.odStyle || 'movies'))));
    const align = opts.timing === 'backtoback' ? 0 : 30;
    // A channel tuned by hand on the board keeps its own timing; the rest follow the overall choice.
    list = list.map((c) => (c.ondemand ? c : { ...c, align: c.align ?? align }));
    let lockId = null;
    if (opts.lockOne) {
      // One always-on channel: everything placed on channels, back to back.
      const sources = list.filter((c) => !c.ondemand).flatMap((c) => c.sources);
      list = [{ name: 'HomeCable', logo: '📺', order: 'sequential', align: 0, sources: sources.length ? sources : [{ type: 'kind', kind: 'episode', label: 'All TV episodes' }, { type: 'kind', kind: 'movie', label: 'All movies' }] }];
    }
    setStatus('Making your channels…');
    let all = list.length ? await tv.createChannels(list) : (await tv.state()).channels;
    if (opts.lockOne) lockId = all.find((c) => c.name === 'HomeCable')?.id || null;
    if (free.classics.length || free.live) await applyFreeTv(free, setStatus);
    await setSettings({ setupDone: true, newArrivals: opts.newArrivals, torrentsOn: wantTor, ...(lockId ? { lockChannel: lockId } : {}) });
    setMade((await tv.state()).channels.length);
    setStep('done');
  };

  const importOld = async () => {
    const r = await tv.importLegacy();
    if (!r) return;
    await setSettings({ setupDone: true, lockChannel: r.channel.id });
    onDone();
  };

  const pct = progress?.phase === 'probing' && progress.total ? (progress.probed / progress.total) * 100 : null;
  const flow = auto && quick ? QUICK : FULL;
  const idx = flow.indexOf(step);
  const start = (q, a) => { setQuick(q); setAuto(a); setBack(null); setStep('people'); };
  const change = (k) => { setBack('summary'); setStep(k); };
  const goNext = () => {
    if (back) { setBack(null); return BEFORE_SCAN.includes(step) ? scan(back) : setStep(back); }
    const next = flow[idx + 1];
    return next === 'found' ? scan() : setStep(next);
  };
  const goBack = () => {
    if (back) { setBack(null); return setStep(back); }
    const prev = flow[idx - 1];
    return setStep(!prev ? 'welcome' : prev === 'found' && !inv ? flow[idx - 2] : prev);
  };
  // A plain helper (not a component) so buttons keep their place for the remote.
  const nav = (disabled = false, finish = null) => {
    const scansNext = !back && flow[idx + 1] === 'found';
    const rescans = back && BEFORE_SCAN.includes(step);
    const label = finish ? 'Set it up' : rescans ? 'Save and look again' : back ? 'Save' : scansNext ? (sources.length ? `Look through ${sources.length} source${sources.length === 1 ? '' : 's'}` : 'Look for videos') : 'Next';
    return html`<div class="row setup-nav">
      <button class="btn" onClick=${goBack}>${back ? 'Cancel' : 'Back'}</button><span class="grow"></span>
      <button class="btn primary big" disabled=${disabled} onClick=${finish || goNext}>${label}</button></div>`;
  };
  const steps = html`<div class="setup-progress"><div class="setup-progress-bar"><i style=${`width:${back ? 100 : ((idx + 1) / flow.length) * 100}%`}></i></div>
    <span>${back ? `Changing: ${TITLES[step]}` : `Step ${idx + 1} of ${flow.length} · ${TITLES[step]}`}</span></div>`;
  const shown = idx >= 0 || back;

  return html`<div class="setup"><div class=${'setup-card' + (step === 'found' ? ' wide' : '')}>
    ${canCancel && !['scanning', 'applying'].includes(step) && html`<button class="btn ghost sm" style="position:absolute;top:18px;right:18px" onClick=${onCancel}>Close</button>`}
    ${shown && !['scanning', 'applying'].includes(step) && steps}

    ${step === 'welcome' && html`
      <${Logo} size=${64} />
      <h1>Your videos.<br/><em>Live, like cable.</em></h1>
      <p class="lead">HomeCable turns the shows and movies on your computer into TV channels, with a guide and channel surfing. It also adds movies you can pick and play, free live TV, and more.</p>
      <p class="muted" style="margin:-6px 0 14px">Nothing is set up until you’ve seen it all on the last screen, and you can change anything later in Settings. How much do you want to decide?</p>
      <button class="choice" onClick=${() => start(true, true)}>
        <div class="ic"><${Icon.sparkle} /></div>
        <div class="grow"><b>Set it all up for me</b><span>The easy way. A few simple questions, and we pick good choices for everything else.</span></div>
      </button>
      <button class="choice" onClick=${() => start(false, true)}>
        <div class="ic alt"><${Icon.guide} /></div>
        <div class="grow"><b>Walk me through it</b><span>One screen for each topic, explained, with good choices already filled in. Change whatever you like.</span></div>
      </button>
      <button class="choice" onClick=${() => start(false, false)}>
        <div class="ic alt"><${Icon.settings} /></div>
        <div class="grow"><b>I’ll do it myself</b><span>The same screens, but you decide where everything goes by dragging movies and shows onto channels.</span></div>
      </button>
      <p class="muted small" style="margin:10px 0 8px">HomeCable is free, open-source software and plays only media you provide or free public streams. By continuing you agree you’re responsible for what you play and won’t use it for piracy or anything illegal. Details are in Settings → Privacy, content & licenses.</p>
      <button class="btn ghost sm" onClick=${importOld}><${Icon.import} /> Import a schedule from the old VideoApp (data.txt)</button>`}

    ${step === 'people' && html`
      <h1 style="font-size:34px">Who watches?</h1>
      <p class="lead" style="margin-bottom:16px">Just you? Press Next. Otherwise, add everyone in the house so each person only sees what suits them.</p>
      ${people && html`<${ProfilesSettings} view=${people} setView=${setPeople} toast=${() => {}} />`}
      <${More}><b>Kids</b> only see channels for everyone. <b>Teens</b> see more. <b>Grown-ups</b> see everything and can change settings. Lock a grown-up profile with a PIN, password or controller combo so kids can’t switch to it.<//>
      ${nav()}`}

    ${step === 'sources' && html`
      <h1 style="font-size:34px">Where are your videos?</h1>
      <p class="lead" style="margin-bottom:14px">We looked on this computer, your USB drives and your network. ${auto ? 'Your video folders are already ticked. If that looks right, just press the button below.' : 'Tick what you want in HomeCable.'}</p>
      <${SourcesPicker} value=${sources} onChange=${setSources} />
      <${More}>HomeCable only reads these folders; it never changes, moves or deletes your videos. It stays out of program, game and code folders on its own. It can also read shared network folders, NAS boxes and media servers.<//>
      ${nav()}`}

    ${step === 'folders' && html`
      <h1 style="font-size:34px">Pick-and-play folders</h1>
      <p class="lead" style="margin-bottom:14px">Channels play on a schedule. These two folders are for when you’d rather choose what to watch. Put a video in one and it just appears.</p>
      <div class="opt-row od-setup"><div class="grow"><b>🎬 Movies: On Demand (channel 1)</b><span>Pick a movie, watch it from the start, pause it, and come back to where you stopped.</span>
          <code class="od-path">${odFolder || '…'}</code></div>
        <div class="row" style="gap:8px;flex:none">
          <button class="btn sm" disabled=${!opts.onDemand} onClick=${async () => { const f = await tv.onDemandPickFolder(odFolder); if (f) setOdFolder(f); }}>Change…</button>
          <${Toggle} on=${opts.onDemand} onClick=${() => set({ onDemand: !opts.onDemand })} /></div></div>
      <div class="opt-row od-setup"><div class="grow"><b>📺 Shows: Stream Demand (channel 2)</b><span>For binge-watching. Give each show its own folder. It remembers your place, and the next episode plays by itself.</span>
          <code class="od-path">${seriesFolder || '…'}</code></div>
        <div class="row" style="gap:8px;flex:none">
          <button class="btn sm" disabled=${!opts.series} onClick=${async () => { const f = await tv.onDemandPickFolder(seriesFolder); if (f) setSeriesFolder(f); }}>Change…</button>
          <${Toggle} on=${opts.series} onClick=${() => set({ series: !opts.series })} /></div></div>
      <${More}>HomeCable makes these folders for you if they don’t exist. Seasons and episodes inside a show’s folder are worked out from their names, like “Show S01E02”.<//>
      ${nav()}`}

    ${step === 'locked' && html`
      <h1 style="font-size:34px">Any private videos?</h1>
      <p class="lead" style="margin-bottom:14px">Most people can skip this. It’s a password-protected place for videos you don’t want anyone stumbling on.</p>
      <div class="opt-row od-setup"><div class="grow"><b>🔒 Make a locked section</b><span>It gets a plain name you choose, and locks again when you leave it.</span>
          ${vaultOn && html`<div class="vault-setup"><${VaultFields} value=${vault} onChange=${setVault} /></div>`}</div>
        <${Toggle} on=${vaultOn} onClick=${() => setVaultOn(!vaultOn)} /></div>
      <${More}>Its folder is hidden from every channel, the Library and the guide, and kids’ profiles never see it. Keep the password somewhere safe.<//>
      ${nav(vaultOn && !vaultReady(vault))}`}

    ${step === 'online' && html`
      <h1 style="font-size:34px">Posters and privacy</h1>
      <p class="lead" style="margin-bottom:14px">HomeCable can look up posters and show details online so everything looks right. We recommend leaving this on.</p>
      <div class="opt-row"><div class="grow"><b>🖼 Look up posters and show info</b><span>Only the names of your shows and movies are sent, with no account or ID. Your videos never leave your computer.</span></div>
        <${Toggle} on=${opts.onlineMeta} onClick=${() => set({ onlineMeta: !opts.onlineMeta })} /></div>
      <div class="sum-sec" style="margin-top:14px"><b>What HomeCable never does</b>
        <div class="sum-row">No accounts, no tracking, and no real advertising. HomeCable doesn’t collect anything about you.</div></div>
      <${More}>Names are looked up on services like TVmaze and Wikipedia. Movies with cover art in the file, or a picture beside them, don’t need to go online at all. The full list of what connects to what is in Settings → Privacy, content & licenses.<//>
      ${nav()}`}

    ${step === 'scanning' && html`
      <${Logo} size=${48} />
      <h1 style="font-size:34px">${progress?.phase === 'probing' ? 'Reading your videos…' : status || 'Looking for videos…'}</h1>
      <p class="lead">${progress?.phase === 'probing' ? `${progress.probed} of ${progress.total} files analyzed` : progress?.found ? `${progress.found} media files found so far` : 'This can take a minute on big libraries. Nothing is changed yet.'}</p>
      <div class=${'progress' + (pct == null ? ' indeterminate' : '')}><i style=${pct != null ? `width:${pct}%` : ''}></i></div>
      <div class="scan-path">${progress?.current || ''}</div>
      <div class="scan-joke" key=${joke}>${SCAN_JOKES[joke]}</div>`}

    ${step === 'found' && inv && plan && html`
      <h1 style="font-size:34px">Here’s what we found</h1>
      <${SetupBoard} inv=${inv} plan=${plan} setPlan=${setPlan} guessed=${auto} onGuess=${() => { setPlan(withFolders(initialPlan(inv, true, { odFolder: opts.onDemand ? odFolder : null, seriesFolder: opts.series ? seriesFolder : null }), inv)); setAuto(true); }} />
      ${nav()}`}

    ${step === 'free' && html`
      <h1 style="font-size:34px">Free TV from the internet</h1>
      <p class="lead" style="margin-bottom:16px">Free live stations and classic movies are ready to go, as channels from 100 up. Everything in your language is included. Just check your language is right and press Next.</p>
      <${FreeTvPicker} value=${free} onChange=${setFree} />
      <${More}>The stations come from public lists, and HomeCable only adds ones that actually play. This keeps going in the background for a few minutes after setup, so channels will keep appearing. HomeCable doesn’t run or host them, and some come and go on their own. You can add or remove them any time in Settings.<//>
      ${nav()}`}

    ${step === 'showtime' && html`
      <h1 style="font-size:34px">The stuff between the shows 🤫</h1>
      <p class="lead" style="margin-bottom:18px">Real cable was never just the shows. These are just for fun, and you can turn them on or off by pressing them.</p>
      <div class="fun-cards">
        <button class=${'fun-card' + (opts.bumpers !== false ? ' on' : '')} onClick=${() => set({ bumpers: opts.bumpers === false })}>
          <div class="fun-demo"><div class="mini-ident"><span class="mi-kicker">YOU’RE WATCHING</span><span class="mi-badge">GT</span><span class="mi-name">Galaxy Toons</span></div></div>
          <b>📺 Channel bumpers</b>
          <span>Between shows, every channel flashes its own animated logo: “You’re watching Galaxy Toons.”</span>
          <div class="fun-tog">${opts.bumpers !== false ? '✓ ON — very professional' : 'OFF — channels feel naked'}</div>
        </button>
        <button class=${'fun-card' + (opts.ads ? ' on' : '')} onClick=${() => set({ ads: !opts.ads })}>
          <div class="fun-demo">${adPrev ? html`<video src=${adPrev.url} autoplay muted loop playsinline></video>` : html`<span style="font-size:44px">📣</span>`}</div>
          <b>👽 Joke commercial breaks</b>
          <span>Short, silly, family-friendly ads from other dimensions, for products that don’t exist. They’re jokes, not real advertising, and nobody pays us for them.</span>
          <div class="fun-tog">${opts.ads ? '✓ ON — only 19,9 Fleebles!' : 'Tap to experience commerce from beyond'}</div>
        </button>
      </div>
      ${nav()}`}

    ${step === 'channels' && html`
      <h1 style="font-size:34px">How should channels play?</h1>
      <p class="lead" style="margin-bottom:14px">Channels are always running, like real TV. You join whatever’s on. Pick the feel you like.</p>
      <div class="opt-choices">
        <${Choice} on=${opts.timing === 'cable' && !opts.lockOne} title="Like cable" desc="Shows start on the hour and half hour, with breaks in between" onClick=${() => set({ timing: 'cable', lockOne: false })} />
        <${Choice} on=${opts.timing === 'backtoback' && !opts.lockOne} title="Back to back" desc="The next show starts as soon as one ends, with no waiting" onClick=${() => set({ timing: 'backtoback', lockOne: false })} />
        <${Choice} on=${opts.lockOne} title="Just one channel" desc="Everything on one always-on channel, with no flipping" onClick=${() => set({ lockOne: true })} />
      </div>
      <${More}>You can set this for each channel later, along with its logo, its order and time blocks like “cartoons on Saturday morning”. Look in Edit → Manage channels.<//>
      ${nav()}`}

    ${step === 'newvideos' && html`
      <h1 style="font-size:34px">When you add new videos</h1>
      <p class="lead" style="margin-bottom:14px">What should happen when a new movie or episode appears in your folders?</p>
      <div class="opt-choices">
        <${Choice} on=${opts.newMedia === 'auto'} title="Add them for me" desc="New movies join On Demand and new episodes join their shows, with nothing to do" onClick=${() => set({ newMedia: 'auto' })} />
        <${Choice} on=${opts.newMedia === 'review'} title="Let me approve them" desc="New videos wait in Library → New until you say yes" onClick=${() => set({ newMedia: 'review' })} />
        <${Choice} on=${opts.newMedia === 'library'} title="Library only" desc="Keep them in the Library; I’ll put them on channels myself" onClick=${() => set({ newMedia: 'library' })} />
      </div>
      <div class="opt-row"><div class="grow"><b>How often to look</b><span>Your pick-and-play folders are also checked every time you open them.</span></div>
        <${Seg} value=${opts.scanInterval} onChange=${(v) => set({ scanInterval: v })} options=${[['1h', 'Hourly'], ['6h', 'Every 6 h'], ['24h', 'Daily'], ['off', 'Never']]} /></div>
      <div class="opt-row"><div class="grow"><b>✨ “New Arrivals” channel</b><span>A channel that plays whatever you added in the last two weeks.</span></div>
        <${Toggle} on=${opts.newArrivals} onClick=${() => set({ newArrivals: !opts.newArrivals })} /></div>
      ${nav()}`}

    ${step === 'subs' && html`
      <h1 style="font-size:34px">Subtitles and sound</h1>
      <p class="lead" style="margin-bottom:14px">The usual choices are already picked. You can always change them while watching with the CC button.</p>
      <div class="opt-row"><div class="grow"><b>💬 Subtitles</b><span>“Auto” turns them on only when the sound isn’t in your language.</span></div>
        <${Seg} value=${opts.subMode} onChange=${(v) => set({ subMode: v })} options=${[['auto', 'Auto'], ['on', 'Always'], ['off', 'Off']]} /></div>
      <div class="opt-row"><div class="grow"><b>🌐 Your language</b><span>Used for subtitles, and for dubs if you prefer them.</span></div>
        <select class="select" value=${opts.subLang} onChange=${(e) => set({ subLang: e.target.value })}>
          ${[['eng', 'English'], ['spa', 'Spanish'], ['fra', 'French'], ['deu', 'German'], ['por', 'Portuguese'], ['ita', 'Italian'], ['jpn', 'Japanese'], ['kor', 'Korean'], ['zho', 'Chinese'], ['rus', 'Russian'], ['ara', 'Arabic'], ['nld', 'Dutch']].map(([k, l]) => html`<option value=${k}>${l}</option>`)}
        </select></div>
      <div class="opt-row"><div class="grow"><b>🔊 Shows with two languages</b><span>Anime and foreign shows often have the original sound and a dub.</span></div>
        <${Seg} value=${opts.audioPref} onChange=${(v) => set({ audioPref: v })} options=${[['orig', 'Original'], ['dub', 'Prefer dub']]} /></div>
      <${More}>“Original” plays the original sound with subtitles. “Prefer dub” plays the track in your language when there is one. Your choice is remembered per show. Live captions for anything without subtitles are in the CC menu while watching.<//>
      ${nav()}`}

    ${step === 'watching' && html`
      <h1 style="font-size:34px">The picture</h1>
      <p class="lead" style="margin-bottom:14px">A few small things about how it looks on screen.</p>
      <div class="opt-row"><div class="grow"><b>📐 Picture size</b><span>“Fit” shows the whole picture. “Fill” zooms to remove black bars. “Stretch” fills the screen.</span></div>
        <${Seg} value=${opts.fit} onChange=${(v) => set({ fit: v })} options=${[['fit', 'Fit'], ['fill', 'Fill'], ['stretch', 'Stretch']]} /></div>
      <div class="opt-row"><div class="grow"><b>🖥 Start in full screen</b><span>Opens straight into TV, like turning on a set. Press Esc to leave it.</span></div>
        <${Toggle} on=${opts.startFullscreen} onClick=${() => set({ startFullscreen: !opts.startFullscreen })} /></div>
      <div class="opt-row"><div class="grow"><b>📺 Static when changing channels</b><span>A little burst of TV static while a channel tunes in.</span></div>
        <${Toggle} on=${opts.transitions} onClick=${() => set({ transitions: !opts.transitions })} /></div>
      <div class="opt-row"><div class="grow"><b>🕒 Clock on screen</b><span>Shows the time in the corner while watching.</span></div>
        <${Toggle} on=${opts.showClock} onClick=${() => set({ showClock: !opts.showClock })} /></div>
      ${nav()}`}

    ${step === 'devices' && html`
      <h1 style="font-size:34px">Watching on other screens</h1>
      <p class="lead" style="margin-bottom:14px">Nothing to set up now. Here’s what HomeCable can do when you want it.</p>
      <div class="sum-sec"><b>📡 Your TV</b><div class="sum-row">Press <kbd>K</kbd> to send what’s playing to a Chromecast or Google TV. Many older smart TVs work too.</div></div>
      <div class="sum-sec"><b>📱 Phones and tablets</b><div class="sum-row">Scan a code in Settings → Phone app to watch anywhere in the house, or use your phone as the remote.</div></div>
      <div class="sum-sec"><b>🪟 A small window on top</b><div class="sum-row">Press <kbd>P</kbd> for a small player that stays above your other windows while you work or play a game.</div></div>
      <${More}>Phones and TVs connect over your own home network only. HomeCable doesn’t open anything to the internet. Older TVs can also list HomeCable in their own menu; turn that on in Settings. The small window can’t cover a game running in exclusive full screen, because Windows doesn’t allow that. Set the game to borderless or windowed.<//>
      ${nav()}`}

    ${step === 'updates' && html`
      <h1 style="font-size:34px">Keeping it up to date</h1>
      <p class="lead" style="margin-bottom:14px">Updates bring fixes and new things. We recommend leaving these on. They never interrupt what you’re watching.</p>
      <div class="opt-row"><div class="grow"><b>🔄 Check when HomeCable starts</b><span>Usually takes a second or two.</span></div>
        <${Toggle} on=${opts.updateOnStart} onClick=${() => set({ updateOnStart: !opts.updateOnStart })} /></div>
      <div class="opt-row"><div class="grow"><b>Check while it’s running</b><span>For when you leave HomeCable on for days.</span></div>
        <${Seg} value=${opts.updateEvery} onChange=${(v) => set({ updateEvery: v })} options=${[['1h', 'Hourly'], ['6h', '6 h'], ['24h', 'Daily'], ['off', 'Never']]} /></div>
      <div class="opt-row"><div class="grow"><b>Tell me when one is found</b><span>A small note in the corner, and a button when it’s ready.</span></div>
        <${Toggle} on=${opts.updateNotify} onClick=${() => set({ updateNotify: !opts.updateNotify })} /></div>
      <${More}>Checking asks GitHub, where HomeCable’s releases live, whether a newer version exists. No account or ID is sent.<//>
      ${nav()}`}

    ${step === 'torrents' && html`
      <h1 style="font-size:34px">Torrents</h1>
      <p class="lead" style="margin-bottom:14px"><b>Most people should leave this off.</b> While it’s off, torrents are hidden everywhere and nothing about them runs. You can turn them on later in Settings.</p>
      <div class="opt-choices">
        <${Choice} on=${!opts.torrents} title="Leave torrents off" desc="Recommended. You won’t see them anywhere in HomeCable." onClick=${() => set({ torrents: false })} />
        <${Choice} on=${opts.torrents} title="I want torrents" desc="For people who know what torrents are and use them legally." onClick=${() => set({ torrents: true })} />
      </div>
      ${opts.torrents && html`<p class="muted" style="margin:14px 0 10px">Torrents download videos from other people’s computers and share what you download with others at the same time. Please read this first.</p>
        <${TorrentConsent} ticks=${torTicks} setTicks=${setTorTicks} />`}
      ${nav(opts.torrents && !consentDone(torTicks))}`}

    ${step === 'summary' && html`
      <h1 style="font-size:34px">Here’s what will happen</h1>
      <p class="lead" style="margin-bottom:14px">Nothing has been changed yet. Anything you’d like different? Press its <b>Change</b> button. When it looks right, press <b>Set it up</b>.</p>
      <${Summary} plan=${plan} inv=${inv} opts=${opts} free=${free} people=${people} odFolder=${odFolder} seriesFolder=${seriesFolder} vault=${vaultOn && vaultReady(vault) ? vault : null} wantTorrents=${!!opts.torrents && consentDone(torTicks)} sources=${sources} change=${change} />
      ${nav(false, apply)}`}

    ${step === 'applying' && html`
      <${Logo} size=${48} />
      <h1 style="font-size:34px">Setting it up…</h1>
      <p class="lead">${status}</p>
      <div class="progress indeterminate"><i></i></div>
      <div class="scan-joke" key=${joke}>${SCAN_JOKES[joke]}</div>`}

    ${step === 'done' && html`
      <${Logo} size=${56} />
      <h1 style="font-size:40px">You’re on the air.</h1>
      <p class="lead">${made} channel${made === 1 ? '' : 's'} ready. ${opts.newMedia === 'auto' ? 'From now on, new videos are added for you.' : ''} ${free.live ? 'Free live stations keep appearing as channels 100+ while they’re checked.' : ''}</p>
      <p class="muted">Change anything later: <b>Settings</b> has every option, with a search box at the top.<br/>Press <kbd>?</kbd> any time to see all the controls.</p>
      <button class="btn primary big" onClick=${onDone}><${Icon.play} /> Start watching</button>`}
  </div></div>`;
}

// The last screen: everything that will be set up, in plain words, each with a way to change it.
function Summary({ plan, inv, opts, free, people, odFolder, seriesFolder, vault, wantTorrents, sources, change }) {
  const Sec = ({ title, k, children }) => html`<div class="sum-sec"><div class="sum-head"><b>${title}</b><button class="btn ghost sm" onClick=${() => change(k)}>Change</button></div>${children}</div>`;
  const placed = plan ? new Set(Object.values(plan.members).flat()) : new Set();
  const loose = inv ? [...inv.movies.map((m) => 'm:' + m.id), ...inv.shows.map((s) => 's:' + s.key)].filter((k) => !placed.has(k)).length : 0;
  const n = (keys, k) => keys.filter((x) => x.startsWith(k)).length;
  const desc = (d) => {
    const keys = plan.members[d.id] || [];
    const m = n(keys, 'm:'), s = n(keys, 's:');
    const what = [m && `${m} movie${m === 1 ? '' : 's'}`, s && `${s} show${s === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
    if (d.kind === 'ondemand') return html`${what || 'Nothing yet'} to pick from, plus anything you put in <code class="od-path">${odFolder}</code>`;
    if (d.kind === 'series') return html`${what || 'Nothing yet'} to binge, plus any show you put in <code class="od-path">${seriesFolder}</code>`;
    return `Plays ${what} around the clock${opts.timing === 'backtoback' ? ', back to back' : ', starting on the hour and half hour'}.`;
  };
  const channels = plan ? plan.dests.filter((d) => d.kind !== 'channel' || (plan.members[d.id] || []).length) : [];
  const kids = people?.list || [];
  const yes = (v) => (v ? 'On' : 'Off');
  return html`<div class="summary">
    <${Sec} title="📺 Your channels" k="found">
      ${!plan ? html`<div class="sum-row">Nothing found to set up yet. You can add videos any time.</div>` : opts.lockOne ? html`<div class="sum-row">One always-on channel, <b>HomeCable</b>, with everything you placed on channels.</div>`
        : channels.map((d) => html`<div class="sum-row"><span class="sum-logo" style=${`--c:${d.color}`}>${d.logo || d.name.slice(0, 2)}</span><div><b>${d.number ? `Channel ${d.number} · ` : ''}${d.name}</b><span>${desc(d)}</span></div></div>`)}
      ${plan?.extras.filter((x) => x.on).map((x) => html`<div class="sum-row"><span class="sum-logo" style=${`--c:${x.color}`}>${x.logo}</span><div><b>${x.name}</b><span>${x.reason}</span></div></div>`)}
      ${loose > 0 && html`<div class="sum-row muted">${loose} item${loose === 1 ? '' : 's'} not on any channel, but still in your Library to play any time.</div>`}
    <//>
    <${Sec} title="📁 Where your videos come from" k="sources"><div class="sum-row">${sources.length ? `${sources.length} source${sources.length === 1 ? '' : 's'} you picked.` : 'Only the folders below.'} HomeCable never changes your videos.</div><//>
    <${Sec} title="🎬 Pick-and-play folders" k="folders"><div class="sum-row">Movies (On Demand): ${opts.onDemand ? html`<code class="od-path">${odFolder}</code>` : 'Off'}</div><div class="sum-row">Shows (Stream Demand): ${opts.series ? html`<code class="od-path">${seriesFolder}</code>` : 'Off'}</div><//>
    <${Sec} title="🔒 Private videos" k="locked"><div class="sum-row">${vault ? html`“${vault.name.trim()}” opens with your password, for grown-up profiles only. It’s already set up.` : 'No locked section.'}</div><//>
    <${Sec} title="👪 People" k="people"><div class="sum-row">${kids.length > 1 ? kids.map((p) => `${p.avatar || ''} ${p.name} (${p.level === 'kids' ? 'kids' : p.level === 'teens' ? 'teens' : 'grown-up'}${p.lock ? `, ${p.lock} lock` : ''})`).join(' · ') : 'Just one profile.'}</div><//>
    <${Sec} title="📡 Free TV" k="free">
      <div class="sum-row">${free.live ? html`Live stations${free.languages?.length ? html` in <b>${free.languages.map(LANG).join(', ')}</b>` : ''}${free.max ? `, up to ${free.max}` : ', as many as work'}${free.anime ? ', plus anime' : ''}.${free.servicesOff?.length ? ` Turned off: ${free.servicesOff.join(', ')}.` : ' Pluto TV, Samsung TV Plus and other free services included.'}` : 'No live stations.'}</div>
      <div class="sum-row">${free.classics?.length ? `Free classics: ${free.classics.length} collection${free.classics.length === 1 ? '' : 's'} of old movies, cartoons and TV.` : 'No free classics.'}</div>
    <//>
    <${Sec} title="🖼 Posters and show info" k="online"><div class="sum-row">${opts.onlineMeta ? 'Looked up online. Only names are sent.' : 'Off. Nothing is looked up online.'}</div><//>
    <${Sec} title="🎉 Between the shows" k="showtime"><div class="sum-row">Channel bumpers: ${yes(opts.bumpers !== false)}. Joke commercial breaks: ${yes(opts.ads)}.</div><//>
    <${Sec} title="⏱ How channels play" k="channels"><div class="sum-row">${opts.lockOne ? 'Just one channel.' : opts.timing === 'backtoback' ? 'Back to back, with no waiting.' : 'Like cable: shows start on the hour and half hour.'}</div><//>
    <${Sec} title="➕ New videos" k="newvideos"><div class="sum-row">${opts.newMedia === 'auto' ? 'Added for you.' : opts.newMedia === 'review' ? 'Wait in Library → New for your OK.' : 'Go to the Library; you place them yourself.'} Checked ${({ '1h': 'every hour', '6h': 'every 6 hours', '24h': 'once a day', off: 'only when you ask' })[opts.scanInterval]}. “New Arrivals” channel: ${yes(opts.newArrivals)}.</div><//>
    <${Sec} title="💬 Subtitles and sound" k="subs"><div class="sum-row">Subtitles: ${({ auto: 'Auto', on: 'Always', off: 'Off' })[opts.subMode]} in ${LANG(opts.subLang)}. Two-language shows: ${opts.audioPref === 'dub' ? 'prefer the dub' : 'original sound'}.</div><//>
    <${Sec} title="🖥 The picture" k="watching"><div class="sum-row">${({ fit: 'Fit', fill: 'Fill', stretch: 'Stretch' })[opts.fit]}. Start in full screen: ${yes(opts.startFullscreen)}. Channel static: ${yes(opts.transitions)}. Clock: ${yes(opts.showClock)}.</div><//>
    <${Sec} title="📱 Other screens" k="devices"><div class="sum-row">Ready when you want them. Nothing to set up now.</div><//>
    <${Sec} title="🔄 Updates" k="updates"><div class="sum-row">Check at start: ${yes(opts.updateOnStart)}. While running: ${({ '1h': 'hourly', '6h': 'every 6 hours', '24h': 'daily', off: 'never' })[opts.updateEvery]}.</div><//>
    <${Sec} title="🧲 Torrents" k="torrents"><div class="sum-row">${wantTorrents ? 'On, and you accepted the warning. Use them legally and always with a VPN.' : 'Off and hidden. Most people never need them.'}</div><//>
  </div>`;
}
