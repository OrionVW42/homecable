// Settings → Phone app: turn it on, show the QR code, see / forget paired phones.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { tv } from './util.js';

const KIND = { home: 'Home Wi-Fi', radmin: 'Radmin VPN (away from home)', tailscale: 'Tailscale (away from home)', other: 'Other network' };
const ago = (t) => { if (!t) return 'never'; const m = Math.round((Date.now() - t) / 60000); return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };

export function PhoneSettings({ toast }) {
  const [v, setV] = useState(null);
  const [pair, setPair] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { tv.phoneStatus().then(setV); }, []);
  useEffect(() => tv.onPhonePaired(() => { setPair(null); tv.phoneStatus().then(setV); }), []);
  const run = async (fn) => { setErr(''); try { return await fn(); } catch (e) { setErr(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); return null; } };
  const start = async () => { const r = await run(() => tv.phonePairStart()); if (r) { setPair(r); setV(r); } };
  if (!v) return null;
  const away = v.addresses.some((a) => a.kind === 'radmin' || a.kind === 'tailscale');
  return html`<div class="settings-row"><div class="grow"><b>📱 Phone app</b><span>${v.enabled
      ? html`On — ${v.devices.length ? `${v.devices.length} phone${v.devices.length === 1 ? '' : 's'} paired` : 'no phones paired yet'}. Watch from this PC on your phone, or use the phone as a remote. Nothing is copied to the phone.`
      : 'Watch your channels, On Demand and Stream Demand on your phone — streamed from this PC — or use the phone as a remote. Pair it once with a QR code.'}</span></div>
    ${v.enabled && html`<button class="btn sm" onClick=${() => run(() => tv.phoneEnable(false)).then((r) => r && setV(r))}>Turn off</button>`}
    <button class="btn sm primary" onClick=${start}>Pair a phone…</button>
  </div>
  ${v.devices.map((d) => html`<div class="settings-row sub-row"><div class="grow"><b>📱 ${d.name}</b><span>Paired ${new Date(d.added).toLocaleDateString()} · last used ${ago(d.lastSeen)}. Whose phone it is decides what it can watch — a kid's phone only gets kid-friendly channels.</span></div>
    <select class="select" value=${d.level || 'adults'} onChange=${(e) => run(() => tv.phoneSetLevel(d.id, e.target.value)).then((r) => r && setV(r))}>
      <option value="adults">Grown-up’s</option><option value="teens">Teen’s</option><option value="kids">Kid’s</option></select>
    <button class="btn sm" onClick=${() => run(() => tv.phoneForget(d.id)).then((r) => { if (r) { setV(r); toast(`${d.name} can’t connect any more`); } })}>Forget</button></div>`)}
  ${err && html`<div class="vault-msg">${err}</div>`}
  ${pair && html`<div class="modal-bg" onClick=${() => { tv.phonePairStop(); setPair(null); }}><div class="modal phone-pair" onClick=${(e) => e.stopPropagation()}>
    <div class="modal-head"><h3>📱 Pair a phone</h3></div>
    <div class="modal-body">
      <div class="pair-grid">
        <img class="pair-qr" src=${pair.qr} alt="QR code" />
        <div>
          <ol class="pair-steps">
            <li>Install <b>HomeCable</b> on the phone (the HomeCable-Phone APK).</li>
            <li>Open it and tap <b>Scan the QR code</b>.</li>
            <li>Point it at this code. Done — it remembers this PC.</li>
          </ol>
          <p class="muted small">No camera? Type this PC’s address and the code instead:</p>
          <div class="pair-code">${pair.pairing.code.slice(0, 3)} ${pair.pairing.code.slice(3)}</div>
          ${pair.addresses.map((a) => html`<div class="pair-addr"><code>${a.ip}:${pair.port}</code><span>${KIND[a.kind]}</span></div>`)}
        </div>
      </div>
      <p class="muted small" style="margin-top:12px">${away ? 'Away from home: keep Radmin / Tailscale on, on the phone too — it connects the same way.' : 'At home: the phone must be on the same Wi-Fi. Away from home works through a VPN like Radmin or Tailscale on both.'} The code works for 10 minutes. If Windows asks about the firewall, allow private networks.</p>
      <div class="row" style="justify-content:flex-end"><button class="btn" onClick=${() => { tv.phonePairStop(); setPair(null); }}>Close</button></div>
    </div></div></div>`}`;
}
