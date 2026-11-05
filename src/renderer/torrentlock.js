// Torrents stay off, and out of sight, until a grown-up reads this and turns them on.
// The same words in first-time setup and in Settings. src/main/main.js enforces the lock:
// while it's off, nothing torrent-related runs, whatever the screens do.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { tv, Icon } from './util.js';
import { VPNS } from './torrents.js';

export const consentDone = (t) => !!t?.legal && !!t?.own;

// The explanation and the two boxes to tick. ticks: { legal, own }.
export function TorrentConsent({ ticks, setTicks }) {
  const [vpn, setVpn] = useState(null);
  useEffect(() => {
    let on = true;
    const look = () => tv.torrentVpn().then((v) => on && setVpn(v)).catch(() => {});
    look();
    const t = setInterval(look, 5000);
    return () => { on = false; clearInterval(t); };
  }, []);
  const tick = (k, text) => html`<label class="consent-tick"><input type="checkbox" checked=${!!ticks[k]} onChange=${(e) => setTicks({ ...ticks, [k]: e.target.checked })} /><span>${text}</span></label>`;
  return html`<div class="consent">
    <div class="consent-box bad"><b>⚖️ Don’t use torrents for anything illegal</b>
      <span>Only download what you have the right to, like free public-domain films or your own files. Downloading or sharing movies and shows without permission is illegal in most countries, and it can lead to warning letters, fines or lawsuits.</span></div>
    <div class="consent-box"><b>🛡 Always use a VPN</b>
      <span>Torrents show your internet address to everyone sharing the same file, and your internet provider can see that you’re using them. A good VPN hides this. It protects your privacy, but it doesn’t make anything legal.</span>
      ${!vpn ? html`<span>Checking for a VPN…</span>` : vpn.found ? html`<span class="consent-ok">✓ ${vpn.found.provider || 'A VPN'} is on. Torrents will use only that connection.</span>`
        : html`<span class="consent-warn">⚠ No VPN is on right now. We strongly recommend getting one first. Free plans usually aren’t enough, so choose a paid plan that allows torrent sharing (P2P).</span>
          <div class="row" style="gap:8px;flex-wrap:wrap">${VPNS.map(([n, u]) => html`<a class="btn sm" href=${u} target="_blank" rel="noreferrer">${n}</a>`)}</div>`}</div>
    <div class="consent-box"><b>🤝 It’s up to you</b>
      <span>HomeCable doesn’t host, supply or recommend any torrents. You alone choose what you download and share, and you alone are responsible for it. HomeCable and the people who make it are not responsible for how you use this feature.</span></div>
    ${tick('legal', 'I will only download and share things I have the right to.')}
    ${tick('own', 'I understand that I’m responsible for how I use torrents, that HomeCable’s makers are not, and that I should always use a VPN.')}
  </div>`;
}

// Settings: the one switch. Off, it explains itself; turning it on goes through the warning first.
export function TorrentLockDialog({ onClose, onEnabled, toast }) {
  const [ticks, setTicks] = useState({});
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await tv.torrentsLock(true, true); onEnabled(); }
    catch (e) { toast?.(String(e.message || e)); setBusy(false); }
  };
  return html`<div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}><div class="modal consent-modal">
    <div class="modal-head"><h3>Turn on torrents?</h3><button class="icon-btn" title="Close" onClick=${onClose}><${Icon.close} /></button></div>
    <div class="modal-body">
      <p class="muted" style="margin-top:0">Most people never need torrents. They download videos from other people’s computers and share what you download with others at the same time.</p>
      <${TorrentConsent} ticks=${ticks} setTicks=${setTicks} />
      <div class="row" style="justify-content:flex-end;gap:10px;margin-top:16px">
        <button class="btn" onClick=${onClose}>Keep them off</button>
        <button class="btn primary" disabled=${!consentDone(ticks) || busy} onClick=${go}>${busy ? 'Turning on…' : 'Turn on torrents'}</button>
      </div>
    </div>
  </div></div>`;
}

export function TorrentLockRow({ settings, setSettings, toast, askOpen = false, onAsked = () => {} }) {
  const [ask, setAsk] = useState(false);
  const [askOff, setAskOff] = useState(false);
  useEffect(() => { if (askOpen && !settings.torrentsOn) { setAsk(true); onAsked(); } }, [askOpen]);
  const off = async () => {
    try { await tv.torrentsLock(false); setSettings({ torrentsOn: false }); setAskOff(false); toast('Torrents are off. Your downloads are kept for if you turn them back on.'); }
    catch (e) { toast(String(e.message || e)); }
  };
  return html`<div class="settings-row"><div class="grow"><b>🧲 Torrents</b>
      <span>${settings.torrentsOn ? 'On. HCtorrents is in the top bar. Please use them legally, and always with a VPN.' : 'Off, and hidden everywhere. Most people never need them. Turning them on shows you what you need to know first.'}</span></div>
    ${settings.torrentsOn ? html`<button class="btn sm" onClick=${() => setAskOff(true)}>Turn off…</button>` : html`<button class="btn sm" onClick=${() => setAsk(true)}>Turn on…</button>`}
    ${ask && html`<${TorrentLockDialog} toast=${toast} onClose=${() => setAsk(false)} onEnabled=${() => { setAsk(false); setSettings({ torrentsOn: true, torrentsLockNote: null }); toast('Torrents are on. Find HCtorrents in the top bar.'); }} />`}
    ${askOff && html`<div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && setAskOff(false)}><div class="modal"><div class="modal-head"><h3>Turn off torrents?</h3></div>
      <div class="modal-body"><p>Everything downloading or sharing stops, and torrent videos leave your channels and Library. Their files stay on this PC and come back if you turn torrents on again. To delete them, use My torrents first.</p>
        <div class="row" style="justify-content:flex-end;gap:10px"><button class="btn" onClick=${() => setAskOff(false)}>Keep them on</button><button class="btn primary" onClick=${off}>Turn off</button></div></div></div></div>`}
  </div>`;
}
