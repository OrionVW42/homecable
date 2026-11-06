// The Terms of Use: the same text the installer shows (build/license.txt), readable any time.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { tv, Icon } from './util.js';

export function TermsDialog({ onClose }) {
  const [text, setText] = useState('');
  useEffect(() => { tv.terms().then((t) => setText(t.text)).catch(() => setText('The terms could not be opened.')); }, []);
  return html`<div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}><div class="modal">
    <div class="modal-head"><h3>Terms of Use</h3><button class="icon-btn" title="Close" onClick=${onClose}><${Icon.close} /></button></div>
    <div class="modal-body"><pre class="terms-text">${text}</pre></div>
  </div></div>`;
}

// Asked once when the terms have changed since this person last agreed. Nothing plays until they answer.
export function TermsChanged({ onAgreed }) {
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await tv.termsAccept(true); onAgreed(); } catch { setBusy(false); }
  };
  return html`<div class="modal-bg terms-changed"><div class="modal consent-modal">
    <div class="modal-head"><h3>The Terms of Use have changed</h3></div>
    <div class="modal-body">
      <p class="muted">They now cover the Movies, TV shows and anime lists, and what happens if you choose to play films through torrents: a film’s name goes to your search sources, HomeCable doesn’t check the results, and what you play that way is downloaded and shared with other people. Those features stay off unless you turn them on.</p>
      <${TermsAgree} agreed=${agreed} onAgree=${setAgreed} />
      <div class="row" style="justify-content:flex-end;gap:10px">
        <button class="btn" onClick=${() => window.close()}>Close HomeCable</button>
        <button class="btn primary" disabled=${!agreed || busy} onClick=${go}>Continue</button>
      </div>
    </div>
  </div></div>`;
}

// The first screen of setup: plain words, the full text one press away, and a box to tick.
export function TermsAgree({ agreed, onAgree }) {
  const [read, setRead] = useState(false);
  return html`<div class="terms-agree">
    <span>HomeCable is free, comes with no warranty, and doesn’t host any videos. <b>You’re responsible for what you play and for having the right to play it. Don’t use it for anything illegal.</b> The people who make it aren’t responsible for how it’s used.</span>
    <label class="consent-tick terms-tick"><input type="checkbox" checked=${agreed} onChange=${(e) => onAgree(e.target.checked)} /><span>I agree to the <a href="#" onClick=${(e) => { e.preventDefault(); setRead(true); }}>Terms of Use</a>.</span></label>
    ${read && html`<${TermsDialog} onClose=${() => setRead(false)} />`}
  </div>`;
}
