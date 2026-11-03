// The Torrents panel: every torrent in the library in one place — add one, watch
// it download, pause it, pick which of its files to download, open its folder,
// forget it (with or without its files) — and which network interface they use.
// Opened from Settings and from the Library.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { tv, Icon } from './util.js';

const mb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`);
const rate = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB/s` : `${Math.round(n / 1e3)} kB/s`);
const eta = (ms) => { const s = ms / 1000; return !isFinite(s) || s <= 0 ? '' : s < 60 ? `${Math.round(s)} s left` : s < 3600 ? `${Math.round(s / 60)} min left` : `${(s / 3600).toFixed(1)} h left`; };
const stateOf = (t) => (t.stopped ? (t.done ? 'Stopped · plays from this PC' : 'Stopped') : t.paused ? 'Paused' : t.busy ? 'Starting…' : t.waiting ? 'Waiting for the network interface' : t.queued ? 'Queued — waiting its turn' : t.done ? 'Done · sharing' : t.progress > 0 ? 'Downloading' : 'Looking for peers');

// settings / setSettings come from the Settings panel; opened elsewhere it looks after the setting itself.
export function TorrentsPanel({ onClose, toast, onPlay, isAdult = true, settings = null, setSettings = null }) {
  const [list, setList] = useState(null);
  const [bound, setBound] = useState(null);
  const [ifaces, setIfaces] = useState([]);
  const [ownIface, setOwnIface] = useState('');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState({});       // torrent id → its files are shown
  const [confirm, setConfirm] = useState(null); // the torrent about to be forgotten
  const [cfg, setCfgState] = useState(settings || {}); // the torrent settings (storage limit, clean-up, sharing)
  const [usage, setUsage] = useState(null);
  const setCfg = (patch) => { setCfgState((c) => ({ ...c, ...patch })); if (setSettings) setSettings(patch); else tv.setSettings(patch); };
  const iface = settings ? settings.torrentInterface || '' : ownIface;
  const pickIface = (name) => { if (setSettings) setSettings({ torrentInterface: name }); else { setOwnIface(name); tv.setSettings({ torrentInterface: name }); } };
  const refresh = () => Promise.all([tv.torrentsList(), tv.torrentBound(), tv.torrentUsage()]).then(([l, b, u]) => { setList(l); setBound(b); setUsage(u); }).catch(() => {});
  useEffect(() => {
    tv.torrentInterfaces().then(setIfaces).catch(() => {});
    if (!settings) tv.state().then((s) => { setOwnIface(s.settings.torrentInterface || ''); setCfgState(s.settings); }).catch(() => {});
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, []);

  const add = async (what) => {
    const l = String(what ?? link).trim();
    if (!l) return;
    setBusy(true);
    try {
      const r = await tv.torrentAdd(l);
      toast(r.added ? `🧲 ${r.name}: ${r.added} video${r.added === 1 ? '' : 's'} added — playing while it downloads` : `🧲 ${r.name}: no new videos (already in the library, or none ticked)`);
      setLink('');
      refresh();
    } catch (e) { toast(`Couldn’t add that torrent: ${String(e.message || e).replace(/^.*Error: /, '')}`); }
    setBusy(false);
  };
  const pick = async () => { const f = await tv.torrentPickFile(); if (f) add(f); };
  const toggleFile = async (t, f) => {
    const sel = new Set(t.files.filter((x) => x.selected).map((x) => x.path));
    if (sel.has(f.path)) sel.delete(f.path); else sel.add(f.path);
    await tv.torrentFiles(t.id, [...sel]).catch((e) => toast(e.message));
    refresh();
  };
  const forget = async (t, keepFiles) => {
    setConfirm(null);
    await tv.torrentRemove(t.id, { keepFiles }).catch((e) => toast(e.message));
    toast(keepFiles ? `Removed ${t.name} — its files are kept` : `Removed ${t.name} and deleted its files`);
    refresh();
  };
  const keep = async (key, on) => { await tv.torrentKeep(key, on).catch((e) => toast(e.message)); refresh(); };
  const act = (p, msg) => p.then(() => { if (msg) toast(msg); refresh(); }).catch((e) => toast(String(e.message || e)));
  const sum = (k) => (list || []).reduce((n, t) => n + (t[k] || 0), 0);
  const ifaceNote = bound?.state === 'waiting' ? `⏸ Waiting for “${iface}” — it has no address right now, so torrents are paused.`
    : bound?.state === 'ready' && iface ? `Bound to ${bound.address}: peers, trackers and the DHT only ever use this adapter. If it drops, torrents stop.`
      : 'Pin torrents to your VPN adapter and they never use anything else — if the VPN drops, they stop instead of falling back.';

  return html`<div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}><div class="modal tor">
    <div class="modal-head"><h3>🧲 Torrents</h3>
      ${list?.length > 0 && html`<span class="muted small">${list.length} torrent${list.length === 1 ? '' : 's'} · ${sum('peers')} peers · ↓ ${rate(sum('downloadSpeed'))} · ↑ ${rate(sum('uploadSpeed'))}</span>`}
      <button class="icon-btn" title="Close" onClick=${onClose}><${Icon.close} /></button></div>
    <div class="modal-body">
      ${isAdult && html`
        <div class="row" style="flex-wrap:wrap">
          <input class="input grow" style="min-width:260px" placeholder="Magnet link, info hash or .torrent link" value=${link} onInput=${(e) => setLink(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && add()} disabled=${busy} />
          <button class="btn primary" onClick=${() => add()} disabled=${busy || !link.trim()}>${busy ? 'Adding…' : 'Add torrent'}</button>
          <button class="btn" onClick=${pick} disabled=${busy}><${Icon.folder} /> .torrent file…</button>
        </div>
        <div class="row" style="margin:14px 0 6px;flex-wrap:wrap">
          <span class="muted small">Network interface</span>
          <select class="select" value=${iface} onChange=${(e) => pickIface(e.target.value)}>
            <option value="">Any interface</option>
            ${ifaces.map((i) => html`<option value=${i.name}>${i.name} — ${i.address}</option>`)}
            ${iface && !ifaces.some((i) => i.name === iface) && html`<option value=${iface}>${iface} — not connected</option>`}
          </select>
          <span class="muted small grow">${ifaceNote}</span>
        </div>`}
      ${isAdult && html`<div class="tor-store">
        <div class="row" style="flex-wrap:wrap;gap:8px">
          <b>💾 Space for torrents</b>
          <span class="muted small grow">${usage ? `${mb(usage.bytes)} used${usage.limitBytes ? ` of ${mb(usage.limitBytes)}` : ' · no limit'}` : ''}</span>
          ${(() => { const gb = cfg.torrentLimitGB ?? 100; const unit = gb >= 1000 && gb % 1000 === 0 ? 'TB' : 'GB'; const n = !gb ? '' : unit === 'TB' ? gb / 1000 : gb; return html`
            <input class="input" type="number" min="1" style="width:90px" disabled=${!gb} value=${n} onChange=${(e) => { const v = Math.max(1, +e.target.value || 1); setCfg({ torrentLimitGB: unit === 'TB' ? v * 1000 : v }); }} />
            <select class="select" value=${gb ? unit : 'none'} onChange=${(e) => { const u = e.target.value; setCfg({ torrentLimitGB: u === 'none' ? 0 : u === 'TB' ? Math.max(1, Math.round((gb || 1000) / 1000)) * 1000 : (gb ? (unit === 'TB' ? gb : gb) : 100) }); }}>
              <option value="GB">GB</option><option value="TB">TB</option><option value="none">Unlimited</option></select>`; })()}
        </div>
        <div class="tor-bar"><i style=${`width:${usage?.limitBytes ? Math.min(100, (usage.bytes / usage.limitBytes) * 100) : 0}%`}></i></div>
        <p class="muted small" style="margin:6px 0 8px">Over the limit, videos you've already <b>watched</b> make room. Unwatched ones, anything 📌 kept, and what's playing are never deleted.</p>
        <div class="row" style="flex-wrap:wrap;gap:10px">
          <label class="muted small">Series: <select class="select" value=${cfg.torrentCleanSeries || 'watched'} onChange=${(e) => setCfg({ torrentCleanSeries: e.target.value })}><option value="watched">watched longest ago first</option><option value="age">oldest download first</option></select></label>
          <label class="muted small">Movies: <select class="select" value=${cfg.torrentCleanMovies || 'watched'} onChange=${(e) => setCfg({ torrentCleanMovies: e.target.value })}><option value="watched">watched longest ago first</option><option value="age">oldest download first</option></select></label>
        </div>
        <div class="row" style="flex-wrap:wrap;gap:10px;margin-top:10px">
          <label class="muted small">Downloads at once: <select class="select" value=${String(cfg.torrentMaxActive ?? 3)} onChange=${(e) => setCfg({ torrentMaxActive: +e.target.value })}>${[1, 2, 3, 4, 5, 8].map((n) => html`<option value=${n}>${n}</option>`)}<option value="0">All</option></select></label>
          <span class="muted small">The rest queue up by priority (⬆ High first). What you're watching always downloads.</span>
        </div>
        <label class="tor-opt"><button class=${'toggle' + (cfg.torrentStopSeeding ? ' on' : '')} onClick=${() => setCfg({ torrentStopSeeding: !cfg.torrentStopSeeding })}></button><span><b>Stop sharing when a download finishes</b><small>Off: it keeps sharing, and a note up top lets you stop it.</small></span></label>
        <label class="tor-opt"><button class=${'toggle' + (cfg.torrentToOnDemand !== false ? ' on' : '')} onClick=${() => setCfg({ torrentToOnDemand: cfg.torrentToOnDemand === false })}></button><span><b>Put torrent shows in Stream Demand and movies in On Demand</b><small>They're looked up by name too: real titles, posters, genres and tags.</small></span></label>
      </div>`}
      ${list === null ? html`<p class="muted">Loading…</p>`
        : !list.length ? html`<div class="src-empty" style="margin-top:16px">No torrents yet. Paste a magnet link above — its videos join the library and play while they download.</div>`
          : list.map((t) => html`<div class="tor-card" key=${t.id}>
            <div class="row">
              <div class="grow"><b>${t.name}</b>
                <span class="muted small">${mb(t.length)} · ${stateOf(t)}${!t.paused && !t.waiting ? ` · ${Math.round(t.progress * 100)}%${!t.done && t.timeRemaining ? ` · ${eta(t.timeRemaining)}` : ''} · ${t.peers} peer${t.peers === 1 ? '' : 's'}${t.webSeeds ? ` + ${t.webSeeds} web seed${t.webSeeds === 1 ? '' : 's'}` : ''} · ↓ ${rate(t.downloadSpeed)} ↑ ${rate(t.uploadSpeed)}` : t.paused ? ` · ${Math.round(t.progress * 100)}% downloaded` : ''}</span></div>
              ${isAdult && html`
                ${t.paused || t.stopped ? html`<button class="btn sm primary" title="Download and share again" onClick=${() => act(tv.torrentResume(t.id))}>${t.stopped ? '▶ Play' : '▶ Resume'}</button>`
                  : html`<button class="btn sm" title="Pause: out of the swarm for now; its videos wait" onClick=${() => act(tv.torrentPause(t.id))}>❚❚ Pause</button>`}
                ${!t.stopped && html`<button class="btn sm" title="Stop downloading and sharing — finished videos keep playing from this PC" onClick=${() => act(tv.torrentStop(t.id), `⏹ ${t.name} stopped${t.done ? ' — it plays from your PC' : ''}`)}>⏹ Stop</button>`}
                ${!t.stopped && !t.done && html`<select class="select sm" title="Priority: which torrents download first" value=${t.priority} onChange=${(e) => act(tv.torrentPriority(t.id, e.target.value))}>
                  <option value="high">⬆ High</option><option value="normal">Normal</option><option value="low">⬇ Low</option></select>`}
                <button class=${'btn sm' + (t.kept ? ' on' : '')} title=${t.kept ? 'Kept — the storage limit never deletes it (click to allow)' : 'Keep: never deleted by the storage limit'} onClick=${() => keep(t.id, !t.kept)}>📌${t.kept ? ' Kept' : ''}</button>
                <button class="btn sm" title="Open its folder" onClick=${() => tv.torrentOpenFolder(t.id)}>📂</button>
                <button class="btn sm danger" onClick=${() => setConfirm(t)}>Forget…</button>`}
            </div>
            <div class="tor-bar"><i style=${`width:${Math.min(100, t.progress * 100)}%`}></i></div>
            <button class="btn sm ghost" onClick=${() => setOpen((o) => ({ ...o, [t.id]: !o[t.id] }))}>${open[t.id] ? '▾' : '▸'} Files (${t.files.length}) · ${t.files.filter((f) => f.selected).length} downloading</button>
            ${open[t.id] && html`<div class="tor-files">
              ${t.files.map((f) => html`<label class=${'tor-file' + (f.selected ? ' on' : '')} key=${f.path}>
                <input type="checkbox" checked=${f.selected} disabled=${!isAdult} onChange=${() => toggleFile(t, f)} />
                <span class="grow">${f.path}${f.media ? '' : html` <span class="faint">(not a video)</span>`}</span>
                <span class="muted small">${mb(f.length)}${f.selected ? ` · ${Math.round(f.progress * 100)}%` : ''}${f.watched ? ' · ✓ watched' : ''}</span>
                ${f.itemId && isAdult && html`<button class=${'btn sm' + (f.kept ? ' on' : '')} title=${f.kept ? 'Kept' : 'Keep this one'} onClick=${(e) => { e.preventDefault(); keep(f.itemId, !f.kept); }}>📌</button>`}
                ${f.itemId && onPlay && html`<button class="btn sm" onClick=${(e) => { e.preventDefault(); onPlay(f.itemId); }}>▶ Play</button>`}
              </label>`)}
            </div>`}
          </div>`)}
    </div>
    ${confirm && html`<div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && setConfirm(null)}><div class="modal narrow">
      <div class="modal-head"><h3>Forget “${confirm.name}”?</h3></div>
      <div class="modal-body"><p class="muted">Its videos leave the library and every channel. Keep what's downloaded on disk (${mb(confirm.downloaded)}), or delete it too.</p></div>
      <div class="modal-foot"><button class="btn" onClick=${() => setConfirm(null)}>Cancel</button>
        <button class="btn" onClick=${() => forget(confirm, true)}>Remove, keep files</button>
        <button class="btn danger" onClick=${() => forget(confirm, false)}>Remove & delete files</button></div>
    </div></div>`}
  </div></div>`;
}
