<p align="center">
  <img src="docs/media/icon/icon.png" width="96" alt="HomeCable">
</p>

<h1 align="center">HomeCable</h1>
<p align="center"><b>Your videos. Live, like cable.</b></p>

<p align="center">
  <a href="https://github.com/OrionVW42/homecable/releases/latest"><img alt="Download" src="https://img.shields.io/badge/Windows%2010%2F11-download-6c8cff?style=for-the-badge"></a>
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-3ddc97?style=for-the-badge">
  <img alt="No accounts, no tracking" src="https://img.shields.io/badge/privacy-no%20accounts%2C%20no%20tracking-a46cff?style=for-the-badge">
</p>

HomeCable turns the shows, movies and music you already own into **real TV channels**: a schedule that never stops, a cable-style guide, channel surfing, pause & rewind — plus On Demand movie walls, binge-ready shows, free live TV, casting to the TV, and a phone app for the whole house.

Free and open source (MIT). No accounts, no telemetry, no tracking. It's a player: you bring the media, and what you play is your responsibility — see [License & fair use](#license--fair-use).

[![▶ Watch the whole first-run setup — install to watching TV in two minutes](docs/media/screenshots/01-live-tv.jpg)](https://orionvw42.github.io/homecable/)

<p align="center"><b><a href="https://orionvw42.github.io/homecable/">▶ Watch the full setup video on the HomeCable page</a></b> — the real first run, start to finish.</p>

## Why

Streaming menus turned watching TV into homework. HomeCable brings back the other way: channels that are already playing something, a guide to flip through, and the couch feeling of just watching TV — built from your own library, on your own hardware, answering to no one.

## See it move

Captured from the real app running only free, open-licensed films. (Smoother versions play on the [HomeCable page](https://orionvw42.github.io/homecable/).)

| | |
|---|---|
| ![Flip channels — you join shows in progress, like real TV](docs/media/gifs/channel-surfing.gif) | ![The guide: filter by genre, search channels & shows](docs/media/gifs/guide-search-genres.gif) |
| *Flip channels — you join shows in progress, like real TV* | *The guide: filter by genre, search channels & shows* |
| ![Right-click → ❤ Favorite, then show only favorites](docs/media/gifs/guide-favorites.gif) | ![The mini player: pause, mute, volume while you browse](docs/media/gifs/mini-player-volume.gif) |
| *Right-click → ❤ Favorite, then show only favorites* | *The mini player: pause, mute, volume while you browse* |
| ![On Demand — and back to the channel you were on](docs/media/gifs/on-demand.gif) | ![Stream Demand: pick a show, episodes play in a row](docs/media/gifs/stream-demand.gif) |
| *On Demand — and back to the channel you were on* | *Stream Demand: pick a show, episodes play in a row* |
| ![Show ends → channel bumper → an interdimensional ad](docs/media/gifs/bumper-and-wacky-ad.gif) | ![Free TV stations: your lineup + search the whole index](docs/media/gifs/free-tv-manager.gif) |
| *Show ends → channel bumper → an interdimensional ad* | *Free TV stations: your lineup + search the whole index* |
| ![A network look for every channel](docs/media/gifs/network-logos.gif) | |
| *A network look for every channel* | |

## What it does

- **Channels that run like cable.** Shows start on the half hour, episodes air in order (or shuffled, or fully random — your pick per channel), and channels keep airing even while the app is closed — open it next week and the schedule has moved on, exactly on time. Time blocks air specific shows at specific times ("Saturday Cartoons 8–11am").
- **Network logos & channel bumpers.** Every channel gets its own network mark — ready-made looks (fonts, badge shapes, colors; long names become cable-style acronyms) or your own picture. Between shows the channel plays a few seconds of its own animated logo bump, just like real networks.
- **On Demand & Stream Demand.** A wall of your movie posters (pick one, resume where you stopped) and a Netflix-style shows screen — seasons, episodes, "Continue S2 · E4", with OVAs and specials in true airing order. Leave either and you land back on the channel you were watching, like a real cable box.
- **A guide you can search.** Filter by genre, search channels and shows, right-click to ❤ favorite or hide a channel, and a heart button for favorites only. It opens right on the channel you're watching.
- **Live TV that never gives up.** Dropped or stalled streams reconnect by themselves; a quiet station shows "Hang tight" and keeps trying — nothing ever switches you away or removes a channel behind your back.
- **Live DVR.** Pause, rewind and fast-forward live channels like a cable box.
- **The Edit menu.** Manage any channel in one place: add shows and movies (with suggestions that fit what it already plays), name, number, logo, order, timing — with a live cable-strip preview. Plus a Tags page with one-click **auto-tag everything**: posters, genres, corrected names, anime detection (Shounen, Isekai, Mecha…), airing order — titles only are ever sent.
- **Wacky commercial breaks.** Short, family-friendly interdimensional joke ads ship inside the app and are on out of the box — the setup walks you right past the off switch, and Settings has it too. Add your own **ad packs** — a pack is just a folder of short videos, each with its own switch. Ads only ever play in breaks, never in your library.
- **Watch all over the house.** Cast to Chromecast / Google TV. Pair phones with a QR code to watch anywhere in the house or use one as a full remote — with the real guide, search and genres on the phone. Away from the PC, the Android app runs free TV on its own and casts to any TV on the Wi-Fi you're on.
- **Profiles & a locked section.** Kids see kid-friendly channels only; PIN/password/controller-combo locks; plus a password-locked private section kept out of every list, search and guide.
- **Subtitles & dubs, Netflix-style.** Auto-subtitles when the audio isn't your language, per-show memory, anime skip-intro, and live captions generated entirely on your PC.
- **Free TV with a real guide — thousands of stations.** Over 10,000 free, publicly available live stations worldwide from the community-run [iptv-org](https://github.com/iptv-org/iptv) index: pick languages, countries and whole regions, no station limits, every one auto-tested so only working ones are kept — with real programme names and times from free public XMLTV guides. Plus public-domain classics from the Internet Archive.
- **Plays anything.** MP4, MKV, AVI, WMV, MOV, MPEG, TS, FLV, HEVC… converted on the fly by bundled FFmpeg when needed.
- **Finds your media.** This PC, USB, network shares, NAS boxes and DLNA servers (Plex, Jellyfin, Emby…). New files appear on channels automatically — or wait for your review, your choice.
- **Torrents that play while they download.** Add a magnet link or a .torrent file and its videos join the library right away: pieces download in playing order, so a show can start, seek and even be joined in progress before the file has finished. The Torrents tab (next to Library) shows progress, peers and speeds, lets you pick which files download, pause, queue by priority, set a storage limit, open the folder, or forget a torrent with or without its files — and pins torrent traffic to one network adapter, qBittorrent-style: pick your VPN and torrents never use anything else.
- **Search for free films and archives.** Torrents → Search looks through the Internet Archive's public-domain and Creative Commons items. Search sources are small plugins, so you can also connect your own Torznab server or [write your own](docs/search-engines.md). HomeCable hosts no torrents and doesn't list or recommend any other source; only add what you have the right to download and share.
- **Couch-first.** Keyboard, mouse, Xbox / PS5 controllers, fullscreen TV mode, pop-out mini player, a one-time welcome tour, and four retro arcade games.
- **Updates itself, the easy way.** Like Discord: a little updater window at every start checks for a new version, downloads just the app (a few MB) with a progress bar and opens HomeCable on it — no reinstalling. While it runs, updates download quietly and a **Restart to update** button switches over in seconds. Windows' Installed apps shows the new version, and a version that won't start is rolled back by itself.

## Screens

| | | |
|---|---|---|
| ![Movies On Demand](docs/media/screenshots/05-movies-on-demand.jpg) | ![Show page](docs/media/screenshots/06-show-page.jpg) | ![Guide](docs/media/screenshots/02-guide.jpg) |
| ![Free TV stations](docs/media/screenshots/12-free-tv-manager.jpg) | ![Channel Manager](docs/media/screenshots/10-channel-manager.jpg) | ![Network logos](docs/media/screenshots/11-network-logos.jpg) |
| ![Wacky ad](docs/media/screenshots/09-wacky-ad.jpg) | ![Setup: what it found](docs/media/screenshots/23-setup-found.jpg) | ![Phone app](docs/media/screenshots/15-phone-app.jpg) |

## Install

1. Download `HomeCable-Setup-<version>.exe` from [Releases](https://github.com/OrionVW42/homecable/releases/latest) and run it. The installer asks you to agree to the fair-use terms — it won't install without them.
2. On first launch pick **Set it all up for me** — HomeCable finds your media, builds channels, adds free TV and shows you around. Or **I'll do it myself** and place everything by hand.
3. From then on HomeCable **updates itself**: each start, the updater window checks these Releases and swaps in the new version in a few seconds (or press **Restart to update** while it's running) — channels, people and settings are always kept. (Running a newer installer by hand works too.)

> **Note:** the installer is not code-signed yet, so Windows SmartScreen may warn on first run — *More info → Run anyway*. Code signing is on the roadmap.

**Phones:** Settings → Phone app → pair with the QR code. Requirements: Windows 10/11 64-bit; Android 8+ for the companion APK.

## Platforms

| Platform | Status |
|---|---|
| Windows 10/11 (x64) | ✅ Full app |
| Android phone / tablet | ✅ Companion APK (pairs to your PC) |
| Chromecast / Google TV | ✅ Casting |
| Fire TV / Android TV | 🔜 Roadmap |
| iOS | 🔮 Future |

## Roadmap

- **Fire TV / Android TV app** — D-pad-first, paired to the PC like phones.
- **Phone APK updates served from the paired PC.**
- **Code signing** — no more SmartScreen warning.
- **iOS** — future; not started.

## Remote

Works with the keyboard, the mouse, and Xbox or PS5 controllers (Bluetooth or USB). A strip at the bottom shows the buttons for whatever you used last; **Settings → Controls** has the full map for each.

| | Keyboard | Xbox | PS5 |
|---|---|---|---|
| Channel down / up | ↓ ↑ | LB / RB | L1 / R1 |
| Rewind / fast-forward | , . | LT / RT | L2 / R2 |
| Pause | Space | X | □ |
| Mute | M | B | ○ |
| Volume | ← → | D-pad ↓ ↑ | D-pad ↓ ↑ |
| Brightness | [ ] | D-pad ← → | D-pad ← → |
| Guide | G | Menu | Options |
| What's on | I | A | ✕ |
| Menus | C · L · S | Y | △ |
| Fullscreen | F (Esc leaves) | View | Create |
| Picture size | Z | R3 | R3 |
| Previous channel | Backspace | L3 | L3 |
| Arcade | A | Y → Arcade tab | △ → Arcade tab |

## Build from source

```
npm install
npm start        # run from source
npm test         # unit tests
npm run dist     # build dist/HomeCable-Setup-<version>.exe
```

End-to-end tests drive the real app with Playwright — see the repo's test files. Settings, channels and the library live in `%APPDATA%\HomeCable\` (kept across reinstalls).

## Privacy

No accounts, no telemetry, no tracking. HomeCable only goes online for optional features (show info by title, free TV, guides, hosted ad packs), and nothing is ever opened to the public internet — away from home it works only through a VPN you run yourself. [NOTICES.md](NOTICES.md) lists exactly what it contacts and every bundled license.

## Contributing

Issues, ideas and pull requests welcome. If you build something fun — an ad pack, a great channel look, a theme of channels — share it in Discussions.

## Thanks

HomeCable's free live TV is built on [**iptv-org**](https://github.com/iptv-org/iptv) — a community-run, always-updating index of thousands of publicly available IPTV stations, kept alive by its maintainers and hundreds of contributors. Thank you for keeping free TV free. Thanks also to the free public XMLTV guide sources ([epg.pw](https://epg.pw), [i.mjh.nz](https://i.mjh.nz)), the [Internet Archive](https://archive.org) for the public-domain classics, and [TVmaze](https://www.tvmaze.com) & [Wikipedia](https://www.wikipedia.org) for show & movie info.

## License & fair use

MIT — see [LICENSE](LICENSE). HomeCable hosts, provides, sells and endorses no media. You are solely responsible for the content you play and for having the right to play it; the app is **not** intended for piracy or any unlawful use, and installing it means agreeing to that. Provided "as is", without warranty. Bundled third-party components (FFmpeg under GPL v3, Electron, whisper.cpp and others) keep their own licenses — see [NOTICES.md](NOTICES.md).

### Demo footage

The videos and screenshots use only free, open-licensed films: *Tears of Steel*, *Cosmos Laundromat*, *Spring*, *Sprite Fright*, *Agent 327: Operation Barbershop*, *Coffee Run*, *Charge*, *Sintel*, *Big Buck Bunny* and *Caminandes* — © Blender Foundation / Blender Studio, [CC BY](https://creativecommons.org/licenses/by/4.0/) ([studio.blender.org](https://studio.blender.org/films/)). Live stations shown are the official free streams of NASA, DW, France 24, Al Jazeera and Euronews.
