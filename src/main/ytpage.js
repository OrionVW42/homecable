// The page that holds YouTube's embedded player. HomeCable's own screen can't host it directly:
// YouTube's player refuses to start without a web address to say where it's playing, and the
// screen is a file on this PC. So this page is served by HomeCable's media server (this PC only,
// with its key) and shown in a frame. It has no access to the app; the two only exchange
// play/pause/next and "where are we" messages.
module.exports = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="referrer" content="strict-origin">
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#p{width:100%;height:100%}</style></head>
<body><div id="p"></div>
<script>
var player = null, ready = false, pending = null, lastIds = '';
function send(m) { m.hc = 'yt'; parent.postMessage(m, '*'); }
function info() {
  var d = (player && player.getVideoData && player.getVideoData()) || {};
  return { s: player.getPlayerState(), i: player.getPlaylistIndex(), id: d.video_id || '', title: d.title || '', t: player.getCurrentTime() || 0, d: player.getDuration() || 0 };
}
function sendIds() {
  var ids = player.getPlaylist && player.getPlaylist();
  if (ids && ids.length && String(ids) !== lastIds) { lastIds = String(ids); send({ ev: 'playlist', ids: ids }); }
}
function onYouTubeIframeAPIReady() {
  player = new YT.Player('p', {
    host: 'https://www.youtube-nocookie.com',
    playerVars: { playsinline: 1, rel: 0, autoplay: 1, iv_load_policy: 3 },
    events: {
      onReady: function () { ready = true; send({ ev: 'ready' }); if (pending) { run(pending); pending = null; } },
      onStateChange: function (e) { sendIds(); var m = info(); m.ev = e.data === 0 ? 'ended' : 'state'; send(m); },
      onError: function (e) { var m = info(); m.ev = 'error'; m.code = e.data; send(m); }
    }
  });
}
function run(m) {
  if (!ready) { pending = m; return; }
  if (m.cmd === 'load') {
    if (m.list) player[m.cue ? 'cuePlaylist' : 'loadPlaylist']({ list: m.list, listType: 'playlist', index: m.index || 0, startSeconds: m.t || 0 });
    else player[m.cue ? 'cueVideoById' : 'loadVideoById']({ videoId: m.video, startSeconds: m.t || 0 });
  } else if (m.cmd === 'at') player.playVideoAt(m.i);
  else if (m.cmd === 'next') player.nextVideo();
  else if (m.cmd === 'prev') player.previousVideo();
  else if (m.cmd === 'play') player.playVideo();
  else if (m.cmd === 'pause') player.pauseVideo();
}
window.addEventListener('message', function (e) { if (e.source === parent && e.data && e.data.hc === 'yt' && e.data.cmd) run(e.data); });
setInterval(function () { if (ready) { sendIds(); var m = info(); m.ev = 'state'; send(m); } }, 3000);
</script>
<script src="https://www.youtube.com/iframe_api"></script>
</body></html>`;
