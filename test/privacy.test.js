// What HomeCable writes to disk: never an IP address, a torrent search, or what you download.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', f), 'utf8');

test('logs never carry an address or a torrent name', () => {
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'src', 'main')).filter((x) => x.endsWith('.js'))) {
    for (const line of read(f).split(/\r?\n/)) {
      if (!/\blog\(/.test(line)) continue;
      assert.doesNotMatch(line, /log\([^;]*remoteAddress/, f + ': ' + line.trim().slice(0, 90));
    }
  }
  for (const f of ['torrents.js', 'torrentHost.js', 'search.js', 'searchHost.js']) {
    for (const line of read(f).split(/\r?\n/)) {
      // Only what goes into the log: an on-screen message may name a torrent, since it isn't saved.
      for (const m of line.matchAll(/\blog\(((?:[^()]|\([^()]*\))*)\)/g)) assert.doesNotMatch(m[1], /\b(m|t|rec|d)\.name\b|rec\.link|\$\{bound\}|\$\{address\}|query/, f + ': ' + line.trim().slice(0, 90));
    }
  }
});

test('torrent searches are not saved, and the public-address check keeps no address', () => {
  assert.doesNotMatch(read('search.js'), /searchRecent\s*=/);
  assert.match(read('main.js'), /delete settings\.searchRecent/);
  const line = read('main.js').split(/\r?\n/).find((l) => l.includes("h('torrents:publicInfo'"));
  assert.ok(line && !/\bj\.ip\b|\.\.\.j\b/.test(line), 'only the network and place go back');
});
