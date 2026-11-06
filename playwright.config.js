// Automated tests never go looking for real TVs on the network (no surprise casting);
// tests/cast.e2e.test.js opts back in when HOMECABLE_CAST=1.
process.env.HOMECABLE_NO_CAST ??= '1';
// …and never create On Demand / HomeStreamer folders in your real Videos folder.
process.env.HOMECABLE_VIDEOS ??= require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'homecable-videos-'));
// …and aren't stopped by the "terms have changed" question; tests/terms.e2e.test.js turns it back on.
process.env.HOMECABLE_NO_TERMS_ASK ??= '1';
module.exports = { testDir: 'tests', timeout: 180000, workers: 1, reporter: 'list', use: { trace: 'off' } };
