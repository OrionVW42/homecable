# HomeCable — notices, privacy and content

## License & fair use

HomeCable is free, open-source software (MIT license — the LICENSE file ships next to the app). It is a player: it hosts, provides, sells and endorses no media. You are solely responsible for the content you play with it and for having the legal right to play it. HomeCable is not intended for piracy or any other unlawful use, and installing it means agreeing not to use it that way. The software is provided "as is", with no warranty of any kind; to the maximum extent permitted by law, its authors and contributors accept no liability for how it is used or for the content played with it.

## Third-party software

HomeCable ships with these components. Their licenses travel with the installer.

| Component | Version | License | Notes |
|---|---|---|---|
| FFmpeg (static Windows build by gyan.dev) | 6.1.1 essentials | GPL v3 | Runs as a separate program to decode and convert video. Source: https://github.com/FFmpeg/FFmpeg/commit/e38092ef93 — license text: `resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe.LICENSE` |
| Electron (includes Chromium and Node.js) | 45 | MIT + Chromium licenses | Full list: `LICENSES.chromium.html` next to HomeCable.exe |
| Preact | 11 | MIT | |
| htm | 3 | Apache 2.0 | |
| multicast-dns | 7 | MIT | Finds NAS / Mac / Linux shares on your network |
| node-qrcode | 1.5.4 | MIT | Draws the phone pairing QR code |
| WebTorrent (with parse-torrent, bittorrent-dht and friends) | 3 | MIT | Downloads torrents you add, in playing order; its HTTP side listens on this PC only (127.0.0.1) |
| node-datachannel (libdatachannel) | 0.32 | MPL 2.0 | WebRTC for WebTorrent; license text in `resources/app.asar.unpacked/node_modules/node-datachannel/LICENSE` |
| whisper.cpp (`whisper-server`, ggml) | 1.9.5 (build b5454) | MIT | Live captions, run on this PC only (127.0.0.1). https://github.com/ggml-org/whisper.cpp — files in `resources/whisper` |
| Whisper “base” speech model (ggml q5_1) | — | MIT (OpenAI Whisper weights) | `ggml-base-q5_1.bin`, sha256 422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898 |
| Microsoft Visual C++ runtime DLLs | 14.x | Microsoft redistributable | Needed by the captions engine; `resources/whisper` |

## Privacy

HomeCable has no accounts, no telemetry, no analytics and no ads tracking. Everything about your library, channels and viewing stays on your PC.

It only goes online for features you turn on:

| What | Talks to | Sends |
|---|---|---|
| Show info & posters (optional, and the "Update show & movie info" button) | api.tvmaze.com | Show names from your library; for a matched show, a request for its public episode list (to learn the real airing order) |
| Movie posters & genres (same setting; also "Find pictures" when you hold a poster) | en.wikipedia.org, upload.wikimedia.org | A movie's title and year (or whatever name you type into the search box) |
| Classic movies, cartoons & TV (optional) | archive.org | Requests for public-domain films |
| Free live TV (optional) | iptv-org.github.io, then each station's own server | Requests for playlists and streams |
| TV guide for free live stations (with free TV on) | epg.pw; i.mjh.nz (only for stations you have from Pluto TV, Samsung TV Plus, Plex, Stirr or Roku); any guide a playlist itself names | Plain requests for public XMLTV guide files — nothing about you or your library is sent |
| Commercial breaks with an ad pack (optional; the shipped joke ads are on by default, every switch is in setup and Settings) | The ad pack's host | A plain request for the ad list and new ad videos — no cookies, IDs or tracking |
| App updates | api.github.com, github.com (the HomeCable releases page) | A plain request for the newest version's name, then the update files themselves (the small app file and its manifest, or the full installer) — no accounts, cookies, IDs or tracking. New versions install only when HomeCable restarts; Settings → Updates sets how often to look |
| Network sources | Devices on your own network only | Discovery messages (DLNA/SSDP, WS-Discovery, mDNS) |
| Torrents (only ones you add yourself) | The trackers named in the link, the BitTorrent DHT, and the other people sharing that torrent — anywhere on the internet | The torrent's id, and the pieces of it you have and want. Like any BitTorrent client, your IP address is visible to those peers and you share the pieces you have while a torrent is in your library. HomeCable never asks your router to open a port (no UPnP / NAT-PMP). Settings → Torrent network interface pins all of this traffic to one adapter (your VPN, say): if that adapter has no address, torrents pause rather than use another connection |
| Phone app (only while on) | Your paired phones, on your home network or your own VPN | Channels, your library lists and video streams — only to phones paired with a code shown on this PC |
| Live captions | Nothing — speech is turned into text on this PC | — |
| Casting to a TV | Chromecast / Google TV devices on your own network only | Finds them with mDNS; while casting, the TV fetches the video from this PC |

The built-in media server listens only on this PC (127.0.0.1) and requires a random per-session key. While you cast to a TV, a second listener opens on your home network for the TV only: it serves videos and nothing else, needs its own one-time random key, and closes as soon as casting stops.

With Settings → Phone app on, HomeCable also listens on your network (port 47800) for paired phones. Pairing needs a 6-digit code that only exists while the pairing screen is open; each phone then has its own long random key (only a hash is kept), and Forget in Settings cuts it off. The locked section stays off phones unless you turn on its "Also on paired phones" switch — and then only grown-up phones that enter its password, for 20 minutes at a time. Nothing is opened to the internet — away from home it works only through a VPN you run yourself (Radmin, Tailscale).

## Content

HomeCable is a player. It doesn't host, sell or provide any of the media it plays.

- **Your media** — you're responsible for having the right to play what's in your library.
- **Free live TV** — stations come from the public iptv-org lists of streams that broadcasters make freely available on the internet. HomeCable doesn't host or endorse them; availability, quality and content are up to each broadcaster, and some may not be available in your country.
- **Classic movies, cartoons & TV** — public-domain titles streamed from the Internet Archive. HomeCable only imports items marked public domain.
- **Torrents** — a torrent you add is downloaded from, and shared with, other people on the internet, and its videos play while it downloads. HomeCable comes with no torrents, finds none for you and endorses none. Only add torrents you have the right to download and share — open films, public-domain archives (the Internet Archive offers one for every item) and the like — exactly as with any other BitTorrent client.
- **Commercial breaks** — the shipped joke ads are ON by default; the Showtime setup page and Settings both carry the off switch. HomeCable ships a small set of its own short, family-friendly interdimensional joke ads inside the app (nothing is downloaded for them). Your own ad packs are plain folders of short videos on this PC, each with its own switch. Hosted ad packs are optional and provided by whoever hosts them.
