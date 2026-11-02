// "Cast everything": mirror the whole HomeCable window — guide, menus, banners,
// the picture — to the TV. The window is captured (1080p max, 30 fps) and recorded
// as H.264 with the picture's sound; the main process repackages it for the
// Chromecast. While mirroring, the sound plays on the TV only (no echo from the PC).
import { tv } from './util.js';
import { elementAudio, routeAudio } from './audio.js';

let session = null;

export async function startMirror() {
  stopMirror();
  const me = (session = { stopped: false });
  const id = await tv.mirrorSourceId();
  const cam = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30, minFrameRate: 15 } },
  });
  if (me.stopped) { cam.getTracks().forEach((t) => t.stop()); return; }
  const video = document.querySelector('.stage video');
  let audioTracks = [];
  if (video) {
    const { ctx } = elementAudio(video);
    const dest = ctx.createMediaStreamDestination();
    routeAudio(video, dest);
    me.video = video;
    audioTracks = dest.stream.getAudioTracks();
    // Diagnostics: how loud the sound going to the TV is (0–1).
    const an = ctx.createAnalyser(); an.fftSize = 1024;
    ctx.createMediaStreamSource(dest.stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    window.__mirrorLevel = () => { an.getFloatTimeDomainData(buf); let m = 0; for (const x of buf) m = Math.max(m, Math.abs(x)); return m; };
  }
  const stream = new MediaStream([...cam.getVideoTracks(), ...audioTracks]);
  const rec = new MediaRecorder(stream, {
    mimeType: 'video/webm;codecs=h264,opus', videoBitsPerSecond: 8e6, audioBitsPerSecond: 160e3,
    videoKeyFrameIntervalDuration: 1000, // a fresh picture every second: quick start, quick recovery
  });
  rec.ondataavailable = async (e) => { if (e.data.size && !me.stopped) tv.mirrorChunk(await e.data.arrayBuffer()); };
  rec.start(100); // small pieces = less delay
  Object.assign(me, { cam, rec, startedAt: Date.now() });
  window.__mirrorInfo = () => ({ startedAt: me.startedAt, size: cam.getVideoTracks()[0]?.getSettings(), state: rec.state });
}

export function stopMirror() {
  const s = session;
  session = null;
  if (!s) return;
  s.stopped = true;
  try { s.rec?.state !== 'inactive' && s.rec?.stop(); } catch {}
  s.cam?.getTracks().forEach((t) => t.stop());
  if (s.video) routeAudio(s.video, null); // sound back to the PC speakers
}
