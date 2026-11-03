// The HomeCable grid guide for phones and tablets — the same look and feel as
// the PC's guide: the selected programme up top (time, title, episode, what
// it's about, who it's from), a "Watch" button, search + genre + ♥ filters,
// and the half-hour grid with the red "now" line underneath.
//
// Plain JavaScript (no framework) so BOTH halves of the phone app use it:
// the screens the PC serves to a paired phone, and the phone's own Free TV.
// Lives in the PC repo (src/phone/guidegrid.js); the phone APK's build copies it.
//
//   const g = HCGuide.mount(el, {
//     channels: [{ id, number, name, logo, color, provider, fav }],
//     load: (from, to) => Promise<[{ id, entries: [{ start, end, title, sub, summary, type, show, … }] }] | { [id]: entries }>,
//     genres: { [id]: ['News', …] },   // optional
//     tunedId, note, storeKey,
//     onWatch(ch, entry), watchLabel(ch) // the big button (and tapping a selected programme)
//     actions(ch, entry) → [{ label, run }]   // more buttons beside it
//     onBack, backLabel, onFav(ch, on), preview: true
//   });
//   g.update({ channels, tunedId, genres }); g.reload(); g.destroy(); g.previewEl
(function () {
  const SLOT = 30 * 60e3;
  const HOUR = 3600e3;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const floorSlot = (t) => Math.floor(t / SLOT) * SLOT;
  const epLabel = (e) => (e && e.season != null && e.episode != null ? `S${e.season} · E${e.episode}` : '');
  // Main line + second line for a programme (same rules as the PC guide).
  function text(e) {
    if (!e) return { title: 'No signal', sub: '' };
    if (e.type === 'upnext') return { title: 'Up Next', sub: '' };
    if (e.type === 'offair') return { title: e.title || 'Off Air', sub: '' };
    if (e.type === 'filler') return { title: e.title, sub: 'Break' };
    if (e.type === 'ad') return { title: 'Commercial break', sub: e.title };
    if (e.type === 'ident') return { title: e.title || 'Station break', sub: 'We’ll be right back' };
    if (e.live) return { title: e.title, sub: e.sub || (e.fromGuide ? '' : 'Live') }; // a real listing without an episode name shows its time instead
    if (e.show) return { title: e.show, sub: [epLabel(e), e.title].filter(Boolean).join(' · ') };
    return { title: e.title, sub: e.sub || (e.kind === 'movie' ? 'Movie' : e.kind === 'music' ? 'Music' : '') };
  }
  // Breaks and "up next" gaps belong to the programme before them, like the
  // half-hour boxes on a real cable guide.
  function merge(raw) {
    const out = [];
    for (const e of raw || []) {
      const prev = out[out.length - 1];
      if ((e.type === 'filler' || e.type === 'upnext' || e.type === 'ad' || e.type === 'ident') && prev && prev.type !== 'filler') prev.end = Math.max(prev.end, e.end);
      else out.push({ ...e });
    }
    // Sloppy guide data can overlap — each box starts where the last ended.
    for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].end) out[i].start = out[i - 1].end;
    return out.filter((e) => e.end > e.start);
  }
  // A station with no schedule still gets boxes: an hour of "Live" at a time.
  function liveBlocks(ch, from, to) {
    const out = [];
    for (let t = Math.floor(from / HOUR) * HOUR; t < to; t += HOUR) out.push({ start: t, end: t + HOUR, title: ch.name, sub: 'Live', live: true, noGuide: true });
    return out;
  }

  function mount(root, o) {
    let opts = { ...o };
    const KEY = 'hc-guide-' + (opts.storeKey || 'phone');
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
    const st = { q: saved.q || '', genre: saved.genre || '', fav: !!saved.fav, start: floorSlot(Date.now()), shifted: false, data: new Map(), list: [], sel: null, now: Date.now(), loading: 0 };
    const keep = () => { try { localStorage.setItem(KEY, JSON.stringify({ q: st.q, genre: st.genre, fav: st.fav })); } catch {} };

    root.classList.add('hg');
    root.innerHTML = `
      <div class="hg-hero">
        ${opts.preview ? '<div class="hg-preview"></div>' : ''}
        <div class="hg-info">
          ${opts.onBack ? `<button class="hg-back" type="button">${esc(opts.backLabel || '← Back')}</button>` : ''}
          <div class="hg-time"></div>
          <h2 class="hg-title"></h2>
          <div class="hg-sub"></div>
          <div class="hg-via" hidden></div>
          <p class="hg-sum" hidden></p>
          <div class="hg-bar"><button class="hg-btn primary hg-go" type="button"></button><span class="hg-acts"></span></div>
          ${opts.note ? `<div class="hg-note">${esc(opts.note)}</div>` : ''}
        </div>
      </div>
      <div class="hg-filters">
        <input class="hg-q" type="search" enterkeyhint="search" placeholder="🔍 Search channels & shows…">
        <select class="hg-genre"></select>
        <button class="hg-btn hg-fav" type="button" title="Show only ❤ favorites">♡</button>
      </div>
      <div class="hg-grid">
        <div class="hg-times"><div class="hg-corner"><button class="hg-ic hg-prev" type="button" title="Earlier">‹</button><button class="hg-ic hg-next" type="button" title="Later">›</button><span class="hg-date"></span></div><div class="hg-slots"></div></div>
        <div class="hg-rows"><div class="hg-space"></div><div class="hg-empty" hidden></div></div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    const rowsEl = $('.hg-rows'), space = $('.hg-space');
    const qEl = $('.hg-q'), gEl = $('.hg-genre'), favEl = $('.hg-fav');
    qEl.value = st.q;

    // Sizes follow the screen: a phone shows 1½ hours, a tablet 2–2½, like the PC.
    let RH = 60, CHW = 170, SPAN = 2.5 * HOUR;
    const measure = () => {
      const w = root.clientWidth || window.innerWidth;
      RH = w < 520 ? 58 : 62;
      CHW = w < 420 ? 118 : w < 700 ? 150 : 190;
      SPAN = w < 480 ? HOUR : w < 700 ? 1.5 * HOUR : w < 1000 ? 2 * HOUR : 2.5 * HOUR;
      root.style.setProperty('--hg-rh', RH + 'px');
      root.style.setProperty('--hg-chw', CHW + 'px');
      root.classList.toggle('hg-narrow', w < 700);
    };
    measure();

    const entCache = new Map();
    const entries = (ch) => {
      let e = entCache.get(ch.id);
      if (!e) {
        const raw = st.data.get(ch.id);
        e = raw && raw.length ? merge(raw) : liveBlocks(ch, st.start - SLOT, st.start + SPAN + SLOT);
        entCache.set(ch.id, e);
      }
      return e;
    };
    const at = (ch, t) => entries(ch).find((e) => e.start <= t && t < e.end) || null;

    function filter() {
      const ql = st.q.trim().toLowerCase();
      const g = opts.genres || {};
      st.list = (opts.channels || []).filter((c) => (!st.fav || c.fav)
        && (!st.genre || (g[c.id] || []).includes(st.genre))
        && (!ql || String(c.name).toLowerCase().includes(ql) || String(c.number) === ql
          || (st.data.get(c.id) || []).some((e) => String(e.title || '').toLowerCase().includes(ql) || String(e.sub || '').toLowerCase().includes(ql) || String(e.show || '').toLowerCase().includes(ql))));
      if (!st.sel || !st.list.some((c) => c.id === st.sel.id)) {
        const c = st.list.find((x) => x.id === opts.tunedId) || st.list[0];
        st.sel = c ? { id: c.id, t: Math.max(Date.now(), st.start) + 1 } : null;
      }
      space.style.height = st.list.length * RH + 'px';
      const empty = $('.hg-empty');
      empty.hidden = st.list.length > 0;
      empty.textContent = st.fav && !(opts.channels || []).some((c) => c.fav)
        ? 'No favorites yet — press and hold a channel’s name to ❤ it, then the heart up top shows just those.'
        : `Nothing matches${st.q ? ` “${st.q}”` : ''}${st.genre ? ` in ${st.genre}` : ''}${st.fav ? ' in your favorites' : ''}.`;
    }

    function genresSelect() {
      const g = opts.genres || {};
      const count = new Map();
      for (const c of opts.channels || []) for (const x of g[c.id] || []) count.set(x, (count.get(x) || 0) + 1);
      const all = [...count.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { sensitivity: 'base' }));
      gEl.hidden = !all.length;
      if (st.genre && !count.has(st.genre)) st.genre = '';
      gEl.innerHTML = `<option value="">🏷 All genres</option>` + all.map(([x, n]) => `<option value="${esc(x)}"${x === st.genre ? ' selected' : ''}>${esc(x)} (${n})</option>`).join('');
    }

    const pos = (t) => ((t - st.start) / SPAN) * 100;
    function times() {
      $('.hg-date').textContent = new Date(st.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      const n = Math.round(SPAN / SLOT);
      let h = '';
      for (let i = 0; i < n; i++) h += `<span style="left:${pos(st.start + i * SLOT)}%">${fmt(st.start + i * SLOT)}</span>`;
      $('.hg-slots').innerHTML = h;
      $('.hg-prev').disabled = st.start <= floorSlot(Date.now());
    }

    function logoHtml(c) {
      const l = c.logo;
      if (typeof l === 'string' && /^(https?:|\/|data:image)/.test(l)) return `<img class="hg-logo" src="${esc(l)}" alt="" loading="lazy">`;
      if (typeof l === 'string' && l && l.length <= 4) return `<span class="hg-logo hg-emoji">${esc(l)}</span>`;
      return '';
    }

    let drawn = [-1, -1];
    function rows(force) {
      const top = rowsEl.scrollTop, h = rowsEl.clientHeight || 600;
      const a = Math.max(0, Math.floor(top / RH) - 5), b = Math.min(st.list.length, Math.ceil((top + h) / RH) + 5);
      if (!force && a === drawn[0] && b === drawn[1]) return;
      drawn = [a, b];
      const now = st.now, end = st.start + SPAN;
      let html = '';
      for (let i = a; i < b; i++) {
        const c = st.list[i];
        const selRow = st.sel && st.sel.id === c.id;
        let cells = now >= st.start && now < end ? `<div class="hg-nowline" style="left:${pos(now)}%"></div>` : '';
        entries(c).forEach((e, k) => {
          if (e.end <= st.start || e.start >= end) return;
          const l = Math.max(0, pos(e.start)), r = Math.min(100, pos(e.end));
          const t = text(e);
          const sel = selRow && e.start <= st.sel.t && st.sel.t < e.end;
          const onNow = e.start <= now && now < e.end;
          cells += `<div class="hg-cell${sel ? ' sel' : ''}${onNow ? ' now' : ''}${e.end <= now ? ' past' : ''}${e.noGuide ? ' noguide' : ''}" data-i="${i}" data-k="${k}" style="left:calc(${l}% + 2px);width:calc(${r - l}% - 4px)">
            <b>${e.start < st.start ? '‹ ' : ''}${esc(t.title)}</b><small>${esc(t.sub || fmt(e.start))}</small></div>`;
        });
        html += `<div class="hg-row${c.id === opts.tunedId ? ' tuned' : ''}${selRow ? ' selrow' : ''}" style="top:${i * RH}px">
          <button class="hg-ch" type="button" data-i="${i}" style="--c:${esc(c.color || '#3a3f52')}"><b class="hg-num">${esc(c.number)}</b>${logoHtml(c)}<span class="hg-name"><em>${c.fav ? '❤ ' : ''}${esc(c.name)}</em>${c.provider ? `<i>${esc(c.provider)}</i>` : ''}</span></button>
          <div class="hg-cells">${cells}</div></div>`;
      }
      rowsEl.querySelectorAll('.hg-row').forEach((x) => x.remove());
      rowsEl.insertAdjacentHTML('beforeend', html);
    }

    function hero() {
      const c = st.sel && (opts.channels || []).find((x) => x.id === st.sel.id);
      const e = c ? at(c, st.sel.t) : null;
      const t = text(e);
      $('.hg-time').textContent = c ? `${c.number} · ${c.name}${e ? ` · ${fmt(e.start)} – ${fmt(e.end)}` : ''}` : '';
      $('.hg-title').textContent = c ? t.title || c.name : 'No channels';
      $('.hg-sub').textContent = e ? [t.sub, e.block ? `${e.block} block` : ''].filter(Boolean).join(' · ') + (e.noGuide ? ' · no schedule yet' : '') : '';
      const via = $('.hg-via');
      via.hidden = !(c && c.provider);
      if (c && c.provider) via.innerHTML = `<span class="hg-chip">via ${esc(c.provider)}</span> A free channel from ${esc(c.provider)} — its shows, ad breaks and times are ${esc(c.provider)}’s, not HomeCable’s.`;
      const sum = $('.hg-sum');
      sum.hidden = !(e && e.summary);
      sum.textContent = (e && e.summary) || '';
      const go = $('.hg-go');
      go.hidden = !c;
      go.textContent = c ? (opts.watchLabel ? opts.watchLabel(c, e) : `▶ Watch channel ${c.number}`) : '';
      const acts = $('.hg-acts');
      acts.innerHTML = '';
      for (const a of (c && opts.actions ? opts.actions(c, e) : []) || []) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'hg-btn';
        b.textContent = a.label;
        b.onclick = () => a.run(c, e);
        acts.append(b);
      }
      favEl.textContent = st.fav ? '❤' : '♡';
      favEl.classList.toggle('on', st.fav);
      favEl.hidden = !opts.onFav && !(opts.channels || []).some((x) => x.fav);
    }

    function draw(force = true) { times(); hero(); rows(force); }

    async function load() {
      const id = ++st.loading;
      const from = st.start - SLOT, to = st.start + SPAN + SLOT;
      let got;
      try { got = await opts.load(from, to); } catch { got = []; }
      if (id !== st.loading) return;
      st.data = new Map(Array.isArray(got) ? got.map((r) => [r.id, r.entries || []]) : Object.entries(got || {}));
      entCache.clear();
      filter();
      draw();
    }

    const shift = (d) => {
      const min = floorSlot(Date.now());
      const next = Math.max(min, st.start + d * SLOT);
      if (next === st.start) return;
      st.start = next;
      st.shifted = st.start !== min;
      if (st.sel) st.sel.t = Math.max(st.sel.t, st.start + 1);
      if (st.sel && st.sel.t >= st.start + SPAN) st.sel.t = st.start + 1;
      entCache.clear();
      draw();
      load();
    };
    const center = () => {
      const i = st.list.findIndex((c) => c.id === (st.sel && st.sel.id));
      if (i >= 0) rowsEl.scrollTop = Math.max(0, i * RH - (rowsEl.clientHeight - RH) / 2);
    };

    // ---- touch / mouse ----
    const watch = (c, e) => opts.onWatch && opts.onWatch(c, e || at(c, Math.max(Date.now(), st.start) + 1));
    rowsEl.addEventListener('scroll', () => rows(false), { passive: true });
    rowsEl.addEventListener('click', (ev) => {
      if (swiped) { swiped = false; return; }
      const cell = ev.target.closest('.hg-cell');
      const chb = ev.target.closest('.hg-ch');
      if (cell) {
        const c = st.list[+cell.dataset.i];
        const e = entries(c)[+cell.dataset.k];
        if (!c || !e) return;
        const already = st.sel && st.sel.id === c.id && e.start <= st.sel.t && st.sel.t < e.end;
        if (already) { watch(c, e); return; } // a second tap on the selected programme watches it
        st.sel = { id: c.id, t: Math.max(e.start, Date.now()) + 1 };
        if (st.sel.t >= e.end) st.sel.t = e.start + 1;
        hero(); rows(true);
      } else if (chb) {
        const c = st.list[+chb.dataset.i];
        if (c) { st.sel = { id: c.id, t: Math.max(Date.now(), st.start) + 1 }; hero(); rows(true); watch(c); }
      }
    });
    // Press and hold a channel's name: ❤ it (or un-❤ it).
    rowsEl.addEventListener('contextmenu', (ev) => {
      const chb = ev.target.closest('.hg-ch');
      if (!chb || !opts.onFav) return;
      ev.preventDefault();
      const c = st.list[+chb.dataset.i];
      if (!c) return;
      navigator.vibrate && navigator.vibrate(25);
      c.fav = !c.fav;
      Promise.resolve(opts.onFav(c, c.fav)).catch(() => {});
      filter(); draw();
    });
    // Swipe the grid sideways: earlier / later, half an hour at a time.
    let tx = null, swiped = false;
    rowsEl.addEventListener('touchstart', (ev) => { const t = ev.touches[0]; tx = { x: t.clientX, y: t.clientY }; swiped = false; }, { passive: true });
    rowsEl.addEventListener('touchend', (ev) => {
      if (!tx) return;
      const t = ev.changedTouches[0];
      const dx = t.clientX - tx.x, dy = t.clientY - tx.y;
      tx = null;
      if (Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      const slotPx = Math.max(40, ((rowsEl.clientWidth - CHW) * SLOT) / SPAN);
      swiped = true;
      setTimeout(() => { swiped = false; }, 400);
      shift((dx < 0 ? 1 : -1) * Math.max(1, Math.round(Math.abs(dx) / slotPx)));
    }, { passive: true });
    root.addEventListener('error', (ev) => { if (ev.target && ev.target.tagName === 'IMG') ev.target.style.visibility = 'hidden'; }, true);
    $('.hg-prev').onclick = () => shift(-1);
    $('.hg-next').onclick = () => shift(1);
    $('.hg-go').onclick = () => { const c = st.sel && (opts.channels || []).find((x) => x.id === st.sel.id); if (c) watch(c, at(c, st.sel.t)); };
    if (opts.onBack) $('.hg-back').onclick = () => opts.onBack();
    let qT = null;
    qEl.addEventListener('input', () => { clearTimeout(qT); qT = setTimeout(() => { st.q = qEl.value; keep(); filter(); rowsEl.scrollTop = 0; draw(); }, 200); });
    qEl.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') qEl.blur(); });
    gEl.onchange = () => { st.genre = gEl.value; keep(); filter(); rowsEl.scrollTop = 0; draw(); };
    favEl.onclick = () => { st.fav = !st.fav; keep(); filter(); rowsEl.scrollTop = 0; draw(); };
    // Keyboards / TV remotes plugged into a tablet.
    const onKey = (ev) => {
      if (!root.isConnected || root.offsetParent === null || ev.target.closest?.('input, select, textarea')) return;
      const i = st.list.findIndex((c) => c.id === (st.sel && st.sel.id));
      if (i < 0) return;
      const c = st.list[i];
      const list = entries(c);
      const k = list.findIndex((e) => e.start <= st.sel.t && st.sel.t < e.end);
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        const n = st.list[Math.max(0, Math.min(st.list.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))];
        st.sel = { id: n.id, t: st.sel.t };
        const y = st.list.indexOf(n) * RH;
        if (y < rowsEl.scrollTop) rowsEl.scrollTop = y; else if (y + RH > rowsEl.scrollTop + rowsEl.clientHeight) rowsEl.scrollTop = y + RH - rowsEl.clientHeight;
      } else if (ev.key === 'ArrowRight' && list[k + 1]) { st.sel.t = Math.max(list[k + 1].start, st.start) + 1; if (list[k + 1].start >= st.start + SPAN - SLOT / 2) shift(1); }
      else if (ev.key === 'ArrowLeft' && list[k - 1] && list[k - 1].end > Date.now()) { st.sel.t = Math.max(list[k - 1].start, Date.now()) + 1; if (list[k - 1].start < st.start) shift(-1); }
      else if (ev.key === 'Enter') { watch(c, list[k]); }
      else return;
      ev.preventDefault();
      hero(); rows(true);
    };
    window.addEventListener('keydown', onKey);
    const onResize = () => { const s = SPAN; measure(); filter(); if (s !== SPAN) { entCache.clear(); load(); } draw(); };
    window.addEventListener('resize', onResize);
    // Time moves on: the red line, "on now", and the grid itself after the half hour.
    const tick = setInterval(() => {
      st.now = Date.now();
      if (!st.shifted && floorSlot(st.now) > st.start) { st.start = floorSlot(st.now); entCache.clear(); load(); }
      draw();
    }, 15000);

    genresSelect();
    filter();
    draw();
    load().then(() => requestAnimationFrame(center));
    requestAnimationFrame(center);

    return {
      previewEl: root.querySelector('.hg-preview'),
      update(n) {
        const genresChanged = 'genres' in n || 'channels' in n;
        const retune = 'tunedId' in n && n.tunedId && n.tunedId !== opts.tunedId;
        opts = { ...opts, ...n };
        entCache.clear();
        if (genresChanged) genresSelect();
        // A different channel is on now: the guide selects it and centers on it.
        if (retune) st.sel = { id: n.tunedId, t: Math.max(Date.now(), st.start) + 1 };
        filter();
        draw();
        if (retune) requestAnimationFrame(center);
      },
      reload: load,
      center,
      destroy() { clearInterval(tick); window.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); root.innerHTML = ''; root.classList.remove('hg'); },
    };
  }
  window.HCGuide = { mount, text, fmt };
})();
