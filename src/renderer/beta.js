// Settings → Beta: things that are new and still being worked on. Each stays off, and out of
// sight, until a grown-up reads what it does and turns it on. The same words in first-time setup
// and in Settings. src/main/main.js enforces it: while it's off, nothing behind it runs.
import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { tv, Icon } from './util.js';

export const moviesConsentDone = (t) => !!t?.rights && !!t?.own;

// The explanation and the two boxes to tick. ticks: { rights, own }.
export function MoviesConsent({ ticks, setTicks }) {
  const tick = (k, text) => html`<label class="consent-tick"><input type="checkbox" checked=${!!ticks[k]} onChange=${(e) => setTicks({ ...ticks, [k]: e.target.checked })} /><span>${text}</span></label>`;
  return html`<div class="consent">
    <div class="consent-box"><b>🧪 This is a beta</b>
      <span>It’s new and still being worked on. Things may be wrong or missing, or may stop working, and it could change or go away in an update.</span></div>
    <div class="consent-box"><b>🎬 It’s a list of films, TV shows and anime, not a streaming service</b>
      <span>Most of what’s listed won’t play. HomeCable doesn’t host any of it, and a title being listed doesn’t mean you have the right to watch or copy it. Only what you own and free Internet Archive copies play, and everything else says “No streams available”, unless you choose to play films through torrents in Settings → Beta. Then a film’s page searches the torrent sources you turned on or added, and HomeCable can’t tell what those results are or whether you may use them.</span></div>
    <div class="consent-box bad"><b>⚖️ “Free” isn’t a promise</b>
      <span>The Internet Archive’s public-domain and Creative Commons labels are mostly typed in by whoever uploaded the film, and they can be wrong. HomeCable checks what it can, but it can’t be sure. If you know a film isn’t really free, don’t play it.</span></div>
    <div class="consent-box"><b>👪 Not checked for children</b>
      <span>It lists grown-up films, with their covers and stories, and has no rating filter yet. Only grown-up profiles can see this tab.</span></div>
    <div class="consent-box"><b>🌐 It goes online</b>
      <span>Titles are sent to look up covers, stories, episode lists and free copies, and free films stream from the Internet Archive, which can see your internet address, like any website. If you play films through torrents, the name of a film you don’t own also goes to each search source you have on. What you watch stays on this PC. The details are in Privacy, content & licenses.</span></div>
    <div class="consent-box"><b>🤝 It’s up to you</b>
      <span>You alone choose what you play and are responsible for having the right to play it. HomeCable and the people who make it are not responsible for how you use this feature.</span></div>
    ${tick('rights', 'I will only play what I have the right to watch.')}
    ${tick('own', 'I understand this is a beta, that I’m responsible for how I use it, and that HomeCable’s makers are not.')}
  </div>`;
}

function MoviesDialog({ onClose, onEnabled, toast }) {
  const [ticks, setTicks] = useState({});
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await tv.moviesLock(true, true); onEnabled(); }
    catch (e) { toast?.(String(e.message || e)); setBusy(false); }
  };
  return html`<div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}><div class="modal consent-modal">
    <div class="modal-head"><h3>Turn on the Movies tab?</h3><button class="icon-btn" title="Close" onClick=${onClose}><${Icon.close} /></button></div>
    <div class="modal-body">
      <${MoviesConsent} ticks=${ticks} setTicks=${setTicks} />
      <div class="row" style="justify-content:flex-end;gap:10px;margin-top:16px">
        <button class="btn" onClick=${onClose}>Keep it off</button>
        <button class="btn primary" disabled=${!moviesConsentDone(ticks) || busy} onClick=${go}>${busy ? 'Turning on…' : 'Turn on the Movies tab'}</button>
      </div>
    </div>
  </div></div>`;
}

// Choosing torrents has its own warning, because it does something more: it searches your sources, and it shares.
function TorrentPlayDialog({ onClose, onChoose }) {
  const [ok, setOk] = useState(false);
  return html`<div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}><div class="modal consent-modal">
    <div class="modal-head"><h3>Play films through torrents?</h3><button class="icon-btn" title="Close" onClick=${onClose}><${Icon.close} /></button></div>
    <div class="modal-body"><div class="consent">
      <div class="consent-box"><b>🔎 It searches the sources you have on</b>
        <span>Opening a film you don’t own sends its name to every search source you turned on or added, then offers the result with the most seeders at each quality. HomeCable doesn’t check what those results are, whether they’re the right film, or whether you may use them. A film you own plays from your library, with no search. Free web copies aren’t offered on a film’s page in this mode.</span></div>
      <div class="consent-box bad"><b>📤 You’d be sharing, not only watching</b>
        <span>While a film plays this way, your PC downloads it and sends pieces of it to other people, and they can see your internet address. Always use a VPN. It protects your privacy, but it doesn’t make anything legal.</span></div>
      <label class="consent-tick"><input type="checkbox" checked=${ok} onChange=${(e) => setOk(e.target.checked)} /><span>I understand, and I’m responsible for what I download and share.</span></label>
      <div class="row" style="justify-content:flex-end;gap:10px;margin-top:6px">
        <button class="btn" onClick=${onClose}>Keep it off</button>
        <button class="btn primary" disabled=${!ok} onClick=${onChoose}>Use torrents</button>
      </div>
    </div></div>
  </div></div>`;
}

const Toggle = ({ on, label, onClick }) => html`<button class=${'toggle' + (on ? ' on' : '')} aria-label=${label} aria-pressed=${!!on} onClick=${onClick}></button>`;

export function BetaSettings({ settings, setSettings, toast, onOpenMovies = () => {} }) {
  const [ask, setAsk] = useState(false);
  const [askTor, setAskTor] = useState(false);
  const on = !!settings.moviesOn;
  const free = settings.moviesFree !== false;
  const torrentsOn = !!settings.torrentsOn;
  const by = settings.moviesPlayBy === 'torrent' && torrentsOn ? 'torrent' : 'web';
  const off = async () => {
    try { await tv.moviesLock(false); setSettings({ moviesOn: false }); toast?.('The Movies tab is off.'); }
    catch (e) { toast?.(String(e.message || e)); }
  };
  return html`
    <div class="settings-row"><div class="grow"><b>🎬 Movies, TV shows and anime</b>
      <span>${!torrentsOn ? 'Hidden until you turn on Torrents, in the section above.' : on ? 'On. Find them under HCtorrents in the top bar.' : 'Off, and hidden everywhere. A list of films, TV shows and anime, with covers, stories and episode guides. Turning it on shows you what you need to know first.'}</span></div>
      ${on && torrentsOn && html`<button class="btn sm" onClick=${onOpenMovies}>Open</button>`}
      ${on ? html`<button class="btn sm" onClick=${off}>Turn off</button>` : html`<button class="btn sm" disabled=${!torrentsOn} onClick=${() => setAsk(true)}>Turn on…</button>`}
      ${ask && html`<${MoviesDialog} toast=${toast} onClose=${() => setAsk(false)} onEnabled=${() => { setAsk(false); setSettings({ moviesOn: true }); toast?.('Turned on. Find them under HCtorrents in the top bar.'); }} />`}</div>
    ${on && torrentsOn && html`
      <div class="settings-row"><div class="grow"><b>Look for free films</b>
        <span>When you open a film or show from before 1978, ask the Internet Archive’s film and Classic TV collections for a copy marked public domain or Creative Commons. Only the title is sent, and newer titles and anime are never looked up, because those labels are often wrong on them. They can still be wrong. Turn this off and only what you own will play, unless films are set to play through torrents.</span></div>
        <${Toggle} on=${free} label="Look for free films" onClick=${() => setSettings({ moviesFree: !free })} /></div>
      <div class="settings-row"><div class="grow"><b>How films play</b>
        <span>${by === 'web' ? 'Your own and free copies: films you own, and free films straight from the Internet Archive, with nothing to download or clear up.' : 'Through torrents: a film you own plays from your library. Opening any other film searches every source you turned on or added and offers the result with the most seeders at each quality. Each one is a torrent like any you add yourself: it follows your VPN, torrent and clean-up settings, and shares with others.'}
          ${!torrentsOn && ' Through torrents needs Torrents turned on first, in the section above.'}</span></div>
        <div class="seg"><button class=${by === 'web' ? 'on' : ''} onClick=${() => setSettings({ moviesPlayBy: 'web' })}>Own and free copies</button><button class=${by === 'torrent' ? 'on' : ''} disabled=${!torrentsOn} onClick=${() => by !== 'torrent' && setAskTor(true)}>Through torrents</button></div>
        ${askTor && html`<${TorrentPlayDialog} onClose=${() => setAskTor(false)} onChoose=${() => { setAskTor(false); setSettings({ moviesPlayBy: 'torrent' }); }} />`}</div>`}`;
}
