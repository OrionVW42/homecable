// Short dramas: reading pasted YouTube links and YouTube's public feed. No network.
const test = require('node:test');
const assert = require('node:assert');
const { parseLink, parseFeed, STARTERS } = require('../src/main/dramas');

test('playlists, videos and channels are recognised', () => {
  assert.deepEqual(parseLink('https://www.youtube.com/playlist?list=PLjUIVErGlv-QGTgBOIPllJzdqZEZCfTX5'), { kind: 'playlist', ref: 'PLjUIVErGlv-QGTgBOIPllJzdqZEZCfTX5' });
  assert.deepEqual(parseLink('https://www.youtube.com/watch?v=Q4gmh1neOR0&list=PLjUIVErGlv-QGTgBOIPllJzdqZEZCfTX5&index=3'), { kind: 'playlist', ref: 'PLjUIVErGlv-QGTgBOIPllJzdqZEZCfTX5' }, 'a video inside a series means the series');
  assert.deepEqual(parseLink('https://youtu.be/Q4gmh1neOR0?si=abc'), { kind: 'video', ref: 'Q4gmh1neOR0' });
  assert.deepEqual(parseLink('https://m.youtube.com/watch?v=Q4gmh1neOR0'), { kind: 'video', ref: 'Q4gmh1neOR0' });
  assert.deepEqual(parseLink('https://www.youtube.com/shorts/Q4gmh1neOR0'), { kind: 'video', ref: 'Q4gmh1neOR0' });
  assert.deepEqual(parseLink('https://www.youtube.com/channel/UC23wOTsr0ZZrZoyU2jWk6Kw'), { kind: 'channel', ref: 'UC23wOTsr0ZZrZoyU2jWk6Kw' });
  assert.deepEqual(parseLink('https://www.youtube.com/watch?v=Q4gmh1neOR0&list=RDQ4gmh1neOR0'), { kind: 'video', ref: 'Q4gmh1neOR0' }, 'a YouTube mix is not a series');
});

test('anything else gets a plain explanation', () => {
  assert.match(parseLink('not a link').error, /YouTube link/);
  assert.match(parseLink('https://example.com/watch?v=Q4gmh1neOR0').error, /Only YouTube/);
  assert.match(parseLink('https://www.youtube.com/@dramaboxapp').error, /channel ID/);
  assert.match(parseLink('https://www.youtube.com/').error, /isn’t a YouTube/);
});

test('the public feed: its name and its videos', () => {
  const xml = `<?xml version="1.0"?><feed><title>【FULL】【Cheer Up Baby!】</title><author><name>DramaBox</name></author>
<entry><yt:videoId>Q4gmh1neOR0</yt:videoId><title>Episode 1 Cheer Up Baby!</title><published>2026-10-01T00:00:00+00:00</published></entry>
<entry><yt:videoId>1ELkPZF2NDw</yt:videoId><title>Tom &amp; Jerry&#39;s</title></entry><entry><yt:videoId>bad</yt:videoId><title>x</title></entry></feed>`;
  const f = parseFeed(xml);
  assert.equal(f.title, '【FULL】【Cheer Up Baby!】');
  assert.equal(f.author, 'DramaBox');
  assert.deepEqual(f.videos.map((v) => [v.id, v.title]), [['Q4gmh1neOR0', 'Episode 1 Cheer Up Baby!'], ['1ELkPZF2NDw', "Tom & Jerry's"]]);
});

test('starters are the studios’ own channels', () => {
  assert.deepEqual(STARTERS.channels.map((c) => c.name).sort(), ['DramaBox', 'ReelShort']);
  for (const c of STARTERS.channels) assert.match(c.ref, /^UC[A-Za-z0-9_-]{22}$/);
});
