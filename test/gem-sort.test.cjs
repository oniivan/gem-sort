"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
  buildFallbackTemplate,
  buildMetricRecords,
  buildMissingRanges,
  buildPlaylistTemplate,
  buildSortedPlaybackContext,
  buildTopTrackIndex,
  buildTopTrackMap,
  createLimiter,
  extractTrackCounts,
  extractTrackInfoFromProps,
  findColumnTypeIndex,
  findCurrentTrackIndex,
  findMethodOwner,
  findTopTrackRecord,
  fingerprintQueryOptions,
  formatPlayCount,
  getArtistSortConcurrency,
  getCapturedPageOffset,
  getPlaybackContextUri,
  getPlayerContextUri,
  insertTemplateColumn,
  isGemSortPlaybackContext,
  isPlaylistPath,
  nextMetricSortState,
  normalizeTrackName,
  parseVarint,
  preferPlayCount,
  pruneTimedCache,
  removeNamedTemplateTrack,
  remapSortedPlaybackOptions,
  selectMetricRecordValues,
  sortMetricRecords,
  spotifyUriFromHref,
  stripTemplateColumn,
  toDurationMs,
  toPlayCount,
} = require("../gem-sort.js");

test("runtime dataset keys match the Gem Sort CSS attribute namespace", () => {
  const source = fs.readFileSync(require.resolve("../gem-sort.js"), "utf8");

  assert.doesNotMatch(
    source,
    /dataset\.streamRank(?:Grid|HiddenColumn|SortActive|SortKey|TrackUri)/,
  );
  [
    "gemSortGrid",
    "gemSortCurrentTrack",
    "gemSortHiddenColumn",
    "gemSortSortActive",
    "gemSortSortKey",
    "gemSortTrackUri",
  ].forEach((key) => assert.match(source, new RegExp(`dataset\\.${key}`)));
  [
    "data-gem-sort-grid",
    "data-gem-sort-current-track",
    "data-gem-sort-hidden-column",
    "data-gem-sort-sort-key",
  ].forEach((attribute) => assert.match(source, new RegExp(attribute)));
});

test("the circular-card compatibility style cannot affect square artwork", () => {
  const source = fs.readFileSync(require.resolve("../gem-sort.js"), "utf8");

  assert.match(
    source,
    /\.main-cardImage-imageWrapper\.main-cardImage-circular\s*\{/,
  );
  assert.match(
    source,
    /\.main-cardImage-imageWrapper\.main-cardImage-circular\s*\{[^}]*background-color:\s*transparent\s*!important;/s,
  );
  assert.doesNotMatch(
    source,
    /(?<!\.)main-cardImage-imageWrapper\s*\{|\.main-cardImage-imageWrapper\s*\{/,
  );
});

function encodeTaggedVarint(value) {
  let remaining = BigInt(value);
  const bytes = [8];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
  return bytes;
}

test("parseVarint decodes protobuf counts beyond 32-bit integer range", () => {
  assert.equal(parseVarint(encodeTaggedVarint(42)), 42);
  assert.equal(parseVarint(encodeTaggedVarint(5_000_000_000)), 5_000_000_000);
});

test("play counts are normalized and formatted exactly", () => {
  assert.equal(toPlayCount("1234567"), 1_234_567);
  assert.equal(toPlayCount(-1), null);
  assert.equal(toPlayCount(""), null);
  assert.equal(formatPlayCount("1234567", "en-US"), "1,234,567");
  assert.equal(formatPlayCount(null), "—");
  assert.equal(preferPlayCount(1_234, null), 1_234);
  assert.equal(preferPlayCount(null, 5_678), 5_678);
  assert.equal(preferPlayCount(1_234, 5_678), 5_678);
});

test("playlist columns are identified by Spotify metadata, not position", () => {
  const standard = [
    "INDEX",
    "TITLE_AND_ARTIST",
    "ALBUM",
    "ADDED_AT",
    "DURATION",
  ];
  const collaborative = [
    "INDEX",
    "TITLE_AND_ARTIST",
    "ADDED_BY",
    "EVENT_DATE",
    "DURATION",
  ];

  assert.equal(findColumnTypeIndex(standard, ["ALBUM"]), 2);
  assert.equal(findColumnTypeIndex(standard, ["ADDED_AT", "DATE_ADDED"]), 3);
  assert.equal(findColumnTypeIndex(collaborative, ["ALBUM"]), -1);
  assert.equal(
    findColumnTypeIndex(collaborative, ["ADDED_AT", "DATE_ADDED"]),
    -1,
  );
});

test("the grid template insertion is idempotent and reversible", () => {
  const original =
    "[index] var(--index-column-width, 16px) [first] minmax(var(--first-min-width), 4fr) [var1] minmax(120px, 2fr) [last] minmax(120px, 1fr)";
  const inserted = insertTemplateColumn(original);

  assert.match(inserted, /\[streamRank\] 220px \[last\]/);
  assert.equal(insertTemplateColumn(inserted), inserted);
  assert.equal(stripTemplateColumn(inserted), original);
  assert.equal(
    stripTemplateColumn(
      original.replace(
        "[last]",
        "[streamRank] minmax(220px, 1.65fr) [last]",
      ),
    ),
    original,
  );
});

test("the playlist template replaces the Album track", () => {
  const original =
    "[index] 16px [first] minmax(180px, 4fr) [var1] minmax(120px, 2fr) [var2] minmax(120px, 2fr) [last] minmax(120px, 1fr)";
  const withoutAlbum = removeNamedTemplateTrack(original, "var1");
  const playlist = buildPlaylistTemplate(original, 2, 5);

  assert.doesNotMatch(withoutAlbum, /\[var1\]/);
  assert.match(withoutAlbum, /\[var2\]/);
  assert.doesNotMatch(playlist, /\[var1\]/);
  assert.match(playlist, /\[var2\]/);
  assert.match(playlist, /\[streamRank\] 220px/);
  assert.ok(playlist.indexOf("[streamRank]") < playlist.indexOf("[var2]"));
});

test("the playlist template right-packs metrics and Date added", () => {
  const original =
    "[index] var(--index-column-width, 16px) [first] minmax(var(--first-min-width), var(--first-max-width, 4fr)) [var1] minmax(var(--var1-min-width), var(--var1-max-width, 2fr)) [var2] minmax(var(--var2-min-width), var(--var2-max-width, 2fr)) [last] minmax(var(--last-min-width), var(--last-max-width, 1fr))";
  const playlist = buildPlaylistTemplate(original, 2, 5, [2], [3]);

  assert.match(playlist, /\[streamRank\] 220px/);
  assert.match(
    playlist,
    /\[var2\] var\(--var2-min-width, 120px\) \[last\]/,
  );
  assert.match(
    playlist,
    /\[first\] minmax\(var\(--first-min-width\), var\(--first-max-width, 4fr\)\)/,
  );
  assert.doesNotMatch(
    playlist,
    /\[var2\] minmax\(var\(--var2-min-width\), var\(--var2-max-width, 2fr\)\)/,
  );
});

test("the playlist template omits an empty Date added track", () => {
  const original =
    "[index] 16px [first] minmax(180px, 4fr) [var1] minmax(120px, 2fr) [var2] minmax(120px, 2fr) [last] minmax(120px, 1fr)";
  const playlist = buildPlaylistTemplate(original, 2, 5, [2, 3], [3]);

  assert.doesNotMatch(playlist, /\[var1\]/);
  assert.doesNotMatch(playlist, /\[var2\]/);
  assert.match(playlist, /\[streamRank\] 220px/);
});

test("metric sort clicks cycle through both directions and Spotify order", () => {
  const playsDescending = nextMetricSortState(null, "plays");
  const playsAscending = nextMetricSortState(playsDescending, "plays");
  assert.deepEqual(playsDescending, { key: "plays", direction: "desc" });
  assert.deepEqual(playsAscending, { key: "plays", direction: "asc" });
  assert.equal(nextMetricSortState(playsAscending, "plays"), null);

  const rankAscending = nextMetricSortState(null, "rank");
  const rankDescending = nextMetricSortState(rankAscending, "rank");
  assert.deepEqual(rankAscending, { key: "rank", direction: "asc" });
  assert.deepEqual(rankDescending, { key: "rank", direction: "desc" });
  assert.equal(nextMetricSortState(rankDescending, "rank"), null);
});

test("metric sorting is numeric, stable, and keeps unavailable values last", () => {
  const records = [
    { sourceIndex: 0, value: 10 },
    { sourceIndex: 1, value: null },
    { sourceIndex: 2, value: 3 },
    { sourceIndex: 3, value: 10 },
  ];

  const ascending = sortMetricRecords(records, "asc");

  assert.notStrictEqual(ascending, records);
  assert.deepEqual(
    ascending.map((record) => record.sourceIndex),
    [2, 0, 3, 1],
  );
  assert.deepEqual(
    sortMetricRecords(records, "desc").map((record) => record.sourceIndex),
    [0, 3, 2, 1],
  );
  assert.deepEqual(
    records.map((record) => record.sourceIndex),
    [0, 1, 2, 3],
  );
});

test("Top 10 sorting uses descending plays within every rank", () => {
  const records = [
    { plays: 100, sourceIndex: 0, value: 1 },
    { plays: 900, sourceIndex: 1, value: 2 },
    { plays: 500, sourceIndex: 2, value: 1 },
    { plays: null, sourceIndex: 3, value: 1 },
    { plays: 700, sourceIndex: 4, value: null },
    { plays: 200, sourceIndex: 5, value: null },
    { plays: 500, sourceIndex: 6, value: 1 },
  ];
  const options = {
    secondaryDirection: "desc",
    secondaryKey: "plays",
  };

  assert.deepEqual(
    sortMetricRecords(records, "asc", options).map(
      (record) => record.sourceIndex,
    ),
    [2, 6, 0, 3, 1, 4, 5],
  );
  assert.deepEqual(
    sortMetricRecords(records, "desc", options).map(
      (record) => record.sourceIndex,
    ),
    [1, 2, 6, 0, 3, 4, 5],
  );
});

test("large sorts reuse one canonical record graph across both metrics", () => {
  const source = fs.readFileSync(require.resolve("../gem-sort.js"), "utf8");
  const items = Array.from({ length: 3_000 }, (_, index) => ({
    artists: [
      {
        name: `Artist ${index % 300}`,
        uri: `spotify:artist:${String(index % 300).padStart(22, "0")}`,
      },
    ],
    durationMs: 180_000 + index,
    name: `Track ${index}`,
    uri: `spotify:track:${String(index).padStart(22, "0")}`,
  }));
  const records = buildMetricRecords(items);
  const firstInfo = records[0].info;

  records.forEach((record, index) => {
    record.plays = index * 10;
    record.rank = index % 11 === 0 ? null : (index % 10) + 1;
  });

  assert.equal(records.length, items.length);
  assert.strictEqual(selectMetricRecordValues(records, "plays"), records);
  assert.equal(records[2_999].value, 29_990);
  assert.strictEqual(records[0].info, firstInfo);
  assert.strictEqual(selectMetricRecordValues(records, "rank"), records);
  assert.equal(records[1].value, 2);
  assert.equal(records[11].value, null);
  assert.strictEqual(records[0].info, firstInfo);
  assert.doesNotMatch(source, /\b(?:metricRecords|sourceItems)\b/);
});

test("Top 10 bulk work scales within one shared request ceiling", () => {
  assert.equal(getArtistSortConcurrency(0), 0);
  assert.equal(getArtistSortConcurrency(4), 4);
  assert.equal(getArtistSortConcurrency(50), 10);
  assert.equal(getArtistSortConcurrency(51), 16);
  assert.equal(getArtistSortConcurrency(250), 16);
  assert.equal(getArtistSortConcurrency(251), 20);
  assert.equal(getArtistSortConcurrency(3_000), 20);
});

test("timed cache pruning removes expiry before enforcing the LRU cap", () => {
  const cache = new Map([
    ["expired", { expiresAt: 100, value: "stale" }],
    ["live-old", { expiresAt: 500, value: "older" }],
    ["live-new", { expiresAt: 600, value: "newer" }],
  ]);

  assert.deepEqual(pruneTimedCache(cache, 100, 1), {
    evicted: 1,
    expired: 1,
    remaining: 1,
  });
  assert.deepEqual(Array.from(cache.keys()), ["live-new"]);
});

test("full-list pagination reuses the captured page without leaving gaps", () => {
  assert.deepEqual(buildMissingRanges(1_200, 500, 0, 50), [
    { offset: 50, limit: 500 },
    { offset: 550, limit: 500 },
    { offset: 1_050, limit: 150 },
  ]);
  assert.deepEqual(buildMissingRanges(1_200, 500, 500, 100), [
    { offset: 0, limit: 500 },
    { offset: 600, limit: 500 },
    { offset: 1_100, limit: 100 },
  ]);
  assert.deepEqual(buildMissingRanges(50, 500, 0, 50), []);
  assert.deepEqual(buildMissingRanges(1_200, 500, 1_100, 500), [
    { offset: 0, limit: 500 },
    { offset: 500, limit: 500 },
    { offset: 1_000, limit: 100 },
  ]);
});

test("captured page placement prefers the request offset and clamps bounds", () => {
  assert.equal(
    getCapturedPageOffset({ offset: 100 }, { offset: 0 }, 1_200),
    100,
  );
  assert.equal(getCapturedPageOffset({}, { offset: 250 }, 1_200), 250);
  assert.equal(
    getCapturedPageOffset({ offset: -50 }, { offset: 400 }, 1_200),
    0,
  );
  assert.equal(
    getCapturedPageOffset({ offset: 1_500 }, { offset: 400 }, 1_200),
    1_200,
  );
});

test("sorted playback context preserves every Spotify item and its source index", () => {
  const source = [
    {
      type: "track",
      uri: "spotify:track:1111111111111111111111",
      uid: "playlist-item-a",
      provider: "context",
      metadata: { title: "First" },
    },
    {
      uri: "spotify:local:Artist:Album:Second:120",
      id: "local-item-b",
    },
    {
      type: "episode",
      uri: "spotify:episode:2222222222222222222222",
      uid: "episode-item-c",
    },
    {
      uri: "spotify:album:4444444444444444444444",
      uid: "album-item-d",
    },
    {
      type: "kallax",
      uri: "spotify:kallax:made-for-listener",
      uid: "kallax-item-e",
    },
    {
      uri: "spotify:podcast-chapter:5555555555555555555555",
      id: "chapter-item-f",
    },
    {
      type: "show",
      uri: "spotify:show:6666666666666666666666",
    },
    {
      uri: "",
      uid: "empty-uri-is-not-playable",
    },
    {
      uri: "https://open.spotify.com/track/7777777777777777777777",
      uid: "non-spotify-uri-is-not-playable",
    },
  ];
  const context = buildSortedPlaybackContext(
    source,
    "spotify:playlist:3333333333333333333333",
    17,
  );

  assert.equal(
    context.uri,
    "spotify:internal:gem-sort:3333333333333333333333:17",
  );
  assert.equal(
    context.metadata["reporting.uri"],
    "spotify:playlist:3333333333333333333333",
  );
  assert.equal(
    context.pages[0].metadata.page_uri,
    "spotify:internal:gem-sort:3333333333333333333333:17",
  );
  assert.deepEqual(
    context.pages[0].items.map(({ uri, uid }) => ({ uri, uid })),
    [
      {
        uri: "spotify:track:1111111111111111111111",
        uid: "playlist-item-a",
      },
      {
        uri: "spotify:local:Artist:Album:Second:120",
        uid: "local-item-b",
      },
      {
        uri: "spotify:episode:2222222222222222222222",
        uid: "episode-item-c",
      },
      {
        uri: "spotify:album:4444444444444444444444",
        uid: "album-item-d",
      },
      {
        uri: "spotify:kallax:made-for-listener",
        uid: "kallax-item-e",
      },
      {
        uri: "spotify:podcast-chapter:5555555555555555555555",
        uid: "chapter-item-f",
      },
      {
        uri: "spotify:show:6666666666666666666666",
        uid: "3333333333333333333333:6",
      },
    ],
  );
  context.pages[0].items[0].metadata.title = "Changed";
  assert.equal(source[0].metadata.title, "First");
});

test("sorted playback remaps Spotify's source index by occurrence UID", () => {
  const items = [
    { uri: "spotify:track:same", uid: "occurrence-b" },
    { uri: "spotify:track:other", uid: "occurrence-c" },
    { uri: "spotify:track:same", uid: "occurrence-a" },
  ];
  const sourceOptions = {
    paused: false,
    skipTo: {
      index: 1_143,
      pageIndex: 7,
      pageURL: "context://spotify:playlist:original",
      uid: "occurrence-a",
      uri: "spotify:track:same",
    },
  };
  const remapped = remapSortedPlaybackOptions(items, sourceOptions);

  assert.equal(remapped.skipTo.index, 2);
  assert.equal(remapped.skipTo.pageIndex, 0);
  assert.equal("pageURL" in remapped.skipTo, false);
  assert.equal(remapped.shuffle, false);
  assert.equal(sourceOptions.skipTo.index, 1_143);
  assert.deepEqual(remapSortedPlaybackOptions(items), { shuffle: false });
  assert.deepEqual(
    remapSortedPlaybackOptions(items, {
      skipTo: {
        uid: "stale-occurrence",
        uri: "spotify:track:other",
      },
    }).skipTo,
    {
      uid: "occurrence-c",
      uri: "spotify:track:other",
      index: 1,
      pageIndex: 0,
    },
  );
  assert.equal(
    remapSortedPlaybackOptions(items, {
      skipTo: { uid: "missing", uri: "spotify:track:missing" },
    }),
    null,
  );
});

test("the concurrency limiter bounds active work without changing results", async () => {
  const limit = createLimiter(2);
  let active = 0;
  let peak = 0;

  const results = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      limit(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return index * 2;
      }),
    ),
  );

  assert.equal(peak, 2);
  assert.deepEqual(results, [0, 2, 4, 6, 8, 10]);
});

test("playback context URI detection handles Spotify's supported shapes", () => {
  assert.equal(
    getPlaybackContextUri({
      uri: "spotify:playlist:1111111111111111111111",
    }),
    "spotify:playlist:1111111111111111111111",
  );
  assert.equal(
    getPlaybackContextUri({
      current: {
        uri: "spotify:playlist:2222222222222222222222",
      },
    }),
    "spotify:playlist:2222222222222222222222",
  );
  assert.equal(getPlaybackContextUri(null), null);
  assert.equal(
    getPlayerContextUri({
      context: {
        uri: "spotify:internal:gem-sort:playlist-id:17",
      },
    }),
    "spotify:internal:gem-sort:playlist-id:17",
  );
  assert.equal(
    getPlayerContextUri({
      context_uri: "spotify:playlist:1111111111111111111111",
      context: {
        uri: "spotify:playlist:2222222222222222222222",
      },
    }),
    "spotify:playlist:1111111111111111111111",
  );
});

test("Gem Sort playback contexts are scoped to the source playlist", () => {
  const playlist = "spotify:playlist:1111111111111111111111";

  assert.equal(
    isGemSortPlaybackContext(
      "spotify:internal:gem-sort:1111111111111111111111:42",
      playlist,
    ),
    true,
  );
  assert.equal(
    isGemSortPlaybackContext(
      "spotify:internal:gem-sort:2222222222222222222222:42",
      playlist,
    ),
    false,
  );
  assert.equal(
    isGemSortPlaybackContext(playlist, playlist),
    false,
  );
});

test("current-row matching prefers occurrence UIDs for duplicate tracks", () => {
  const rows = [
    { trackUri: "spotify:track:same", uid: "occurrence-b" },
    { trackUri: "spotify:track:other", uid: "occurrence-c" },
    { trackUri: "spotify:track:same", uid: "occurrence-a" },
  ];

  assert.equal(
    findCurrentTrackIndex(rows, {
      uri: "spotify:track:same",
      uid: "occurrence-a",
    }),
    2,
  );
  assert.equal(
    findCurrentTrackIndex(rows, {
      uri: "spotify:track:same",
      uid: "offscreen-occurrence",
    }),
    -1,
  );
  assert.equal(
    findCurrentTrackIndex(
      rows.map(({ trackUri }) => ({ trackUri })),
      { uri: "spotify:track:same" },
    ),
    0,
  );
});

test("method owner lookup reaches inherited Spotify API methods", () => {
  const prototype = {
    play() {},
  };
  const instance = Object.create(prototype);

  assert.equal(findMethodOwner(instance, "play"), prototype);
  instance.play = function replacement() {};
  assert.equal(findMethodOwner(instance, "play"), instance);
  assert.equal(findMethodOwner(instance, "missing"), null);
});

test("list query fingerprints ignore pagination but retain filters and sort", () => {
  const left = fingerprintQueryOptions({
    offset: 0,
    limit: 50,
    filter: "snow",
    sort: { field: "NAME", order: "ASC" },
  });
  const right = fingerprintQueryOptions({
    limit: 500,
    offset: 400,
    sort: { order: "ASC", field: "NAME" },
    filter: "snow",
  });
  const changed = fingerprintQueryOptions({
    filter: "rain",
    sort: { field: "NAME", order: "ASC" },
  });

  assert.equal(left, right);
  assert.notEqual(left, changed);
});

test("fallback templates contain the requested number of tracks", () => {
  const template = buildFallbackTemplate(5);
  assert.match(template, /\[index\]/);
  assert.match(template, /\[first\]/);
  assert.match(template, /\[var1\]/);
  assert.match(template, /\[var2\]/);
  assert.match(template, /\[last\]/);
});

test("artist overview order becomes a one-based Top 10 rank map", () => {
  const response = {
    data: {
      artistUnion: {
        discography: {
          topTracks: {
            items: [
              {
                track: {
                  uri: "spotify:track:1111111111111111111111",
                  name: "First",
                  playcount: "1200",
                },
              },
              {
                track: {
                  uri: "spotify:track:2222222222222222222222",
                  name: "Second",
                  playcount: "900",
                },
              },
            ],
          },
        },
      },
    },
  };

  const result = buildTopTrackMap(response);
  assert.deepEqual(result.get("spotify:track:1111111111111111111111"), {
    rank: 1,
    playcount: 1_200,
    name: "First",
    nameKey: "first",
    durationMs: null,
  });
  assert.equal(result.get("spotify:track:2222222222222222222222").rank, 2);
});

test("track titles and live duration shapes normalize for relink matching", () => {
  assert.equal(normalizeTrackName("  Midnight   CITY  "), "midnight city");
  assert.equal(toDurationMs({ milliseconds: 159_000 }), 159_000);
  assert.equal(toDurationMs({ totalMilliseconds: 158_667 }), 158_667);
  assert.equal(toDurationMs(null), null);
});

test("Top 10 lookup prefers exact URI and accepts a unique relink match", () => {
  const index = buildTopTrackIndex({
    data: {
      artistUnion: {
        discography: {
          topTracks: {
            items: [
              {
                track: {
                  uri: "spotify:track:1111111111111111111111",
                  name: "Midnight City",
                  duration: { totalMilliseconds: 158_667 },
                  playcount: "1200",
                },
              },
              {
                track: {
                  uri: "spotify:track:2222222222222222222222",
                  name: "Different Song",
                  duration: { totalMilliseconds: 245_000 },
                  playcount: "900",
                },
              },
            ],
          },
        },
      },
    },
  });

  const exactInfo = {
    trackUri: "spotify:track:1111111111111111111111",
    trackName: "Different Song",
    durationMs: 245_000,
  };
  const exact = findTopTrackRecord(index, exactInfo, 777);
  assert.equal(exact.rank, 1);

  const relinkedInfo = {
    trackUri: "spotify:track:3333333333333333333333",
    trackName: "  MIDNIGHT   city ",
    durationMs: 159_000,
  };
  const relinked = findTopTrackRecord(index, relinkedInfo);
  assert.equal(relinked.rank, 1);
  assert.equal(relinked.playcount, 1_200);
  assert.equal(findTopTrackRecord(index, relinkedInfo, 777).rank, 1);
});

test("relinked Top 10 lookup rejects different titles and durations", () => {
  const index = buildTopTrackIndex({
    data: {
      artistUnion: {
        discography: {
          topTracks: {
            items: [
              {
                track: {
                  uri: "spotify:track:1111111111111111111111",
                  name: "Midnight City",
                  duration: { totalMilliseconds: 158_667 },
                  playcount: "1200",
                },
              },
            ],
          },
        },
      },
    },
  });
  const relinkedUri = "spotify:track:3333333333333333333333";

  assert.equal(
    findTopTrackRecord(index, {
      trackUri: relinkedUri,
      trackName: "Midnight Sun",
      durationMs: 159_000,
    }),
    null,
  );
  assert.equal(
    findTopTrackRecord(index, {
      trackUri: relinkedUri,
      trackName: "Midnight City",
      durationMs: 160_667,
    }).rank,
    1,
  );
  assert.equal(
    findTopTrackRecord(index, {
      trackUri: relinkedUri,
      trackName: "Midnight City",
      durationMs: 160_668,
    }),
    null,
  );
});

test("ambiguous relink matches require a uniquely confirming playcount", () => {
  const index = buildTopTrackIndex({
    data: {
      artistUnion: {
        discography: {
          topTracks: {
            items: [
              {
                track: {
                  uri: "spotify:track:1111111111111111111111",
                  name: "Midnight City",
                  duration: { totalMilliseconds: 158_667 },
                  playcount: "1200",
                },
              },
              {
                track: {
                  uri: "spotify:track:2222222222222222222222",
                  name: " midnight  city ",
                  duration: { totalMilliseconds: 159_500 },
                  playcount: "900",
                },
              },
              {
                track: {
                  uri: "spotify:track:4444444444444444444444",
                  name: "Midnight City",
                  duration: { totalMilliseconds: 159_200 },
                },
              },
            ],
          },
        },
      },
    },
  });
  const info = {
    trackUri: "spotify:track:3333333333333333333333",
    trackName: "MIDNIGHT CITY",
    durationMs: 159_000,
  };

  assert.equal(findTopTrackRecord(index, info), null);
  assert.equal(findTopTrackRecord(index, info, 1_200).rank, 1);
  assert.equal(findTopTrackRecord(index, info, 777), null);
});

test("track counts are extracted across current album and track response shapes", () => {
  const response = {
    data: {
      albumUnion: {
        tracksV2: {
          items: [
            {
              track: {
                uri: "spotify:track:1111111111111111111111",
                playcount: "777",
              },
            },
          ],
        },
      },
      trackUnion: {
        uri: "spotify:track:2222222222222222222222",
        playCount: 888,
      },
    },
  };

  const counts = extractTrackCounts(response);
  assert.equal(counts.get("spotify:track:1111111111111111111111"), 777);
  assert.equal(counts.get("spotify:track:2222222222222222222222"), 888);
});

test("current Spotify row React props yield track, album, and primary artist", () => {
  const props = {
    children: {
      props: {
        value: {
          item: {
            type: "track",
            uri: "spotify:track:1111111111111111111111",
            uid: "playlist-occurrence-1",
            name: "Current Track",
            duration: {
              milliseconds: 159_000,
            },
            album: {
              uri: "spotify:album:2222222222222222222222",
              artist: {
                uri: "spotify:artist:3333333333333333333333",
                name: "Album Artist",
              },
            },
            artists: [
              {
                uri: "spotify:artist:4444444444444444444444",
                name: "Primary Artist",
              },
              {
                uri: "spotify:artist:5555555555555555555555",
                name: "Featured Artist",
              },
            ],
            isLocal: false,
          },
        },
      },
    },
  };

  assert.deepEqual(extractTrackInfoFromProps(props), {
    uid: "playlist-occurrence-1",
    trackUri: "spotify:track:1111111111111111111111",
    trackName: "Current Track",
    durationMs: 159_000,
    albumUri: "spotify:album:2222222222222222222222",
    artistUri: "spotify:artist:4444444444444444444444",
    artistName: "Primary Artist",
    isLocal: false,
  });
});

test("Spotify hrefs are parsed without accepting malformed IDs", () => {
  assert.equal(
    spotifyUriFromHref("/artist/3333333333333333333333?si=x", "artist"),
    "spotify:artist:3333333333333333333333",
  );
  assert.equal(
    spotifyUriFromHref("/intl-de/album/2222222222222222222222", "album"),
    "spotify:album:2222222222222222222222",
  );
  assert.equal(spotifyUriFromHref("/artist/not-an-id", "artist"), null);
});

test("only playlist and Liked Songs routes are eligible for the column", () => {
  assert.equal(isPlaylistPath("/playlist/7xe9UW8o2MxI8pLoGoJJxB"), true);
  assert.equal(isPlaylistPath("/collection/tracks"), true);
  assert.equal(isPlaylistPath("/album/5woXvVFWOSTXmJUAZt6oLL"), false);
  assert.equal(isPlaylistPath("/artist/5iLlplPCL89LQt9mTwrs6f"), false);
});
