# dsh-netease-float

English | [简体中文](README.md)

A **full-page NetEase Cloud Music player** plugin for DeepSeek Harness. Click "闊充箰" (Music) in the sidebar to open a dedicated page where you can play, read lyrics, browse playlists, search and sign in 鈥?no floating mini window taking over your workspace.

> Reworked from [stardream-1/dsh-netease-float](https://github.com/stardream-1/dsh-netease-float) (MIT), whose floating-window UI is replaced by a full-page layout. Its wallpaper/scene support is kept.

## About

Most NetEase plugins for DSH are floating mini windows: you can only watch the current track, and playlists, search and sign-in take you back to the host UI. This plugin moves the whole app into a dedicated page 鈥?click "闊充箰" in the sidebar and you get now-playing, full-screen lyrics, your playlists, playlist details and search on one page, with a single search box on top and no nested left navigation. The player lives with the page, so switching views never interrupts playback.

Data comes straight from NetEase's web endpoints (including the eapi-encrypted SMS login). After resolving a playback URL the plugin probes the file header first; when a CDN node answers 403 it retries with other nodes instead of handing the error to the user.

## Features

- **Full-page player**: one sidebar entry, opened as a page instead of a floating window
- **Now playing**: cover-driven accent color, layered title/artist, seekable progress bar, volume, three-state loop, shuffle, previous/next
- **Full-screen lyrics**: click the lyrics area to enter; current line highlighted, neighbours faded; translation supported
- **My playlists**: grid of account playlists; open one to see details and queue the whole list
- **Search**: Songs / Playlists tabs; playlists open in place
- **Per-row menu**: `鈰痐 鈫?"Play next" / "Add to queue"
- **Settings** (host Settings 鈫?Music): account, playback, lyrics, appearance

## Account & sign-in

Four ways, all under **Settings 鈫?Music 鈫?Account**:

| Method | Notes |
|---|---|
| Phone + SMS code | Phone number + SMS code (eapi endpoints); unregistered numbers get a new account |
| QR code | Scan with the NetEase app; the server may reject it with 8821 (platform risk control) |
| Paste cookie | Paste `MUSIC_U=...; __csrf=...` copied from a browser or client |
| Read from local client | Decrypts the local NetEase client's login state (v10 AES-GCM). **Playback only** 鈥?it cannot read account profile or full playlists |

Credentials are stored locally in `~/.dsh/netease-float.json` and never uploaded; logging out clears them.

> Free tracks play without signing in. VIP/paid tracks need a valid login.

## Install

**Plugin panel**

1. Clone this repository anywhere on disk
2. Settings 鈫?Plugins 鈫?Add plugin, point it at that directory
3. Fully quit and reopen DSH

**Manual**

In `~/.dsh/profiles/desktop/package.json`:

```json
{
  "dependencies": {
    "dsh-netease-float": "file:<plugin-dir>"
  },
  "dsh": { "profile": { "bundles": [
    "...",
    "dsh-netease-float"
  ] } }
}
```

Use an absolute path for `file:`; on Windows write it as `file:D:/plugins/dsh-netease-float`. Run `pnpm install` in that directory, then restart DSH.

## FAQ

**Nothing happens / "鏃犳硶鎾斁" on play**: check whether the track is VIP-only (needs login); if a URL was resolved but the CDN returns 403, the plugin automatically retries with other nodes (`m801`, `m701`, 鈥?.

**Playlists are empty**: the local-client login state only grants playback; the server treats it as an anonymous user (uid=0) and returns empty playlists. Sign in properly to see them.

**QR login stays on "scanned"**: NetEase applies risk control to QR login (8821). Use the SMS code or paste a cookie instead.

## Notes & license

- MIT, see `LICENSE`; reworked from stardream-1/dsh-netease-float.
- Scene wallpapers are rendered in real time by [WebWallGL](https://github.com/oneincase/webwallgl) from the layers, particles and effects inside `.pkg` files, mounted with `scripts: false` (wallpaper scripts are never executed).
- `.pkg` parsing is adapted from [elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine). Third-party notices: `lib/vendor/NOTICE.md`.
