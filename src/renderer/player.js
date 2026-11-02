import { html } from 'htm/preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { tv, fmtTime, fmtClock, entryText, ChannelLogo, providerOf } from './util.js';
import { IdentCard } from './identcard.js';
import { CastMedia } from './castmedia.js';
import { elementAudio, setLevel } from './audio.js';
import { startLiveCaptions } from './livecc.js';

// TV static between channels: low-res noise scaled up.
function Static({ on }) {
  const ref = useRef();
  useEffect(() => {
    if (!on) return;
    const c = ref.current, ctx = c.getContext('2d');
    const img = ctx.createImageData(c.width, c.height);
    const buf = new Uint32Array(img.data.buffer);
    let raf;
    const draw = () => {
      for (let i = 0; i < buf.length; i++) { const v = (Math.random() * 255) | 0; buf[i] = 0xff000000 | (v << 16) | (v << 8) | v; }
      ctx.putImageData(img, 0, 0);
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [on]);
  return html`<canvas ref=${ref} class=${'static' + (on ? ' on' : '')} width="240" height="135"></canvas>`;
}

function Countdown({ until }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  return html`${fmtClock((until - Date.now()) / 1000)}`;
}

function UpNextScreen({ channel, next }) {
  const t = entryText(next);
  return html`<div class="card-screen"><div>
    <div class="chlogo-wrap"><${ChannelLogo} ch=${channel} size=${72} /></div>
    <div class="kicker">Up next on ${channel.name}</div>
    <h1>${t.title}</h1>
    <div class="sub">${t.sub}${next ? ' · ' + fmtTime(next.start) : ''}</div>
    ${next && html`<div class="count">Starts in <${Countdown} until=${next.start} /></div>`}
  </div></div>`;
}

const BARS_TOP = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
const BARS_MID = ['#0000c0', '#131313', '#c000c0', '#131313', '#00c0c0', '#131313', '#c0c0c0'];
const BARS_BOT = ['#00214c', '#ffffff', '#32006a', '#131313', '#090909', '#131313', '#1d1d1d'];
function OffAirScreen({ channel, entry, next }) {
  const resumes = next && next.type === 'program' ? next.start : null;
  return html`<div class="card-screen offair">
    <div class="bars">
      <div class="top">${BARS_TOP.map((c) => html`<span style=${'background:' + c}></span>`)}</div>
      <div class="mid">${BARS_MID.map((c) => html`<span style=${'background:' + c}></span>`)}</div>
      <div class="bot">${BARS_BOT.map((c) => html`<span style=${'background:' + c}></span>`)}</div>
    </div>
    <div class="label">
      <div class="kicker">${channel.number} · ${channel.name}</div>
      <h1>${entry?.reason ? 'Hang tight' : entry?.title === 'No programming' ? 'Nothing scheduled' : 'Off Air'}</h1>
      <div class="sub">${entry?.reason ? entry.reason : resumes ? `Programming resumes at ${fmtTime(resumes)}` : entry?.title === 'No programming' ? 'Add shows to this channel in Channels' : `Back at ${fmtTime(entry.end)}`}</div>
    </div>
  </div>`;
}

const castIcon = html`<svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 8V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/><path d="M3 12a8 8 0 0 1 8 8M3 16a4 4 0 0 1 4 4"/><circle cx="3.5" cy="19.5" r="1" fill="currentColor"/></svg>`;

let analyser = null;
const timers = {};
function Visualizer({ video }) {
  const ref = useRef();
  useEffect(() => {
    try {
      if (!analyser) {
        // Shared with screen mirroring (audio.js): the analyser just listens in.
        const { ctx, src } = elementAudio(video);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
      }
    } catch { return; }
    const c = ref.current, ctx = c.getContext('2d');
    const data = new Uint8Array(analyser.frequencyBinCount);
    let raf;
    const draw = () => {
      c.width = c.clientWidth; c.height = c.clientHeight;
      analyser.getByteFrequencyData(data);
      const n = 64, w = c.width / n;
      const g = ctx.createLinearGradient(0, c.height, 0, c.height * 0.4);
      g.addColorStop(0, 'rgba(108,140,255,0.55)'); g.addColorStop(1, 'rgba(164,108,255,0.05)');
      ctx.fillStyle = g;
      for (let i = 0; i < n; i++) {
        const v = data[Math.floor(i * data.length / n / 1.3)] / 255;
        const h = v * v * c.height * 0.6;
        ctx.fillRect(i * w + 2, c.height - h, w - 4, h);
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);
  return html`<canvas ref=${ref}></canvas>`;
}

function MusicScreen({ entry, channel, video }) {
  return html`<div class="music-screen">
    ${video && html`<${Visualizer} video=${video} />`}
    <div class="disc">♪</div>
    <div class="meta">
      <div class="kicker" style="color:var(--accent);font-weight:700;letter-spacing:.2em;font-size:12px;text-transform:uppercase">Now playing on ${channel.name}</div>
      <h1>${entry.title}</h1>
      <div class="muted">${entry.path ? entry.path.split(/[\\/]/).slice(-2, -1)[0] : ''}</div>
    </div>
  </div>`;
}

export function Banner({ tuned, show, live, getBehind, getPos, paused, raised }) {
  const [, tick] = useState(0);
  useEffect(() => { if (!show) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [show]);
  if (!tuned?.channel) return null;
  const { channel, entry, next } = tuned;
  const n = entryText(next);
  const behind = getBehind?.() || 0;
  const t = entry?.live ? { title: channel.name, sub: entry.sub } : entry?.type === 'upnext' && next ? { title: 'Coming up: ' + n.title, sub: n.sub } : entryText(entry);
  // On demand: where you are in the movie, not clock times.
  const vodLen = tuned.vod && entry ? (entry.end - entry.start) / 1000 : 0;
  const vodPos = tuned.vod ? Math.max(0, getPos?.() || 0) : 0;
  const pct = !entry ? 0 : tuned.vod ? Math.min(100, (vodPos / (vodLen || 1)) * 100) : Math.min(100, Math.max(0, ((Date.now() - entry.start) / (entry.end - entry.start)) * 100));
  return html`<div class=${'banner' + (show ? ' show' : '') + (raised ? ' raised' : '')}>
    <div class="num"><b>${channel.number}</b><span>${channel.name}</span></div>
    ${entry?.poster && html`<img class="poster" src=${entry.poster} onError=${(e) => { e.target.style.display = 'none'; }} />`}
    <div class="info">
      <div class="row" style="gap:10px"><span class=${'live-dot' + (live ? '' : ' behind')}>${tuned.vod ? 'ON DEMAND' : paused ? 'PAUSED' : live ? 'LIVE' : 'REPLAY'}</span>${!live && behind > 1 && html`<span class="muted small">${fmtClock(behind)} behind live</span>`}${!tuned.vod && providerOf(channel) && html`<span class="via-chip" title=${`This is ${providerOf(channel)}’s free channel — its shows, ad breaks and times come from ${providerOf(channel)}, not HomeCable.`}>via ${providerOf(channel)}</span>`}</div>
      <div class="now">${t.title}</div>
      <div class="ep">${t.sub || ' '}</div>
      ${entry && html`<div class="bar"><i style=${'width:' + pct + '%'}></i></div>
      ${tuned.vod ? html`<div class="times"><span>${fmtClock(vodPos)}</span><span>${fmtDur(vodLen - vodPos)} left</span><span>${fmtClock(vodLen)}</span></div>`
        : html`<div class="times"><span>${fmtTime(entry.start)}</span><span>${fmtDur((entry.end - Date.now()) / 1000)} left</span><span>${fmtTime(entry.end)}</span></div>`}`}
    </div>
    ${next && html`<div class="next"><small>${tuned.vod ? 'Up next' : `Next · ${fmtTime(next.start)}`}</small><div>${tuned.vod ? next.show || next.title : n.title}</div><span class="muted small">${tuned.vod ? [next.season != null && `S${next.season} · E${next.episode}`, next.show && next.title].filter(Boolean).join(' · ') : n.sub}</span></div>`}
  </div>`;
}
const fmtDur = (s) => { s = Math.max(0, Math.round(s / 60)); return s >= 60 ? `${Math.floor(s / 60)}h ${s % 60}m` : `${s} min`; };

// Plays whatever `tuned` says is on air. Calls onEnded when the program is over
// (the app then re-tunes to whatever is live now) and onFailed when a file
// won't decode (the app asks main for a transcode and re-tunes).
export function Player({ tuned, settings, transitions, pip, quiet, covered, bufferStart = 0, apiRef, onEnded, onFailed, onShift, onStalled, onHiccup, onPlaying: onPlayingCb, cast, children, onCaptionsError, onVolume }) {
  // While casting, everything below talks to a CastMedia stand-in instead of the
  // <video> element — same API, but the picture plays on the TV.
  const realVid = useRef();
  const castMedia = useRef(null);
  const vid = useMemo(() => ({ get current() { return castMedia.current || realVid.current; } }), []);
  const casting = !!cast?.on;
  useEffect(() => {
    if (!casting) return;
    const v = realVid.current;
    v.pause(); v.removeAttribute('src'); v.load();
    castMedia.current = new CastMedia();
    return () => { castMedia.current.dispose(); castMedia.current = null; };
  }, [casting]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [paused, setPaused] = useState(false);
  const pausedAt = useRef(0);
  const base = useRef(0);        // stream modes: where in the file the stream starts
  const seekTimer = useRef(null);
  const pending = useRef(null);  // stream seek target while a trigger is held
  const [dvr, setDvr] = useState(null); // on-screen scrub bar
  const [preview, setPreview] = useState(null); // seconds: picture of where a seek is going
  const entry = tuned?.entry;
  // Picture subtitles are drawn into the video by a special stream (keyed to this tune).
  const [burn, setBurn] = useState(null); // { for: tuned, play, trackId }
  const play = burn?.for === tuned ? burn.play : tuned?.play;
  // ---- subtitles ----
  const [subs, setSubs] = useState(null);       // { tracks, pick, showKey } for what's playing
  const [subId, setSubId] = useState(null);     // the track showing (null = off)
  const [subSrc, setSubSrc] = useState(null);   // WebVTT url for a text track
  const subFor = useRef(null);
  const vod = !!tuned?.vod;                 // on demand from the library: free seeking
  // A still from any point of what's playing (the media server's /frame route).
  const frameUrl = (t) => {
    try { if (!play?.url || !entry?.itemId) return null; const u = new URL(play.url); return `${u.origin}/frame/${entry.itemId}?k=${u.searchParams.get('k')}&t=${Math.max(0, Math.round(t))}`; } catch { return null; }
  };
  const live = play?.mode === 'live';        // IPTV station: seek within what's buffered

  // Load the new source whenever we tune.
  useEffect(() => {
    const v = vid.current;
    setError(null);
    setPaused(false);
    if (!play) {
      v.removeAttribute('src'); v.load();
      tv.playing(false);
      if (transitions) { setLoading(true); const t = setTimeout(() => setLoading(false), 350); return () => clearTimeout(t); }
      setLoading(false);
      return;
    }
    setLoading(true);
    if (castMedia.current) {
      const tx = entryText(entry);
      castMedia.current.meta = { title: tuned.vod ? tx.title : entry?.live ? tuned.channel?.name : tx.title, subtitle: tuned.channel ? `${tuned.channel.number} · ${tuned.channel.name}${tx.sub && !entry?.live ? ' · ' + tx.sub : ''}` : tx.sub, image: entry?.poster, audioOnly: play.audioOnly };
    }
    base.current = play.mode === 'direct' ? 0 : play.startedAt;
    clearTimeout(seekTimer.current); pending.current = null; setDvr(null);
    if (!vod && !live && tuned.now - tuned.at > 4000) showDvr(); // landed somewhere in the DVR buffer
    // Drift-correct the offset for time spent in the IPC round trip.
    const lag = vod ? 0 : (Date.now() - tuned.now) / 1000;
    const startAt = play.mode === 'direct' ? (burn?.for === tuned && burn.resumeAt != null ? burn.resumeAt : play.offset + lag) : 0;
    let seeked = false;
    const onMeta = () => {
      if (play.mode === 'direct' && !seeked) { seeked = true; if (startAt > 1 && startAt < v.duration) v.currentTime = startAt; }
      v.play().catch(() => {});
    };
    let started = false;
    const onPlaying = () => { started = true; setLoading(false); tv.playing(true); onPlayingRef.current?.(tuned); };
    // A live station that never starts (dead source, endless buffering): treat it as a failure
    // so the app can re-encode once and then show "off the air" instead of a black screen.
    const stall = live ? setTimeout(() => { if (!started) onFailedRef.current?.(tuned, 'stall'); }, 20000) : null;
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('playing', onPlaying);
    v.src = play.url;
    v.load();
    return () => { clearTimeout(stall); v.removeEventListener('loadedmetadata', onMeta); v.removeEventListener('playing', onPlaying); };
    // (Starting/stopping casting re-tunes in the app, which lands here with TV-friendly formats.)
  }, [tuned, burn]);
  const onFailedRef = useRef(onFailed);
  onFailedRef.current = onFailed;
  const onPlayingRef = useRef(onPlayingCb);
  onPlayingRef.current = onPlayingCb;

  // Live captions: on for whatever plays when no subtitle track is showing.
  // (a burn stream only blocks captions while subtitles are actually drawn into it)
  const liveCC = !!settings.liveCaptions && !!play && !casting && !play.audioOnly && !subSrc && !(burn?.for === tuned && burn.subbed);
  useEffect(() => {
    const v = realVid.current;
    if (liveCC) {
      // Full level into the sound graph; volume and mute are applied after the captions tap.
      v.volume = 1; v.muted = false;
      setLevel(v, settings.muted || quiet ? 0 : settings.volume ?? 0.9);
      return;
    }
    if (ccLevelUsed.current) setLevel(v, 1);
    v.volume = settings.volume ?? 0.9;
    v.muted = !!settings.muted || !!quiet; // e.g. while playing an arcade game
    // Casting: the volume and mute controls turn the TV up and down instead.
    if (castMedia.current) tv.castControl('VOLUME', settings.muted ? { muted: true } : { level: settings.volume ?? 0.9, muted: false });
  }, [settings.volume, settings.muted, quiet, liveCC]);
  const ccLevelUsed = useRef(false);
  if (liveCC) ccLevelUsed.current = true;
  const ccLines = useRef([]);
  useEffect(() => {
    if (!liveCC) return;
    const box = () => subBox.current;
    const draw = () => {
      const now = Date.now();
      ccLines.current = ccLines.current.filter((l) => now - l.at < 7000).slice(-2);
      const b = box();
      if (!b) return;
      b.replaceChildren(...ccLines.current.map((l) => { const d = document.createElement('div'); d.className = 'sub-line live'; const s = document.createElement('span'); s.textContent = l.text; d.append(s); return d; }));
    };
    ccLines.current = [];
    draw();
    const tick = setInterval(draw, 1000);
    const stop = startLiveCaptions(realVid.current, (text) => {
      // Long lines split so two short rows show at a time.
      for (const part of text.match(/.{1,90}(\s|$)/g) || [text]) ccLines.current.push({ text: part.trim(), at: Date.now() });
      draw();
    }, (e) => onCaptionsError?.(e));
    return () => { stop(); clearInterval(tick); ccLines.current = []; box()?.replaceChildren(); };
  }, [liveCC, play?.url]);

  // What's playing has subtitles? Load the list, then show what Auto (or your last choice) picks.
  const itemId = entry?.itemId || null;
  const subAt = useRef(null);
  const subBox = useRef(null);
  // Bumped whenever the video changes, so a late answer for the last video is thrown away.
  const subGen = useRef(0);
  const textSrc = async (trackId, t) => (trackId ? tv.subtitleUrl(itemId, trackId, t) : null);
  const streamBase = () => (play && play.mode !== 'direct' ? base.current : 0);
  subAt.current = (t) => {
    if (!subId || subs?.tracks.find((x) => x.id === subId)?.kind !== 'text') return;
    const gen = subGen.current;
    textSrc(subId, t).then((u) => { if (gen === subGen.current) setSubSrc(u); });
  };
  // What the picture is built from right now: burned-in picture subtitles, and which audio track.
  const alt = useRef({ burn: null, audio: 0 });
  // Switch to a stream with another audio track (dub / original) and/or picture subtitles
  // drawn in — from where you are now. Back to the plain file when neither is needed.
  const switchStream = async (o) => {
    const gen = subGen.current;
    const want = { ...alt.current, ...o };
    const plainAudio = !subs?.audio?.length || want.audio === (subs.audioDefault ?? 0);
    const same = want.burn === alt.current.burn && want.audio === alt.current.audio;
    alt.current = want;
    if (same) return null;
    // Not playing yet (just started / resuming): where it's about to start, not 0.
    const notYet = (vid.current?.readyState || 0) < 2;
    const at = notYet ? (play?.mode === 'direct' ? (burn?.for === tuned && burn.resumeAt != null ? burn.resumeAt : play.offset || 0) : play?.startedAt || 0) : position();
    if (want.burn == null && plainAudio) {
      if (burn?.for !== tuned) return null; // already the plain file
      const p0 = tuned.play;
      setBurn(p0.mode === 'direct' ? { for: tuned, play: p0, resumeAt: at, subbed: false } : { for: tuned, play: { ...p0, url: p0.url.replace(/([?&]t=)[\d.]+/, '$1' + at.toFixed(2)), startedAt: at, offset: 0 }, subbed: false });
      return p0.mode === 'direct' ? 0 : at; // where the new stream's clock starts
    }
    const url = await tv.altStreamUrl(itemId, { burn: want.burn, audio: want.audio, t: at });
    if (gen !== subGen.current || !url) return null;
    setBurn({ for: tuned, play: { ...tuned.play, mode: 'transcode', url, offset: 0, startedAt: at }, subbed: want.burn != null });
    return at;
  };
  const applySub = async (trackId, { remember } = {}) => {
    const gen = subGen.current;
    const stale = () => gen !== subGen.current;
    const tr = subs?.tracks.find((x) => x.id === trackId) || null;
    setSubId(tr ? tr.id : null);
    if (remember && subs?.showKey) tv.rememberSubtitle(subs.showKey, tr ? tr.lang || 'on' : 'off');
    // Picture subtitles: a stream with them drawn in.
    if (tr?.kind === 'image') { setSubSrc(null); await switchStream({ burn: tr.id }); return; }
    const st = await switchStream({ burn: null });
    // Text subtitles line up with wherever the stream starts.
    const url = tr ? await textSrc(tr.id, st != null ? st : streamBase()) : null;
    if (!stale()) setSubSrc(url);
  };
  const applyAudio = async (n, { remember } = {}) => {
    const a = subs?.audio?.find((x) => x.n === n);
    if (!a) return;
    if (remember && subs?.showKey) tv.rememberAudio(subs.showKey, n === subs.audioDefault ? 'orig' : a.lang || 'orig');
    const textOn = subId && subs.tracks.find((x) => x.id === subId)?.kind === 'text';
    const st = await switchStream({ audio: n });
    if (st != null && textOn) { const u = await textSrc(subId, st); setSubSrc(u); }
  };
  const applyAudioRef = useRef(null); applyAudioRef.current = applyAudio;
  useEffect(() => {
    subGen.current++;
    alt.current = { burn: null, audio: 0 };
    subBox.current?.replaceChildren();
    setSubs(null); setSubId(null); setSubSrc(null);
    if (!itemId || !tuned?.play || cast?.on || play?.mode === 'live') return;
    const want = itemId;
    subFor.current = want;
    tv.subtitles(itemId).then((r) => {
      if (subFor.current !== want || !r) return;
      alt.current = { burn: null, audio: r.audioDefault ?? 0 };
      setSubs(r);
      // Your audio first (dub or original), then the subtitles that go with it.
      setTimeout(async () => {
        if (r.audio?.length && r.audioPick !== r.audioDefault) await applyAudioRef.current(r.audioPick);
        if (r.pick) applySubRef.current(r.pick);
      }, 0);
    });
  }, [tuned, cast?.on]);
  const applySubRef = useRef(applySub); applySubRef.current = applySub;
  // We draw the subtitles ourselves (not the browser's cue box): a clean outlined line a bit
  // above the bottom edge, cleared the moment the video or track changes.
  useEffect(() => {
    const v = realVid.current;
    const box = subBox.current;
    box?.replaceChildren();
    if (!v) return;
    const all = v.textTracks;
    for (let i = 0; i < all.length; i++) all[i].mode = 'disabled';
    const tr = subSrc && v.querySelector('track')?.track;
    if (!tr) return;
    tr.mode = 'hidden'; // cues still fire; the browser just doesn't paint them
    const show = () => {
      const seen = new Set();
      const lines = [];
      for (const c of [...(tr.activeCues || [])].sort((a, b) => a.startTime - b.startTime)) {
        const key = c.text.trim();
        if (!key || seen.has(key)) continue; // styled subs often repeat a line in layers
        seen.add(key);
        const line = document.createElement('div');
        line.className = 'sub-line';
        const span = document.createElement('span');
        span.append(c.getCueAsHTML());
        line.append(span);
        lines.push(line);
      }
      box?.replaceChildren(...lines);
    };
    const wipe = () => box?.replaceChildren();
    tr.addEventListener('cuechange', show);
    v.addEventListener('emptied', wipe); // the video was unloaded or swapped
    v.addEventListener('ended', wipe);
    return () => { tr.removeEventListener('cuechange', show); v.removeEventListener('emptied', wipe); v.removeEventListener('ended', wipe); tr.mode = 'disabled'; wipe(); };
  }, [subSrc]);

  useEffect(() => {
    const v = vid.current;
    const onError = () => {
      if (!tuned?.play) return;
      const code = v.error?.code;
      onFailed(tuned, code).then((retrying) => { if (!retrying) { setLoading(false); setError(live ? 'This station isn\u2019t broadcasting right now.' : `This file couldn't be played (code ${code}).`); } });
    };
    const onEnd = () => onEnded(tuned);
    v.addEventListener('error', onError);
    v.addEventListener('ended', onEnd);
    return () => { v.removeEventListener('error', onError); v.removeEventListener('ended', onEnd); };
  }, [tuned, onEnded, onFailed, casting]);

  // Playback can stall SILENTLY — the data stops but no 'ended' or 'error' ever
  // fires (hours in the background, or the PC briefly too busy to serve video).
  // If the clock freezes for ~15s while we're supposed to be playing: a live
  // station goes through its reconnect logic, a file quietly resumes where it
  // was. Once something is playing it must NEVER sit there not knowing what to do.
  useEffect(() => {
    if (!tuned?.play || casting) return;
    const isLive = tuned.play.mode === 'live';
    let last = -1, still = 0, loadStuck = 0;
    const kick = () => { still = 0; loadStuck = 0; last = -1; if (isLive) onEnded(tuned); else onStalled?.(tuned, vid.current?.currentTime || 0); };
    const t = setInterval(() => {
      const v = vid.current;
      if (!v || error) { still = 0; loadStuck = 0; return; }
      // Stuck CONNECTING is a drop too: a reconnect that answers but never
      // sends a byte used to spin forever until someone re-clicked the channel.
      if (loading) { ++loadStuck; if (isLive && loadStuck === 2) onHiccup?.(tuned); if (loadStuck >= 5) kick(); return; }
      loadStuck = 0;
      if (v.paused || v.seeking) { still = 0; return; }
      if (v.currentTime > 0 && v.currentTime === last) {
        ++still;
        // Live: say what's happening after ~5s, reconnect after ~10s (a frozen
        // picture for 20s looked broken). Files stay patient (~20s).
        if (isLive && still === 1) onHiccup?.(tuned);
        if (still >= (isLive ? 2 : 4)) kick();
      } else { still = 0; last = v.currentTime; }
    }, 5000);
    return () => clearInterval(t);
  }, [tuned, casting, loading, error, onEnded, onStalled, onHiccup]);

  // ---- DVR: pause, rewind, fast-forward — like a cable box ----
  // The buffer starts when you tune to the channel: rewind as far back as you've
  // been watching it, fast-forward up to live. Only this viewer is time-shifted;
  // channel schedules never move. Crossing a program boundary re-tunes at that
  // point on the channel's timeline.
  const length = () => (entry ? (entry.end - entry.start) / 1000 : 0);
  const liveAt = () => (entry ? Math.min(length(), (Date.now() - entry.start) / 1000) : 0);
  const position = () => pending.current ?? (base.current + (vid.current?.currentTime || 0));
  // Where on the channel's timeline we are (cards have no media: they keep the tune delay).
  const wallPos = () => (play ? entry.start + position() * 1000 : Date.now() - (tuned.now - tuned.at));
  const behind = () => (entry ? Math.max(0, (Date.now() - wallPos()) / 1000) : 0);
  const showDvr = () => {
    setDvr({ at: Date.now() });
    clearTimeout(timers.dvr);
    timers.dvr = setTimeout(() => setDvr(null), 2600);
  };
  // Live stations: the "buffer" is what the video element has downloaded.
  const bufEdge = () => { const b = vid.current?.buffered; return b && b.length ? b.end(b.length - 1) : 0; };
  const bufStart = () => { const b = vid.current?.buffered; return b && b.length ? b.start(0) : 0; };
  const seekTo = (target) => {
    const v = vid.current;
    if (!entry) return;
    if (live) {
      v.currentTime = Math.max(bufStart(), Math.min(bufEdge() - 1, target));
      v.play().catch(() => {}); setPaused(false); showDvr();
      return;
    }
    if (vod) {
      target = Math.max(0, Math.min(length() - 1, target));
      clearTimeout(timers.preview);
      timers.preview = setTimeout(() => setPreview(Math.round(target / 5) * 5), 120);
      clearTimeout(timers.previewOff);
      timers.previewOff = setTimeout(() => setPreview(null), 2200);
      if (play.mode === 'direct') { v.currentTime = target; v.play().catch(() => {}); setPaused(false); showDvr(); return; }
      pending.current = target;
      clearTimeout(seekTimer.current);
      seekTimer.current = setTimeout(() => {
        const t = pending.current;
        base.current = t;
        v.src = play.url.replace(/([?&]t=)[\d.]+/, '$1' + t.toFixed(2));
        subAt.current?.(t);
        v.load(); v.play().catch(() => {});
        pending.current = null; setPaused(false);
      }, 450);
      showDvr();
      return;
    }
    // Can't rewind past when you tuned in, or fast-forward past live.
    target = Math.max(target, (bufferStart - entry.start) / 1000);
    if (play && entry.end > Date.now()) target = Math.min(target, liveAt());
    // Outside this program (or on an "Up next"/off-air card): re-tune on the timeline.
    if (!play || target < 0 || target >= length() - 0.5) { showDvr(); return onShift(entry.start + target * 1000); }
    target = Math.min(liveAt(), target);
    if (liveAt() - target < 2) target = liveAt(); // close enough: back to live
    if (play.mode === 'direct') { v.currentTime = target; v.play().catch(() => {}); setPaused(false); }
    else {
      // A stream can only start where ffmpeg starts it: restart once the scrub settles.
      pending.current = target;
      clearTimeout(seekTimer.current);
      seekTimer.current = setTimeout(() => {
        const t = pending.current;
        base.current = t;
        v.src = play.url.replace(/([?&]t=)[\d.]+/, '$1' + t.toFixed(2));
        subAt.current?.(t);
        v.load(); v.play().catch(() => {});
        pending.current = null;
        setPaused(false);
      }, 450);
    }
    showDvr();
  };

  // Imperative controls for the remote.
  apiRef.current = {
    // Subtitles: cycle Off → track 1 → track 2 …; returns what's showing now.
    cycleSubs() {
      if (!subs?.tracks.length) return { label: 'No subtitles for this video', none: true };
      const opts = [null, ...subs.tracks.map((x) => x.id)];
      const next = opts[(opts.indexOf(subId) + 1) % opts.length];
      applySub(next, { remember: true });
      return { label: next ? subs.tracks.find((x) => x.id === next).label : 'Off' };
    },
    subtitles: () => ({ tracks: subs?.tracks || [], on: subId, audio: subs?.audio || [], audioOn: alt.current.audio }),
    setSubtitle: (id) => applySub(id, { remember: true }),
    setAudio: (n) => applyAudio(n, { remember: true }),
    // Cycle audio tracks (dub ↔ original); returns what's playing now.
    cycleAudio() {
      const list = subs?.audio || [];
      if (list.length < 2) return { label: 'Only one audio track', none: true };
      const i = list.findIndex((a) => a.n === alt.current.audio);
      const nx = list[(i + 1) % list.length];
      applyAudio(nx.n, { remember: true });
      return { label: nx.label };
    },
    togglePause() {
      const v = vid.current;
      if (!tuned?.play) return;
      if (v.paused) { v.play(); setPaused(false); }
      else { v.pause(); pausedAt.current = Date.now(); setPaused(true); }
      showDvr();
    },
    seekBy: (d) => (live ? seekTo((vid.current?.currentTime || 0) + d) : play ? seekTo(position() + d) : entry && onShift(Math.max(bufferStart, wallPos() + d * 1000))),
    goLive: () => (live ? seekTo(Infinity) : vod ? null : entry && entry.end > Date.now() && play ? seekTo(liveAt()) : onShift(Date.now())),
    behind: () => (vod ? 0 : live ? Math.max(0, bufEdge() - (vid.current?.currentTime || 0)) : behind()),
    // Paused or rewound = time-shifted; the app stops jumping to the next show.
    isLive: () => !vod && !paused && (live ? bufEdge() - (vid.current?.currentTime || 0) < 8 : behind() < 4),
    position,
    paused,
    // For the mouse scrub bar (on demand): how long it is, and jump anywhere.
    duration: () => (vod && play ? length() : 0),
    seekTo: (t) => vod && play && seekTo(t),
    frameUrl,
    // Opening / ending chapters found in the file (for Skip intro / Next episode).
    chapters: () => ({ intro: subs?.intro || null, outro: subs?.outro || null, ready: !!subs }),
  };

  const dvrBar = (dvr || paused) && entry && vod && (() => {
    const len = length() || 1, pos = position();
    const pf = preview != null && frameUrl(preview);
    return html`<div class="dvr">
      <span class="dvr-state">${paused ? '❚❚' : '▶'}</span>
      <div class="dvr-track"><i class="dvr-live" style="left:0;right:0"></i><i class="dvr-pos" style=${`left:${Math.min(100, (pos / len) * 100)}%`}></i>
        ${pf && html`<div class="dvr-preview" style=${`left:${Math.min(100, (preview / len) * 100)}%`}><img src=${pf} alt="" /><span>${fmtClock(preview)}</span></div>`}</div>
      <span class="dvr-time" style="min-width:120px">${fmtClock(pos)} / ${fmtClock(len)}</span>
    </div>`;
  })() || (dvr || paused) && entry && live && (() => {
    const b = Math.max(0, bufEdge() - (vid.current?.currentTime || 0));
    const span = Math.max(bufEdge() - bufStart(), 1);
    return html`<div class="dvr">
      <span class="dvr-state">${paused ? '❚❚' : b < 8 ? '●' : '⟲'}</span>
      <div class="dvr-track"><i class="dvr-live" style="left:0;right:0"></i><i class="dvr-pos" style=${`left:${Math.min(100, ((vid.current?.currentTime || 0) - bufStart()) / span * 100)}%`}></i></div>
      <span class="dvr-time">${b < 8 && !paused ? 'LIVE' : '−' + fmtClock(b)}</span>
    </div>`;
  })() || (dvr || paused) && entry && (() => {
    const now = Date.now();
    const from = Math.min(bufferStart, now - 60e3);
    const span = Math.max(now - from, 1);
    const b = behind();
    return html`<div class="dvr">
      <span class="dvr-state">${paused ? '❚❚' : b < 4 ? '●' : '⟲'}</span>
      <div class="dvr-track">
        <i class="dvr-live" style=${`left:${Math.max(0, (bufferStart - from) / span) * 100}%;right:0`}></i>
        <i class="dvr-pos" style=${`left:${Math.min(100, Math.max(0, (wallPos() - from) / span * 100))}%`}></i>
      </div>
      <span class="dvr-time">${b < 4 && !paused ? 'LIVE' : '−' + fmtClock(b)}</span>
    </div>`;
  })();

  const audioOnly = play?.audioOnly;
  return html`<div class=${'stage' + (pip ? ' pip' : '') + (covered ? ' covered' : '')} data-fit=${settings.fit || 'fit'} data-vod=${vod ? '1' : undefined}>
    <video ref=${realVid} crossorigin="anonymous" playsinline style=${(audioOnly ? 'opacity:0;' : '') + `filter:brightness(${settings.brightness ?? 1})`}>${subSrc && html`<track key=${subSrc} kind="subtitles" src=${subSrc} />`}</video>
    <div class="sub-box" ref=${subBox} aria-live="off"></div>
    ${tuned?.channel && entry && !play && entry.type === 'offair' && html`<${OffAirScreen} channel=${tuned.channel} entry=${entry} next=${tuned.next} />`}
    ${tuned?.channel && entry && !play && (entry.type === 'ident' || entry.type === 'ad') && html`<${IdentCard} channel=${tuned.channel} entry=${entry} />`}
    ${tuned?.channel && entry && !play && entry.type !== 'offair' && entry.type !== 'ad' && entry.type !== 'ident' && entry.type !== 'ondemand' && html`<${UpNextScreen} channel=${tuned.channel} next=${tuned.next} />`}
    ${audioOnly && !casting && html`<${MusicScreen} entry=${entry} channel=${tuned.channel} video=${realVid.current} />`}
    ${casting && html`<div class="card-screen cast-screen"><div>
      <div class="cast-ic">${castIcon}</div>
      <div class="kicker">Playing on ${cast.device}</div>
      <h1>${tuned?.entry ? (tuned.entry.live ? tuned.channel?.name : entryText(tuned.entry).title) : tuned?.channel?.name || ''}</h1>
      <div class="sub">${tuned?.channel ? `Channel ${tuned.channel.number} · ${tuned.channel.name}` : 'On demand'}</div>
      <div class="hint">Your remote, keyboard and controller still work — change channels, open the guide, pause and rewind. Press K to stop casting.</div>
    </div></div>`}
    ${error && html`<div class="card-screen error-screen"><div><div class="kicker">Signal problem</div><h1>${entryText(entry).title}</h1><div class="sub">${error}<br/>Back on air at ${fmtTime(entry.end)}.</div></div></div>`}
    <${Static} on=${transitions && loading} />
    ${!transitions && loading && html`<div class="card-screen" style="background:#000"></div>`}
    ${dvrBar}
    ${pip && html`<button class=${'pip-pause' + (paused ? ' show' : '')} title=${paused ? 'Play' : 'Pause'} onClick=${(e) => { e.stopPropagation(); apiRef.current.togglePause(); }}>${paused ? '▶' : '❚❚'}</button>`}
    ${pip && onVolume && html`
      <button class="pip-mute" title=${settings.muted ? 'Unmute (M)' : 'Mute (M)'} onClick=${(e) => { e.stopPropagation(); onVolume({ muted: !settings.muted }); }}>${settings.muted ? '🔇' : '🔊'}</button>
      <div class="pip-volbar" onClick=${(e) => e.stopPropagation()}>
        <input type="range" min="0" max="1" step="0.05" value=${settings.muted ? 0 : settings.volume ?? 0.9} onInput=${(e) => onVolume({ volume: +e.target.value, muted: false })} />
      </div>`}
    ${children}
  </div>`;
}
