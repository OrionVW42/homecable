'use strict';
// Things that must be set before Electron is ready. The launcher applies the
// copy from whichever app version it's about to run (so a downloaded version's
// switches take effect too), and main.js applies it again when run directly.
function apply(app) {
  if (global.__hcSwitches) return;
  global.__hcSwitches = true;
  // Tests point this at a throwaway profile.
  if (process.env.HOMECABLE_DATA) app.setPath('userData', process.env.HOMECABLE_DATA);
  if (process.env.HOMECABLE_MUTE) app.commandLine.appendSwitch('mute-audio');
  // Let HEVC/AV1 use the GPU where the driver supports it.
  app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  // Windows promotes <video> to a hardware overlay plane that paints ABOVE the
  // page — menus, the guide and the banner ended up buried under the picture
  // (worst in fullscreen). Keep video in the normal compositing stack.
  app.commandLine.appendSwitch('disable-direct-composition-video-overlays');
}
module.exports = { apply };
