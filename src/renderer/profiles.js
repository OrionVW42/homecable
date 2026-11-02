// "Who's watching?" — profiles, unlocking (PIN pad / password / controller
// combo), and managing people. Built to be easy with a mouse, keyboard or pad.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { tv, Icon } from './util.js';

export const LEVEL_LABEL = { kids: 'Kid', teens: 'Teen', adults: 'Grown-up' };
const LEVEL_DESC = { kids: 'Only shows and channels for everyone', teens: 'Everything except grown-up channels', adults: 'Everything, and can change settings' };
const AVATARS = ['🙂', '😎', '👵', '👴', '🧑', '👩', '👨', '🧒', '👧', '👦', '🐱', '🐶', '🦊', '🐼', '🦄', '🐸', '🚀', '⚽', '🎮', '🎨'];
const PAD_GLYPH = { UP: '↑', DOWN: '↓', LEFT: '←', RIGHT: '→', A: 'A', B: 'B', X: 'X', Y: 'Y', LB: 'LB', RB: 'RB', LT: 'LT', RT: 'RT' };

// Enter a controller combo (or arrow keys + A/B/X/Y on the keyboard).
function useCombo(onDone, enabled = true) {
  const [seq, setSeq] = useState([]);
  const seqRef = useRef(seq);
  seqRef.current = seq;
  useEffect(() => {
    if (!enabled) return;
    window.__padCapture = (name) => {
      if (name === 'MENU' || name === 'VIEW') return onDone(seqRef.current);
      if (PAD_GLYPH[name]) setSeq((s) => [...s, name].slice(-12));
    };
    const key = (e) => {
      const map = { ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', a: 'A', b: 'B', x: 'X', y: 'Y' };
      if (e.key === 'Enter') { onDone(seqRef.current); e.preventDefault(); e.stopPropagation(); return; }
      if (e.key === 'Backspace') { setSeq((s) => s.slice(0, -1)); e.preventDefault(); e.stopPropagation(); return; }
      const b = map[e.key] || map[e.key.toLowerCase()];
      if (b) { setSeq((s) => [...s, b].slice(-12)); e.preventDefault(); e.stopPropagation(); }
    };
    addEventListener('keydown', key, true);
    return () => { window.__padCapture = null; removeEventListener('keydown', key, true); };
  }, [enabled]);
  return [seq, setSeq];
}

// One input for any lock type. onSubmit(secret) returns true/false (or {wait}).
export function LockInput({ type, comboLength, onSubmit, submitLabel = 'Unlock', confirm }) {
  const [val, setVal] = useState('');
  const [msg, setMsg] = useState('');
  const send = async (secret) => {
    const r = await onSubmit(secret);
    if (r === true || r?.ok) return;
    setMsg(r?.wait ? `Too many tries — wait ${r.wait} seconds` : r?.error || 'That’s not it — try again');
    setVal('');
    setSeq([]);
  };
  const [seq, setSeq] = useCombo((s) => send(s), type === 'combo');
  // PIN: number keys work anywhere on the screen (no need to click a box first).
  const valRef = useRef(val);
  valRef.current = val;
  useEffect(() => {
    if (type !== 'pin') return;
    const key = (e) => {
      if (/^\d$/.test(e.key)) { setVal((v) => (v + e.key).slice(0, 8)); setMsg(''); }
      else if (e.key === 'Backspace') setVal((v) => v.slice(0, -1));
      else if (e.key === 'Enter' && valRef.current.length >= 4) send(valRef.current);
      else return;
      e.preventDefault(); e.stopPropagation();
    };
    addEventListener('keydown', key, true);
    return () => removeEventListener('keydown', key, true);
  }, [type]);
  const pwRef = useRef();
  useEffect(() => { pwRef.current?.focus(); }, []);
  useEffect(() => { if (type === 'combo' && comboLength && seq.length === comboLength && !confirm) send(seq); }, [seq]);

  if (type === 'pin') {
    const press = (d) => { const v = (val + d).slice(0, 8); setVal(v); setMsg(''); };
    return html`<div class="lock-input">
      <div class="pin-dots">${Array.from({ length: Math.max(4, val.length) }, (_, i) => html`<i class=${i < val.length ? 'on' : ''}></i>`)}</div>
      <div class="pin-pad">
        ${['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => html`<button class="pin-key" onClick=${() => press(d)}>${d}</button>`)}
        <button class="pin-key soft" onClick=${() => setVal(val.slice(0, -1))} title="Erase">⌫</button>
        <button class="pin-key" onClick=${() => press('0')}>0</button>
        <button class="pin-key go" disabled=${val.length < 4} onClick=${() => send(val)}>OK</button>
      </div>
      ${msg && html`<p class="lock-msg">${msg}</p>`}
    </div>`;
  }
  if (type === 'combo') {
    return html`<div class="lock-input">
      <p class="muted" style="margin:0 0 12px">Press your button combo on the controller${confirm ? '' : ''} <span class="faint">(or arrows + A B X Y on the keyboard)</span>, then press Menu / Enter.</p>
      <div class="combo-row">${seq.length ? seq.map((b) => html`<span class="combo-btn">${PAD_GLYPH[b]}</span>`) : html`<span class="faint">waiting for buttons…</span>`}</div>
      <div class="row" style="justify-content:center;margin-top:14px"><button class="btn sm" onClick=${() => setSeq([])}>Start over</button><button class="btn sm primary" disabled=${seq.length < 4} onClick=${() => send(seq)}>${submitLabel}</button></div>
      ${msg && html`<p class="lock-msg">${msg}</p>`}
    </div>`;
  }
  return html`<div class="lock-input">
    <input ref=${pwRef} class="input big-input" type="password" placeholder="Password" value=${val} onInput=${(e) => { setVal(e.target.value); setMsg(''); }} onKeyDown=${(e) => { if (e.key === 'Enter' && val) send(val); e.stopPropagation(); }} />
    <button class="btn primary big" style="margin-top:12px;width:100%" disabled=${!val} onClick=${() => send(val)}>${submitLabel}</button>
    ${msg && html`<p class="lock-msg">${msg}</p>`}
  </div>`;
}

// Full-screen "Who's watching?"
export function ProfilePicker({ view, onPicked, onCancel }) {
  const [unlock, setUnlock] = useState(null);
  const pick = async (p, secret) => {
    const r = await tv.switchProfile(p.id, secret);
    if (r.ok) onPicked(r.view);
    return r;
  };
  return html`<div class="setup who">
    <div class="setup-card" style="text-align:center">
      ${onCancel && html`<button class="btn ghost sm" style="position:absolute;top:18px;right:18px" onClick=${onCancel}>Close</button>`}
      ${!unlock ? html`
        <h1 style="font-size:44px">Who’s watching?</h1>
        <div class="who-grid">${view.list.map((p) => html`<button class=${'who-card' + (p.id === view.active ? ' current' : '')} onClick=${() => (p.lock ? setUnlock(p) : pick(p))}>
          <span class="who-avatar">${p.avatar}</span><b>${p.name}</b><small>${LEVEL_LABEL[p.level]}${p.lock ? ' · 🔒' : ''}</small></button>`)}</div>`
      : html`
        <span class="who-avatar" style="margin:0 auto">${unlock.avatar}</span>
        <h1 style="font-size:34px;margin-top:14px">Hi ${unlock.name}</h1>
        <p class="lead" style="margin:0 auto 20px">${unlock.lock === 'pin' ? 'Enter your PIN' : unlock.lock === 'combo' ? 'Enter your controller combo' : 'Enter your password'}</p>
        <div style="max-width:340px;margin:0 auto"><${LockInput} type=${unlock.lock} comboLength=${unlock.comboLength} onSubmit=${(s) => pick(unlock, s)} /></div>
        <button class="btn ghost sm" style="margin-top:18px" onClick=${() => setUnlock(null)}>Back</button>`}
    </div>
  </div>`;
}

// Set or change a lock: type it twice.
function LockSetup({ profile, onClose, toast }) {
  const [type, setType] = useState('pin');
  const [first, setFirst] = useState(null);
  const [key, setKey] = useState(0);
  const done = async (secret) => {
    if (first == null) { setFirst(secret); setKey((k) => k + 1); return true; }
    const same = JSON.stringify(first) === JSON.stringify(secret);
    if (!same) { setFirst(null); setKey((k) => k + 1); return { error: 'They didn’t match — let’s start again' }; }
    try { await tv.setLock(profile.id, type, secret); } catch (e) { setFirst(null); setKey((k) => k + 1); return { error: String(e.message).replace(/^.*Error: /, '') }; }
    toast(`🔒 ${profile.name} is locked`);
    onClose(true);
    return true;
  };
  return html`<div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}><div class="modal narrow">
    <div class="modal-head"><h3>Lock ${profile.name}</h3><button class="icon-btn" onClick=${() => onClose()}><${Icon.close} /></button></div>
    <div class="modal-body" style="text-align:center">
      <div class="seg" style="margin-bottom:18px">${[['pin', 'PIN numbers'], ['password', 'Password'], ['combo', 'Controller combo']].map(([k, l]) => html`<button class=${type === k ? 'on' : ''} onClick=${() => { setType(k); setFirst(null); setKey((n) => n + 1); }}>${l}</button>`)}</div>
      <p class="muted" style="margin-top:0">${first == null ? (type === 'pin' ? 'Choose a PIN (4 to 8 numbers)' : type === 'combo' ? 'Press 4 or more buttons, then Menu' : 'Choose a password') : 'Once more to be sure'}</p>
      <div style="max-width:340px;margin:0 auto"><${LockInput} key=${type + key} type=${type} confirm onSubmit=${done} submitLabel=${first == null ? 'Next' : 'Save lock'} /></div>
    </div>
  </div></div>`;
}

// Settings → People.
export function ProfilesSettings({ view, setView, toast }) {
  const [editing, setEditing] = useState(null);
  const [locking, setLocking] = useState(null);
  const save = async (p) => { setView(await tv.saveProfile(p)); setEditing(null); toast(`Saved ${p.name}`); };
  return html`<div>
    <div class="people">${view.list.map((p) => html`<div class="person">
      <span class="who-avatar sm">${p.avatar}</span>
      <div class="grow"><b>${p.name}</b><span>${LEVEL_LABEL[p.level]} · ${LEVEL_DESC[p.level]}${p.lock ? ` · 🔒 ${p.lock === 'pin' ? 'PIN' : p.lock === 'combo' ? 'controller combo' : 'password'}` : ' · no lock'}</span></div>
      <button class="btn sm" onClick=${() => setEditing({ ...p })}>Edit</button>
      <button class="btn sm" onClick=${() => setLocking(p)}>${p.lock ? 'Change lock' : 'Add lock'}</button>
      ${p.lock && html`<button class="btn sm ghost" onClick=${async () => { setView(await tv.setLock(p.id, null)); toast(`${p.name} is unlocked`); }}>Remove lock</button>`}
    </div>`)}</div>
    <div class="row" style="margin-top:12px">
      <button class="btn sm" onClick=${() => setEditing({ name: '', avatar: '🧒', level: 'kids' })}><${Icon.plus} /> Add someone</button>
      <span class="grow"></span>
      <span class="muted small">Ask “Who’s watching?” when HomeCable starts</span>
      <button class=${'toggle' + (view.askAtStart ? ' on' : '')} onClick=${async () => setView(await tv.askAtStart(!view.askAtStart))}></button>
    </div>
    ${editing && html`<${PersonEditor} person=${editing} onSave=${save} onRemove=${editing.id && view.list.length > 1 ? async () => { setView(await tv.removeProfile(editing.id)); setEditing(null); } : null} onClose=${() => setEditing(null)} />`}
    ${locking && html`<${LockSetup} profile=${locking} toast=${toast} onClose=${async (changed) => { setLocking(null); if (changed) setView(await tv.profiles()); }} />`}
  </div>`;
}

export function PersonEditor({ person, onSave, onRemove, onClose }) {
  const [p, setP] = useState(person);
  return html`<div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}><div class="modal narrow">
    <div class="modal-head"><h3>${person.id ? 'Edit' : 'Add someone'}</h3><button class="icon-btn" onClick=${onClose}><${Icon.close} /></button></div>
    <div class="modal-body">
      <label class="field">Name<input class="input big-input" autofocus value=${p.name} placeholder="e.g. Grandma, Sam" onInput=${(e) => setP({ ...p, name: e.target.value })} /></label>
      <div class="field" style="margin-top:14px">Picture<div class="swatches">${AVATARS.map((a) => html`<button class=${p.avatar === a ? 'on' : ''} style="background:var(--raise);font-size:18px;width:38px;height:38px" onClick=${() => setP({ ...p, avatar: a })}>${a}</button>`)}</div></div>
      <div class="field" style="margin-top:14px">Who is this?
        <div class="opt-choices">${['adults', 'teens', 'kids'].map((l) => html`<button class=${'opt-choice' + (p.level === l ? ' on' : '')} onClick=${() => setP({ ...p, level: l })}><b>${LEVEL_LABEL[l]}</b><span>${LEVEL_DESC[l]}</span></button>`)}</div></div>
    </div>
    <div class="modal-foot">${onRemove && html`<button class="btn danger" style="margin-right:auto" onClick=${onRemove}>Remove</button>`}<button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${!p.name.trim()} onClick=${() => onSave(p)}>Save</button></div>
  </div></div>`;
}
