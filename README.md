# Gem Sort

**Spotify-reported play counts and primary-artist Top 10 ranks, directly in
Spicetify playlist rows.**

Gem Sort adds one focused **Plays · Top 10** column to playlist-style
tracklists. It prefers the space used by Album, leaves album and artist pages
alone, and keeps the rest of Spotify's layout familiar.

| Title | Plays · Top 10 | Date added | Length |
| --- | ---: | --- | ---: |
| Example track | `385,244,129 · #1` | Jul 20, 2026 | 3:42 |

## Features

- Shows the full, locale-formatted play count returned by Spotify—no `1.2M`
  abbreviation.
- Shows `#1`–`#10` when the track appears in the first-listed artist's Top 10,
  and `—` when it does not or the data is unavailable.
- Recognizes Spotify's relinked and reissued copies without a relink database:
  exact track IDs take priority, followed by a unique same-title,
  near-identical-duration match within that artist's Top 10.
- Sorts the complete playlist view numerically by Plays or Top 10 rank without
  rewriting the playlist.
- Fetches missing play counts for a large sort in bulk and retrieves the
  remaining playlist pages concurrently instead of waiting for visible-row
  batches.
- Keeps ties in Spotify's original order and places unavailable values last.
- Starts new playback from an active sorted view with Shuffle off, so Next and
  Previous follow the displayed sort.
- Keeps native drag-out behavior for adding tracks to another playlist while
  blocking reordering drops inside the temporarily sorted source playlist.
- Retains Date added when the playlist has meaningful dates, but hides the
  empty field on radio, mixes, and other generated playlist views.
- Batches visible play-count lookups, deduplicates artist lookups, and reuses
  in-memory results within defined windows. No API key, Spotify developer app,
  or third-party service is required.

## Supported views

| Spotify view | Counts and ranks | Plays / Top 10 sorting | Layout |
| --- | :---: | :---: | --- |
| Playlist URLs | Yes | Yes | Replaces Album when detected; otherwise replaces native Plays or inserts a column |
| Radio, mixes, and generated playlist URLs | Yes* | Yes* | Hides Date added when the returned list has no meaningful dates |
| Liked Songs | Yes | No | Sorting is disabled on the current Spotify implementation |
| Album, artist, search, and other tracklists | Unchanged | — | Gem Sort does not modify these routes |

\* Spotify must expose the playlist grid and list loader that Gem Sort
expects. These are private interfaces and can change between Spotify releases.

## Sorting

Click either half of the column header:

- **Plays:** highest to lowest → lowest to highest → Spotify order
- **Top 10:** `#1` to `#10` → `#10` to `#1` → Spotify order

This is a temporary **view sort**. It loads and holds the current playlist
result in memory, then serves that result back to Spotify in sorted order. It
does not edit or rewrite the playlist.

To build that result, Gem Sort reuses the page Spotify has already loaded
and requests missing pages with limited concurrency. A Plays sort asks
Spotify's MetadataService for uncached counts in bulk before using album and
track GraphQL fallbacks. A Top 10 sort deduplicates primary artists and limits
the number of artist requests running at once.

While the sort is active:

- Dragging tracks to another playlist in the sidebar remains available.
  Dropping tracks back into the sorted source grid is blocked because that
  would make the temporary view order ambiguous.
- Starting playback from the playlist hands Spotify a temporary in-memory
  context containing the displayed order and starts that context with Shuffle
  off. Next and Previous then follow the sort; Spotify's manual queue can still
  take precedence, and Shuffle can be turned on again afterward.
- Sorting alone does not alter current playback. Clearing or changing the view
  sort does not interrupt a playback context that has already started.

An active sort clears when you click the active metric a third time, use a
native column sort, filter the playlist, navigate away, or the playlist
changes.

Clearing or navigating away invalidates the loading operation, prevents queued
requests from being issued, and prevents late results from being installed.
Capture, playlist-page, and metric requests are time-limited. Spotify's private
interfaces do not expose a transport abort here, however, so a request already
sent may still finish internally after Gem Sort has stopped waiting for it.

## Installation

Gem Sort is not yet listed in Spicetify Marketplace.

### Requirements

- macOS
- The Spotify desktop app in its standard `/Applications` location
- [Spicetify](https://spicetify.app/docs/getting-started) available on your
  `PATH` or installed at `~/.spicetify/spicetify`

Live-tested on macOS 26.5.1 with Spotify 1.2.94.583 and Spicetify 2.44.0 on
July 28, 2026. Private Spotify interfaces make this a compatibility snapshot,
not a guarantee for later releases.

### Quick install

Download or clone this repository, open Terminal in its directory, and run:

```sh
./install.sh
```

The installer copies `gem-sort.js` into the Extensions directory reported
by Spicetify, enables it, reapplies Spicetify, and restarts Spotify. It uses an
existing configured backup when one is present and creates a backup on the
first run. It overwrites an existing extension file with the same name and
removes the legacy `stream-rank.js` installation when upgrading from the
pre-release name.

### Manual install

```sh
mkdir -p ~/.config/spicetify/Extensions
cp gem-sort.js ~/.config/spicetify/Extensions/gem-sort.js
spicetify config extensions gem-sort.js
spicetify apply
```

Spicetify documents the standard extension locations and commands in its
[Extensions guide](https://spicetify.app/docs/customization/extensions).
If Spicetify is not on your `PATH`, substitute
`~/.spicetify/spicetify` for `spicetify` in the commands above and below.

### After a Spotify update

Spotify updates can replace Spicetify's changes. Reapply them with:

```sh
spicetify backup apply
```

If Spicetify also needs updating:

```sh
spicetify update
spicetify restore backup apply
```

## Data and privacy

Gem Sort uses the Spotify desktop client's existing logged-in session to
request data from Spotify's internal MetadataService and GraphQL interfaces.
It does not collect credentials, add analytics, or send data to a third-party
service.

The metric result caches are session-only: they are held in Spotify's process
and disappear when Spotify reloads or closes. Entries use the reuse windows
and hard count limits below:

| Cached data | Reuse window | Maximum entries |
| --- | ---: | ---: |
| Track play counts | 1 hour | 20,000 |
| Artist Top 10 results | 30 minutes | 5,000 |
| Album fallback results | 6 hours | 5,000 |
| Failed or unavailable lookups | 2 minutes | Uses the relevant cache limit |

An active sort also retains one complete playlist result and its loaded
metrics until the sort is cleared. Large playlists can therefore use more
temporary memory and take longer to sort. Nothing is written to a database,
`localStorage`, IndexedDB, or a cache file, so cache data does not accumulate
on disk between sessions.

When playback is started from a sorted view, Spotify may also retain a
temporary page containing that sorted track order for the playback context.
Spotify controls that context's lifetime; Gem Sort never persists it.

Expiry is touch-based rather than swept in the background: an expired entry is
removed when that key is requested again. Each cache also evicts the
least-recently-used entries when its count limit is reached, so stale entries
can remain during a session but cannot make those maps grow without bound.
Clearing a sort releases its playlist snapshot, but does not clear the shared
metric caches.

Gem Sort writes failure diagnostics to the Spotify DevTools console. Those
messages may include Spotify track, album, or artist URIs. Its remembered
diagnostic-key set is capped at 200 entries.

## Limitations and compatibility

- Gem Sort depends on private Spotify data and UI interfaces exposed through
  Spicetify. Spotify can change them without notice.
- “Full play count” means the unabridged integer returned by Spotify; Gem Sort
  cannot independently audit Spotify's counting semantics.
- Top 10 rank is based on the first-listed artist and the order returned to the
  current logged-in Spotify client.
- `—` can mean not in the artist's returned Top 10, a local file, or data that
  is missing or temporarily unavailable. Hover the cell for more detail.
- Sorting Liked Songs is intentionally disabled because its current list
  loader cannot be safely view-sorted.
- Playlist capture and follow-up page requests are time-limited. Clearing a
  loading sort or receiving a playlist update prevents its result from being
  installed, but Spotify's underlying private request may still finish because
  it cannot be transport-aborted here.
- Sorted playback depends on Spotify's private page-backed context interface.
  Turning Shuffle back on, manually queued tracks, or a later playback action
  can intentionally change what plays next.
- Other extensions that replace tracklist columns, wrap playlist loaders, or
  wrap `PlayerAPI.play` may conflict with Gem Sort.
- The included installer targets macOS. Other desktop platforms have not been
  tested.

## Disable or remove

Disable the extension and reapply Spicetify:

```sh
spicetify config extensions gem-sort.js-
spicetify apply
```

This leaves the copied `gem-sort.js` file in Spicetify's Extensions
directory. Delete that file separately if you want to remove it completely.

To restore the unmodified Spotify client instead:

```sh
spicetify restore
```

## Development

The shipped extension is dependency-free. Its Node test suite covers exported
helpers for number decoding and formatting, playlist template transforms,
stable metric ordering, pagination-range construction, response parsing,
concurrency limiting, conservative relink matching, playback-context shaping,
URI handling, API method-owner lookup, and route eligibility.

```sh
npm test
npm run check
```

These checks do not simulate Spotify's live list loader, player hook, DOM
lifecycle, network cancellation, or private event interfaces, and they do not
guarantee compatibility with a future Spotify release. In Spotify DevTools,
`window.__spotifyGemSort.getStatus()` exposes runtime diagnostics.

## Credits

Parts of the MetadataService discovery and protobuf play-count decoding are
adapted from [Sort-Play](https://github.com/hoeci/sort-play) under the MIT
License. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

[Sort-Play](https://github.com/hoeci/sort-play) also provides play-count
columns and sorting as part of a broader Spotify toolkit. Gem Sort is
deliberately narrower: one combined playlist column, primary-artist Top 10
rank, playlist-aware layout, and temporary view sorting.

## License

[MIT](LICENSE) © 2026 Gem Sort contributors.

Gem Sort is an unofficial community extension and is not affiliated with,
maintained by, or endorsed by Spotify.
