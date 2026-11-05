// "Cast to TV": pick a Chromecast / Google TV on your network. Whatever is on
// keeps playing — on the TV — and the channels, guide and remote keep working here.
// TVs are found in the background, so the list is ready the moment this opens;
// the TV you used last is first and already highlighted (one press to cast).
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { tv, Icon } from './util.js';

export const CastGlyph = () => html`<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 8V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/><path d="M3 12a8 8 0 0 1 8 8M3 16a4 4 0 0 1 4 4"/><circle cx="3.5" cy="19.5" r="1" fill="currentColor"/></svg>`;

const clean = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function CastMenu({ cast, tvs, setTvs, settings, setSettings, onClose, toast }) {
  const [looking, setLooking] = useState(false);
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);
  const first = useRef();

  const look = (refresh) => {
    setLooking(true);
    tv.castDevices(refresh).then((l) => { setTvs(l); setLooking(false); }).catch(() => setLooking(false));
  };
  useEffect(() => { look(false); const t = setTimeout(() => look(true), 400); return () => clearTimeout(t); }, []);
  // A TV switched on while this is open turns up by itself.
  useEffect(() => {
    if (cast?.on) return;
    const t = setInterval(() => tv.castDevices(true).then(setTvs).catch(() => {}), 15000);
    return () => clearInterval(t);
  }, [cast?.on]);
  // Keyboard: Enter casts to the highlighted (last-used) TV straight away.
  useEffect(() => { if (!cast?.on) first.current?.focus(); }, [tvs.length]);

  // While casting, the live mode; before that, the one you picked (remembered).
  const mode = cast?.on ? cast.mode : settings.castMode || 'mirror';
  const setMode = async (m) => { if (cast?.on) { setBusy('mode'); await tv.castMode(m); setBusy(null); } else setSettings({ castMode: m }); };
  const start = async (d) => {
    setBusy(d.id); setProblem(null);
    try { await tv.castStart(d.id, mode); toast(`📺 Now on ${d.name}`); onClose(); }
    catch (e) { setProblem(`${d.name}: ${clean(e)}`); }
    setBusy(null);
  };
  const stop = async () => { setBusy('stop'); await tv.castStop(); setBusy(null); toast('Back on this screen'); onClose(); };

  const others = tvs.filter((d) => d.id !== cast?.deviceId);
  return html`<div class="modal-bg" onClick=${onClose}><div class="modal narrow cast-menu" onClick=${(e) => e.stopPropagation()}>
    <div class="modal-head"><h3><${CastGlyph} /> ${cast?.on ? 'Casting' : 'Watch on a TV'}</h3><button class="icon-btn" title="Close (Esc)" onClick=${onClose}><${Icon.close} /></button></div>
    <div class="modal-body">
      ${cast?.on && html`<div class="cast-now"><span class="ic"><${CastGlyph} /></span><div><small>Playing on</small><b>${cast.device}</b></div>
        <button class="btn primary gp-default" disabled=${busy === 'stop'} onClick=${stop}>${busy === 'stop' ? 'Stopping…' : 'Stop casting'}</button></div>`}
      <div class="cast-modes">
        <button class=${'cast-mode' + (mode === 'mirror' ? ' on' : '')} disabled=${busy === 'mode'} onClick=${() => setMode('mirror')}>
          <b>🖥️ Everything</b><span>The TV shows exactly what’s on this screen — guide, menus, banners. Use your controller and see it on the TV (about a second behind — a few seconds on older TVs).</span></button>
        <button class=${'cast-mode' + (mode === 'media' ? ' on' : '')} disabled=${busy === 'mode'} onClick=${() => setMode('media')}>
          <b>🎬 Just the picture</b><span>Sharpest video, sent straight to the TV. Menus and the guide stay on this screen.</span></button>
      </div>
      ${!cast?.on && html`<p class="muted" style="margin:0 0 14px">Pick your TV — your channels carry on there, live like cable.</p>`}
      ${cast?.on && others.length > 0 && html`<div class="tv-section-label">Switch to another TV</div>`}

      ${others.map((d, i) => html`<div class=${'cast-dev-row' + (d.online === false ? ' off' : '')}><button ref=${i === 0 ? first : null} class=${'cast-dev' + (i === 0 && !cast?.on && d.online !== false ? ' gp-default' : '')} disabled=${!!busy} onClick=${() => start(d)}>
        <span class="ic">${d.kind === 'dlna' ? '📺' : html`<${CastGlyph} />`}</span>
        <span class="grow"><b>${d.saved ? '★ ' : ''}${d.name}</b><small>${d.last ? 'Last used · ' : ''}${d.kind === 'dlna' ? d.label || 'Smart TV (DLNA)' : d.model ? `Chromecast · ${d.model}` : 'Chromecast / Google TV'}${d.online === false ? ' · off or not on this Wi-Fi' : ''}</small></span>
        <span class="go">${busy === d.id ? html`<span class="spin"></span> Connecting…` : d.online === false ? 'Try' : cast?.on ? 'Switch' : 'Cast'}</span></button>
        ${d.saved && html`<button class="cast-forget" title=${`Forget ${d.name}`} onClick=${async () => setTvs(await tv.castForget(d.id))}>✕</button>`}</div>`)}
      ${tvs.length > 0 && html`<p class="muted small" style="margin:8px 2px 0">★ = saved (your last 10 TVs). Works with Chromecast / Google TV and smart TVs with a built-in media player (DLNA) — Samsung 2010 and later, LG, Sony, Panasonic and more.</p>`}
      <p class="muted small" style="margin:8px 2px 0">Using a VPN? It can stay on. If a TV doesn’t show up, look in your VPN’s settings for something like “Allow LAN connections”.</p>

      ${!tvs.length && (looking ? html`<div class="cast-dev muted" style="cursor:default"><span class="spin"></span> Looking for TVs on your Wi-Fi…</div>`
        : html`<div class="cast-empty"><b>No TVs found yet</b><span>Switch the TV (or Chromecast) on, and make sure it’s on the same Wi-Fi as this PC. Older smart TVs (Samsung AllShare and others with DLNA) show up here too. It should appear by itself within a few seconds, or press “Look again”.</span></div>`)}
      ${problem && html`<div class="cast-problem">${problem}</div>`}

      ${settings.castLast && html`<label class="cast-auto">
        <button class=${'toggle' + (settings.castAuto ? ' on' : '')} role="switch" aria-checked=${!!settings.castAuto} onClick=${() => setSettings({ castAuto: !settings.castAuto })}></button>
        <span><b>Start on ${settings.castLast.name} automatically</b><small>When HomeCable opens and that TV is on, the picture goes straight to it.</small></span></label>`}

      <div class="row" style="justify-content:space-between;margin-top:14px;gap:12px">
        <button class="btn sm" onClick=${() => look(true)} disabled=${looking}>${looking ? html`<span class="spin"></span> Looking…` : html`<${Icon.refresh} /> Look again`}</button>
        <span class="muted small">${mode === 'mirror' ? 'Keep HomeCable open (not minimized). Fullscreen on the PC gives the sharpest TV picture.' : 'Keep HomeCable open — the TV plays from this PC.'}</span>
      </div>
    </div>
  </div></div>`;
}
