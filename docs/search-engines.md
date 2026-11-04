# Writing a torrent search engine for HomeCable

HomeCable's Torrents tab searches through small plugins. It ships with two: the Internet
Archive, limited to items marked public domain or Creative Commons, and a connector for
a Torznab server you run yourself. You can add your own: a single JavaScript file,
installed from a file on your PC or from a link (then it can update itself when you
press *Check for updates*).

**This project doesn't supply, list, link to or accept engines for other sources.** What
you write or install is your own choice and your responsibility. Use engines only for
material you have the right to download and share, and respect each site's terms and
any limits it puts on automated access.

Engines run in HomeCable's search process, which is pinned to the torrent network
interface — with a VPN adapter chosen, every request an engine makes goes through it.

## The file

```js
// mysite.js — HomeCable search engine for Some Site
module.exports = {
  name: 'Some Site',                      // shown in the list and on every result
  url: 'https://somesite.example',        // the site, linked from the list
  about: 'A plain index of open films',   // one line under the name (optional)
  version: '1.0',                         // bump it when you change the file; updates compare it
  categories: ['all', 'movies', 'tv'],    // what it can narrow a search to (see below)
  options: [                              // settings the user fills in (optional)
    { key: 'apiKey', label: 'API key', placeholder: 'from your account page', secret: true, required: true },
  ],

  // query: what was typed; category: one of the categories above (or 'all');
  // h: the helpers below. Return an array of results, or throw an Error with a short reason.
  async search(query, category, h) {
    const j = await h.json(`https://somesite.example/api/search?q=${encodeURIComponent(query)}&key=${h.options.apiKey}`);
    return j.items.map((t) => ({
      name: t.title,
      size: t.bytes,                      // bytes, or a string like "1.2 GB"
      seeds: t.seeders,                   // numbers; leave out what the site doesn't say
      leech: t.leechers,
      link: h.magnet(t.infoHash, t.title),  // a magnet link, or an http(s) link to a .torrent file
      descLink: `https://somesite.example/t/${t.id}`,   // the torrent's page (optional)
      pubDate: t.added,                   // a date string or unix time (optional)
    }));
  },
};
```

Install it from the Torrents tab (Search engines → *Install from a file…*), or put it
in the engines folder (Search engines → *Engines folder*). An engine you install
starts **on**. The file name becomes its id (`mysite.js` → `mysite`); it can't be the
name of a built-in engine. Edit the file and the next search uses the new code.

### Categories

`all`, `movies`, `tv`, `anime`, `music`, `games`, `software`, `books`. List the ones
the site can filter by. When the user picks a category the engine doesn't list, it is
skipped for that search (and the status line says so); *Everything* always runs every
engine. If the site can't filter at all, list just `['all']`.

### Results

| Field | | |
| --- | --- | --- |
| `name` | required | HTML entities are decoded for you |
| `link` | one of these | a `magnet:` link, or an `http(s)` link to a `.torrent` file |
| `page` | one of these | the torrent's own page, when the site only shows the magnet there — see `resolve` |
| `size` | optional | bytes, or `"1.2 GB"` / `"523.5 MiB"` |
| `seeds`, `leech` | optional | numbers; `null` (or left out) shows as "web" for seeds — use it for web-seeded torrents |
| `descLink` | optional | the torrent's page, opened in the browser from the result |
| `pubDate` | optional | a date string `Date.parse` understands, or unix seconds / milliseconds |

Rows without a name or a link/page are dropped. Up to 300 results per engine are kept.

### `resolve` — when the list has no links

Some sites only put the magnet link on each torrent's page. Return `page` instead of
`link`, and add a `resolve` that fetches it when the user presses *Add*:

```js
  async resolve(result, h) {
    const html = await h.text(result.page);
    const m = /href="(magnet:[^"]+)"/.exec(html);
    return { link: m ? h.decode(m[1]) : null };
  },
```

### Options

Each entry in `options` becomes a field under the engine in the list; the values
arrive as `h.options`. `secret: true` hides what's typed; `required: false` lets a
search run without it. An engine with a required option left empty isn't searched
(the status line says it needs its settings).

## The helpers (`h`)

| | |
| --- | --- |
| `h.fetch(url, init?)` | `fetch`, identifying itself as HomeCable, with a 25 s deadline and the search's cancel signal |
| `h.text(url, init?)` | fetch → text; throws a readable error on a non-200 answer (404, 429…) |
| `h.json(url, init?)` | fetch → JSON |
| `h.decode(s)` | HTML entities → characters |
| `h.strip(s)` | tags out, entities decoded, whitespace folded |
| `h.bytes(s)` | `"1.2 GB"` → bytes |
| `h.magnet(infoHash, name?, trackers?)` | a magnet link (`h.TRACKERS` are the defaults) |
| `h.all(s, /re/g)` | every match of a global regex, as match arrays |
| `h.between(s, a, b)` | the text between two markers |
| `h.options` | the engine's settings; `h.category` the category asked for; `h.signal` the cancel signal; `h.log(...)` writes to HomeCable's log |

There is no DOM: parse HTML with regular expressions (`h.all`, `h.between`) the way
you need to. Keep requests few — one per search, plus one per *Add* for
`resolve`.

## Trying it out

From a terminal in HomeCable's folder (or with the paths of an installed copy):

```sh
node -e "const {helpersFor}=require('./src/main/searchHelpers');const e=require('./mysite.js');e.search('sintel','all',helpersFor({})).then(r=>console.log(r.slice(0,3)),e=>console.log('ERROR',e.message))"
```

The built-in engines live in `src/main/searchEngines/` — `internetarchive.js` is a
simple JSON API and `jackett.js` has options. `test/search-engines.test.js` runs each
one on a saved answer.

## Installing from a link, and your responsibility

*Check for updates* fetches an engine installed from a link again and keeps it when its
`version` is newer. Engines run with the app's permissions, so install only ones you
trust.

HomeCable doesn't host or review engines, and search results come from the source, not
from HomeCable. Add only what you have the right to download and share.
