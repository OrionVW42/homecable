import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { tv, Icon, Logo } from './util.js';
import { SourcesPicker, FreeTvPicker, DEFAULT_FREE, freeFromSettings, applyFreeTv } from './sources.js';
import { ProfilesSettings } from './profiles.js';
import { SetupBoard, initialPlan, planToChannels } from './setupboard.js';
import { VaultFields, vaultReady, newVault } from './vault.js';

// First run, one clear step at a time — the same steps whether HomeCable fills
// everything in for you ("Set it all up for me") or you do it yourself. Nothing is
// created until the last step, which says in plain words exactly what will happen.
//   1 Who watches → 2 Your media → (scan) → 3 What we found → 4 Free TV → 5 How it runs → 6 Check & go
const STEPS = ['people', 'sources', 'found', 'free', 'showtime', 'options', 'summary'];
const TITLES = { people: 'Who watches', sources: 'Your media', found: 'What we found', free: 'Free TV', showtime: 'Showtime', options: 'How it runs', summary: 'Check & go' };

function Seg({ value, options, onChange }) {
  return html`<div class="seg">${options.map(([k, l]) => html`<button class=${value === k ? 'on' : ''} onClick=${() => onChange(k)}>${l}</button>`)}</div>`;
}
function Choice({ on, title, desc, onClick }) {
  return html`<button class=${'opt-choice' + (on ? ' on' : '')} onClick=${onClick}><b>${title}</b><span>${desc}</span></button>`;
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
  // One joke at a time while scanning or applying, a new one every few seconds.
  const [joke, setJoke] = useState(() => Math.floor(Math.random() * SCAN_JOKES.length));
  useEffect(() => {
    if (step !== 'scanning' && step !== 'applying') return;
    const t = setInterval(() => setJoke((j) => (j + 1) % SCAN_JOKES.length), 3800);
    return () => clearInterval(t);
  }, [step]);
  const [auto, setAuto] = useState(true);
  const [sources, setSources] = useState([]);
  const [odFolder, setOdFolder] = useState('');
  const [seriesFolder, setSeriesFolder] = useState('');
  useEffect(() => { tv.onDemandDefaultFolder('movies').then(setOdFolder); tv.onDemandDefaultFolder('series').then(setSeriesFolder); }, []);
  const [opts, setOpts] = useState({ onDemand: true, series: true, newMedia: 'auto', scanInterval: '6h', timing: 'cable', newArrivals: true, lockOne: false, startFullscreen: false, onlineMeta: settings.onlineMeta !== false, ads: true, bumpers: true, subMode: settings.subMode || 'auto', subLang: settings.subLang || 'eng', audioPref: settings.audioPref || 'orig' });
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

  // Step 2 → scan: read every source and the two on-demand folders, look up show
  // info (so genre channels can be guessed), then show what was found.
  const scan = async () => {
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
    setStep('found');
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
    await tv.setSettings({ newMedia: opts.newMedia, scanInterval: opts.scanInterval, onlineMeta: opts.onlineMeta, startFullscreen: opts.startFullscreen, adsOn: !!opts.ads, bumpersOn: opts.bumpers !== false, newArrivals: false, defaultAlign: opts.timing === 'backtoback' ? 0 : 30, subMode: opts.subMode, subLang: opts.subLang, audioPref: opts.audioPref });
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
    await setSettings({ setupDone: true, newArrivals: opts.newArrivals, ...(lockId ? { lockChannel: lockId } : {}) });
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
  const idx = STEPS.indexOf(step);
  // A plain helper (not a component) so buttons keep their place for the remote.
  const nav = (next, label = 'Next', disabled = false) => html`<div class="row setup-nav">
    <button class="btn" onClick=${() => setStep(idx > 0 ? STEPS[idx - 1] === 'found' && !inv ? 'sources' : STEPS[idx - 1] : 'welcome')}>Back</button><span class="grow"></span>
    <span class="faint small">Step ${idx + 1} of ${STEPS.length} · ${TITLES[step]}</span>
    <button class="btn primary big" disabled=${disabled} onClick=${next}>${label}</button></div>`;
  const steps = html`<div class="setup-steps">${STEPS.map((s, i) => html`<span class=${i < idx ? 'done' : i === idx ? 'on' : ''}>${i < idx ? '✓' : i + 1} ${TITLES[s]}</span>`)}</div>`;

  return html`<div class="setup"><div class=${'setup-card' + (step === 'found' ? ' wide' : '')}>
    ${canCancel && !['scanning', 'applying'].includes(step) && html`<button class="btn ghost sm" style="position:absolute;top:18px;right:18px" onClick=${onCancel}>Close</button>`}
    ${idx >= 0 && steps}

    ${step === 'welcome' && html`
      <${Logo} size=${64} />
      <h1>Your videos.<br/><em>Live, like cable.</em></h1>
      <p class="lead">HomeCable turns the shows, movies and music on your PC and network into TV channels with a guide and channel surfing — plus On Demand movies, binge-watching for your shows, and free live TV from the internet.</p>
      <p class="muted" style="margin:-6px 0 14px">Either way, you’ll see every choice in plain words before anything is set up — and you can change it all later.</p>
      <p class="muted small" style="margin:-6px 0 16px">HomeCable is free, open-source software and plays only media you provide or free public streams. By continuing you agree you’re responsible for what you play and won’t use it for piracy or anything illegal — details under Settings → Privacy, content & licenses.</p>
      <button class="choice" onClick=${() => { setAuto(true); setStep('people'); }}>
        <div class="ic"><${Icon.sparkle} /></div>
        <div class="grow"><b>Set it all up for me</b><span>HomeCable finds your media, sorts movies and shows into channels, On Demand and Stream Demand, and fills in every step — you just check it and press Next.</span></div>
      </button>
      <button class="choice" onClick=${() => { setAuto(false); setStep('people'); }}>
        <div class="ic alt"><${Icon.settings} /></div>
        <div class="grow"><b>I’ll do it myself</b><span>Same steps, but you decide where everything goes — drag movies and shows onto channels, On Demand or Stream Demand.</span></div>
      </button>
      <button class="btn ghost sm" style="margin-top:6px" onClick=${importOld}><${Icon.import} /> Import a schedule from the old VideoApp (data.txt)</button>`}

    ${step === 'people' && html`
      <h1 style="font-size:34px">Who watches?</h1>
      <p class="lead" style="margin-bottom:16px">Add everyone in the house. <b>Kids</b> only see channels for everyone; <b>teens</b> see more; <b>grown-ups</b> see everything and can change settings. Lock a grown-up profile with a PIN, password or controller combo so kids can’t switch to it. Just you? Press Next.</p>
      ${people && html`<${ProfilesSettings} view=${people} setView=${setPeople} toast=${() => {}} />`}
      ${nav(() => setStep('sources'))}`}

    ${step === 'sources' && html`
      <h1 style="font-size:34px">Where’s your media?</h1>
      <p class="lead" style="margin-bottom:14px">HomeCable looked around this PC, your USB drives and your network. ${auto ? 'Your video folders and media servers are ticked — tick anything else you want in.' : 'Tick what you want in HomeCable.'} It stays out of program, game and code folders on its own.</p>
      <${SourcesPicker} value=${sources} onChange=${setSources} />
      <div class="opt-section">Folders for watching on demand</div>
      <div class="opt-row od-setup"><div class="grow"><b>🎬 Movies folder — On Demand</b><span>HomeCable makes this folder for you. Movies you put in it show up on <strong>channel 1, On Demand</strong>: pick one, watch it from the start, pause and resume.</span>
          <code class="od-path">${odFolder || '…'}</code></div>
        <div class="row" style="gap:8px;flex:none">
          <button class="btn sm" disabled=${!opts.onDemand} onClick=${async () => { const f = await tv.onDemandPickFolder(odFolder); if (f) setOdFolder(f); }}>Change…</button>
          <button class=${'toggle' + (opts.onDemand ? ' on' : '')} onClick=${() => set({ onDemand: !opts.onDemand })}></button></div></div>
      <div class="opt-row od-setup"><div class="grow"><b>📺 Shows folder — Stream Demand</b><span>For binge-watching: put each show in its own folder (seasons and episodes inside). It appears on <strong>channel 2, Stream Demand</strong> — “Continue S2 · E4”, and the next episode plays by itself.</span>
          <code class="od-path">${seriesFolder || '…'}</code></div>
        <div class="row" style="gap:8px;flex:none">
          <button class="btn sm" disabled=${!opts.series} onClick=${async () => { const f = await tv.onDemandPickFolder(seriesFolder); if (f) setSeriesFolder(f); }}>Change…</button>
          <button class=${'toggle' + (opts.series ? ' on' : '')} onClick=${() => set({ series: !opts.series })}></button></div></div>
      <div class="opt-row od-setup"><div class="grow"><b>🔒 Locked section (optional)</b><span>A screen with a plain name you choose that opens only with a password — for videos you don’t want anyone stumbling on. Its folder is hidden from every channel, the Library and the guide, kids’ profiles never see it, and it locks again when you leave.</span>
          ${vaultOn && html`<div class="vault-setup"><${VaultFields} value=${vault} onChange=${setVault} /></div>`}</div>
        <button class=${'toggle' + (vaultOn ? ' on' : '')} onClick=${() => setVaultOn(!vaultOn)}></button></div>
      <div class="opt-row"><div class="grow"><b>Posters & show info</b><span>Look up posters and genres online (TVmaze, Wikipedia — only titles are sent). Helps HomeCable guess good channels.</span></div><button class=${'toggle' + (opts.onlineMeta ? ' on' : '')} onClick=${() => set({ onlineMeta: !opts.onlineMeta })}></button></div>
      ${nav(scan, sources.length ? `Look through ${sources.length} source${sources.length === 1 ? '' : 's'}` : 'Next', vaultOn && !vaultReady(vault))}`}

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
      ${nav(() => setStep('free'))}`}

    ${step === 'free' && html`
      <h1 style="font-size:34px">Free TV from the internet</h1>
      <p class="lead" style="margin-bottom:16px">Optional live stations and classic movies that run like cable channels (from 100 up). <b>Pick your languages</b> so you only get stations you understand — HomeCable only adds stations that actually play.</p>
      <${FreeTvPicker} value=${free} onChange=${setFree} />
      ${nav(() => setStep('showtime'))}`}

    ${step === 'showtime' && html`
      <h1 style="font-size:34px">The stuff between the shows 🤫</h1>
      <p class="lead" style="margin-bottom:18px">Real cable was never just the shows — it was the logo bumps and the weird ads in between. This is what makes HomeCable feel <em>alive</em>. Try them — both switch off in Settings any time.</p>
      <div class="fun-cards">
        <button class=${'fun-card' + (opts.bumpers !== false ? ' on' : '')} onClick=${() => set({ bumpers: opts.bumpers === false })}>
          <div class="fun-demo"><div class="mini-ident"><span class="mi-kicker">YOU’RE WATCHING</span><span class="mi-badge">GT</span><span class="mi-name">Galaxy Toons</span></div></div>
          <b>📺 Channel bumpers</b>
          <span>Between shows, every channel flashes its own animated network logo — “You’re watching Galaxy Toons.” Six little animations, built from each channel’s look. Pure network energy.</span>
          <div class="fun-tog">${opts.bumpers !== false ? '✓ ON — very professional' : 'OFF — channels feel naked'}</div>
        </button>
        <button class=${'fun-card' + (opts.ads ? ' on' : '')} onClick=${() => set({ ads: !opts.ads })}>
          <div class="fun-demo">${adPrev ? html`<video src=${adPrev.url} autoplay muted loop playsinline></video>` : html`<span style="font-size:44px">📣</span>`}</div>
          <b>👽 Interdimensional commercial breaks</b>
          <span>Short, ridiculous, family-friendly ads from other dimensions. One-eyed salesmen. Products that don’t exist. Prices in Fleebles. You will quote them at dinner.</span>
          <div class="fun-tog">${opts.ads ? '✓ ON — only 19,9 Fleebles!' : 'Tap to experience commerce from beyond'}</div>
        </button>
      </div>
      ${nav(() => setStep('options'))}`}

    ${step === 'options' && html`
      <h1 style="font-size:34px">How should it run?</h1>
      <div class="opt-section">When you add new videos later</div>
      <div class="opt-choices">
        <${Choice} on=${opts.newMedia === 'auto'} title="Add them for me" desc="New movies join On Demand, new episodes join their show’s channels — nothing to do" onClick=${() => set({ newMedia: 'auto' })} />
        <${Choice} on=${opts.newMedia === 'review'} title="Let me approve them" desc="New videos wait in Library → New until you say yes" onClick=${() => set({ newMedia: 'review' })} />
        <${Choice} on=${opts.newMedia === 'library'} title="Library only" desc="Keep them in the Library; I’ll put them on channels myself" onClick=${() => set({ newMedia: 'library' })} />
      </div>
      <div class="opt-row"><div class="grow"><b>Look for new videos</b><span>Your On Demand and Stream Demand folders are also checked every time you open them.</span></div>
        <${Seg} value=${opts.scanInterval} onChange=${(v) => set({ scanInterval: v })} options=${[['1h', 'Hourly'], ['6h', 'Every 6 h'], ['24h', 'Daily'], ['off', 'Never']]} /></div>
      <div class="opt-section">Channels</div>
      <div class="opt-choices">
        <${Choice} on=${opts.timing === 'cable' && !opts.lockOne} title="Like cable" desc="Shows start on the hour and half hour, with breaks in between" onClick=${() => set({ timing: 'cable', lockOne: false })} />
        <${Choice} on=${opts.timing === 'backtoback' && !opts.lockOne} title="Back to back" desc="The next show starts as soon as one ends — no waiting" onClick=${() => set({ timing: 'backtoback', lockOne: false })} />
        <${Choice} on=${opts.lockOne} title="Just one channel" desc="Everything on one always-on channel, no flipping" onClick=${() => set({ lockOne: true })} />
      </div>
      <div class="opt-section">Subtitles & audio</div>
      <div class="opt-row"><div class="grow"><b>💬 Subtitles</b><span>Auto turns them on when the audio isn’t in your language — e.g. anime with Japanese audio gets your subtitles. Change anytime with the CC button.</span></div>
        <${Seg} value=${opts.subMode} onChange=${(v) => set({ subMode: v })} options=${[['auto', 'Auto'], ['on', 'Always'], ['off', 'Off']]} />
        <select class="select" value=${opts.subLang} onChange=${(e) => set({ subLang: e.target.value })}>
          ${[['eng', 'English'], ['spa', 'Spanish'], ['fra', 'French'], ['deu', 'German'], ['por', 'Portuguese'], ['ita', 'Italian'], ['jpn', 'Japanese'], ['kor', 'Korean'], ['zho', 'Chinese'], ['rus', 'Russian'], ['ara', 'Arabic'], ['nld', 'Dutch']].map(([k, l]) => html`<option value=${k}>${l}</option>`)}
        </select></div>
      <div class="opt-row"><div class="grow"><b>🔊 Shows with two languages</b><span>Anime and foreign shows often carry the original audio and a dub. Original plays the original with subtitles; Prefer dub plays the track in your language when there is one.</span></div>
        <${Seg} value=${opts.audioPref} onChange=${(v) => set({ audioPref: v })} options=${[['orig', 'Original'], ['dub', 'Prefer dub']]} /></div>
      <div class="opt-row"><div class="grow"><b>“New Arrivals” channel</b><span>Plays whatever you added in the last two weeks.</span></div><button class=${'toggle' + (opts.newArrivals ? ' on' : '')} onClick=${() => set({ newArrivals: !opts.newArrivals })}></button></div>
      <div class="opt-row"><div class="grow"><b>Start in fullscreen</b><span>Open straight into TV, like turning on a set.</span></div><button class=${'toggle' + (opts.startFullscreen ? ' on' : '')} onClick=${() => set({ startFullscreen: !opts.startFullscreen })}></button></div>
      ${nav(() => setStep('summary'))}`}

    ${step === 'summary' && html`
      <h1 style="font-size:34px">Here’s what will happen</h1>
      <p class="lead" style="margin-bottom:14px">Nothing has been changed yet. Check it over, go Back to change anything, then press <b>Set it up</b>.</p>
      <${Summary} plan=${plan} inv=${inv} opts=${opts} free=${free} people=${people} odFolder=${odFolder} seriesFolder=${seriesFolder} vault=${vaultOn && vaultReady(vault) ? vault : null} />
      ${nav(apply, 'Set it up')}`}

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
      <p class="muted">Change anything later: <b>Channels</b> to rearrange, <b>Settings</b> for folders, people and free TV.<br/>📱 Got a phone or tablet? <b>Settings → Phone app</b> pairs it with a QR code — watch anywhere in the house, or use it as the remote.</p>
      <button class="btn primary big" onClick=${onDone}><${Icon.play} /> Start watching</button>`}
  </div></div>`;
}

// Step 6: everything that will be set up, in plain words.
function Summary({ plan, inv, opts, free, people, odFolder, seriesFolder, vault }) {
  if (!plan) return html`<p class="muted">Nothing found to set up yet — you can add media later.</p>`;
  const placed = new Set(Object.values(plan.members).flat());
  const loose = [...inv.movies.map((m) => 'm:' + m.id), ...inv.shows.map((s) => 's:' + s.key)].filter((k) => !placed.has(k)).length;
  const n = (keys, k) => keys.filter((x) => x.startsWith(k)).length;
  const desc = (d) => {
    const keys = plan.members[d.id] || [];
    const m = n(keys, 'm:'), s = n(keys, 's:');
    const what = [m && `${m} movie${m === 1 ? '' : 's'}`, s && `${s} show${s === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
    if (d.kind === 'ondemand') return html`${what || 'Nothing yet'} to pick from, plus anything you put in <code class="od-path">${odFolder}</code>`;
    if (d.kind === 'series') return html`${what || 'Nothing yet'} to binge, plus any show you put in <code class="od-path">${seriesFolder}</code>`;
    return `Plays ${what} around the clock${opts.timing === 'backtoback' ? ', back to back' : ', starting on the hour and half hour'}.`;
  };
  const channels = plan.dests.filter((d) => d.kind !== 'channel' || (plan.members[d.id] || []).length);
  const kids = people?.list || [];
  return html`<div class="summary">
    <div class="sum-sec"><b>📺 Your channels</b>
      ${opts.lockOne ? html`<div class="sum-row">One always-on channel, <b>HomeCable</b>, with everything you placed on channels — no flipping.</div>`
        : channels.map((d) => html`<div class="sum-row"><span class="sum-logo" style=${`--c:${d.color}`}>${d.logo || d.name.slice(0, 2)}</span><div><b>${d.number ? `Channel ${d.number} · ` : ''}${d.name}</b><span>${desc(d)}</span></div></div>`)}
      ${plan.extras.filter((x) => x.on).map((x) => html`<div class="sum-row"><span class="sum-logo" style=${`--c:${x.color}`}>${x.logo}</span><div><b>${x.name}</b><span>${x.reason}</span></div></div>`)}
      ${opts.newArrivals && html`<div class="sum-row"><span class="sum-logo">✨</span><div><b>New Arrivals</b><span>Whatever you added in the last two weeks.</span></div></div>`}
      ${loose > 0 && html`<div class="sum-row muted">${loose} item${loose === 1 ? '' : 's'} not on any channel — still in your Library to play any time.</div>`}
    </div>
    ${vault && html`<div class="sum-sec"><b>🔒 Locked section</b>
      <div class="sum-row">“${vault.name.trim()}” in the top bar — opens with your password, for grown-up profiles only. Videos in <code class="od-path">${vault.folder}</code> stay out of every channel, the Library and the guide. (Already set up — change it in Settings.)</div></div>`}
    <div class="sum-sec"><b>📡 Free TV</b>
      <div class="sum-row">${free.live ? html`Live stations${free.languages?.length ? html` in <b>${free.languages.map(LANG).join(', ')}</b>` : ''}${free.categories?.length ? ` (${free.categories.join(', ')})` : ''}, up to ${free.max}${free.anime ? ', plus anime' : ''} — only ones that actually play.` : 'No live stations.'}</div>
      <div class="sum-row">${free.classics?.length ? `Free public-domain classics: ${free.classics.length} collection${free.classics.length === 1 ? '' : 's'} (old movies, cartoons, TV).` : 'No free classics.'}</div>
    </div>
    <div class="sum-sec"><b>👪 People</b>
      <div class="sum-row">${kids.length > 1 ? kids.map((p) => `${p.avatar || ''} ${p.name} (${p.level === 'kids' ? 'kids' : p.level === 'teens' ? 'teens' : 'grown-up'}${p.lock ? `, ${p.lock} lock` : ''})`).join(' · ') : 'Just one profile — add people any time in Settings.'}</div>
    </div>
    <div class="sum-sec"><b>⚙️ From now on</b>
      <div class="sum-row">${opts.newMedia === 'auto' ? 'New videos are added for you — new movies to On Demand, new episodes to their shows.' : opts.newMedia === 'review' ? 'New videos wait in Library → New for your OK.' : 'New videos go to the Library; you place them yourself.'} Checked ${({ '1h': 'every hour', '6h': 'every 6 hours', '24h': 'once a day', off: 'only when you ask' })[opts.scanInterval]}.</div>
      ${opts.ads && html`<div class="sum-row">Funny commercial breaks between shows (change in Settings).</div>`}
    </div>
  </div>`;
}
