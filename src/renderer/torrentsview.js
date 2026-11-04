// The Torrents tab: search the sources you've chosen, see and manage every torrent in
// the library, and manage search engines (docs/search-engines.md). HomeCable ships only
// the Internet Archive and a connector for your own server; it lists and links to no
// torrent sites. What a search finds is added like any other torrent.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { tv } from './util.js';
import { TorrentsBody } from './torrents.js';

const CATEGORIES = [['all', 'Everything'], ['movies', 'Movies'], ['tv', 'TV shows'], ['anime', 'Anime'], ['music', 'Music'], ['games', 'Games'], ['software', 'Software'], ['books', 'Books']];
const catLabel = (k) => CATEGORIES.find(([c]) => c === k)?.[1] || k;
const DOCS = 'https://github.com/OrionVW42/homecable/blob/master/docs/search-engines.md';
const mb = (n) => (n == null ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round(n / 1e3)} kB`);
const ago = (t) => { if (!t) return ''; const d = (Date.now() - t) / 864e5; return d < 1 ? 'today' : d < 2 ? 'yesterday' : d < 30 ? `${Math.round(d)} d ago` : d < 365 ? `${Math.round(d / 30)} mo ago` : `${Math.round(d / 365)} y ago`; };
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const plain = (e) => String(e?.message || e).replace(/^.*Error: /, '');

// The search lives outside the component, so leaving the tab (or switching to My
// torrents) loses nothing: results keep arriving and are there when you come back.
const S = { tab: 'search', q: '', cat: 'all', searchId: null, running: false, results: [], status: {}, order: {}, names: {}, skipped: [], needSetup: [], sort: 'seeds', dir: -1, filter: '', added: {}, adding: {}, accepted: null };
const listeners = new Set();
const notify = () => { for (const l of listeners) l(); };
const pending = []; // events for a search whose id hasn't reached us yet
const take = (m) => {
  if (m.event === 'search') {
    S.status[m.engine] = { count: m.results.length, error: m.error, ms: m.ms };
    if (!(m.engine in S.order)) S.order[m.engine] = Object.keys(S.order).length;
    S.results = [...S.results, ...m.results.map((r) => ({ ...r, key: `${r.engine}|${r.link || r.page}` }))];
  } else if (m.event === 'search-done') S.running = false;
  notify();
};
tv.onTorrentSearch?.((m) => { if (m.searchId === S.searchId) take(m); else { pending.push(m); if (pending.length > 100) pending.shift(); } });
function useTick() { const [, set] = useState(0); useEffect(() => { const l = () => set((n) => n + 1); listeners.add(l); return () => listeners.delete(l); }, []); }

export function TorrentsView({ toast, onPlay, isAdult = true, settings = null, setSettings = null }) {
  useTick();
  const setTab = (t) => { S.tab = t; notify(); };
  useEffect(() => { if (S.accepted === null) tv.state().then((s) => { S.accepted = !!s.settings.searchTermsOk; notify(); }).catch(() => {}); }, []);
  const accept = () => tv.setSettings({ searchTermsOk: true }).then(() => { S.accepted = true; notify(); }).catch((e) => toast(plain(e)));
  const needsOk = S.tab !== 'mine' && S.accepted === false;
  return html`<div class="overlay tor-view">
    <div class="overlay-head">
      <h2>Torrents</h2>
      <div class="seg tor-tabs">${[['search', '🔍 Search'], ['mine', '🧲 My torrents'], ['engines', '⚙ Search engines']].map(([k, l]) => html`<button class=${S.tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}</div>
      <span class="grow"></span>
    </div>
    <div class="overlay-body">
      ${needsOk && html`<div class="sr-empty sr-terms"><h3>Before you search</h3><p>HomeCable doesn’t host, list or recommend torrents. It comes with the Internet Archive’s free items, and anything else you search is a source you added yourself.</p><p><b>Only download and share what you have the right to.</b> Downloading or sharing copyrighted material without permission may be illegal where you live, and a torrent shares what you download with other people. What you search for and add is your responsibility.</p>${isAdult ? html`<button class="btn primary" onClick=${accept}>I understand</button>` : html`<p class="muted">Ask a grown-up to set this up.</p>`}</div>`}
      ${!needsOk && S.tab === 'search' && html`<${SearchTab} toast=${toast} isAdult=${isAdult} onEngines=${() => setTab('engines')} onMine=${() => setTab('mine')} />`}
      ${S.tab === 'mine' && html`<${TorrentsBody} toast=${toast} onPlay=${onPlay} isAdult=${isAdult} settings=${settings} setSettings=${setSettings} />`}
      ${!needsOk && S.tab === 'engines' && html`<${EnginesTab} toast=${toast} isAdult=${isAdult} />`}
    </div>
  </div>`;
}

function SearchTab({ toast, isAdult, onEngines, onMine }) {
  useTick();
  const [engines, setEngines] = useState(null);
  const [recent, setRecent] = useState([]);
  useEffect(() => {
    tv.searchEngines().then((l) => { setEngines(l); for (const e of l) S.names[e.id] = e.name; notify(); }).catch((e) => toast(plain(e)));
    tv.state().then((s) => setRecent(s.settings.searchRecent || [])).catch(() => {});
  }, []);
  const on = (engines || []).filter((e) => e.enabled && !e.error);
  const run = async () => {
    const q = S.q.trim();
    if (!q || !on.length) return;
    if (S.running && S.searchId) tv.searchCancel(S.searchId).catch(() => {});
    Object.assign(S, { results: [], status: {}, order: {}, running: true, searchId: null, skipped: [], needSetup: [], filter: '' });
    notify();
    try {
      const r = await tv.searchRun(q, S.cat);
      S.searchId = r.searchId; S.skipped = r.skipped || []; S.needSetup = r.needSetup || [];
      for (const m of pending.splice(0)) if (m.searchId === r.searchId) take(m);
      setRecent((l) => [q, ...l.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 20));
    } catch (e) { S.running = false; toast(plain(e)); }
    notify();
  };
  const stop = () => { if (S.searchId) tv.searchCancel(S.searchId).catch(() => {}); S.running = false; notify(); };
  const add = async (r) => {
    S.adding[r.key] = true; notify();
    try {
      const x = await tv.searchAdd(r.engine, { link: r.link, page: r.page, name: r.name });
      S.added[r.key] = x.serverId;
      toast(x.added ? `🧲 ${x.name}: ${x.added} video${x.added === 1 ? '' : 's'} added — playing while it downloads` : `🧲 ${x.name}: no new videos (already in the library, or none ticked)`);
    } catch (e) { toast(`Couldn’t add that: ${plain(e)}`); }
    delete S.adding[r.key]; notify();
  };
  const sortBy = (k) => { if (S.sort === k) S.dir = -S.dir; else { S.sort = k; S.dir = k === 'name' ? 1 : -1; } notify(); };
  const f = S.filter.trim().toLowerCase();
  const rows = S.results.filter((r) => !f || r.name.toLowerCase().includes(f)).sort((a, b) => {
    if (S.sort === 'name') return S.dir * a.name.localeCompare(b.name);
    const av = a[S.sort], bv = b[S.sort];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return S.dir * (av - bv);
  });
  const head = (k, label, cls = '') => html`<button class=${(S.sort === k ? 'on ' : '') + cls} onClick=${() => sortBy(k)}>${label}${S.sort === k ? (S.dir < 0 ? ' ▾' : ' ▴') : ''}</button>`;
  const status = Object.keys(S.status).sort((a, b) => S.order[a] - S.order[b]).map((id) => { const s = S.status[id]; return html`<span key=${id} class=${s.error ? 'bad' : s.count ? 'ok' : ''} title=${s.error || `${s.ms} ms`}>${S.names[id] || id}: ${s.error ? `⚠ ${s.error}` : s.count}</span>`; });
  return html`<div class="sr">
    <div class="sr-bar">
      <input class="input q grow" list="sr-recent" placeholder=${on.length ? `Search ${on.length} source${on.length === 1 ? '' : 's'}…` : 'Turn on a search source first'} value=${S.q} onInput=${(e) => { S.q = e.target.value; }} onKeyDown=${(e) => e.key === 'Enter' && run()} disabled=${!on.length} />
      <datalist id="sr-recent">${recent.map((q) => html`<option value=${q} />`)}</datalist>
      <select class="select" value=${S.cat} onChange=${(e) => { S.cat = e.target.value; notify(); }}>${CATEGORIES.map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select>
      ${S.running ? html`<button class="btn" onClick=${stop}>■ Stop</button>` : html`<button class="btn primary" onClick=${run} disabled=${!on.length}>🔍 Search</button>`}
      <button class="btn ghost" onClick=${onEngines} title="Choose which sources to search">${engines ? `${on.length} of ${engines.length} engines on` : 'Engines'} ▸</button>
    </div>
    ${(status.length > 0 || S.skipped.length > 0 || S.running) && html`<div class="sr-status">
      ${S.running && html`<span>Searching…</span>`}${status}
      ${S.skipped.length > 0 && html`<span class="faint" title="These sources can't narrow a search to one kind of thing — pick Everything to use them">${S.skipped.join(', ')}: not for ${catLabel(S.cat)}</span>`}
    </div>`}
    ${S.results.length > 0 && html`<div class="row" style="margin-bottom:8px"><input class="input" style="width:260px" placeholder="Narrow these results…" value=${S.filter} onInput=${(e) => { S.filter = e.target.value; notify(); }} /><span class="muted small">${rows.length} of ${S.results.length}</span></div>`}
    ${!engines ? null : !on.length ? html`<div class="sr-empty"><h3>No search sources are on</h3><p>Turn on the Internet Archive’s free items, or add a source of your own.</p><button class="btn primary" onClick=${onEngines}>Choose search engines</button></div>`
      : !S.results.length && !S.running && S.searchId ? html`<div class="sr-empty"><h3>Nothing found</h3><p>Try fewer words, another spelling, or Everything instead of ${catLabel(S.cat)}.</p></div>`
        : !S.results.length && !S.searchId ? html`<div class="sr-empty"><h3>Search ${on.length} source${on.length === 1 ? '' : 's'}</h3><p>Add a result and find it under My torrents. Only add what you have the right to download and share.</p></div>`
          : html`<div class="sr-table">
            <div class="sr-row head">${head('name', 'Name')}${head('size', 'Size', 'num')}${head('seeds', 'Seeds', 'num')}${head('leech', 'Peers', 'num')}${head('pubDate', 'Added', 'num')}<span></span></div>
            ${rows.slice(0, 400).map((r) => html`<div class="sr-row" key=${r.key}>
              <div class="name"><b title=${r.name}>${r.name}</b><span><span class="sr-eng">${S.names[r.engine] || r.engine}</span>${r.descLink && html`<a href=${r.descLink} target="_blank" rel="noreferrer" title="Open its page in your browser">${hostOf(r.descLink)} ↗</a>`}</span></div>
              <span class="num">${mb(r.size)}</span>
              <span class="num" title=${r.seeds == null ? 'Web-seeded: always available' : ''}>${r.seeds == null ? 'web' : r.seeds}</span>
              <span class="num">${r.leech == null ? '' : r.leech}</span>
              <span class="num muted">${ago(r.pubDate)}</span>
              <div class="acts">${S.added[r.key] ? html`<button class="btn sm" onClick=${onMine}>✓ Added · see it</button>` : html`<button class="btn sm primary" disabled=${!isAdult || !!S.adding[r.key]} onClick=${() => add(r)}>${S.adding[r.key] ? 'Adding…' : '＋ Add'}</button>`}</div>
            </div>`)}
          </div>`}
  </div>`;
}

function EnginesTab({ toast, isAdult }) {
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState('');
  const [askUrl, setAskUrl] = useState(false);
  const [url, setUrl] = useState('');
  const [sure, setSure] = useState(null); // the engine whose Remove was pressed once
  const load = () => tv.searchEngines().then((l) => { setList(l); for (const e of l) S.names[e.id] = e.name; }).catch((e) => toast(plain(e)));
  useEffect(() => { load(); }, []);
  const toggle = (e) => tv.searchEnable(e.id, !e.enabled).then(load).catch((x) => toast(plain(x)));
  const installed = (r) => { toast(`✓ ${r.name}${r.version ? ` ${r.version}` : ''} installed and turned on`); load(); };
  const installFile = async () => { const f = await tv.searchPickFile(); if (!f) return; setBusy('file'); try { installed(await tv.searchInstall(f)); } catch (e) { toast(`Couldn’t install it: ${plain(e)}`); } setBusy(''); };
  const installUrl = async () => { const u = url.trim(); if (!u) return; setBusy('url'); try { installed(await tv.searchInstall(u)); setUrl(''); setAskUrl(false); } catch (e) { toast(`Couldn’t install it: ${plain(e)}`); } setBusy(''); };
  const update = async () => {
    setBusy('update');
    try {
      const r = await tv.searchUpdate();
      const n = list?.filter((e) => !e.builtin && e.source).length || 0;
      toast(!n ? 'Nothing to check — only engines installed from a link can update' : r.updated.length ? `⬆ Updated ${r.updated.map((x) => `${x.name} to ${x.version}`).join(', ')}` : r.failed.length ? `Couldn’t check ${r.failed.map((x) => x.name).join(', ')}: ${r.failed[0].error}` : 'Every engine is up to date');
      load();
    } catch (e) { toast(plain(e)); }
    setBusy('');
  };
  const remove = async (e) => { if (sure !== e.id) { setSure(e.id); setTimeout(() => setSure((s) => (s === e.id ? null : s)), 4000); return; } setSure(null); try { await tv.searchRemove(e.id); toast(`Removed ${e.name}`); load(); } catch (x) { toast(plain(x)); } };
  const setOpt = (e, key, val) => tv.searchOptions(e.id, { [key]: val }).then(load).catch((x) => toast(plain(x)));
  const last = (e) => !e.last ? 'Not searched yet' : e.last.error ? `⚠ Last search: ${e.last.error}` : `Last search: ${e.last.count} result${e.last.count === 1 ? '' : 's'} in ${(e.last.ms / 1000).toFixed(1)} s · ${ago(e.last.at)}`;
  const n = list?.filter((e) => e.enabled).length || 0;
  return html`<div class="tor-engines">
    <div class="row" style="flex-wrap:wrap;margin-bottom:14px">
      <span class="muted small grow" style="min-width:280px">HomeCable comes with the Internet Archive’s free items and a connector for your own server. Anything else is yours to add: HomeCable doesn’t supply, list or recommend other sources, and you’re responsible for what you add. Engines run with the app’s permissions, so install only ones you trust. <a href=${DOCS} target="_blank" rel="noreferrer">How engines work</a></span>
      ${isAdult && html`<button class="btn sm" onClick=${installFile} disabled=${!!busy}>📄 Install from a file…</button>
      <button class="btn sm" onClick=${() => setAskUrl((v) => !v)} disabled=${!!busy}>🔗 Install from a link…</button>
      <button class="btn sm" onClick=${update} disabled=${!!busy}>${busy === 'update' ? 'Checking…' : '⬆ Check for updates'}</button>
      <button class="btn sm" onClick=${() => tv.searchOpenFolder()} title="Where your own engines live">📂 Engines folder</button>`}
    </div>
    ${askUrl && html`<div class="row" style="margin-bottom:14px"><input class="input grow" placeholder="https://…/my-engine.js" value=${url} onInput=${(e) => setUrl(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && installUrl()} /><button class="btn primary sm" onClick=${installUrl} disabled=${!url.trim() || !!busy}>${busy === 'url' ? 'Installing…' : 'Install'}</button><button class="btn sm" onClick=${() => setAskUrl(false)}>Cancel</button></div>`}
    ${list === null ? html`<p class="muted">Loading…</p>` : html`
      <p class="muted small" style="margin:0 0 6px">${n} of ${list.length} on</p>
      ${list.map((e) => html`<div class=${'eng-row' + (e.enabled ? ' on' : '')} key=${e.id}>
        <button class=${'toggle' + (e.enabled ? ' on' : '')} title=${e.error ? 'This engine can’t load' : e.enabled ? 'On — click to turn off' : 'Off — click to turn on'} disabled=${!isAdult || !!e.error} onClick=${() => toggle(e)}></button>
        <div class="grow">
          <div class="title"><b>${e.name}</b>${e.builtin ? html`<span class="eng-tag">built in</span>` : html`<span class="eng-tag custom">yours</span>`}${e.version && html`<span class="faint small">v${e.version}</span>`}${e.url && html`<a href=${e.url} target="_blank" rel="noreferrer">${hostOf(e.url)} ↗</a>`}</div>
          <div class="muted small">${e.error ? `⚠ ${e.error}` : [e.about, e.categories.length === 1 && e.categories[0] === 'all' ? 'Everything (can’t narrow by kind)' : e.categories.map(catLabel).join(', ')].filter(Boolean).join(' · ')}</div>
          ${!e.error && html`<div class=${'last' + (e.last?.error ? ' bad' : '')}>${last(e)}${e.source ? ` · updates from ${hostOf(e.source)}` : ''}</div>`}
          ${e.options.length > 0 && html`<div class="eng-opts">${e.options.map((o) => html`<label key=${o.key}>${o.label}${o.required ? '' : ' (optional)'}<input class="input" type=${o.secret ? 'password' : 'text'} placeholder=${o.placeholder} value=${e.values[o.key] || ''} disabled=${!isAdult} onChange=${(ev) => setOpt(e, o.key, ev.target.value)} /></label>`)}</div>`}
        </div>
        ${!e.builtin && isAdult && html`<button class=${'btn sm' + (sure === e.id ? ' danger' : '')} onClick=${() => remove(e)}>${sure === e.id ? 'Sure? Remove' : 'Remove'}</button>`}
      </div>`)}
      <p class="muted small" style="margin-top:16px">Searches use the torrent network interface you chose.</p>`}
  </div>`;
}
