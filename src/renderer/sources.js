// Where media comes from: this PC, network shares, media servers, free TV.
// Used by both the setup wizard and Library → Add sources.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { tv, Icon } from './util.js';

const Check = ({ on }) => html`<div class=${'pick-item' + (on ? ' on' : '')} style="padding:0;border:0;background:none"><div class="box">${on ? '✓' : ''}</div></div>`;

// Finds everything on this PC and the network; `value` is the list of chosen sources.
export function SourcesPicker({ value, onChange, autoSelect = true }) {
  const [found, setFound] = useState(null);
  const [busy, setBusy] = useState(false);
  const [roots, setRoots] = useState([]);
  const [unc, setUnc] = useState('');
  const [uncMsg, setUncMsg] = useState('');
  const [torrent, setTorrent] = useState('');
  const key = (s) => s.type === 'dlna' ? 'dlna:' + s.server.id : s.type === 'torrent' ? 'torrent:' + s.link : 'folder:' + s.path.toLowerCase();
  const has = (s) => value.some((v) => key(v) === key(s));
  const toggle = (s) => onChange(has(s) ? value.filter((v) => key(v) !== key(s)) : [...value, s]);

  const search = async () => {
    setBusy(true);
    const [r, quick] = await Promise.all([tv.discover(), tv.quickRoots()]);
    setFound(r); setRoots(quick); setBusy(false);
    if (autoSelect && !value.length) {
      // Auto: only real VIDEO places get ticked — plus media servers, which can
      // only ever hand over media. Downloads, Desktop, Music, whole drives and
      // other PCs' shares are listed right below, one tap to add.
      const pick = [...quick.filter((q) => q.video).map((q) => ({ type: 'folder', path: q.path, label: q.path.split(/[\\/]/).filter(Boolean).pop() || q.path }))];
      for (const d of r.dlna) pick.push({ type: 'dlna', server: d, label: d.name });
      onChange(pick);
    }
  };
  useEffect(() => { search(); }, []);

  const addUnc = async () => {
    const p = unc.trim();
    if (!p) return;
    if (/^\\\\[^\\]+\\?$/.test(p)) {
      // Just a computer name: list its shares.
      const host = p.replace(/^\\\\|\\$/g, '');
      const shares = await tv.shares(host);
      if (!shares.length) { setUncMsg(`No shared folders visible on ${host} (it may need you to sign in to it once in File Explorer).`); return; }
      onChange([...value, ...shares.filter((s) => !has({ type: 'folder', path: s.path })).map((s) => ({ type: 'folder', path: s.path, label: `${s.name} on ${host}` }))]);
    } else onChange([...value, { type: 'folder', path: p, label: p }]);
    setUnc(''); setUncMsg('');
  };
  // A magnet link, an info hash or a .torrent file: its videos play while they download.
  const addTorrent = () => {
    const link = torrent.trim();
    if (!link) return;
    const dn = link.match(/[?&]dn=([^&]+)/);
    const label = dn ? decodeURIComponent(dn[1].replace(/\+/g, ' ')) : link.split(/[\\/]/).pop().replace(/\.torrent$/i, '');
    if (!has({ type: 'torrent', link })) onChange([...value, { type: 'torrent', link, label }]);
    setTorrent('');
  };
  const pickFolders = async () => {
    const f = await tv.pickFolders();
    onChange([...value, ...f.filter((p) => !has({ type: 'folder', path: p })).map((p) => ({ type: 'folder', path: p, label: p }))]);
  };

  const Row = ({ s, icon, title, sub }) => html`<div class=${'src-row' + (has(s) ? ' on' : '')} onClick=${() => toggle(s)}>
    <${Check} on=${has(s)} /><span class="src-ic">${icon}</span><div class="grow"><b>${title}</b>${sub && html`<span>${sub}</span>`}</div></div>`;
  const extra = value.filter((v) => v.type === 'torrent' || (v.type === 'folder' && !roots.some((q) => q.path === v.path) && !found?.thisPc.drives.some((d) => d.path === v.path) && !found?.pcs.some((pc) => pc.shares.some((sh) => sh.path === v.path))));

  return html`<div class="sources">
    <div class="row" style="margin-bottom:10px"><b class="grow">${busy ? 'Looking around your PC and network…' : 'Found on this PC and your network'}</b>
      <button class="btn sm" onClick=${search} disabled=${busy}><${Icon.refresh} /> Search again</button></div>
    ${busy && html`<div class="progress indeterminate" style="margin-bottom:12px"><i></i></div>`}
    ${found && html`
      <div class="src-group">💻 This PC — ${found.thisPc.name}</div>
      ${roots.map((q) => html`<${Row} s=${{ type: 'folder', path: q.path, label: q.path.split(/[\\/]/).filter(Boolean).pop() }} icon=${q.video ? '🎬' : '📁'} title=${q.path.split(/[\\/]/).filter(Boolean).pop()} sub=${q.path} />`)}
      ${found.thisPc.drives.map((d) => html`<${Row} s=${{ type: 'folder', path: d.path, label: d.name }} icon=${d.type === 'network' ? '🌐' : d.type === 'removable' ? '🔌' : '🖴'} title=${'Whole drive: ' + d.name} sub=${d.detail || 'Everything on it (skips Windows and program folders)'} />`)}
      <div class="src-group">📡 Media servers on your network (DLNA — NAS, Plex, Jellyfin, Emby, TVs)</div>
      ${found.dlna.length ? found.dlna.map((d) => html`<${Row} s=${{ type: 'dlna', server: d, label: d.name }} icon="📡" title=${d.name} sub=${d.detail} />`) : html`<div class="src-empty">None found. Turn on DLNA / “media sharing” on your NAS or media server to have it show up here.</div>`}
      <div class="src-group">🖥️ Shared folders on other computers</div>
      ${found.pcs.some((pc) => pc.shares.length) ? found.pcs.filter((pc) => pc.shares.length).map((pc) => pc.shares.map((sh) => html`<${Row} s=${{ type: 'folder', path: sh.path, label: `${sh.name} on ${pc.name}` }} icon="🖥️" title=${`${sh.name}`} sub=${`on ${pc.name} · ${sh.path}`} />`)) : html`<div class="src-empty">No shared folders visible. Add one below by its path, like <code>\\\\LIVINGROOM-PC\\Movies</code>.</div>`}
    `}
    ${extra.length > 0 && html`<div class="src-group">➕ Added by you</div>${extra.map((s) => html`<${Row} s=${s} icon=${s.type === 'torrent' ? '🧲' : '📁'} title=${s.label || s.path || s.link} sub=${s.type === 'torrent' ? 'Torrent — plays while it downloads' : s.path} />`)}`}
    <div class="row" style="margin-top:14px;flex-wrap:wrap">
      <button class="btn sm" onClick=${pickFolders}><${Icon.folder} /> Choose a folder…</button>
      <input class="input grow" style="min-width:220px" placeholder="Network path, e.g. \\\\NAS\\Videos or \\\\OTHER-PC" value=${unc} onInput=${(e) => setUnc(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && addUnc()} />
      <button class="btn sm" onClick=${addUnc}>Add</button>
    </div>
    ${uncMsg && html`<p class="small" style="color:var(--warn)">${uncMsg}</p>`}
    <div class="row" style="margin-top:8px;flex-wrap:wrap">
      <input class="input grow" style="min-width:220px" placeholder="Magnet link or .torrent file, e.g. magnet:?xt=urn:btih:…" value=${torrent} onInput=${(e) => setTorrent(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && addTorrent()} />
      <button class="btn sm" onClick=${addTorrent}>Add torrent</button>
    </div>
    <p class="small muted">A torrent’s videos play while they download, on channels and On Demand alike. Only add torrents you have the right to download.</p>
  </div>`;
}

// Free live TV (IPTV) and public-domain classics.
export function FreeTvPicker({ value, onChange }) {
  const [countries, setCountries] = useState([]);
  const [regions, setRegions] = useState([]);
  const [colls, setColls] = useState([]);
  const [cats, setCats] = useState([]);
  const [langs, setLangs] = useState([]);
  const [moreLangs, setMoreLangs] = useState(false);
  useEffect(() => {
    tv.iptvCountries().then(setCountries);
    tv.iptvRegions().then(setRegions).catch(() => {});
    tv.freeCollections().then(setColls);
    tv.iptvCategories().then(setCats);
    tv.iptvLanguages().then(setLangs);
  }, []);
  const togRegion = (code) => { const cur = value.regions || []; set({ regions: cur.includes(code) ? cur.filter((x) => x !== code) : [...cur, code] }); };
  const set = (p) => onChange({ ...value, ...p });
  const togColl = (id) => set({ classics: value.classics.includes(id) ? value.classics.filter((c) => c !== id) : [...value.classics, id] });
  const togLang = (c) => { const cur = value.languages || []; set({ languages: cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c] }); };
  const COMMON = ['eng', 'spa', 'fra', 'deu', 'por', 'ita', 'ara', 'hin', 'zho', 'jpn', 'kor', 'rus', 'tur', 'nld', 'pol', 'vie', 'tgl', 'ukr', 'ell', 'swe'];
  const langName = (c) => langs.find((l) => l.code === c)?.name || c;
  const shownLangs = moreLangs ? langs.map((l) => l.code) : COMMON;
  const togCat = (c) => set({ categories: value.categories.includes(c) ? value.categories.filter((x) => x !== c) : [...value.categories, c] });
  return html`<div class="freetv">
    <div class="opt-card">
      <div class="row"><button class=${'toggle' + (value.live ? ' on' : '')} onClick=${() => set({ live: !value.live })}></button>
        <div class="grow"><b>Free live TV channels (IPTV)</b><span>Public, free-to-air streams from the iptv-org lists. HomeCable tests each station and adds the ones that work — numbered from 100. HomeCable doesn’t host these streams; what’s on is up to each broadcaster.</span></div></div>
      ${value.live && html`<div class="row" style="margin-top:12px;flex-wrap:wrap;gap:6px"><span class="muted small">Station lists</span>
        ${[['iptv-org', 'iptv-org (biggest)'], ['free-tv', 'Free-TV (official broadcasters)']].map(([k, l]) => html`<button class=${'chip' + ((value.sources || ['iptv-org', 'free-tv']).includes(k) ? ' chip-on' : '')} onClick=${() => { const cur = value.sources || ['iptv-org', 'free-tv']; set({ sources: cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k] }); }}>${l}</button>`)}</div>
      <div class="row" style="margin-top:12px;flex-wrap:wrap;gap:6px"><span class="pick-label">🗣 Languages</span>
        ${shownLangs.map((c) => html`<button class=${'chip' + ((value.languages || []).includes(c) ? ' chip-on' : '')} onClick=${() => togLang(c)}>${langName(c)}</button>`)}
        <button class="btn sm ghost" onClick=${() => setMoreLangs(!moreLangs)}>${moreLangs ? 'Fewer' : `All languages (${langs.length || '…'})`}</button></div>
      <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:6px">
        <span class="pick-label">🌍 Countries</span>
        ${(value.countries || [value.country]).map((cc) => html`<span class="chip chip-on">${(countries.find((c) => c.code.toLowerCase() === cc) || {}).flag || ''} ${(countries.find((c) => c.code.toLowerCase() === cc) || { name: cc.toUpperCase() }).name}
          ${(value.countries || [value.country]).length > 1 && html`<button onClick=${() => { const cur = (value.countries || [value.country]).filter((x) => x !== cc); set({ countries: cur, country: cur[0] }); }}>×</button>`}</span>`)}
        <select class="select" value="" onChange=${(e) => { const cc = e.target.value; if (!cc) return; const cur = value.countries || [value.country]; if (!cur.includes(cc)) set({ countries: [...cur, cc], country: (value.countries || [value.country])[0] }); e.target.value = ''; }}>
          <option value="">+ Add a country…</option>
          ${countries.map((c) => html`<option value=${c.code.toLowerCase()}>${c.flag} ${c.name}</option>`)}
        </select>
      </div>
      <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:6px">
        <span class="pick-label">🗺 Regions</span>
        ${(value.regions || []).map((rg) => html`<span class="chip chip-on">${(regions.find((x) => x.code === rg) || { name: rg.toUpperCase() }).name}<button onClick=${() => togRegion(rg)}>×</button></span>`)}
        <select class="select" value="" onChange=${(e) => { if (e.target.value) togRegion(e.target.value); e.target.value = ''; }}>
          <option value="">+ Add a whole region…</option>
          ${regions.filter((x) => !(value.regions || []).includes(x.code)).map((x) => html`<option value=${x.code}>${x.name}</option>`)}
        </select>
        ${!(value.regions || []).length && html`<span class="muted small">e.g. all of Europe or Latin America in one go</span>`}
      </div>
      <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:6px">
        <span class="pick-label">📦 How many</span>
        <select class="select" value=${value.max || 0} onChange=${(e) => set({ max: +e.target.value })}>
          <option value="0">No limit — every station that works</option>
          ${[25, 50, 100, 200, 300, 500].map((n) => html`<option value=${n}>${n} stations</option>`)}</select>
      </div>
      <div class="row" style="margin-top:10px;flex-wrap:wrap"><span class="muted small">Your own playlist</span>
        <input class="input grow" style="min-width:240px" placeholder="M3U link (optional), e.g. https://…/playlist.m3u" value=${value.m3u || ''} onInput=${(e) => set({ m3u: e.target.value })} /></div>
      <div class="row" style="margin-top:12px"><button class=${'toggle' + (value.anime ? ' on' : '')} onClick=${() => set({ anime: !value.anime })}></button>
        <div class="grow"><b>🍥 Free anime channels</b><span class="muted small" style="display:block">Crunchyroll, RetroCrush, Anime x HIDIVE, Toonami Aftermath, Naruto, One Piece, Yu-Gi-Oh! and more — whichever are on the air.</span></div></div>
      <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:6px"><span class="pick-label">🏷 Categories</span><span class="muted small">(any country)</span>
        ${cats.map((c) => html`<button class=${'chip' + (value.categories.includes(c) ? ' chip-on' : '')} onClick=${() => togCat(c)}>${c}</button>`)}</div>`}
    </div>
    <div class="opt-card">
      <div class="row"><button class=${'toggle' + (value.classics.length ? ' on' : '')} onClick=${() => set({ classics: value.classics.length ? [] : colls.slice(0, 3).map((c) => c.id) })}></button>
        <div class="grow"><b>Classic movies, cartoons & TV</b><span>Public-domain films and shows from the Internet Archive, scheduled like regular channels (streams over the internet).</span></div></div>
      ${value.classics.length > 0 && html`<div class="row" style="margin-top:10px;flex-wrap:wrap;gap:6px">
        ${colls.map((c) => html`<button class=${'chip' + (value.classics.includes(c.id) ? ' chip-on' : '')} onClick=${() => togColl(c.id)}>${c.logo} ${c.name}</button>`)}</div>`}
    </div>
  </div>`;
}

// The viewer's own language, as an ISO 639-3 code like iptv-org uses.
const LANG3 = { en: 'eng', es: 'spa', fr: 'fra', de: 'deu', pt: 'por', it: 'ita', ar: 'ara', hi: 'hin', zh: 'zho', ja: 'jpn', ko: 'kor', ru: 'rus', tr: 'tur', nl: 'nld', pl: 'pol', vi: 'vie', tl: 'tgl', uk: 'ukr', el: 'ell', sv: 'swe' };
export const DEFAULT_FREE = { anime: true, live: true, country: (navigator.language.split('-')[1] || 'us').toLowerCase(), languages: [LANG3[navigator.language.split('-')[0]] || 'eng'], max: 0, categories: [], classics: ['feature_films', 'classic_cartoons', 'classic_tv'] };

// What the Free TV picker should start from: what's already set up, when it is.
export function freeFromSettings(live, { classics = [] } = {}) {
  if (!live) return { ...DEFAULT_FREE, live: false, classics };
  return {
    ...DEFAULT_FREE, live: true, classics,
    country: live.country || DEFAULT_FREE.country,
    countries: live.countries || [live.country || DEFAULT_FREE.country],
    languages: live.languages || [], regions: live.regions || [], categories: live.categories || [],
    max: live.max ?? 0, sources: live.sources || ['iptv-org', 'free-tv'],
    anime: !!live.anime, m3u: (live.urls || [])[0] || '',
  };
}

// Kick off free TV setup (classics import waits; IPTV checks run in the background).
export async function applyFreeTv(free, onStatus) {
  if (free.classics.length) { onStatus?.('Adding classic movies, cartoons & TV…'); await tv.freeAdd(free.classics, 60); }
  if (free.live) await tv.iptvAuto({ country: free.country, countries: free.countries || [free.country], regions: free.regions || [], categories: free.categories, languages: free.languages || [], anime: !!free.anime, max: free.max ?? 0, sources: free.sources || ['iptv-org', 'free-tv'], urls: free.m3u?.trim() ? [free.m3u.trim()] : [] });
}
