// The locked section: a password-protected On Demand screen with a plain name you pick
// ("Archive", "Extras"…). Its folder is hidden from channels, the Library, the guide and
// setup, it's only offered to grown-up profiles, and it locks again when you leave it.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { tv } from './util.js';

export const VAULT_NAMES = ['Archive', 'Extras', 'Collection', 'Backup'];

// Name, folder and password — used by first-time setup and by Settings.
export function VaultFields({ value, onChange }) {
  const v = value;
  const set = (p) => onChange({ ...v, ...p });
  // The folder follows the name until you pick one yourself.
  useEffect(() => { if (!v.folderPicked) tv.vaultDefaultFolder(v.name).then((f) => set({ folder: f })); }, [v.name]);
  const short = v.password.length > 0 && v.password.length < 4;
  const differ = v.confirm.length > 0 && v.confirm !== v.password;
  return html`<div class="vault-fields">
    <label class="field">Name on the button <span class="faint">(pick something plain)</span>
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <input class="input" style="width:200px" maxlength="30" value=${v.name} onInput=${(e) => set({ name: e.target.value })} />
        ${VAULT_NAMES.map((n) => html`<button class=${'chip' + (v.name === n ? ' on' : '')} onClick=${() => set({ name: n })}>${n}</button>`)}
      </div></label>
    <label class="field">Folder <span class="faint">(made for you; put the videos you want locked in it)</span>
      <div class="row" style="gap:8px"><code class="od-path grow">${v.folder || '…'}</code>
        <button class="btn sm" onClick=${async () => { const f = await tv.onDemandPickFolder(v.folder); if (f) set({ folder: f, folderPicked: true }); }}>Change…</button></div></label>
    <div class="row" style="gap:10px;flex-wrap:wrap">
      <label class="field">Password<input class="input" type="password" style="width:200px" value=${v.password} onInput=${(e) => set({ password: e.target.value })} /></label>
      <label class="field">Type it again<input class="input" type="password" style="width:200px" value=${v.confirm} onInput=${(e) => set({ confirm: e.target.value })} /></label>
    </div>
    <div class="vault-msg small">${short ? 'At least 4 characters' : differ ? 'The two don’t match' : ''}</div>
  </div>`;
}
export const vaultReady = (v) => v.name.trim() && v.folder && v.password.length >= 4 && v.password === v.confirm;
export const newVault = () => ({ name: 'Archive', folder: '', password: '', confirm: '', folderPicked: false });

// Settings → Locked section
export function VaultSettings({ vault, setVault, toast, onOpen }) {
  const [modal, setModal] = useState(null); // 'create' | 'manage'
  const [form, setForm] = useState(newVault);
  const [pw, setPw] = useState({ old: '', next: '', confirm: '', remove: '' });
  const [err, setErr] = useState('');
  const close = () => { setModal(null); setErr(''); setPw({ old: '', next: '', confirm: '', remove: '' }); };
  const run = async (fn, done) => {
    setErr('');
    try { const r = await fn(); setVault(r); if (done) toast(done); return r; }
    catch (e) { setErr(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); return null; }
  };
  return html`<div class="settings-row"><div class="grow"><b>🔒 Locked section</b><span>${vault.set
      ? html`<b>${vault.name}</b> — opens with a password and locks again when you leave. What’s in its folder never shows up anywhere else.`
      : 'A password-protected screen with a plain name you choose, for videos you don’t want found by accident. Its folder stays hidden from channels, the Library and the guide.'}</span></div>
    ${vault.set ? html`<button class="btn sm" onClick=${onOpen}>Open</button><button class="btn sm primary" onClick=${() => setModal('manage')}>Manage…</button>`
      : html`<button class="btn sm primary" onClick=${() => { setForm(newVault()); setModal('create'); }}>Set up…</button>`}
    ${modal === 'create' && html`<div class="modal-bg" onClick=${close}><div class="modal" onClick=${(e) => e.stopPropagation()}>
      <div class="modal-head"><h3>🔒 Set up a locked section</h3></div>
      <div class="modal-body">
        <${VaultFields} value=${form} onChange=${setForm} />
        <div class="vault-msg">${err}</div>
        <div class="row" style="justify-content:flex-end;gap:10px;margin-top:10px">
          <button class="btn" onClick=${close}>Cancel</button>
          <button class="btn primary" disabled=${!vaultReady(form)} onClick=${async () => { if (await run(() => tv.vaultCreate({ name: form.name, password: form.password, folder: form.folder }), `🔒 “${form.name.trim()}” is ready`)) close(); }}>Lock it</button></div>
      </div></div></div>`}
    ${modal === 'manage' && vault.set && html`<div class="modal-bg" onClick=${close}><div class="modal" onClick=${(e) => e.stopPropagation()}>
      <div class="modal-head"><h3>🔒 ${vault.name}</h3></div>
      <div class="modal-body vault-manage">
        <label class="field">Name on the button<div class="row" style="gap:6px;flex-wrap:wrap">
          <input class="input" style="width:200px" maxlength="30" value=${vault.name} onChange=${(e) => run(() => tv.vaultUpdate({ name: e.target.value }))} />
          ${VAULT_NAMES.map((n) => html`<button class=${'chip' + (vault.name === n ? ' on' : '')} onClick=${() => run(() => tv.vaultUpdate({ name: n }))}>${n}</button>`)}</div></label>
        <div class="settings-row"><div class="grow"><b>Button in the top bar</b><span>Off: open it only from here (Settings → Locked section → Open).</span></div>
          <button class=${'toggle' + (vault.showButton ? ' on' : '')} onClick=${() => run(() => tv.vaultUpdate({ showButton: !vault.showButton }))}></button></div>
        <div class="settings-row"><div class="grow"><b>Also on paired phones</b><span>Shows in the phone app for grown-up phones — it asks for this password there too, and locks again when you leave it.</span></div>
          <button class=${'toggle' + (vault.phone ? ' on' : '')} onClick=${() => run(() => tv.vaultUpdate({ phone: !vault.phone }))}></button></div>
        <div class="field">Locked folders <span class="faint">(everything inside is hidden everywhere else)</span>
          ${vault.folders.map((f) => html`<div class="row" style="gap:8px;margin-top:6px"><code class="od-path grow">${f}</code>
            ${vault.folders.length > 1 && html`<button class="btn sm" onClick=${() => run(() => tv.vaultUpdate({ removeFolder: f }), 'Folder unlocked')}>Unlock folder</button>`}</div>`)}
          <button class="btn sm" style="margin-top:8px" onClick=${async () => { const f = await tv.onDemandPickFolder(vault.folders[0]); if (f) run(() => tv.vaultUpdate({ addFolder: f }), '🔒 Folder locked'); }}>+ Lock another folder…</button></div>
        <div class="field">Change the password<div class="row" style="gap:8px;flex-wrap:wrap">
          <input class="input" type="password" placeholder="Current" style="width:150px" value=${pw.old} onInput=${(e) => setPw({ ...pw, old: e.target.value })} />
          <input class="input" type="password" placeholder="New" style="width:150px" value=${pw.next} onInput=${(e) => setPw({ ...pw, next: e.target.value })} />
          <input class="input" type="password" placeholder="New again" style="width:150px" value=${pw.confirm} onInput=${(e) => setPw({ ...pw, confirm: e.target.value })} />
          <button class="btn sm primary" disabled=${!pw.old || pw.next.length < 4 || pw.next !== pw.confirm} onClick=${async () => { if (await run(() => tv.vaultUpdate({ oldPassword: pw.old, newPassword: pw.next }), 'Password changed')) setPw({ ...pw, old: '', next: '', confirm: '' }); }}>Change</button></div></div>
        <div class="field">Remove the locked section <span class="faint">(your files stay where they are — they just aren’t locked any more)</span><div class="row" style="gap:8px">
          <input class="input" type="password" placeholder="Password" style="width:150px" value=${pw.remove} onInput=${(e) => setPw({ ...pw, remove: e.target.value })} />
          <button class="btn sm danger" disabled=${!pw.remove} onClick=${async () => { if (await run(() => tv.vaultRemove(pw.remove), 'Locked section removed')) close(); }}>Remove</button></div></div>
        <div class="vault-msg">${err}</div>
        <div class="row" style="justify-content:flex-end;margin-top:6px"><button class="btn primary" onClick=${close}>Done</button></div>
      </div></div></div>`}
  </div>`;
}
