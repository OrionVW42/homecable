// The Tags page: every show and movie with its tags right there — tap ✕ to take
// one off, ＋ to add from the full list (anime words included), or let the
// auto-tagger do the whole library in one click. Hand-set tags always win:
// online lookups never overwrite them.
import { html } from 'htm/preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { tv, Icon } from './util.js';
import { ArtModal, TAGS, ANIME_TAGS } from './ondemand.js';

export function TagsPanel({ toast, isAdult }) {
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all'); // all | untagged | anime
  const [pick, setPick] = useState(null);      // the row whose ＋ palette is open
  const [edit, setEdit] = useState(null);      // the full Edit dialog
  const [custom, setCustom] = useState('');
  const [tagging, setTagging] = useState(false);
  const err = (e) => String(e.message || e).replace(/^Error invoking remote method '[^']+': Error: /, '');

  const load = () => tv.browse().then(setData).catch(() => setData({ items: [], shows: [] }));
  useEffect(() => { load(); }, []);
  useEffect(() => tv.onLibraryChanged(() => load()), []);

  const rows = useMemo(() => {
    if (!data) return [];
    const shows = data.shows.map((s) => ({ kind: 'show', key: s.key, name: s.name, sub: `${s.count} episode${s.count === 1 ? '' : 's'}`, art: s.poster, genres: s.genres || [], renamed: s.renamed, target: { showKey: s.key, name: s.name } }));
    const movies = data.items.filter((i) => i.kind === 'movie' && !i.showKey).map((i) => ({ kind: 'movie', key: i.id, name: i.title, sub: i.year ? String(i.year) : 'Movie', art: i.poster || i.art, genres: i.genres || [], renamed: i.renamed, year: i.year, target: { itemId: i.id } }));
    return [...shows, ...movies].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [data]);
  const ql = q.trim().toLowerCase();
  const shown = rows.filter((r) => (!ql || r.name.toLowerCase().includes(ql))
    && (filter === 'all' || (filter === 'untagged' ? !r.genres.length : r.genres.includes('Anime'))));
  const untagged = rows.filter((r) => !r.genres.length).length;

  const setTags = (row, genres) => {
    setData((d) => !d ? d : {
      ...d,
      shows: d.shows.map((s) => (row.kind === 'show' && s.key === row.key ? { ...s, genres } : s)),
      items: d.items.map((i) => (row.kind === 'movie' && i.id === row.key ? { ...i, genres } : i)),
    });
    tv.tagsSet(row.target, genres).catch((e) => toast(err(e)));
  };
  const toggle = (row, g) => setTags(row, row.genres.includes(g) ? row.genres.filter((x) => x !== g) : [...row.genres, g]);
  const tagAll = () => {
    setTagging(true);
    toast('🏷 Looking everything up by name — tags, posters, anime, airing order…');
    tv.metaRefreshAll()
      .then((r) => { toast(`🏷 Updated info for ${r.shows} show${r.shows === 1 ? '' : 's'} and ${r.movies} movie${r.movies === 1 ? '' : 's'}`); load(); })
      .catch((e) => toast(err(e)))
      .finally(() => setTagging(false));
  };
  const openEdit = (r) => setEdit({ kind: r.kind, name: r.name, year: r.year || null, genres: r.genres, renamed: !!r.renamed, target: r.target, others: r.kind === 'movie' && data ? data.items.filter((x) => x.kind === 'movie' && x.id !== r.key).map(({ id, title }) => ({ id, title })) : [] });

  if (!isAdult) return html`<div class="overlay"><div class="overlay-head"><h2>Tags</h2></div><div class="overlay-body"><p class="muted">Ask a grown-up to change tags.</p></div></div>`;
  return html`<div class="overlay tagspage">
    <div class="overlay-head"><h2>Tags</h2>
      <span class="muted" style="margin-bottom:6px">${rows.length} titles${untagged ? ` · ${untagged} without tags` : ''}</span>
      <span class="grow"></span>
      <input class="input" style="width:240px" placeholder="Search…" value=${q} onInput=${(e) => setQ(e.target.value)} />
      <div class="seg">${[['all', 'All'], ['untagged', `No tags${untagged ? ` (${untagged})` : ''}`], ['anime', '⛩️ Anime']].map(([k, l]) => html`<button class=${filter === k ? 'on' : ''} onClick=${() => setFilter(k)}>${l}</button>`)}</div>
      <button class="btn primary" disabled=${tagging} title="Look everything up by name online: tags, posters, anime, airing order — old entries too" onClick=${tagAll}>${tagging ? 'Looking everything up…' : '🏷 Auto-tag everything'}</button>
    </div>
    <div class="overlay-body">
      ${!data && html`<p class="muted">Loading your library…</p>`}
      ${data && !rows.length && html`<p class="muted">Nothing in the library yet — add folders in Library first.</p>`}
      <div class="tag-rows">
        ${shown.map((r) => html`<div class=${'tag-row' + (pick === r.key ? ' open' : '')} key=${r.kind + r.key}>
          <div class="tag-art">${r.art ? html`<img src=${r.art} loading="lazy" alt="" onError=${(e) => { e.target.style.display = 'none'; }} />` : html`<span>${r.kind === 'show' ? '📺' : '🎬'}</span>`}</div>
          <div class="tag-meta"><b>${r.name}</b><small>${r.kind === 'show' ? '📺 ' : '🎬 '}${r.sub}</small></div>
          <div class="tag-chips">
            ${r.genres.map((g) => html`<span class="chip on">${g}<button title=${`Remove “${g}”`} onClick=${() => toggle(r, g)}>×</button></span>`)}
            <button class="chip add" title="Add a tag" onClick=${() => { setPick(pick === r.key ? null : r.key); setCustom(''); }}>＋ tag</button>
            <button class="chip add" title="Full edit: name, picture, tags, make-a-show" onClick=${() => openEdit(r)}><${Icon.edit} /> edit</button>
          </div>
          ${pick === r.key && html`<div class="tag-palette" onClick=${(e) => e.stopPropagation()}>
            <div class="tag-pal-group">${TAGS.filter((g) => !r.genres.includes(g)).map((g) => html`<button class="chip" onClick=${() => toggle(r, g)}>＋ ${g}</button>`)}</div>
            <div class="small muted" style="margin:8px 0 4px">Anime tags</div>
            <div class="tag-pal-group">${ANIME_TAGS.filter((g) => !r.genres.includes(g)).map((g) => html`<button class="chip" onClick=${() => toggle(r, g)}>＋ ${g}</button>`)}</div>
            <form class="row" style="margin-top:8px" onSubmit=${(e) => { e.preventDefault(); const t = custom.trim(); if (t) { toggle(r, t); setCustom(''); } }}>
              <input class="input grow" placeholder="Your own tag…" value=${custom} onInput=${(e) => setCustom(e.target.value)} />
              <button class="btn sm" type="submit" disabled=${!custom.trim()}>Add</button>
              <button class="btn sm ghost" type="button" onClick=${() => setPick(null)}>Done</button>
            </form>
          </div>`}
        </div>`)}
        ${data && rows.length > 0 && !shown.length && html`<p class="muted" style="padding:14px">Nothing matches.</p>`}
      </div>
    </div>
    ${edit && html`<${ArtModal} what=${edit} onClose=${() => setEdit(null)} onDone=${() => { setEdit(null); load(); }} toast=${toast} />`}
  </div>`;
}
