# Source Gateway · YesPlayMusic

English · [简体中文](README.zh-CN.md)

A community plugin for [YesPlayMusic](https://github.com/qier222/YesPlayMusic) **3.0.0 or newer**. Not an official plugin.

It keeps the **catalog** and the **audio sources** separate. The catalog (search, home, artists, albums, playlists, lyrics) comes from NetEase Cloud Music's anonymous endpoints and needs **no sign-in**. The audio source (the playback direct link) is resolved by a gateway inside the plugin from several third-party sources; every candidate is verified before playback, and failures fall back to the next source. The plugin does not sign in, store credentials, download audio, or redistribute it.

## Features

- **NetEase catalog without signing in**: track, album, artist and playlist search with paging, search suggestions and hot searches; recommended playlists and new songs on the home page; charts, new albums and popular playlists by category; album, artist and playlist details; original and translated LRC lyrics.
- **Multi-source gateway**: GDStudio and Kuwo sources are tried in order; a failure switches to the next one automatically.
- **Pre-playback availability check**: candidate direct links are probed before they reach the player, so expired or broken URLs are not handed over.
- **Circuit breaker and caching**: repeated failures cool down and recover on success; a track that just failed is not retried immediately.
- **"Source gateway" sidebar page**: shows per-source sample self-test results and the current fallback order.
- **Track context menu** (shown only for tracks from this plugin): copy the source direct link or check source availability.
- **Local playlists without sign-in**: use **Add to playlist → New playlist** in a track's context menu; playlists and track snapshots are stored in the plugin data directory and survive restarts, and tracks can be removed. Rename, drag-to-reorder and delete-playlist are exported through the plugin API; whether the player shows those entries depends on its version.
- **Hearts and Liked Songs**: clicking the heart button in the player adds the track to the fixed **Liked Songs** playlist, and clicking it again removes it; the state is stored in the plugin data directory and survives restarts.
- **Saved playlists**: while browsing a NetEase playlist, right-click a **song in that playlist**; the menu shows **Save playlist: playlist name** (or **Unsave playlist: playlist name** when already saved). Saving stores only a snapshot of the playlist's basic information in the plugin data directory — no sign-in, no account sync. Saved playlists appear on the **Playlists** page after user-created playlists, marked as saved, up to 500, and do not count toward the 100 user-created playlist limit.
- **Nine interface languages**: follows the YesPlayMusic interface language.
- **No sign-in entry point**: the plugin does not export `account`, `signIn`, `signOut` or other account-bound features, and offers no membership, purchase or download capability.

## Installation

YesPlayMusic **3.0.0 or newer** is required. The plugin runs in the app's built-in QuickJS engine; no Node.js, server, API key or extra program is needed.

- **Option 1 (recommended)**: open **Settings → Plugins → Install from local folder…** and select the plugin folder that contains `plugin.json`. If you downloaded a ZIP, extract it first; do not select only the `plugin.json` file.
- **Option 2**: open **Settings → Plugins → Install plugin** and paste `github.com/WooLeo1995/ypm-plugin-switch`; the app installs the `.zip` from the latest Release. Release tag (`.../releases/tag/v0.4.1`), ZIP and `plugin.json` links also work; see the [plugin development guide](https://github.com/qier222/YesPlayMusic/blob/main/docs/plugins.md).

Before installation the app lists the network permissions the plugin needs (NetEase eapi, GDStudio, NetEase CDN, Kuwo search / Bodian / mobile / CDN). After confirming and enabling it, choose **Source gateway** under **Settings → Plugins → Music source**, or click the avatar at the bottom-left of the sidebar.

## Usage

1. After selecting the "Source gateway" music source, search, home, album, artist and NetEase playlist contents come from the NetEase catalog; the **Playlists** page of the music library also lists local playlists, Liked Songs and saved playlists.
2. Double-click a track to play it. The gateway first fills in the title, artists and duration through the anonymous API, then asks the sources for direct links in order; only a link that passes probing is returned to the player.
3. The **Source gateway** sidebar page shows each source's self-test result and the current fallback order.
4. In the track context menu, **Copy source direct link** resolves and copies a currently usable link; **Check source availability** tries immediately and reports the result.

### Local playlists

Local playlists need no sign-in and are not synced to a NetEase account:

1. In a track's context menu choose **Add to playlist**, then **New playlist**, and enter a name to create a playlist containing that track. Tracks can also be added to an existing local playlist.
2. Local playlists appear on the **Playlists** page of the music library. Open one to play it, or remove tracks from it.
3. Playback still goes through the source gateway: a local playlist stores only metadata snapshots, never audio, so whether a track plays depends on whether a source offers a playable direct link.
4. Rename, drag-to-reorder and delete-playlist are exported by the plugin; whether their interface entries appear depends on the player version. The YesPlayMusic 3.0.0 interface currently offers creating a playlist, adding tracks and removing tracks from a playlist.

### Saved playlists

Saved playlists keep NetEase playlists without signing in, and they are not synced to a NetEase account:

1. Open a NetEase playlist and right-click a **track inside that playlist**; the menu shows **Save playlist: playlist name**, or **Unsave playlist: playlist name** when already saved. Click it to save or unsave. The YesPlayMusic 3.0.0 "other people's playlists" page does not pass the playlist ID to the context menu, so the plugin remembers the most recently opened NetEase playlists and their tracks and only shows this entry on tracks that belong to one of them; opening a local playlist or Liked Songs clears this context, so the entry does not appear there. If the host does pass the playlist ID directly, the menu may show the plain **Save playlist / Unsave playlist** entries without the name.
2. Saved playlists appear on the **Playlists** page of the music library after user-created playlists and are marked as saved. Open one to browse and play it like a normal NetEase playlist; playback still goes through the source gateway.
3. Saving keeps only a basic snapshot (name, cover, creator, track count and saved time), not the full track list or audio. When you open a saved playlist, its contents are still read from the anonymous NetEase API.
4. Up to 500 playlists can be saved; this count is separate and does not use the 100 user-created playlist limit. Local playlists and Liked Songs cannot be saved.

### Likes

- Click the heart button in the player to add the current track to **Liked Songs**; click it again to unlike. The plugin stores the like state, which survives app restarts.
- **Liked Songs** is a fixed playlist shown first on the **Playlists** page of the music library and cannot be renamed or deleted. It can be opened and played like a normal playlist, and tracks can be removed from it — removing a track unlikes it.
- The sidebar gains a **Liked Songs** entry; the label is provided by YesPlayMusic and follows its interface language.
- Like local playlists, Liked Songs keeps only metadata snapshots in the plugin data directory: no sign-in, no NetEase account sync, no audio. Playback still goes through the source gateway and depends on whether a source has a playable link.

The catalog and the sources are independent layers: a track being in the catalog does not mean a third-party source has its rights or a matching resource. If no enabled source can provide a playable link, the plugin reports "No playable source is available. Try again later." and the player skips the track. That is expected behavior, not a bug.

## Sources and fallback order

A "source" here is a third-party provider of audio direct links; the catalog does not come from these sources.

Default order:

1. **GDStudio** (by NetEase track ID)
2. **Kuwo** (Bodian `audioUrl` endpoint)
3. **Kuwo mobile** (mobile `convert_url2` endpoint)
4. **GDStudio Search** (keyword search with strict matching)

ID-based links are the fastest and hit most often; the two Kuwo routes complement each other; keyword search comes last because it must match the version, artists and duration and is slower and easier to get wrong. The keyword routes only accept a result when the title, version qualifier and artists match and, when both durations are known, differ by no more than 8 seconds; they would rather return nothing than mistake an instrumental, DJ edit or cover for the original.

- **Preferred source** set to "Prefer GDStudio" puts the two GDStudio routes before Kuwo; "Prefer Kuwo" tries Kuwo first; "Automatic" uses the default order above.
- **Disable GDStudio source** or **Disable Kuwo source** removes that whole family from the attempt list. Disabling both makes playback fail with a request to enable at least one source in settings.
- A playback attempt has a total budget of about 22 seconds; requests inside a source tighten their timeouts according to the remaining budget.

Failures and fallback:

- No match in a source (an empty result) is a soft failure: the next source is tried and no cooldown is recorded.
- Network errors, timeouts, 5xx / 429, unparsable responses, or a returned link that fails probing are hard failures: they count toward that source's circuit breaker and the next source is tried.
- Ordinary 4xx responses (for example an endpoint that does not support the request) are treated as soft failures.
- If every source fails, a 45-second failure cache is recorded; for the same track and quality the plugin reports "No playable source is available. Try again later." without hitting the upstream services again during that window.

## Pre-playback verification and circuit breaker

- **Probing**: a `HEAD` request is preferred. A 2xx with an audio/video/`application/octet-stream` content type, or with a `Content-Length`, counts as playable; an HTML, JSON or XML error page counts as expired (expired signatures often look like that). If `HEAD` is rejected (403 / 405 / 501) or fails at the network level, a one-byte `Range: bytes=0-0` `GET` is used to confirm once more. A 2xx with no type or length information is also trusted, to avoid rejecting a healthy CDN. 4xx / 5xx, timeouts and network errors are all unavailable.
- **Direct-link cache**: a resolved link is reused from memory for up to 10 minutes; links verified less than 2 minutes ago are returned directly, older ones are probed again and discarded if they fail.
- **Circuit breaker**: consecutive hard failure 1 / 2 / 3 puts the source on cooldown for 30 seconds / 2 minutes / 10 minutes; one success resets it. Health state is stored in the plugin data directory and survives an app restart.
- **Skip pre-playback verification** (setting): off by default. When on, links are returned without probing, so stale links may reach the player. Use it only temporarily for troubleshooting.
- **Self-test does not write the circuit breaker**: the sidebar self-test is read-only and does not affect the ordering used for normal playback.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Quality | Follow player | "Standard (128k)", "High (320k)" or "Lossless (FLAC when available)". The setting takes precedence over the quality passed by the player; what you actually get depends on the source, and it may fall back to a lower tier. |
| Preferred source | Automatic | "Automatic", "Prefer GDStudio" or "Prefer Kuwo". Only reorders source families; it does not guarantee a source works. |
| Skip pre-playback verification | Off | Skips link probing when on; stale links may be returned. |
| Disable GDStudio source | Off | When on, only Kuwo sources are used. |
| Disable Kuwo source | Off | When on, only GDStudio sources are used. |

Boolean settings are off until changed. Both source families can be disabled, but then playback cannot work and the plugin asks you to enable at least one. Lossless FLAC is available only when a source actually returns FLAC: for lossless, GDStudio asks for FLAC first and falls back to 320k MP3; the Kuwo routes request MP3 only, so 320k is usually their ceiling.

## Source gateway self-test page

The **Source gateway** page in the sidebar contains two sections:

- **Source self-test**: for every enabled source, one fixed sample track is resolved end to end and the returned direct link is probed. Different sources use different samples (the GDStudio and Kuwo routes do not share the same sample), so a copyright change at one catalog does not make "sample not found" look like "endpoint broken". Entering the page again runs the checks again; each result includes availability, elapsed time and the reason. If a keyword source is reachable but the sample track is not found, it is marked available with "Endpoint reachable; sample track not found" — that means the route itself works, not that playback failed.
- **Fallback order**: the order in which the gateway tries sources under the current settings, numbered from 1.

The "Test connection" button in the plugin settings (available in YesPlayMusic 3.1.0+) runs the same self-test: it reports the number of available sources when all pass, the number of unavailable ones on failure, and asks you to enable a source when none is enabled.

The self-test uses fixed sample tracks only. Passing it does not mean every track can play; conversely, one failing route does not mean the other sources are unavailable.

## FAQ

**A track keeps saying "No playable source is available. Try again later."**
Every enabled source lacks a playable resource for that track, or all returned links are stale. Common causes are that a third-party source has no rights for the track, only covers or instrumentals (which strict matching rejects), or is temporarily rate-limiting. This is expected: the plugin never substitutes a preview clip or a cover for the original, and it does not attempt to bypass official authentication. Try again later.

**Nothing plays at all?**
Open the **Source gateway** page and check the self-test results. Make sure the network can reach the required domains and that a proxy, if any, applies to plugin requests. Also check that you did not disable both GDStudio and Kuwo in settings. Third-party endpoints occasionally fluctuate; retry later.

**Why is "Lossless" not FLAC?**
Quality is a request preference, not a guarantee. Whether lossless is available depends on the track, the rights and the upstream policy; the Kuwo routes request MP3 only. The plugin tries the best available tier and never substitutes a preview clip for the full track.

**Do I need to sign in? Can membership tracks be unlocked?**
No sign-in is needed. The plugin does not integrate with any account system and has no membership, purchase or download features. Playback depends only on whether a third-party source has a matching direct link; many tracks that require membership in the official app can play when a source has the resource, and when none does the plugin says so clearly. The plugin itself does not bypass authentication; whether a track plays depends entirely on whether a third-party source offers a playable direct link for it.

**What does "Endpoint reachable; sample track not found" mean in the self-test?**
The keyword source can search normally but did not match the sample in its own catalog, so the route is reachable and is shown as available. Actual playback still depends on whether a specific track has a playable resource.

**Does the plugin download or cache audio?**
No. Audio is requested by the YesPlayMusic player directly from the CDN URL returned by the source. The plugin only performs availability probes on candidate links and caches links, metadata and health state — never audio files.

**Are local playlists synced to my NetEase account?**
No. They live only in the plugin data directory on this machine; no sign-in is needed and nothing is uploaded. A local playlist stores metadata snapshots only, not audio, so whether a track plays still depends on the sources. Uninstalling the plugin or clearing its data removes the playlists, so do not use them as a cloud backup.

**Can Liked Songs be renamed or deleted?**
No. It is a fixed playlist shown first on the **Playlists** page, but it can be opened and played, and tracks can be removed from it — removing a track unlikes it. Like local playlists, it is stored only on this machine, with no sign-in and no account sync.

**Are saved playlists synced to my NetEase account?**
No. Saving stores only a basic playlist snapshot in the plugin data directory; no sign-in is needed and nothing is uploaded. When you open a saved playlist, its tracks are still read from the anonymous NetEase API. Up to 500 playlists can be saved, separately from the user-created playlist limit.

## Privacy and compliance

- **No sign-in**: no account credentials, cookies, tokens or passwords are requested or stored; catalog requests use the anonymous eapi.
- **Pre-playback probing**: only a lightweight probe is sent to a candidate link (`HEAD`, or a one-byte `Range GET` when needed); the full audio is never read.
- **Minimal network access**: the plugin only contacts the domains declared in `plugin.json` (NetEase eapi, GDStudio, NetEase CDN, Kuwo search / Bodian / mobile / CDN).
- **No downloads, no audio redistribution**: the plugin resolves links and probes their availability; playback is done by the host player. It bundles, caches and redistributes no audio files.
- **Local playlists and Liked Songs**: playlist names, track metadata snapshots and timestamps are stored only in `host.storage` inside the plugin data directory; they are not uploaded and are not tied to a NetEase account. Limits: at most 100 user-created playlists plus one fixed Liked Songs playlist, 2000 tracks per playlist, and about 6 MB of data. No audio is stored; playback is still resolved by the source gateway.
- **Saved playlists**: saving stores only the playlist card's basic information (name, cover, creator, track count and saved time) in `host.storage` inside the plugin data directory; it does not sign in, upload, sync to a NetEase account, or store the track list or audio. Opening a saved playlist still reads its contents from the anonymous NetEase API. Up to 500 playlists can be saved, counted separately from the 100 user-created playlist limit.
- **Local data**: the plugin data directory stores only a randomly generated device identifier, source health state and local, liked and saved playlist data; direct-link and failure caches live in memory and disappear when the app exits.
- **Third-party services**: requests reach the endpoints above, which may log request information under their own terms and privacy policies. Follow the applicable terms of service and local law. Catalog metadata and audio remain the property of their respective rights holders.

## Development

See [ARCHITECTURE.md](ARCHITECTURE.md) for the layout: `index.js` is the host entry, `catalog/` is the anonymous catalog, `gateway/` is the source gateway, `stream.js` fills in track metadata before playback, and copy lives in `i18n.js` and `locales/`.

Offline tests never touch the real network; they use a mock host and a programmable `fetch` (Node.js 22+):

```sh
node --experimental-vm-modules --test test/*.test.mjs
```

To verify real endpoints, run the live smoke script manually. It contacts third-party services, depends on your network, and never prints full signed direct links:

```sh
node scripts/live-check.mjs            # live smoke test
node scripts/live-check.mjs --verbose  # also print plugin logs
```

The script first checks that the `plugin.json` network permissions cover every host requested at runtime, then exercises search, all three quality tiers, an unavailable track, direct-link caching and the self-test. It exits with code 0 when everything passes.

The plugin API follows the [YesPlayMusic plugin development guide](https://github.com/qier222/YesPlayMusic/blob/main/docs/plugins.md). When changing copy, update all nine locales under `locales/` and run the localization test.

## License and acknowledgements

Released under the [MIT License](LICENSE). Source resolution logic is ported from `src/unblock.js` in [TIMER-err/qplayer-netease-plugin](https://github.com/TIMER-err/qplayer-netease-plugin) and [TIMER-err/qplayer-qqmusic-plugin](https://github.com/TIMER-err/qplayer-qqmusic-plugin) (MIT). The catalog API conventions and plugin engineering structure only reference [lymzzyh/ypm-plugin-netease](https://github.com/lymzzyh/ypm-plugin-netease) and [lymzzyh/ypm-plugin-qqmusic](https://github.com/lymzzyh/ypm-plugin-qqmusic) (MIT); none of their code was copied. Full copyright notices and trademark attribution are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

NetEase Cloud Music, QQ Music, Kuwo Music, GDStudio and YesPlayMusic names and logos belong to their respective owners. This is an independent community project, not affiliated with, endorsed by or sponsored by any of them, and it distributes no audio or credentials.
