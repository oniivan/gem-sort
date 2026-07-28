/*
 * Gem Sort
 * Adds one combined "Plays · Top 10" column to Spotify playlist track lists.
 *
 * Spotify's play-count and artist-ranking interfaces are private and may change.
 * The extension feature-detects them and degrades to dashes when unavailable.
 *
 * MetadataService discovery and play-count decoding are adapted from Sort-Play:
 * https://github.com/hoeci/sort-play (MIT). See THIRD_PARTY_NOTICES.md.
 */

(function attachStreamRank(root, factory) {
  "use strict";

  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root && root.document) {
    api.start(root);
  }
})(typeof window !== "undefined" ? window : null, function createStreamRankApi() {
  "use strict";

  const VERSION = "0.5.2";
  const GLOBAL_KEY = "__spotifyGemSort";
  const STYLE_ID = "spotify-gem-sort-style";
  const GRID_SELECTOR =
    '[role="grid"].main-trackList-trackList.main-trackList-indexable, ' +
    '[role="grid"][data-testid="playlist-tracklist"]';
  const ROW_SELECTOR =
    ".main-trackList-trackListRow, [data-testid=\"tracklist-row\"]";
  const PLACEHOLDER_SELECTOR =
    ".main-trackList-trackListRowGrid:not(.main-trackList-trackListRow)" +
    ":not(.main-trackList-trackListHeaderRow), " +
    '[data-testid="tracklist-row-placeholder"]';
  const COLUMN_MARKER = "[streamRank] 220px";
  const LOADING = Symbol("gem-sort-loading");
  const PLAY_COUNT_TTL_MS = 60 * 60 * 1000;
  const ALBUM_TTL_MS = 6 * 60 * 60 * 1000;
  const ARTIST_TTL_MS = 30 * 60 * 1000;
  const FAILURE_TTL_MS = 2 * 60 * 1000;
  const REQUEST_TIMEOUT_MS = 12 * 1000;
  const RECONCILE_DELAY_MS = 40;
  const PLAY_COUNT_BATCH_DELAY_MS = 45;
  const SORT_PLAY_COUNT_BATCH_SIZE = 3000;
  const COMPLETE_LIST_PAGE_SIZE = 500;
  const COMPLETE_LIST_CONCURRENCY = 3;
  const ARTIST_REQUEST_CONCURRENCY_LIMIT = 20;
  const PLAY_COUNT_CACHE_LIMIT = 20_000;
  const ALBUM_CACHE_LIMIT = 5_000;
  const ARTIST_CACHE_LIMIT = 5_000;
  const LOGGED_MESSAGE_LIMIT = 200;
  const RELINK_DURATION_TOLERANCE_MS = 2_000;
  const CACHE_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
  const CACHE_PRUNE_IDLE_TIMEOUT_MS = 30 * 1000;

  function normalizeByteArray(value) {
    if (!value) return [];
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      return Array.from(value, Number);
    }

    if (typeof value === "object") {
      return Object.keys(value)
        .filter((key) => /^\d+$/.test(key))
        .sort((left, right) => Number(left) - Number(right))
        .map((key) => Number(value[key]));
    }

    return [];
  }

  function parseVarint(value, startIndex = 1) {
    const bytes = normalizeByteArray(value);
    let result = 0n;
    let shift = 0n;

    for (let index = startIndex; index < bytes.length; index += 1) {
      const byte = bytes[index];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
    }

    return Number(result);
  }

  function toPlayCount(value) {
    if (value === null || value === undefined || typeof value === "boolean") {
      return null;
    }

    if (typeof value === "bigint") {
      const numeric = Number(value);
      return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
    }

    if (typeof value === "string" && value.trim() === "") return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : null;
  }

  function formatPlayCount(value, locale = "en-US") {
    const numeric = toPlayCount(value);
    if (numeric === null) return "—";

    try {
      return new Intl.NumberFormat(locale).format(numeric);
    } catch {
      return new Intl.NumberFormat("en-US").format(numeric);
    }
  }

  function preferPlayCount(cachedValue, incomingValue) {
    return toPlayCount(incomingValue) === null &&
      toPlayCount(cachedValue) !== null
      ? cachedValue
      : incomingValue;
  }

  function findColumnTypeIndex(columnTypes, acceptedTypes) {
    if (!Array.isArray(columnTypes) || !Array.isArray(acceptedTypes)) {
      return -1;
    }
    const accepted = new Set(acceptedTypes);
    return columnTypes.findIndex(
      (columnType) =>
        typeof columnType === "string" && accepted.has(columnType),
    );
  }

  function stripTemplateColumn(template) {
    return removeNamedTemplateTrack(template, "streamRank");
  }

  function insertTemplateColumn(template) {
    const cleanTemplate = stripTemplateColumn(template);
    if (!cleanTemplate) return "";

    if (cleanTemplate.includes("[last]")) {
      return cleanTemplate.replace("[last]", `${COLUMN_MARKER} [last]`);
    }

    return `${cleanTemplate} ${COLUMN_MARKER}`.trim();
  }

  function removeNamedTemplateTrack(template, lineName) {
    if (typeof template !== "string" || !lineName) return template || "";
    const marker = `[${lineName}]`;
    const start = template.indexOf(marker);
    if (start < 0) return template;

    const nextLine = template.slice(start + marker.length).match(/\[[A-Za-z0-9_-]+\]/);
    if (!nextLine || nextLine.index === undefined) {
      return template.slice(0, start).replace(/\s+$/, "");
    }

    const end = start + marker.length + nextLine.index;
    return `${template.slice(0, start)}${template.slice(end)}`
      .replace(/\s+/g, " ")
      .trim();
  }

  function getTemplateLineForColumn(columnIndex, totalColumnCount) {
    if (columnIndex === 0) return "index";
    if (columnIndex === 1) return "first";
    if (columnIndex === totalColumnCount - 1) return "last";
    return `var${columnIndex - 1}`;
  }

  function replaceNamedTemplateTrack(template, lineName, replacement) {
    if (
      typeof template !== "string" ||
      !lineName ||
      typeof replacement !== "string"
    ) {
      return template || "";
    }

    const marker = `[${lineName}]`;
    const start = template.indexOf(marker);
    if (start < 0) return template;

    const nextLine = template.slice(start + marker.length).match(/\[[A-Za-z0-9_-]+\]/);
    const end =
      nextLine && nextLine.index !== undefined
        ? start + marker.length + nextLine.index
        : template.length;

    return `${template.slice(0, start)}${replacement} ${template.slice(end)}`
      .replace(/\s+/g, " ")
      .trim();
  }

  function buildPlaylistTemplate(
    template,
    albumColumnIndex,
    totalColumnCount,
    hiddenColumnIndexes = [],
    compactColumnIndexes = [],
  ) {
    const cleanTemplate = stripTemplateColumn(template);
    const albumLine =
      albumColumnIndex >= 0
        ? getTemplateLineForColumn(albumColumnIndex, totalColumnCount)
        : null;
    let playlistTemplate =
      albumLine && cleanTemplate.includes(`[${albumLine}]`)
        ? replaceNamedTemplateTrack(cleanTemplate, albumLine, COLUMN_MARKER)
        : insertTemplateColumn(cleanTemplate);

    new Set(hiddenColumnIndexes).forEach((columnIndex) => {
      if (columnIndex < 0 || columnIndex === albumColumnIndex) return;
      playlistTemplate = removeNamedTemplateTrack(
        playlistTemplate,
        getTemplateLineForColumn(columnIndex, totalColumnCount),
      );
    });

    new Set(compactColumnIndexes).forEach((columnIndex) => {
      if (
        columnIndex < 0 ||
        columnIndex === albumColumnIndex ||
        hiddenColumnIndexes.includes(columnIndex)
      ) {
        return;
      }

      const lineName = getTemplateLineForColumn(
        columnIndex,
        totalColumnCount,
      );
      playlistTemplate = replaceNamedTemplateTrack(
        playlistTemplate,
        lineName,
        `[${lineName}] var(--${lineName}-min-width, 120px)`,
      );
    });

    return playlistTemplate;
  }

  function buildFallbackTemplate(totalColumnCount) {
    const middleCount = Math.max(0, totalColumnCount - 3);
    let template = "[index] 16px [first] minmax(180px, 5fr)";

    for (let index = 1; index <= middleCount; index += 1) {
      template += ` [var${index}] minmax(120px, 2fr)`;
    }

    return `${template} [last] minmax(120px, 1fr)`;
  }

  function normalizeTrackName(value) {
    if (typeof value !== "string") return "";

    const normalized =
      typeof value.normalize === "function" ? value.normalize("NFKC") : value;
    return normalized.trim().toLowerCase().replace(/\s+/g, " ");
  }

  function toDurationMs(value) {
    let candidate = value;

    if (candidate && typeof candidate === "object") {
      candidate =
        candidate.totalMilliseconds ??
        candidate.milliseconds ??
        candidate.durationMs ??
        candidate.duration_ms ??
        candidate.ms;
    }

    if (
      candidate === null ||
      candidate === undefined ||
      typeof candidate === "boolean" ||
      typeof candidate === "symbol" ||
      (typeof candidate === "string" && candidate.trim() === "")
    ) {
      return null;
    }

    const numeric = Number(candidate);
    return Number.isFinite(numeric) && numeric >= 0
      ? Math.round(numeric)
      : null;
  }

  function buildTopTrackIndex(response) {
    const items = response?.data?.artistUnion?.discography?.topTracks?.items;
    const byUri = new Map();
    const records = [];

    if (!Array.isArray(items)) return { byUri, records };

    items.slice(0, 10).forEach((item, index) => {
      const track = item?.track ?? item;
      if (typeof track?.uri !== "string" || !track.uri.startsWith("spotify:track:")) {
        return;
      }

      const name = typeof track.name === "string" ? track.name : "";
      const record = {
        rank: index + 1,
        playcount: toPlayCount(track.playcount ?? track.playCount),
        name,
        nameKey: normalizeTrackName(name),
        durationMs: toDurationMs(
          track.duration ?? track.durationMs ?? track.duration_ms,
        ),
      };
      byUri.set(track.uri, record);
      records.push(record);
    });

    return { byUri, records };
  }

  function buildTopTrackMap(response) {
    return buildTopTrackIndex(response).byUri;
  }

  function findTopTrackRecord(topTracks, info, observedPlaycount = null) {
    if (!topTracks || !info) return null;

    const exact = topTracks.byUri?.get?.(info.trackUri);
    if (exact) return exact;

    const nameKey = normalizeTrackName(info.trackName);
    const durationMs = toDurationMs(info.durationMs);
    if (
      !nameKey ||
      durationMs === null ||
      !Array.isArray(topTracks.records)
    ) {
      return null;
    }

    const playcount =
      typeof observedPlaycount === "symbol"
        ? null
        : toPlayCount(observedPlaycount);

    let match = null;
    let matchCount = 0;
    let playcountMatch = null;
    let playcountMatchCount = 0;
    for (const record of topTracks.records) {
      if (
        record.nameKey !== nameKey ||
        record.durationMs === null ||
        Math.abs(record.durationMs - durationMs) >
          RELINK_DURATION_TOLERANCE_MS
      ) {
        continue;
      }

      match ??= record;
      matchCount += 1;
      if (playcount !== null && record.playcount === playcount) {
        playcountMatch = record;
        playcountMatchCount += 1;
      }
    }

    if (matchCount === 1) return match;
    return playcountMatchCount === 1 ? playcountMatch : null;
  }

  function extractTrackCounts(response) {
    const counts = new Map();
    const visited = new Set();

    function visit(value, depth) {
      if (!value || typeof value !== "object" || depth > 14 || visited.has(value)) {
        return;
      }

      visited.add(value);

      if (typeof value.uri === "string" && value.uri.startsWith("spotify:track:")) {
        const count = toPlayCount(value.playcount ?? value.playCount);
        if (count !== null) counts.set(value.uri, count);
      }

      if (Array.isArray(value)) {
        value.forEach((entry) => visit(entry, depth + 1));
        return;
      }

      Object.values(value).forEach((entry) => visit(entry, depth + 1));
    }

    visit(response, 0);
    return counts;
  }

  function isTrackItem(value) {
    return (
      value &&
      typeof value === "object" &&
      typeof value.uri === "string" &&
      (value.uri.startsWith("spotify:track:") || value.uri.startsWith("spotify:local:"))
    );
  }

  function findTrackItem(value, maxDepth = 12) {
    const directCandidates = [
      value?.children?.props?.value?.item,
      value?.children?.props?.item,
      value?.props?.value?.item,
      value?.value?.item,
      value?.item,
      value,
    ];

    const directMatch = directCandidates.find(isTrackItem);
    if (directMatch) return directMatch;

    const visited = new Set();
    const allowedKeys = new Set([
      "children",
      "props",
      "value",
      "item",
      "track",
      "data",
      "spec",
      "_path",
    ]);

    function visit(candidate, depth) {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        depth > maxDepth ||
        visited.has(candidate)
      ) {
        return null;
      }

      visited.add(candidate);
      if (isTrackItem(candidate)) return candidate;

      for (const key of Object.keys(candidate)) {
        if (!allowedKeys.has(key) && !/^\d+$/.test(key)) continue;
        const match = visit(candidate[key], depth + 1);
        if (match) return match;
      }

      return null;
    }

    return visit(value, 0);
  }

  function normalizeTrackItem(item) {
    if (!isTrackItem(item)) return null;

    const primaryArtist =
      (Array.isArray(item.artists) && item.artists[0]) ||
      item.album?.artist ||
      item.artist ||
      null;

    return {
      trackUri: item.uri,
      trackName: typeof item.name === "string" ? item.name : "",
      durationMs: toDurationMs(
        item.duration ?? item.durationMs ?? item.duration_ms,
      ),
      albumUri:
        typeof item.album?.uri === "string" && item.album.uri.startsWith("spotify:album:")
          ? item.album.uri
          : null,
      artistUri:
        typeof primaryArtist?.uri === "string" &&
        primaryArtist.uri.startsWith("spotify:artist:")
          ? primaryArtist.uri
          : null,
      artistName: typeof primaryArtist?.name === "string" ? primaryArtist.name : "",
      isLocal: item.isLocal === true || item.uri.startsWith("spotify:local:"),
    };
  }

  function extractTrackInfoFromProps(props) {
    return normalizeTrackItem(findTrackItem(props));
  }

  function spotifyUriFromHref(href, type) {
    if (typeof href !== "string") return null;
    const match = href.match(new RegExp(`/(?:intl-[^/]+/)?${type}/([A-Za-z0-9]{22})(?:[/?#]|$)`));
    return match ? `spotify:${type}:${match[1]}` : null;
  }

  function isPlaylistPath(pathname) {
    return (
      typeof pathname === "string" &&
      (pathname.startsWith("/playlist/") || pathname === "/collection/tracks")
    );
  }

  function nextMetricSortState(currentState, requestedKey) {
    const firstDirection = requestedKey === "plays" ? "desc" : "asc";
    if (!currentState || currentState.key !== requestedKey) {
      return { key: requestedKey, direction: firstDirection };
    }

    if (currentState.direction === firstDirection) {
      return {
        key: requestedKey,
        direction: firstDirection === "asc" ? "desc" : "asc",
      };
    }

    return null;
  }

  function buildMetricRecords(items) {
    return (Array.isArray(items) ? items : []).map(
      (item, sourceIndex) => ({
        info: normalizeTrackItem(item),
        item,
        plays: null,
        rank: null,
        sourceIndex,
        value: null,
      }),
    );
  }

  function selectMetricRecordValues(records, key) {
    if (!["plays", "rank"].includes(key)) return records;
    (Array.isArray(records) ? records : []).forEach((record) => {
      record.value = record[key] ?? null;
    });
    return records;
  }

  function getArtistSortConcurrency(artistCount) {
    const count = Math.max(0, Math.floor(Number(artistCount) || 0));
    if (count === 0) return 0;
    if (count <= 50) return Math.min(count, 10);
    if (count <= 250) return 16;
    return ARTIST_REQUEST_CONCURRENCY_LIMIT;
  }

  function sortMetricRecords(
    records,
    direction,
    {
      secondaryDirection = "desc",
      secondaryKey = null,
    } = {},
  ) {
    const multiplier = direction === "desc" ? -1 : 1;
    const secondaryMultiplier =
      secondaryDirection === "asc" ? 1 : -1;
    return records.slice().sort((left, right) => {
      const leftMissing = left.value === null || left.value === undefined;
      const rightMissing = right.value === null || right.value === undefined;
      if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
      if (!leftMissing && left.value !== right.value) {
        return (left.value - right.value) * multiplier;
      }

      if (secondaryKey) {
        const leftSecondary = left[secondaryKey];
        const rightSecondary = right[secondaryKey];
        const leftSecondaryMissing =
          leftSecondary === null || leftSecondary === undefined;
        const rightSecondaryMissing =
          rightSecondary === null || rightSecondary === undefined;
        if (leftSecondaryMissing !== rightSecondaryMissing) {
          return leftSecondaryMissing ? 1 : -1;
        }
        if (
          !leftSecondaryMissing &&
          leftSecondary !== rightSecondary
        ) {
          return (
            (leftSecondary - rightSecondary) *
            secondaryMultiplier
          );
        }
      }

      return left.sourceIndex - right.sourceIndex;
    });
  }

  function buildMissingRanges(
    totalLength,
    pageSize,
    coveredOffset = 0,
    coveredLength = 0,
  ) {
    const total = Math.max(0, Math.trunc(Number(totalLength)) || 0);
    const size = Math.max(1, Math.trunc(Number(pageSize)) || 1);
    const coveredStart = Math.min(
      total,
      Math.max(0, Math.trunc(Number(coveredOffset)) || 0),
    );
    const coveredEnd = Math.min(
      total,
      coveredStart + Math.max(0, Math.trunc(Number(coveredLength)) || 0),
    );
    const ranges = [];
    let offset = 0;

    while (offset < total) {
      if (offset >= coveredStart && offset < coveredEnd) {
        offset = coveredEnd;
        continue;
      }

      const nextBoundary = offset < coveredStart ? coveredStart : total;
      const limit = Math.min(size, nextBoundary - offset);
      if (limit <= 0) {
        offset = Math.max(offset + 1, coveredEnd);
        continue;
      }
      ranges.push({ offset, limit });
      offset += limit;
    }

    return ranges;
  }

  function getCapturedPageOffset(options, response, totalLength) {
    const requestedOffset = options?.offset;
    const reportedOffset = response?.offset;
    const rawOffset = requestedOffset ?? reportedOffset;
    return Math.min(
      Math.max(0, Number(totalLength) || 0),
      Math.max(0, Math.trunc(Number(rawOffset)) || 0),
    );
  }

  function getPlaybackContextUri(context) {
    if (typeof context === "string") return context;
    if (!context || typeof context !== "object") return null;
    if (typeof context.uri === "string") return context.uri;
    return typeof context.current?.uri === "string"
      ? context.current.uri
      : null;
  }

  function findMethodOwner(value, methodName) {
    let current = value;
    while (current && typeof current === "object") {
      if (
        Object.prototype.hasOwnProperty.call(current, methodName) &&
        typeof current[methodName] === "function"
      ) {
        return current;
      }
      current = Object.getPrototypeOf(current);
    }
    return null;
  }

  function buildSortedPlaybackContext(items, originalUri, generation = 0) {
    const originalToken =
      typeof originalUri === "string"
        ? originalUri.split(":").at(-1)?.replace(/[^A-Za-z0-9]/g, "")
        : "";
    const generationToken =
      String(generation).replace(/[^A-Za-z0-9_-]/g, "") || "0";
    const contextItems = (Array.isArray(items) ? items : []).flatMap(
      (item, index) => {
        const uri = typeof item?.uri === "string" ? item.uri : "";
        if (!uri.startsWith("spotify:")) {
          return [];
        }

        const metadata =
          item.metadata &&
          typeof item.metadata === "object" &&
          !Array.isArray(item.metadata)
            ? { ...item.metadata }
            : undefined;
        const contextItem = {
          type: typeof item.type === "string" ? item.type : "track",
          uri,
          uid:
            typeof item.uid === "string"
              ? item.uid
              : typeof item.id === "string"
                ? item.id
                : `${originalToken || "playlist"}:${index}`,
          provider: item.provider ?? null,
        };
        if (metadata) contextItem.metadata = metadata;
        return [contextItem];
      },
    );
    const contextMetadata =
      typeof originalUri === "string"
        ? { "reporting.uri": originalUri }
        : {};
    const contextUri =
      `spotify:internal:gem-sort:${originalToken || "playlist"}:` +
      generationToken;

    return {
      uri: contextUri,
      metadata: contextMetadata,
      pages: [
        {
          items: contextItems,
          metadata: { page_uri: contextUri },
        },
      ],
    };
  }

  function remapSortedPlaybackOptions(items, options) {
    const sourceOptions =
      options && typeof options === "object" ? options : {};
    const skipTo = options?.skipTo;
    if (!skipTo) {
      return {
        ...sourceOptions,
        shuffle: false,
      };
    }

    const contextItems = Array.isArray(items) ? items : [];
    let sortedIndex = -1;
    if (typeof skipTo.uid === "string" && skipTo.uid) {
      sortedIndex = contextItems.findIndex(
        (item) => item?.uid === skipTo.uid,
      );
    }
    if (
      sortedIndex < 0 &&
      typeof skipTo.uri === "string" &&
      skipTo.uri
    ) {
      sortedIndex = contextItems.findIndex(
        (item) => item?.uri === skipTo.uri,
      );
    }
    if (sortedIndex < 0) return null;

    const matchedItem = contextItems[sortedIndex];
    const remappedSkipTo = {
      ...skipTo,
      index: sortedIndex,
      pageIndex: 0,
      uri: matchedItem.uri,
    };
    if (typeof matchedItem.uid === "string" && matchedItem.uid) {
      remappedSkipTo.uid = matchedItem.uid;
    } else {
      delete remappedSkipTo.uid;
    }
    delete remappedSkipTo.pageURL;
    return {
      ...sourceOptions,
      shuffle: false,
      skipTo: remappedSkipTo,
    };
  }

  function fingerprintQueryOptions(options) {
    function normalize(value) {
      if (Array.isArray(value)) return value.map(normalize);
      if (!value || typeof value !== "object") return value;

      return Object.keys(value)
        .filter((key) => key !== "offset" && key !== "limit")
        .sort()
        .reduce((result, key) => {
          const normalized = normalize(value[key]);
          if (normalized !== undefined) result[key] = normalized;
          return result;
        }, {});
    }

    try {
      return JSON.stringify(normalize(options || {}));
    } catch {
      return "";
    }
  }

  function countExpiredCacheEntries(cache, now = Date.now()) {
    if (!(cache instanceof Map)) return 0;
    const currentTime = Number.isFinite(Number(now))
      ? Number(now)
      : Date.now();
    let expired = 0;

    cache.forEach((entry) => {
      const expiresAt = Number(entry?.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= currentTime) {
        expired += 1;
      }
    });
    return expired;
  }

  function pruneTimedCache(
    cache,
    now = Date.now(),
    maximum = Number.POSITIVE_INFINITY,
  ) {
    if (!(cache instanceof Map)) {
      return { evicted: 0, expired: 0, remaining: 0 };
    }

    const currentTime = Number.isFinite(Number(now))
      ? Number(now)
      : Date.now();
    const numericMaximum = Number(maximum);
    const limit = Number.isFinite(numericMaximum)
      ? Math.max(0, Math.floor(numericMaximum))
      : Number.POSITIVE_INFINITY;
    let expired = 0;
    let evicted = 0;

    cache.forEach((entry, key) => {
      const expiresAt = Number(entry?.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= currentTime) {
        cache.delete(key);
        expired += 1;
      }
    });

    while (cache.size > limit) {
      const oldestKey = cache.keys().next().value;
      if (!cache.delete(oldestKey)) break;
      evicted += 1;
    }

    return { evicted, expired, remaining: cache.size };
  }

  function createLimiter(maximum) {
    const queue = [];
    let active = 0;

    function drain() {
      while (active < maximum && queue.length > 0) {
        const entry = queue.shift();
        active += 1;

        Promise.resolve()
          .then(entry.task)
          .then(entry.resolve, entry.reject)
          .finally(() => {
            active -= 1;
            drain();
          });
      }
    }

    return function limit(task) {
      return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        drain();
      });
    };
  }

  function withTimeout(promise, milliseconds, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function start(browserRoot) {
    if (!browserRoot?.document) return null;

    const previous = browserRoot[GLOBAL_KEY];
    if (previous?.destroy) previous.destroy();

    const runtime = createRuntime(browserRoot);
    browserRoot[GLOBAL_KEY] = runtime;
    runtime.init();
    return runtime;
  }

  function createRuntime(browserRoot) {
    const document = browserRoot.document;
    const playCountCache = new Map();
    const playCountInFlight = new Map();
    const albumCache = new Map();
    const albumInFlight = new Map();
    const artistCache = new Map();
    const artistInFlight = new Map();
    const pendingPlayCounts = new Map();
    const observedGrids = new Set();
    const loggedMessages = new Set();
    const cachePolicies = [
      {
        cache: playCountCache,
        evicted: 0,
        expiredPruned: 0,
        limit: PLAY_COUNT_CACHE_LIMIT,
        name: "playCounts",
      },
      {
        cache: albumCache,
        evicted: 0,
        expiredPruned: 0,
        limit: ALBUM_CACHE_LIMIT,
        name: "albums",
      },
      {
        cache: artistCache,
        evicted: 0,
        expiredPruned: 0,
        limit: ARTIST_CACHE_LIMIT,
        name: "artists",
      },
    ];
    const cachePolicyByCache = new Map(
      cachePolicies.map((policy) => [policy.cache, policy]),
    );
    const albumLimit = createLimiter(3);
    const artistLimit = createLimiter(
      ARTIST_REQUEST_CONCURRENCY_LIMIT,
    );
    const trackLimit = createLimiter(3);
    const artistRequestMetrics = {
      active: 0,
      cacheHits: 0,
      completed: 0,
      deduplicated: 0,
      failed: 0,
      peak: 0,
      totalDurationMs: 0,
    };

    let destroyed = false;
    let initialized = false;
    let mutationObserver = null;
    let resizeObserver = null;
    let historyUnlisten = null;
    let reconcileTimer = null;
    let playCountBatchTimer = null;
    let cachePruneTimer = null;
    let cachePruneIdleHandle = null;
    let cachePruneIdleKind = null;
    let cachePruneRuns = 0;
    let lastCachePruneAt = null;
    let metadataServiceClient = null;
    let metadataServiceAttempted = false;
    let sortSession = null;
    let sortLoading = null;
    let sortOperationId = 0;
    let bulkPlaySorts = 0;
    let sortedPlaybackStarts = 0;
    let captureLock = Promise.resolve();

    function getSpicetify() {
      return browserRoot.Spicetify;
    }

    function getCurrentPath() {
      return (
        getSpicetify()?.Platform?.History?.location?.pathname ||
        browserRoot.location?.pathname ||
        ""
      );
    }

    function getLocale() {
      const Spicetify = getSpicetify();
      try {
        return Spicetify?.Locale?.getLocale?.() || browserRoot.navigator?.language || "en-US";
      } catch {
        return browserRoot.navigator?.language || "en-US";
      }
    }

    function logOnce(key, ...message) {
      if (loggedMessages.has(key)) return;
      while (loggedMessages.size >= LOGGED_MESSAGE_LIMIT) {
        loggedMessages.delete(loggedMessages.values().next().value);
      }
      loggedMessages.add(key);
      console.warn("[Gem Sort]", ...message);
    }

    function getTotalCacheEntries() {
      return cachePolicies.reduce(
        (total, policy) => total + policy.cache.size,
        0,
      );
    }

    function cancelScheduledCachePrune() {
      if (cachePruneTimer !== null) {
        browserRoot.clearTimeout(cachePruneTimer);
        cachePruneTimer = null;
      }
      if (cachePruneIdleHandle === null) return;

      if (
        cachePruneIdleKind === "idle" &&
        typeof browserRoot.cancelIdleCallback === "function"
      ) {
        browserRoot.cancelIdleCallback(cachePruneIdleHandle);
      } else {
        browserRoot.clearTimeout(cachePruneIdleHandle);
      }
      cachePruneIdleHandle = null;
      cachePruneIdleKind = null;
    }

    function pruneCaches() {
      cancelScheduledCachePrune();
      const now = Date.now();
      const caches = {};

      cachePolicies.forEach((policy) => {
        const result = pruneTimedCache(
          policy.cache,
          now,
          policy.limit,
        );
        policy.expiredPruned += result.expired;
        policy.evicted += result.evicted;
        caches[policy.name] = result;
      });
      cachePruneRuns += 1;
      lastCachePruneAt = now;

      if (!destroyed && getTotalCacheEntries() > 0) {
        scheduleCachePrune();
      }
      return {
        caches,
        prunedAt: now,
        remaining: getTotalCacheEntries(),
      };
    }

    function scheduleCachePrune() {
      if (
        destroyed ||
        cachePruneTimer !== null ||
        cachePruneIdleHandle !== null ||
        getTotalCacheEntries() === 0
      ) {
        return;
      }

      cachePruneTimer = browserRoot.setTimeout(() => {
        cachePruneTimer = null;
        const run = () => {
          cachePruneIdleHandle = null;
          cachePruneIdleKind = null;
          if (!destroyed) pruneCaches();
        };

        if (typeof browserRoot.requestIdleCallback === "function") {
          cachePruneIdleKind = "idle";
          cachePruneIdleHandle = browserRoot.requestIdleCallback(run, {
            timeout: CACHE_PRUNE_IDLE_TIMEOUT_MS,
          });
        } else {
          cachePruneIdleKind = "timeout";
          cachePruneIdleHandle = browserRoot.setTimeout(run, 0);
        }
      }, CACHE_PRUNE_INTERVAL_MS);
    }

    function cacheRead(cache, key) {
      const entry = cache.get(key);
      if (!entry) return { hit: false, value: undefined };
      if (entry.expiresAt <= Date.now()) {
        cache.delete(key);
        return { hit: false, value: undefined };
      }
      cache.delete(key);
      cache.set(key, entry);
      return { hit: true, value: entry.value };
    }

    function cacheWrite(cache, key, value, ttl) {
      if (destroyed) return value;
      const existing = cache.get(key);
      if (
        cache === playCountCache &&
        existing?.expiresAt > Date.now() &&
        preferPlayCount(existing.value, value) === existing.value
      ) {
        cache.delete(key);
        cache.set(key, existing);
        return existing.value;
      }
      cache.delete(key);
      cache.set(key, { value, expiresAt: Date.now() + ttl });
      const policy = cachePolicyByCache.get(cache);
      while (policy && cache.size > policy.limit) {
        const oldestKey = cache.keys().next().value;
        if (!cache.delete(oldestKey)) break;
        policy.evicted += 1;
      }
      scheduleCachePrune();
      return value;
    }

    function addStyles() {
      let style = document.getElementById(STYLE_ID);
      if (!style) {
        style = document.createElement("style");
        style.id = STYLE_ID;
        document.head.appendChild(style);
      }

      style.textContent = `
        [data-gem-sort-grid="true"] .spotify-gem-sort-header,
        [data-gem-sort-grid="true"] .spotify-gem-sort-cell {
          box-sizing: border-box;
          min-width: 0;
          padding-inline: 8px 12px;
          display: flex;
          align-items: center;
          gap: 8px;
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
          overflow: hidden;
        }

        [data-gem-sort-grid="true"] .spotify-gem-sort-header {
          justify-content: flex-end;
          color: var(--spice-subtext, var(--text-subdued, #b3b3b3));
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.02em;
          text-transform: uppercase;
        }

        [data-gem-sort-grid="true"] .spotify-gem-sort-cell {
          justify-content: flex-end;
          color: var(--spice-subtext, var(--text-subdued, #b3b3b3));
          font-size: 14px;
          font-weight: 400;
        }

        [data-gem-sort-grid="true"] .spotify-gem-sort-header > *,
        [data-gem-sort-grid="true"] .spotify-gem-sort-cell > * {
          margin-inline-end: 0 !important;
        }

        [data-gem-sort-grid="true"] .spotify-gem-sort-plays {
          flex: 1 0 110px;
          min-width: 110px;
          overflow: visible;
          text-overflow: clip;
          text-align: right;
        }

        [data-gem-sort-grid="true"] [data-gem-sort-hidden-column] {
          display: none !important;
        }

        [data-gem-sort-grid="true"] .spotify-gem-sort-separator {
          flex: 0 0 auto;
          opacity: 0.65;
        }

        [data-gem-sort-grid="true"] .spotify-gem-sort-rank {
          flex: 0 0 52px;
          text-align: right;
        }

        [data-gem-sort-grid="true"] .spotify-gem-sort-sort-button {
          appearance: none;
          border: 0;
          background: transparent;
          color: inherit;
          cursor: pointer;
          font: inherit;
          letter-spacing: inherit;
          line-height: inherit;
          padding: 0;
          text-transform: inherit;
        }

        [data-gem-sort-grid="true"] .spotify-gem-sort-sort-button:not(:disabled):hover,
        [data-gem-sort-grid="true"] .spotify-gem-sort-sort-button[aria-pressed="true"] {
          color: var(--spice-text, var(--text-base, #fff));
        }

        [data-gem-sort-grid="true"] .spotify-gem-sort-sort-button:disabled {
          cursor: not-allowed;
          opacity: 0.55;
        }

        [data-gem-sort-grid="true"] .spotify-gem-sort-sort-button:focus-visible {
          border-radius: 2px;
          outline: 2px solid var(--spice-button, #1ed760);
          outline-offset: 2px;
        }

        [data-gem-sort-grid="true"] .spotify-gem-sort-skeleton {
          min-width: 0;
          opacity: 0.35;
        }
      `;
    }

    function makeHeaderCell() {
      const cell = document.createElement("div");
      cell.className =
        "main-trackList-rowSectionVariable spotify-gem-sort-header";
      cell.setAttribute("role", "columnheader");
      cell.setAttribute("aria-label", "Spotify plays and primary artist Top 10 rank");
      cell.setAttribute("aria-sort", "none");
      cell.setAttribute("tabindex", "-1");
      cell.title =
        "Click Plays or Top 10 to sort this view; click three times to restore Spotify order";

      const plays = document.createElement("button");
      plays.type = "button";
      plays.className =
        "spotify-gem-sort-plays spotify-gem-sort-sort-button";
      plays.dataset.gemSortSortKey = "plays";
      plays.setAttribute("aria-label", "Sort playlist view by Spotify plays");
      plays.setAttribute("aria-pressed", "false");
      plays.textContent = "Plays";

      const separator = document.createElement("span");
      separator.className = "spotify-gem-sort-separator";
      separator.textContent = "·";

      const rank = document.createElement("button");
      rank.type = "button";
      rank.className =
        "spotify-gem-sort-rank spotify-gem-sort-sort-button";
      rank.dataset.gemSortSortKey = "rank";
      rank.setAttribute(
        "aria-label",
        "Sort playlist view by primary artist Top 10 rank",
      );
      rank.setAttribute("aria-pressed", "false");
      rank.textContent = "Top 10";

      [plays, rank].forEach((button) => {
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const grid = cell.closest('[role="grid"]');
          if (grid) {
            handleMetricSortRequest(
              grid,
              button.dataset.gemSortSortKey,
            );
          }
        });
      });

      cell.append(plays, separator, rank);
      return cell;
    }

    function makeDataCell() {
      const cell = document.createElement("div");
      cell.className =
        "main-trackList-rowSectionVariable spotify-gem-sort-cell";
      cell.setAttribute("role", "gridcell");

      const plays = document.createElement("span");
      plays.className = "spotify-gem-sort-plays";

      const separator = document.createElement("span");
      separator.className = "spotify-gem-sort-separator";
      separator.textContent = "·";

      const rank = document.createElement("span");
      rank.className = "spotify-gem-sort-rank";

      cell.append(plays, separator, rank);
      return cell;
    }

    function getDirectCells(container, role) {
      return Array.from(container?.children || []).filter(
        (child) => child.getAttribute?.("role") === role,
      );
    }

    function renumberCells(container, role) {
      let visibleIndex = 0;
      getDirectCells(container, role).forEach((cell) => {
        if (cell.dataset.gemSortHiddenColumn) {
          cell.removeAttribute("aria-colindex");
          return;
        }

        visibleIndex += 1;
        cell.setAttribute("aria-colindex", String(visibleIndex));
      });
    }

    function applyHiddenColumns(cells, hiddenColumnIndexes) {
      const hidden = new Set(hiddenColumnIndexes);
      cells.forEach((cell, index) => {
        if (hidden.has(index)) {
          cell.dataset.gemSortHiddenColumn = "true";
        } else {
          delete cell.dataset.gemSortHiddenColumn;
        }
      });
    }

    function restoreHiddenColumns(grid) {
      grid
        .querySelectorAll("[data-gem-sort-hidden-column]")
        .forEach((cell) => {
          delete cell.dataset.gemSortHiddenColumn;
        });
    }

    function findAlbumColumnIndex(nativeHeaders, columnTypes) {
      const namedIndex = nativeHeaders.findIndex((cell) => {
        const label = `${cell.textContent || ""} ${cell.getAttribute("aria-label") || ""}`
          .trim()
          .toLocaleLowerCase();
        return /(^|\s)album(\s|$)/.test(label);
      });
      if (namedIndex >= 0) return namedIndex;

      return columnTypes?.length === nativeHeaders.length
        ? findColumnTypeIndex(columnTypes, ["ALBUM"])
        : -1;
    }

    function findDateAddedColumnIndex(nativeHeaders, columnTypes) {
      const namedIndex = nativeHeaders.findIndex((cell) => {
        const label = `${cell.textContent || ""} ${cell.getAttribute("aria-label") || ""}`
          .trim()
          .toLocaleLowerCase();
        return label.includes("date added");
      });
      if (namedIndex >= 0) return namedIndex;

      return columnTypes?.length === nativeHeaders.length
        ? findColumnTypeIndex(columnTypes, ["ADDED_AT", "DATE_ADDED"])
        : -1;
    }

    function findNativePlaysColumnIndex(nativeHeaders, columnTypes) {
      const namedIndex = nativeHeaders.findIndex((cell) => {
        const label = `${cell.textContent || ""} ${cell.getAttribute("aria-label") || ""}`
          .trim()
          .toLocaleLowerCase();
        return /(^|\s)plays?(\s|$)/.test(label);
      });
      if (namedIndex >= 0) return namedIndex;

      return columnTypes?.length === nativeHeaders.length
        ? findColumnTypeIndex(columnTypes, ["PLAYS", "PLAY_COUNT"])
        : -1;
    }

    function shouldHideEmptyDateColumn(grid, dateColumnIndex) {
      if (dateColumnIndex < 0) return false;
      if (grid.__streamRankDataHasMeaningfulDates === false) return true;
      const rows = Array.from(grid.querySelectorAll(ROW_SELECTOR));
      let inspectedCells = 0;

      for (const row of rows) {
        const nativeCells = getDirectCells(row, "gridcell").filter(
          (cell) => !cell.classList.contains("spotify-gem-sort-cell"),
        );
        const dateCell = nativeCells[dateColumnIndex];
        if (!dateCell) continue;

        inspectedCells += 1;
        const hasDate =
          dateCell.textContent.trim() !== "" ||
          Boolean(dateCell.querySelector("time[datetime]"));
        if (hasDate) return false;
      }

      return inspectedCells > 0;
    }

    function installGridSafetyGuards(grid, headerRow) {
      if (!grid.__streamRankDropGuard) {
        const dropGuard = (event) => {
          const guarded =
            grid.dataset.gemSortSortActive === "true" ||
            sortLoading?.grid === grid;
          if (!guarded) return;
          event.stopImmediatePropagation();
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
          const noticeTarget =
            sortSession?.grid === grid ? sortSession : sortLoading;
          if (!noticeTarget?.dropNoticeShown) {
            if (noticeTarget) noticeTarget.dropNoticeShown = true;
            notify(
              "Reordering is disabled while sorting or sorted. You can still drag tracks to another playlist.",
            );
          }
        };
        grid.addEventListener("dragover", dropGuard, true);
        grid.addEventListener("drop", dropGuard, true);
        grid.__streamRankDropGuard = dropGuard;
      }

      if (!headerRow.__streamRankNativeSortGuard) {
        const nativeSortGuard = (event) => {
          if (event.target.closest(".spotify-gem-sort-sort-button")) return;
          if (
            !event.target.closest("button") ||
            (sortSession?.grid !== grid && sortLoading?.grid !== grid)
          ) {
            return;
          }
          clearMetricSort();
        };
        headerRow.addEventListener("click", nativeSortGuard, true);
        headerRow.__streamRankNativeSortGuard = nativeSortGuard;
      }
    }

    function getHeaderRow(grid) {
      return Array.from(grid.querySelectorAll('[role="row"]')).find(
        (row) => getDirectCells(row, "columnheader").length > 0,
      );
    }

    function ensureGridTemplate(
      grid,
      albumColumnIndex,
      hiddenColumnIndexes,
      nativeColumnCount,
      compactColumnIndexes,
    ) {
      const inlineTemplate = grid.style.getPropertyValue("--grid-template-columns");
      const computedTemplate = browserRoot
        .getComputedStyle(grid)
        .getPropertyValue("--grid-template-columns");
      const currentTemplate =
        inlineTemplate || computedTemplate || buildFallbackTemplate(nativeColumnCount);

      if (
        !grid.__streamRankBaseTemplate ||
        !inlineTemplate.includes("[streamRank]")
      ) {
        grid.__streamRankBaseTemplate = stripTemplateColumn(currentTemplate);
      }

      const nextTemplate = buildPlaylistTemplate(
        grid.__streamRankBaseTemplate,
        albumColumnIndex,
        nativeColumnCount,
        hiddenColumnIndexes,
        compactColumnIndexes,
      );

      if (
        nextTemplate &&
        grid.style.getPropertyValue("--grid-template-columns").trim() !== nextTemplate
      ) {
        grid.style.setProperty("--grid-template-columns", nextTemplate);
      }
    }

    function getReactProps(element) {
      if (!element) return null;
      const key = Object.keys(element).find((candidate) =>
        candidate.startsWith("__reactProps$"),
      );
      return key ? element[key] : null;
    }

    function extractRowInfo(row) {
      const candidates = [row, row.closest?.('[role="row"]')].filter(Boolean);

      for (const candidate of candidates) {
        const info = extractTrackInfoFromProps(getReactProps(candidate));
        if (info) return info;
      }

      const trackLink = row.querySelector('a[href*="/track/"]');
      const trackUri =
        spotifyUriFromHref(trackLink?.getAttribute("href"), "track") || null;
      if (!trackUri) return null;

      return {
        trackUri,
        trackName: trackLink?.textContent?.trim() || "",
        durationMs: null,
        albumUri: spotifyUriFromHref(
          row.querySelector('a[href*="/album/"]')?.getAttribute("href"),
          "album",
        ),
        artistUri: spotifyUriFromHref(
          row.querySelector('a[href*="/artist/"]')?.getAttribute("href"),
          "artist",
        ),
        artistName:
          row.querySelector('a[href*="/artist/"]')?.textContent?.trim() || "",
        isLocal: false,
      };
    }

    function resetCell(cell, info) {
      cell.dataset.gemSortTrackUri = info?.trackUri || "";
      cell.__streamRankState = {
        trackUri: info?.trackUri || "",
        artistName: info?.artistName || "",
        count: info ? LOADING : null,
        rank: info ? LOADING : null,
        rankUnavailable: false,
        topTracks: null,
      };
      renderCell(cell);
    }

    function renderCell(cell) {
      const state = cell.__streamRankState;
      if (!state) return;

      const plays = cell.querySelector(".spotify-gem-sort-plays");
      const rank = cell.querySelector(".spotify-gem-sort-rank");
      if (!plays || !rank) return;

      plays.textContent =
        state.count === LOADING ? "…" : formatPlayCount(state.count, getLocale());
      rank.textContent =
        state.rank === LOADING ? "…" : state.rank ? `#${state.rank}` : "—";

      const countDescription =
        state.count === LOADING
          ? "Loading Spotify plays"
          : state.count === null
            ? "Spotify plays unavailable"
            : `${formatPlayCount(state.count, getLocale())} Spotify plays`;

      let rankDescription = "Top 10 rank unavailable";
      if (state.rank === LOADING) {
        rankDescription = "loading primary-artist Top 10 rank";
      } else if (state.rank) {
        rankDescription = `#${state.rank} in ${state.artistName || "the primary artist"}'s Top 10`;
      } else if (!state.rankUnavailable) {
        rankDescription = `not in ${state.artistName || "the primary artist"}'s Top 10`;
      }

      cell.title = `${countDescription} · ${rankDescription}`;
      cell.setAttribute("aria-label", cell.title);
    }

    function updateCellIfCurrent(cell, expectedUri, update) {
      if (
        destroyed ||
        !cell.isConnected ||
        cell.dataset.gemSortTrackUri !== expectedUri ||
        cell.__streamRankState?.trackUri !== expectedUri
      ) {
        return false;
      }

      update(cell.__streamRankState);
      renderCell(cell);
      return true;
    }

    function getWebpackService(serviceId) {
      const chunk =
        browserRoot.webpackChunkclient_web ?? browserRoot.rspackChunkclient_web;
      if (!chunk) return null;

      const request = chunk.push([[Symbol("spotify-gem-sort")], {}, (runtime) => runtime]);
      if (!request?.m) return null;

      for (const moduleId of Object.keys(request.m)) {
        try {
          const exports = request(moduleId);
          const candidates =
            exports && typeof exports === "object"
              ? [exports, ...Object.values(exports)]
              : [exports];
          const match = candidates.find(
            (candidate) => candidate?.SERVICE_ID === serviceId,
          );
          if (match) return match;
        } catch {
          // Some Spotify modules require route-specific context and cannot be loaded here.
        }
      }

      return null;
    }

    function getMetadataServiceClient() {
      if (metadataServiceAttempted) return metadataServiceClient;
      metadataServiceAttempted = true;

      try {
        const MetadataService = getWebpackService(
          "spotify.mdata_esperanto.proto.MetadataService",
        );
        const transport =
          getSpicetify()?.Platform?.ProductStateAPI?.productStateApi?.transport;
        if (MetadataService && transport) {
          metadataServiceClient = new MetadataService(transport);
        }
      } catch (error) {
        logOnce("metadata-init", "Fast play-count service is unavailable.", error);
      }

      return metadataServiceClient;
    }

    async function fetchMetadataPlayCounts(uris) {
      const client = getMetadataServiceClient();
      if (!client) throw new Error("MetadataService is unavailable");

      const validUris = uris.filter((uri) => uri.startsWith("spotify:track:"));
      if (validUris.length === 0) return new Map();

      const response = await withTimeout(
        client.fetch({
          extensionQuery: [{ extensionKind: 185, entityUri: validUris }],
        }),
        REQUEST_TIMEOUT_MS,
        "MetadataService",
      );

      const results = new Map();
      const entities = response?.extension?.[0]?.entityExtension;
      if (!Array.isArray(entities)) return results;

      entities.forEach((item) => {
        if (
          typeof item?.entityUri === "string" &&
          item?.extensionData?.value
        ) {
          results.set(item.entityUri, parseVarint(item.extensionData.value));
        }
      });

      return results;
    }

    async function fetchAlbumCounts(albumUri) {
      if (!albumUri) return new Map();

      const cached = cacheRead(albumCache, albumUri);
      if (cached.hit) return cached.value;
      if (albumInFlight.has(albumUri)) return albumInFlight.get(albumUri);

      const request = albumLimit(async () => {
        const Spicetify = getSpicetify();
        const definition =
          Spicetify?.GraphQL?.Definitions?.getAlbum ||
          Spicetify?.GraphQL?.Definitions?.queryAlbumTracks;
        if (!definition || !Spicetify?.GraphQL?.Request) {
          throw new Error("Album GraphQL definition is unavailable");
        }

        const response = await withTimeout(
          Spicetify.GraphQL.Request(definition, {
            uri: albumUri,
            locale: getLocale(),
            offset: 0,
            limit: 500,
          }),
          REQUEST_TIMEOUT_MS,
          "Album play-count request",
        );

        if (response?.errors?.length) {
          throw new Error(response.errors[0]?.message || "Album GraphQL request failed");
        }

        const counts = extractTrackCounts(response);
        cacheWrite(albumCache, albumUri, counts, ALBUM_TTL_MS);
        counts.forEach((count, trackUri) => {
          cacheWrite(playCountCache, trackUri, count, PLAY_COUNT_TTL_MS);
        });
        return counts;
      })
        .catch((error) => {
          logOnce(`album:${albumUri}`, `Album fallback failed for ${albumUri}.`, error);
          const empty = new Map();
          cacheWrite(albumCache, albumUri, empty, FAILURE_TTL_MS);
          return empty;
        })
        .finally(() => albumInFlight.delete(albumUri));

      albumInFlight.set(albumUri, request);
      return request;
    }

    async function fetchSingleTrackCount(trackUri) {
      const Spicetify = getSpicetify();
      const definition = Spicetify?.GraphQL?.Definitions?.getTrack;
      if (!definition || !Spicetify?.GraphQL?.Request) return null;

      return trackLimit(async () => {
        try {
          const response = await withTimeout(
            Spicetify.GraphQL.Request(definition, { uri: trackUri }),
            REQUEST_TIMEOUT_MS,
            "Track play-count request",
          );
          return (
            extractTrackCounts(response).get(trackUri) ??
            toPlayCount(response?.data?.trackUnion?.playcount)
          );
        } catch (error) {
          logOnce(`track:${trackUri}`, `Track fallback failed for ${trackUri}.`, error);
          return null;
        }
      });
    }

    function requestPlayCount(info) {
      const cached = cacheRead(playCountCache, info.trackUri);
      if (cached.hit) return Promise.resolve(cached.value);
      if (playCountInFlight.has(info.trackUri)) {
        return playCountInFlight.get(info.trackUri);
      }

      let resolveRequest;
      const request = new Promise((resolve) => {
        resolveRequest = resolve;
      }).finally(() => playCountInFlight.delete(info.trackUri));

      pendingPlayCounts.set(info.trackUri, { info, resolve: resolveRequest });
      playCountInFlight.set(info.trackUri, request);

      clearTimeout(playCountBatchTimer);
      playCountBatchTimer = setTimeout(flushPlayCountBatch, PLAY_COUNT_BATCH_DELAY_MS);
      return request;
    }

    async function flushPlayCountBatch() {
      playCountBatchTimer = null;
      const batch = Array.from(pendingPlayCounts.values());
      pendingPlayCounts.clear();
      if (batch.length === 0) return;

      const resolved = new Map();

      const uris = batch.map((entry) => entry.info.trackUri);
      for (let offset = 0; offset < uris.length; offset += 100) {
        try {
          const fastCounts = await fetchMetadataPlayCounts(
            uris.slice(offset, offset + 100),
          );
          fastCounts.forEach((count, uri) => resolved.set(uri, count));
        } catch (error) {
          logOnce(
            "metadata-fetch",
            "Using GraphQL play-count fallbacks.",
            error,
          );
        }
      }

      const missing = batch.filter(
        (entry) => !resolved.has(entry.info.trackUri),
      );
      const albums = new Map();

      missing.forEach((entry) => {
        if (entry.info.albumUri && !albums.has(entry.info.albumUri)) {
          albums.set(entry.info.albumUri, fetchAlbumCounts(entry.info.albumUri));
        }
      });

      await Promise.all(
        Array.from(albums, async ([albumUri, promise]) => {
          const counts = await promise;
          counts.forEach((count, trackUri) => {
            if (!resolved.has(trackUri)) resolved.set(trackUri, count);
          });
          return albumUri;
        }),
      );

      const stillMissing = missing.filter(
        (entry) => !resolved.has(entry.info.trackUri),
      );

      await Promise.all(
        stillMissing.map(async (entry) => {
          const count = await fetchSingleTrackCount(entry.info.trackUri);
          if (count !== null) resolved.set(entry.info.trackUri, count);
        }),
      );

      batch.forEach((entry) => {
        const value = resolved.get(entry.info.trackUri) ?? null;
        const storedValue = cacheWrite(
          playCountCache,
          entry.info.trackUri,
          value,
          value === null ? FAILURE_TTL_MS : PLAY_COUNT_TTL_MS,
        );
        entry.resolve(storedValue);
      });
    }

    async function resolveBulkPlayCounts(infos, isCancelled) {
      const uniqueInfos = new Map();
      (Array.isArray(infos) ? infos : []).forEach((info) => {
        if (
          info &&
          !info.isLocal &&
          typeof info.trackUri === "string" &&
          info.trackUri.startsWith("spotify:track:") &&
          !uniqueInfos.has(info.trackUri)
        ) {
          uniqueInfos.set(info.trackUri, info);
        }
      });

      const resolved = new Map();
      const missing = new Map();
      const existingRequests = [];
      if (uniqueInfos.size > 0) bulkPlaySorts += 1;
      uniqueInfos.forEach((info, trackUri) => {
        const cached = cacheRead(playCountCache, trackUri);
        if (cached.hit) {
          resolved.set(trackUri, cached.value);
          return;
        }
        const inFlight = playCountInFlight.get(trackUri);
        if (inFlight) {
          existingRequests.push(
            inFlight.then((value) => resolved.set(trackUri, value)),
          );
          return;
        }
        missing.set(trackUri, info);
      });

      await Promise.all(existingRequests);
      if (isCancelled()) return null;

      const ownedRequests = new Map();
      const lateRequests = [];
      missing.forEach((info, trackUri) => {
        const cached = cacheRead(playCountCache, trackUri);
        if (cached.hit) {
          resolved.set(trackUri, cached.value);
          return;
        }
        const inFlight = playCountInFlight.get(trackUri);
        if (inFlight) {
          lateRequests.push(
            inFlight.then((value) => resolved.set(trackUri, value)),
          );
          return;
        }

        ownedRequests.set(trackUri, info);
      });

      function completeOwned(trackUri, value, cacheResult = true) {
        if (!ownedRequests.has(trackUri)) return;
        if (cacheResult) {
          value = cacheWrite(
            playCountCache,
            trackUri,
            value,
            value === null ? FAILURE_TTL_MS : PLAY_COUNT_TTL_MS,
          );
        }
        resolved.set(trackUri, value);
        ownedRequests.delete(trackUri);
      }

      await Promise.all(lateRequests);
      if (isCancelled()) return null;

      const metadataUris = Array.from(ownedRequests.keys());
      for (
        let offset = 0;
        offset < metadataUris.length;
        offset += SORT_PLAY_COUNT_BATCH_SIZE
      ) {
        if (isCancelled()) return null;
        try {
          const fastCounts = await fetchMetadataPlayCounts(
            metadataUris.slice(
              offset,
              offset + SORT_PLAY_COUNT_BATCH_SIZE,
            ),
          );
          fastCounts.forEach((count, trackUri) => {
            if (uniqueInfos.has(trackUri)) {
              completeOwned(trackUri, count);
            }
          });
        } catch (error) {
          logOnce(
            "metadata-sort-fetch",
            "Using GraphQL fallbacks for full-playlist sorting.",
            error,
          );
          break;
        }
      }

      if (isCancelled()) return null;
      const albums = new Set();
      ownedRequests.forEach((info) => {
        if (info.albumUri) albums.add(info.albumUri);
      });
      const albumUris = Array.from(albums);
      let nextAlbumIndex = 0;
      await Promise.all(
        Array.from(
          {
            length: Math.min(
              COMPLETE_LIST_CONCURRENCY,
              albumUris.length,
            ),
          },
          async () => {
            while (nextAlbumIndex < albumUris.length) {
              if (isCancelled()) return;
              const albumUri = albumUris[nextAlbumIndex++];
              const counts = await fetchAlbumCounts(albumUri);
              counts.forEach((count, trackUri) => {
                if (ownedRequests.has(trackUri)) {
                  completeOwned(trackUri, count);
                }
              });
            }
          },
        ),
      );

      if (isCancelled()) return null;
      const remainingTrackUris = Array.from(ownedRequests.keys());
      let nextTrackIndex = 0;
      await Promise.all(
        Array.from(
          {
            length: Math.min(
              COMPLETE_LIST_CONCURRENCY,
              remainingTrackUris.length,
            ),
          },
          async () => {
            while (nextTrackIndex < remainingTrackUris.length) {
              if (isCancelled()) return;
              const trackUri =
                remainingTrackUris[nextTrackIndex++];
              const count = await fetchSingleTrackCount(trackUri);
              if (count !== null) completeOwned(trackUri, count);
            }
          },
        ),
      );

      if (isCancelled()) return null;
      Array.from(ownedRequests.keys()).forEach((trackUri) => {
        completeOwned(trackUri, null);
      });
      return resolved;
    }

    function requestArtistTopTracks(artistUri, fallbackName) {
      if (!artistUri) {
        return Promise.resolve({
          artistName: fallbackName || "",
          byUri: new Map(),
          records: [],
          unavailable: true,
        });
      }

      const cached = cacheRead(artistCache, artistUri);
      if (cached.hit) {
        artistRequestMetrics.cacheHits += 1;
        return Promise.resolve(cached.value);
      }
      if (artistInFlight.has(artistUri)) {
        artistRequestMetrics.deduplicated += 1;
        return artistInFlight.get(artistUri);
      }

      const request = artistLimit(async () => {
        const startedAt = Date.now();
        artistRequestMetrics.active += 1;
        artistRequestMetrics.peak = Math.max(
          artistRequestMetrics.peak,
          artistRequestMetrics.active,
        );

        try {
          const Spicetify = getSpicetify();
          const definition =
            Spicetify?.GraphQL?.Definitions?.queryArtistOverview;
          if (!definition || !Spicetify?.GraphQL?.Request) {
            throw new Error(
              "Artist overview GraphQL definition is unavailable",
            );
          }

          const response = await withTimeout(
            Spicetify.GraphQL.Request(definition, {
              uri: artistUri,
              locale: getLocale(),
              includePrerelease: false,
            }),
            REQUEST_TIMEOUT_MS,
            "Artist Top 10 request",
          );

          if (response?.errors?.length) {
            throw new Error(
              response.errors[0]?.message ||
                "Artist GraphQL request failed",
            );
          }

          const { byUri, records } = buildTopTrackIndex(response);
          byUri.forEach((record, trackUri) => {
            if (record.playcount !== null) {
              cacheWrite(
                playCountCache,
                trackUri,
                record.playcount,
                PLAY_COUNT_TTL_MS,
              );
            }
          });

          const value = {
            artistName:
              response?.data?.artistUnion?.profile?.name ||
              fallbackName ||
              "",
            byUri,
            records,
            unavailable: false,
          };
          cacheWrite(artistCache, artistUri, value, ARTIST_TTL_MS);
          artistRequestMetrics.completed += 1;
          return value;
        } catch (error) {
          artistRequestMetrics.failed += 1;
          throw error;
        } finally {
          artistRequestMetrics.active -= 1;
          artistRequestMetrics.totalDurationMs += Date.now() - startedAt;
        }
      })
        .catch((error) => {
          logOnce(`artist:${artistUri}`, `Top 10 lookup failed for ${artistUri}.`, error);
          const value = {
            artistName: fallbackName || "",
            byUri: new Map(),
            records: [],
            unavailable: true,
          };
          cacheWrite(artistCache, artistUri, value, FAILURE_TTL_MS);
          return value;
        })
        .finally(() => artistInFlight.delete(artistUri));

      artistInFlight.set(artistUri, request);
      return request;
    }

    function notify(message, isError = false) {
      try {
        getSpicetify()?.showNotification?.(message, isError);
      } catch {
        // Notifications are helpful but not required for the extension to work.
      }
    }

    function getTracklistInternals(grid) {
      const headerRow = getHeaderRow(grid);
      const seed =
        getDirectCells(headerRow, "columnheader").find(
          (cell) => !cell.classList.contains("spotify-gem-sort-header"),
        ) || grid;
      const fiberKey = Object.keys(seed || {}).find((key) =>
        key.startsWith("__reactFiber"),
      );
      let controller = null;
      let playlistUri = null;
      let collectionUri = null;
      let formatListData = null;
      let renderedColumnTypes = null;

      for (
        let fiber = fiberKey ? seed[fiberKey] : null;
        fiber;
        fiber = fiber.return
      ) {
        const props = fiber.memoizedProps || {};
        if (
          !controller &&
          props.itemsCache?.invalidateCache &&
          props.itemsCache?.getItems
        ) {
          controller = {
            cache: props.itemsCache,
            canFetchAllTracks: props.canFetchAllTracks !== false,
            outer: props.outerRef?.current || null,
          };
        }
        if (!playlistUri && typeof props.playlistUri === "string") {
          playlistUri = props.playlistUri;
        }
        if (!collectionUri && typeof props.collectionUri === "string") {
          collectionUri = props.collectionUri;
        }
        if (!formatListData && props.formatListData) {
          formatListData = props.formatListData;
        }
        if (
          !renderedColumnTypes &&
          Array.isArray(props.columns) &&
          props.columns.some(
            (column) =>
              column &&
              typeof column === "object" &&
              typeof column.columnType === "string",
          )
        ) {
          const visibleColumnTypes = props.columns
            .filter(
              (column) =>
                column &&
                typeof column === "object" &&
                typeof column.columnType === "string" &&
                column.hidden !== true,
            )
            .map((column) => column.columnType);
          if (visibleColumnTypes.length > 0) {
            renderedColumnTypes = visibleColumnTypes;
          }
        }
      }

      return {
        controller,
        playlistUri,
        collectionUri,
        formatListData,
        renderedColumnTypes,
      };
    }

    function getSortContext(grid) {
      const path = getCurrentPath();
      const internals = getTracklistInternals(grid);
      const Spicetify = getSpicetify();
      const playlistMatch = path.match(/^\/playlist\/([A-Za-z0-9]{22})/);

      if (playlistMatch && Spicetify?.Platform?.PlaylistAPI?.getContents) {
        const uri =
          internals.playlistUri || `spotify:playlist:${playlistMatch[1]}`;
        return {
          kind: "playlist",
          grid,
          internals,
          methodName: "getContents",
          optionsIndex: 1,
          owner: Spicetify.Platform.PlaylistAPI,
          path,
          uri,
        };
      }

      if (
        path === "/collection/tracks" &&
        Spicetify?.Platform?.LibraryAPI?.getTracks
      ) {
        return {
          kind: "liked",
          grid,
          internals,
          methodName: "getTracks",
          optionsIndex: 0,
          owner: Spicetify.Platform.LibraryAPI,
          path,
          uri:
            internals.collectionUri ||
            Spicetify.Platform.LibraryAPI._likedSongsUri ||
            "spotify:collection:tracks",
        };
      }

      return null;
    }

    function replaceApiMethod(owner, methodName, replacement) {
      const ownDescriptor = Object.getOwnPropertyDescriptor(owner, methodName);
      const previous = owner[methodName];

      try {
        owner[methodName] = replacement;
      } catch {
        // Fall through to defineProperty for inherited methods.
      }

      if (owner[methodName] !== replacement) {
        Object.defineProperty(owner, methodName, {
          configurable: true,
          enumerable: ownDescriptor?.enumerable ?? false,
          value: replacement,
          writable: true,
        });
      }

      return {
        previous,
        replacement,
        restore() {
          if (owner[methodName] !== replacement) return false;
          if (ownDescriptor) {
            Object.defineProperty(owner, methodName, ownDescriptor);
          } else {
            delete owner[methodName];
          }
          return true;
        },
      };
    }

    function isTargetListCall(context, args) {
      if (getCurrentPath() !== context.path) return false;
      if (context.kind === "playlist") return args[0] === context.uri;
      const options = args[context.optionsIndex];
      return (
        options &&
        typeof options === "object" &&
        Number.isFinite(Number(options.offset ?? 0))
      );
    }

    async function captureCurrentListRequest(context, operationId) {
      const previousCapture = captureLock;
      let releaseCapture;
      captureLock = new Promise((resolve) => {
        releaseCapture = resolve;
      });
      await previousCapture;

      const { owner, methodName } = context;
      let methodHandle = null;

      try {
        if (
          operationId !== sortOperationId ||
          getCurrentPath() !== context.path
        ) {
          return null;
        }

        const upstream = owner[methodName];
        if (typeof upstream !== "function") {
          throw new Error("Spotify list data source is unavailable");
        }

        let resolveCapture;
        const capturedRequest = new Promise((resolve) => {
          resolveCapture = resolve;
        });
        let cancelCapture;
        const cancelledRequest = new Promise((resolve) => {
          cancelCapture = () => resolve(null);
        });
        if (sortLoading?.operationId === operationId) {
          sortLoading.cancelCapture = cancelCapture;
        }
        let captured = false;

        const captureWrapper = async function captureListCall(...args) {
          const response = await upstream.apply(this, args);
          if (
            !captured &&
            isTargetListCall(context, args) &&
            Array.isArray(response?.items)
          ) {
            captured = true;
            resolveCapture({ args, response });
          }
          return response;
        };
        methodHandle = replaceApiMethod(
          owner,
          methodName,
          captureWrapper,
        );

        const current = getTracklistInternals(context.grid).controller;
        if (!current?.cache?.invalidateCache) {
          throw new Error("Spotify list cache is unavailable");
        }
        current.cache.invalidateCache();
        const capturedValue = await withTimeout(
          Promise.race([capturedRequest, cancelledRequest]),
          5_000,
          "Playlist view capture",
        );
        if (
          !capturedValue ||
          operationId !== sortOperationId ||
          getCurrentPath() !== context.path
        ) {
          return null;
        }
        return {
          ...capturedValue,
          upstream,
        };
      } finally {
        if (sortLoading?.operationId === operationId) {
          delete sortLoading.cancelCapture;
        }
        methodHandle?.restore();
        releaseCapture();
      }
    }

    async function fetchCompleteList(context, capture, operationId) {
      const options =
        capture.args[context.optionsIndex] &&
        typeof capture.args[context.optionsIndex] === "object"
          ? capture.args[context.optionsIndex]
          : {};
      const totalLength = Number(capture.response.totalLength);
      if (!Number.isSafeInteger(totalLength) || totalLength < 1) {
        throw new Error("This playlist has no sortable tracks");
      }

      const items = new Array(totalLength);
      const capturedOffset = getCapturedPageOffset(
        options,
        capture.response,
        totalLength,
      );
      const capturedItems = capture.response.items.slice(
        0,
        totalLength - capturedOffset,
      );
      capturedItems.forEach((item, index) => {
        items[capturedOffset + index] = item;
      });
      const ranges = buildMissingRanges(
        totalLength,
        COMPLETE_LIST_PAGE_SIZE,
        capturedOffset,
        capturedItems.length,
      );
      const listLimit = createLimiter(COMPLETE_LIST_CONCURRENCY);
      const responses = await Promise.all(
        ranges.map(({ offset, limit }) =>
          listLimit(async () => {
            if (
              operationId !== sortOperationId ||
              getCurrentPath() !== context.path
            ) {
              return null;
            }
            const args = capture.args.slice();
            args[context.optionsIndex] = {
              ...options,
              offset,
              limit,
            };
            const response = await withTimeout(
              capture.upstream.apply(context.owner, args),
              REQUEST_TIMEOUT_MS,
              "Playlist page request",
            );
            if (
              operationId !== sortOperationId ||
              getCurrentPath() !== context.path
            ) {
              return null;
            }
            if (
              Number(response?.totalLength) !== totalLength ||
              !Array.isArray(response?.items)
            ) {
              throw new Error(
                "Playlist changed while sorting; please try again",
              );
            }

            response.items.forEach((item, index) => {
              items[offset + index] = item;
            });
            return response;
          }),
        ),
      );
      if (responses.some((response) => response === null)) return null;

      for (let index = 0; index < items.length; index += 1) {
        if (!(index in items)) {
          throw new Error("Spotify did not return the complete playlist");
        }
      }

      const responseBase = { ...capture.response };
      delete responseBase.items;
      delete responseBase.offset;
      delete responseBase.limit;
      delete responseBase.totalLength;

      return {
        items,
        options,
        queryFingerprint: fingerprintQueryOptions(options),
        responseBase,
      };
    }

    function updateSortHeader(grid) {
      if (!grid) return;
      const header = grid.querySelector(".spotify-gem-sort-header");
      if (!header) return;

      const sortingUnavailable = getCurrentPath() === "/collection/tracks";
      const state =
        sortSession?.grid === grid ? sortSession.sortState : null;
      const loading =
        sortLoading?.grid === grid ? sortLoading : null;
      const plays = header.querySelector(
        '[data-gem-sort-sort-key="plays"]',
      );
      const rank = header.querySelector(
        '[data-gem-sort-sort-key="rank"]',
      );

      [
        ["plays", plays, "Plays"],
        ["rank", rank, "Top 10"],
      ].forEach(([key, button, label]) => {
        if (!button) return;
        const active = state?.key === key;
        const busy = loading?.key === key;
        const disabled = Boolean(loading) || sortingUnavailable;
        const arrow =
          active && !busy
            ? state.direction === "asc"
              ? " ↑"
              : " ↓"
            : busy
              ? " …"
              : "";
        button.textContent = `${label}${arrow}`;
        button.setAttribute("aria-pressed", String(active));
        button.setAttribute("aria-disabled", String(disabled));
        button.setAttribute(
          "aria-label",
          sortingUnavailable
            ? `${label} sorting is unavailable in Liked Songs on this Spotify version`
            : key === "plays"
              ? "Sort playlist view by Spotify plays"
              : "Sort playlist view by primary artist Top 10 rank",
        );
        button.disabled = disabled;
      });

      header.setAttribute(
        "aria-sort",
        state
          ? state.direction === "asc"
            ? "ascending"
            : "descending"
          : "none",
      );
      if (loading) {
        header.title =
          loading.key === "plays"
            ? "Loading exact play counts for the full playlist…"
            : "Loading each primary artist's Top 10 for the full playlist…";
      } else if (sortingUnavailable) {
        header.title =
          "Counts and ranks are available here, but this Spotify version does not expose a safe Liked Songs view-sort loader";
      } else if (state) {
        header.title =
          "View-only sort: the playlist is not rewritten; new playback follows this order when Shuffle is off";
      } else {
        header.title =
          "Click Plays or Top 10 to sort this view; click three times to restore Spotify order";
      }
    }

    function scrollGridToTop(grid) {
      browserRoot.setTimeout(() => {
        if (!grid?.isConnected) return;
        const main = document.querySelector("main");
        const scroller = Array.from(document.querySelectorAll("body *")).find(
          (element) =>
            element !== main &&
            element.contains(grid) &&
            element.scrollHeight > element.clientHeight &&
            ["auto", "scroll"].includes(
              browserRoot.getComputedStyle(element).overflowY,
            ),
        );
        if (scroller) {
          scroller.scrollTop = 0;
          scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
          return;
        }
        getTracklistInternals(grid).controller?.outer?.scrollToIndex?.(0);
      }, 80);
    }

    function invalidateSortedGrid(grid, scrollToTop = true) {
      const controller = getTracklistInternals(grid).controller;
      controller?.cache?.invalidateCache?.();
      if (scrollToTop) scrollGridToTop(grid);
    }

    function installSortedDataSource(session) {
      const { context } = session;
      const upstream = context.owner[context.methodName];
      if (typeof upstream !== "function") {
        throw new Error("Spotify list data source is unavailable");
      }

      const sortedWrapper = async function serveSortedList(...args) {
        const active = sortSession;
        const options =
          args[context.optionsIndex] &&
          typeof args[context.optionsIndex] === "object"
            ? args[context.optionsIndex]
            : {};
        const matches =
          active === session &&
          getCurrentPath() === session.path &&
          (context.kind !== "playlist" || args[0] === session.uri) &&
          fingerprintQueryOptions(options) === session.queryFingerprint;

        if (!matches) return upstream.apply(this, args);

        const offset = Math.max(0, Number(options.offset) || 0);
        const requestedLimit = Number(options.limit);
        const limit =
          Number.isFinite(requestedLimit) && requestedLimit >= 0
            ? requestedLimit
            : session.sortedItems.length;
        const response = {
          ...session.responseBase,
          items: session.sortedItems.slice(offset, offset + limit),
          offset,
          limit,
          totalLength: session.sortedItems.length,
        };
        if (
          context.kind === "liked" &&
          !Number.isFinite(Number(response.unfilteredTotalLength))
        ) {
          response.unfilteredTotalLength = session.sortedItems.length;
        }
        return response;
      };

      session.methodHandle = replaceApiMethod(
        context.owner,
        context.methodName,
        sortedWrapper,
      );
    }

    function installSortedPlaybackSource(session) {
      const playerApi = getSpicetify()?.Platform?.PlayerAPI;
      const playerPlayOwner = findMethodOwner(playerApi, "play");
      if (!playerPlayOwner) {
        logOnce(
          "sorted-playback-unavailable",
          "Sorted playback context is unavailable on this Spotify version.",
        );
        return;
      }

      const upstream = playerPlayOwner.play;
      const sortedPlayWrapper = function playSortedContext(
        context,
        ...remainingArgs
      ) {
        const shouldUseSortedContext =
          sortSession === session &&
          getCurrentPath() === session.path &&
          getPlaybackContextUri(context) === session.uri;
        if (!shouldUseSortedContext) {
          return upstream.call(this, context, ...remainingArgs);
        }

        if (
          !session.playbackContext ||
          session.playbackContextGeneration !==
            session.sortGeneration
        ) {
          session.playbackContext = buildSortedPlaybackContext(
            session.sortedItems,
            session.uri,
            session.sortGeneration,
          );
          session.playbackContextGeneration =
            session.sortGeneration;
        }
        const sortedContext = session.playbackContext;
        if (sortedContext.pages[0].items.length === 0) {
          return upstream.call(this, context, ...remainingArgs);
        }
        const originalOptions = remainingArgs[1];
        const remappedOptions = remapSortedPlaybackOptions(
          sortedContext.pages[0].items,
          originalOptions,
        );
        if (!remappedOptions) {
          return upstream.call(this, context, ...remainingArgs);
        }
        remainingArgs[1] = remappedOptions;
        if (
          !session.shuffleNoticeShown &&
          getSpicetify()?.Player?.getShuffle?.()
        ) {
          session.shuffleNoticeShown = true;
          notify("Shuffle turned off to follow the sorted playlist order.");
        }

        session.sortedPlaybackStarts += 1;
        sortedPlaybackStarts += 1;
        return upstream.call(this, sortedContext, ...remainingArgs);
      };

      try {
        session.playerPlayHandle = replaceApiMethod(
          playerPlayOwner,
          "play",
          sortedPlayWrapper,
        );
      } catch (error) {
        logOnce(
          "sorted-playback-install",
          "Sorted playback context could not be installed.",
          error,
        );
      }
    }

    function installPlaylistMutationListener(session) {
      if (session.context.kind !== "playlist") return;

      try {
        const events =
          getSpicetify()?.Platform?.PlaylistAPI?.getEvents?.();
        if (!events?.addListener) return;

        let unlisten = null;
        const handleUpdate = () => {
          browserRoot.setTimeout(() => {
            const activeTarget =
              sortSession?.updateUnlisten === unlisten
                ? sortSession
                : sortLoading?.updateUnlisten === unlisten
                  ? sortLoading
                  : null;
            if (!activeTarget) return;
            const wasLoading = activeTarget === sortLoading;
            clearMetricSort();
            notify(
              wasLoading
                ? "Playlist changed while sorting; restored Spotify order."
                : "Playlist changed; restored Spotify order.",
            );
          }, 0);
        };
        unlisten = events.addListener(
          "update",
          handleUpdate,
          { uri: session.uri },
        );
        if (typeof unlisten === "function") {
          session.updateUnlisten = unlisten;
        }
      } catch (error) {
        logOnce(
          "playlist-update-listener",
          "Playlist update listener is unavailable.",
          error,
        );
      }
    }

    async function loadMetricRecords(session, key, operationId) {
      if (session.loadedMetrics.has(key)) {
        return selectMetricRecordValues(session.records, key);
      }

      const records = session.records;
      const isCancelled = () =>
        operationId !== sortOperationId ||
        getCurrentPath() !== session.path;

      const loadPlays = async () => {
        if (session.loadedMetrics.has("plays")) return true;
        const counts = await resolveBulkPlayCounts(
          records.map((record) => record.info),
          isCancelled,
        );
        if (!counts || isCancelled()) return false;
        records.forEach((record) => {
          if (record.info) {
            record.plays = counts.get(record.info.trackUri) ?? null;
          }
        });
        session.loadedMetrics.add("plays");
        return true;
      };

      const loadRanks = async () => {
        const artists = new Map();
        records.forEach((record) => {
          if (!record.info?.artistUri || record.info.isLocal) return;
          if (!artists.has(record.info.artistUri)) {
            artists.set(record.info.artistUri, {
              name: record.info.artistName,
              records: [],
            });
          }
          artists.get(record.info.artistUri).records.push(record);
        });

        const entries = Array.from(artists);
        const concurrency = getArtistSortConcurrency(entries.length);
        const progress = {
          completed: 0,
          concurrency,
          durationMs: null,
          startedAt: Date.now(),
          total: entries.length,
        };
        session.artistProgress = progress;
        if (sortLoading?.operationId === operationId) {
          sortLoading.artistProgress = progress;
        }
        let nextArtistIndex = 0;
        await Promise.all(
          Array.from(
            {
              length: Math.min(
                concurrency,
                entries.length,
              ),
            },
            async () => {
              while (nextArtistIndex < entries.length) {
                if (isCancelled()) return;
                const [artistUri, group] =
                  entries[nextArtistIndex++];
                const artist = await requestArtistTopTracks(
                  artistUri,
                  group.name,
                );
                group.records.forEach((record) => {
                  record.rank =
                    findTopTrackRecord(artist, record.info)?.rank ?? null;
                });
                progress.completed += 1;
              }
            },
          ),
        );
        progress.durationMs = Date.now() - progress.startedAt;
        if (isCancelled()) return false;
        session.loadedMetrics.add("rank");
        return true;
      };

      if (key === "plays") {
        if (!(await loadPlays())) return null;
      } else {
        const [playsLoaded, ranksLoaded] = await Promise.all([
          loadPlays(),
          loadRanks(),
        ]);
        if (!playsLoaded || !ranksLoaded) return null;
      }

      if (isCancelled()) return null;
      return selectMetricRecordValues(records, key);
    }

    function releaseSortSessionMemory(session) {
      if (!session) return;
      session.loadedMetrics?.clear?.();
      if (Array.isArray(session.records)) session.records.length = 0;
      if (Array.isArray(session.sortedItems)) {
        session.sortedItems.length = 0;
      }
      session.playbackContext = null;
      session.responseBase = null;
      session.artistProgress = null;
    }

    function clearMetricSort({
      invalidate = true,
      scrollToTop = true,
    } = {}) {
      sortOperationId += 1;
      const loading = sortLoading;
      const loadingGrid = loading?.grid || null;
      loading?.cancelCapture?.();
      try {
        loading?.updateUnlisten?.();
      } catch (error) {
        logOnce(
          "playlist-loading-update-unlisten",
          "Playlist loading listener could not be removed.",
          error,
        );
      }
      if (loading) loading.updateUnlisten = null;
      sortLoading = null;
      const session = sortSession;
      sortSession = null;

      if (session) {
        try {
          session.updateUnlisten?.();
        } catch (error) {
          logOnce(
            "playlist-update-unlisten",
            "Playlist update listener could not be removed.",
            error,
          );
        }
        session.updateUnlisten = null;
        session.playerPlayHandle?.restore();
        session.playerPlayHandle = null;
        session.methodHandle?.restore();
        delete session.grid.dataset.gemSortSortActive;
        updateSortHeader(session.grid);
        if (invalidate && session.grid.isConnected) {
          invalidateSortedGrid(session.grid, scrollToTop);
        }
        releaseSortSessionMemory(session);
      }
      if (loadingGrid && loadingGrid !== session?.grid) {
        updateSortHeader(loadingGrid);
      }
    }

    async function handleMetricSortRequest(grid, requestedKey) {
      if (!["plays", "rank"].includes(requestedKey)) return;
      if (getCurrentPath() === "/collection/tracks") {
        notify("Sorting is unavailable in Liked Songs on this Spotify version.");
        return;
      }
      if (sortLoading) {
        notify("Gem Sort is still loading this sort.");
        return;
      }

      const currentState =
        sortSession?.grid === grid ? sortSession.sortState : null;
      const nextState = nextMetricSortState(
        currentState,
        requestedKey,
      );
      if (!nextState) {
        clearMetricSort();
        return;
      }

      if (sortSession && sortSession.grid !== grid) {
        clearMetricSort({ scrollToTop: false });
      }

      const operationId = ++sortOperationId;
      sortLoading = { grid, key: requestedKey, operationId };
      updateSortHeader(grid);

      try {
        let session =
          sortSession?.grid === grid ? sortSession : null;
        if (!session) {
          const context = getSortContext(grid);
          if (!context) {
            throw new Error("Sorting is unavailable in this playlist view");
          }
          sortLoading.context = context;
          sortLoading.uri = context.uri;
          installPlaylistMutationListener(sortLoading);
          const capture = await captureCurrentListRequest(
            context,
            operationId,
          );
          if (!capture) return;
          const complete = await fetchCompleteList(
            context,
            capture,
            operationId,
          );
          if (!complete) return;

          session = {
            context,
            grid,
            artistProgress: null,
            loadedMetrics: new Set(),
            methodHandle: null,
            path: context.path,
            playbackContext: null,
            playbackContextGeneration: null,
            playerPlayHandle: null,
            queryFingerprint: complete.queryFingerprint,
            records: buildMetricRecords(complete.items),
            responseBase: complete.responseBase,
            sortState: null,
            sortGeneration: operationId,
            sortedPlaybackStarts: 0,
            sortedItems: complete.items,
            uri: context.uri,
            updateUnlisten: sortLoading?.updateUnlisten || null,
          };

          const hasMeaningfulDates = complete.items.some((item) => {
            const timestamp = Date.parse(item?.addedAt || "");
            return Number.isFinite(timestamp) && timestamp > 0;
          });
          grid.__streamRankDataHasMeaningfulDates = hasMeaningfulDates;
        }

        const records = await loadMetricRecords(
          session,
          requestedKey,
          operationId,
        );
        if (
          !records ||
          operationId !== sortOperationId ||
          getCurrentPath() !== session.path
        ) {
          return;
        }

        session.sortState = nextState;
        session.sortedItems = sortMetricRecords(
          records,
          nextState.direction,
          requestedKey === "rank"
            ? {
                secondaryDirection: "desc",
                secondaryKey: "plays",
              }
            : undefined,
        ).map((record) => record.item);
        session.sortGeneration = operationId;
        session.playbackContext = null;
        session.playbackContextGeneration = null;

        if (!session.methodHandle) {
          sortSession = session;
          if (sortLoading?.operationId === operationId) {
            sortLoading.updateUnlisten = null;
          }
          installSortedDataSource(session);
          installSortedPlaybackSource(session);
          if (!session.updateUnlisten) {
            installPlaylistMutationListener(session);
          }
        } else {
          sortSession = session;
        }
        session.grid.dataset.gemSortSortActive = "true";
        sortLoading = null;
        updateSortHeader(session.grid);
        invalidateSortedGrid(session.grid);
        scheduleReconcile(120);
      } catch (error) {
        if (operationId === sortOperationId) {
          clearMetricSort({ invalidate: false });
          notify(
            `Could not sort this view: ${error?.message || "unknown error"}`,
            true,
          );
          console.error("[Gem Sort] Sort failed.", error);
        }
      } finally {
        if (sortLoading?.operationId === operationId) {
          sortLoading = null;
          updateSortHeader(grid);
        }
      }
    }

    function populateCell(cell, info) {
      if (!info) {
        if (cell.dataset.gemSortTrackUri !== "") resetCell(cell, null);
        return;
      }

      if (cell.dataset.gemSortTrackUri === info.trackUri) return;
      resetCell(cell, info);

      if (info.isLocal || !info.trackUri.startsWith("spotify:track:")) {
        updateCellIfCurrent(cell, info.trackUri, (state) => {
          state.count = null;
          state.rank = null;
          state.rankUnavailable = true;
        });
        return;
      }

      requestPlayCount(info).then((count) => {
        updateCellIfCurrent(cell, info.trackUri, (state) => {
          state.count = count;
          if (state.topTracks) {
            state.rank =
              findTopTrackRecord(state.topTracks, info, count)?.rank ?? null;
          }
        });
      });

      requestArtistTopTracks(info.artistUri, info.artistName).then((artist) => {
        updateCellIfCurrent(cell, info.trackUri, (state) => {
          const count = state.count === LOADING ? null : state.count;
          const record = findTopTrackRecord(artist, info, count);
          state.topTracks = artist;
          state.artistName = artist.artistName || info.artistName;
          state.rank = record?.rank ?? null;
          state.rankUnavailable = artist.unavailable;
          if (
            (state.count === LOADING || state.count === null) &&
            record?.playcount !== null &&
            record?.playcount !== undefined
          ) {
            state.count = record.playcount;
          }
        });
      });
    }

    function ensureHeader(
      grid,
      headerRow,
      albumColumnIndex,
      hiddenColumnIndexes,
    ) {
      let header = headerRow.querySelector(
        ":scope > .spotify-gem-sort-header",
      );
      const nativeHeaders = getDirectCells(headerRow, "columnheader").filter(
        (cell) => !cell.classList.contains("spotify-gem-sort-header"),
      );
      const endHeader = nativeHeaders[nativeHeaders.length - 1] || null;
      const insertionReference =
        albumColumnIndex >= 0
          ? nativeHeaders[albumColumnIndex + 1] || endHeader
          : endHeader;

      applyHiddenColumns(nativeHeaders, hiddenColumnIndexes);
      if (!header) header = makeHeaderCell();
      if (
        insertionReference &&
        header.nextElementSibling !== insertionReference
      ) {
        headerRow.insertBefore(header, insertionReference);
      } else if (!header.isConnected) {
        headerRow.appendChild(header);
      }

      renumberCells(headerRow, "columnheader");
      grid.setAttribute(
        "aria-colcount",
        String(
          nativeHeaders.length -
            new Set(hiddenColumnIndexes).size +
            1,
        ),
      );
      installGridSafetyGuards(grid, headerRow);
      updateSortHeader(grid);
      return nativeHeaders.length;
    }

    function ensurePlaceholder(
      placeholder,
      albumColumnIndex,
      hiddenColumnIndexes,
    ) {
      let cell = placeholder.querySelector(
        ":scope > .spotify-gem-sort-skeleton",
      );
      const nativeChildren = Array.from(placeholder.children).filter(
        (child) => !child.classList.contains("spotify-gem-sort-skeleton"),
      );
      const endCell = nativeChildren[nativeChildren.length - 1] || null;
      const insertionReference =
        albumColumnIndex >= 0
          ? nativeChildren[albumColumnIndex + 1] || endCell
          : endCell;

      applyHiddenColumns(nativeChildren, hiddenColumnIndexes);
      if (!cell) {
        cell = document.createElement("div");
        cell.className =
          "main-trackList-rowSectionVariable spotify-gem-sort-skeleton";
      }

      if (
        insertionReference &&
        cell.nextElementSibling !== insertionReference
      ) {
        placeholder.insertBefore(cell, insertionReference);
      } else if (!cell.isConnected) {
        placeholder.appendChild(cell);
      }
    }

    function ensureRow(row, albumColumnIndex, hiddenColumnIndexes) {
      let cell = row.querySelector(":scope > .spotify-gem-sort-cell");
      const nativeCells = getDirectCells(row, "gridcell").filter(
        (candidate) =>
          !candidate.classList.contains("spotify-gem-sort-cell"),
      );
      const endCell = nativeCells[nativeCells.length - 1] || null;
      const insertionReference =
        albumColumnIndex >= 0
          ? nativeCells[albumColumnIndex + 1] || endCell
          : endCell;

      applyHiddenColumns(nativeCells, hiddenColumnIndexes);
      if (!cell) cell = makeDataCell();
      if (
        insertionReference &&
        cell.nextElementSibling !== insertionReference
      ) {
        row.insertBefore(cell, insertionReference);
      } else if (!cell.isConnected) {
        row.appendChild(cell);
      }

      renumberCells(row, "gridcell");
      populateCell(cell, extractRowInfo(row));
    }

    function reconcileGrid(grid) {
      if (destroyed || !grid.isConnected) return;
      const headerRow = getHeaderRow(grid);
      if (!headerRow) return;

      grid.dataset.gemSortGrid = "true";
      const nativeHeaders = getDirectCells(headerRow, "columnheader").filter(
        (cell) => !cell.classList.contains("spotify-gem-sort-header"),
      );
      const columnTypes =
        getTracklistInternals(grid).renderedColumnTypes || [];
      const albumColumnIndex = findAlbumColumnIndex(
        nativeHeaders,
        columnTypes,
      );
      const nativePlaysColumnIndex =
        findNativePlaysColumnIndex(nativeHeaders, columnTypes);
      const replacementColumnIndex =
        albumColumnIndex >= 0
          ? albumColumnIndex
          : nativePlaysColumnIndex;
      const dateColumnIndex = findDateAddedColumnIndex(
        nativeHeaders,
        columnTypes,
      );
      const hiddenColumnIndexes = [replacementColumnIndex].filter(
        (index) => index >= 0,
      );
      if (
        nativePlaysColumnIndex >= 0 &&
        nativePlaysColumnIndex !== replacementColumnIndex
      ) {
        hiddenColumnIndexes.push(nativePlaysColumnIndex);
      }
      if (shouldHideEmptyDateColumn(grid, dateColumnIndex)) {
        hiddenColumnIndexes.push(dateColumnIndex);
      }

      const nativeColumnCount = ensureHeader(
        grid,
        headerRow,
        replacementColumnIndex,
        hiddenColumnIndexes,
      );
      ensureGridTemplate(
        grid,
        replacementColumnIndex,
        hiddenColumnIndexes,
        nativeColumnCount,
        [dateColumnIndex],
      );

      grid
        .querySelectorAll(PLACEHOLDER_SELECTOR)
        .forEach((placeholder) =>
          ensurePlaceholder(
            placeholder,
            replacementColumnIndex,
            hiddenColumnIndexes,
          ),
        );
      grid
        .querySelectorAll(ROW_SELECTOR)
        .forEach((row) =>
          ensureRow(row, replacementColumnIndex, hiddenColumnIndexes),
        );

      if (resizeObserver && !observedGrids.has(grid)) {
        observedGrids.add(grid);
        resizeObserver.observe(grid);
      }
    }

    function reconcileAll() {
      reconcileTimer = null;
      if (destroyed) return;

      const activeGrid = sortSession?.grid || sortLoading?.grid;
      if (activeGrid && !activeGrid.isConnected) {
        clearMetricSort({
          invalidate: false,
          scrollToTop: false,
        });
      }
      observedGrids.forEach((grid) => {
        if (grid.isConnected) return;
        resizeObserver?.unobserve?.(grid);
        observedGrids.delete(grid);
      });

      if (!isPlaylistPath(getCurrentPath())) {
        document
          .querySelectorAll('[data-gem-sort-grid="true"]')
          .forEach(restoreGrid);
        return;
      }

      document.querySelectorAll(GRID_SELECTOR).forEach(reconcileGrid);
    }

    function scheduleReconcile(delay = RECONCILE_DELAY_MS) {
      if (destroyed) return;
      clearTimeout(reconcileTimer);
      reconcileTimer = setTimeout(reconcileAll, delay);
    }

    function installObservers() {
      const main = document.querySelector("main") || document.body;

      mutationObserver = new MutationObserver((mutations) => {
        const relevant = mutations.some((mutation) =>
          Array.from(mutation.addedNodes).some(
            (node) =>
              node.nodeType === 1 &&
              (node.matches?.(GRID_SELECTOR) ||
                node.matches?.(ROW_SELECTOR) ||
                node.querySelector?.(`${GRID_SELECTOR}, ${ROW_SELECTOR}`)),
          ),
        );
        if (relevant) scheduleReconcile();
      });
      mutationObserver.observe(main, { childList: true, subtree: true });

      if (typeof browserRoot.ResizeObserver === "function") {
        resizeObserver = new browserRoot.ResizeObserver(() => scheduleReconcile());
      }

      document.addEventListener("scroll", scheduleReconcile, true);
      document.addEventListener("input", handlePlaylistFilterInput, true);
      browserRoot.addEventListener("resize", scheduleReconcile);

      try {
        historyUnlisten =
          getSpicetify()?.Platform?.History?.listen?.(() => {
            clearMetricSort({
              invalidate: false,
              scrollToTop: false,
            });
            scheduleReconcile(80);
          }) || null;
      } catch (error) {
        logOnce("history-listener", "Navigation listener is unavailable.", error);
      }
    }

    function handlePlaylistFilterInput(event) {
      const grid = sortSession?.grid || sortLoading?.grid;
      if (
        !grid ||
        !(event.target instanceof browserRoot.HTMLInputElement)
      ) {
        return;
      }
      const section = grid.closest("section");
      if (section?.contains(event.target)) {
        clearMetricSort();
      }
    }

    function initializeWhenReady(attempt = 0) {
      if (destroyed || initialized) return;
      const Spicetify = getSpicetify();
      const ready =
        Spicetify?.Platform &&
        Spicetify?.GraphQL?.Request &&
        Spicetify?.Locale;

      if (!ready) {
        if (attempt === 200) {
          logOnce("startup", "Spicetify APIs did not become ready.");
        }
        setTimeout(() => initializeWhenReady(attempt + 1), 100);
        return;
      }

      initialized = true;
      addStyles();
      installObservers();
      reconcileAll();
      setTimeout(reconcileAll, 300);
      setTimeout(reconcileAll, 1200);
    }

    function restoreGrid(grid) {
      if (sortSession?.grid === grid || sortLoading?.grid === grid) {
        clearMetricSort({
          invalidate: false,
          scrollToTop: false,
        });
      }
      resizeObserver?.unobserve?.(grid);
      observedGrids.delete(grid);
      const headerRow = getHeaderRow(grid);
      grid
        .querySelectorAll(
          ".spotify-gem-sort-header, .spotify-gem-sort-cell, .spotify-gem-sort-skeleton",
        )
        .forEach((element) => element.remove());
      restoreHiddenColumns(grid);
      const restoredTemplate =
        grid.__streamRankBaseTemplate ||
        stripTemplateColumn(
          grid.style.getPropertyValue("--grid-template-columns"),
        );
      if (restoredTemplate) {
        grid.style.setProperty("--grid-template-columns", restoredTemplate);
      } else {
        grid.style.removeProperty("--grid-template-columns");
      }
      delete grid.__streamRankBaseTemplate;
      delete grid.__streamRankDataHasMeaningfulDates;
      delete grid.dataset.gemSortGrid;
      delete grid.dataset.gemSortSortActive;

      if (grid.__streamRankDropGuard) {
        grid.removeEventListener(
          "dragover",
          grid.__streamRankDropGuard,
          true,
        );
        grid.removeEventListener("drop", grid.__streamRankDropGuard, true);
        delete grid.__streamRankDropGuard;
      }
      if (headerRow?.__streamRankNativeSortGuard) {
        headerRow.removeEventListener(
          "click",
          headerRow.__streamRankNativeSortGuard,
          true,
        );
        delete headerRow.__streamRankNativeSortGuard;
      }

      if (headerRow) {
        renumberCells(headerRow, "columnheader");
        const count = getDirectCells(headerRow, "columnheader").length;
        if (count > 0) grid.setAttribute("aria-colcount", String(count));
      }

      grid.querySelectorAll(ROW_SELECTOR).forEach((row) => {
        renumberCells(row, "gridcell");
      });
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(reconcileTimer);
      clearTimeout(playCountBatchTimer);
      reconcileTimer = null;
      playCountBatchTimer = null;
      cancelScheduledCachePrune();
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      observedGrids.clear();

      document.removeEventListener("scroll", scheduleReconcile, true);
      document.removeEventListener(
        "input",
        handlePlaylistFilterInput,
        true,
      );
      browserRoot.removeEventListener("resize", scheduleReconcile);

      try {
        if (typeof historyUnlisten === "function") historyUnlisten();
      } catch {
        // The Spotify history implementation may already be torn down.
      }

      clearMetricSort({
        invalidate: false,
        scrollToTop: false,
      });
      pendingPlayCounts.forEach((entry) => entry.resolve(null));
      pendingPlayCounts.clear();
      playCountInFlight.clear();
      albumInFlight.clear();
      artistInFlight.clear();
      cachePolicies.forEach((policy) => policy.cache.clear());
      loggedMessages.clear();
      metadataServiceClient = null;
      document.querySelectorAll('[data-gem-sort-grid="true"]').forEach(restoreGrid);
      document.getElementById(STYLE_ID)?.remove();
      if (browserRoot[GLOBAL_KEY] === runtime) {
        delete browserRoot[GLOBAL_KEY];
      }
    }

    function getStatus() {
      const now = Date.now();
      const caches = {};
      cachePolicies.forEach((policy) => {
        caches[policy.name] = {
          entries: policy.cache.size,
          evicted: policy.evicted,
          expired: countExpiredCacheEntries(policy.cache, now),
          expiredPruned: policy.expiredPruned,
          limit: policy.limit,
        };
      });

      return {
        version: VERSION,
        initialized,
        destroyed,
        activeGrids: document.querySelectorAll(
          '[data-gem-sort-grid="true"]',
        ).length,
        renderedCells: document.querySelectorAll(
          ".spotify-gem-sort-cell",
        ).length,
        playCountCacheEntries: playCountCache.size,
        artistCacheEntries: artistCache.size,
        albumCacheEntries: albumCache.size,
        cacheLimits: {
          playCounts: PLAY_COUNT_CACHE_LIMIT,
          albums: ALBUM_CACHE_LIMIT,
          artists: ARTIST_CACHE_LIMIT,
          warnings: LOGGED_MESSAGE_LIMIT,
        },
        caches,
        artistRequests: {
          ...artistRequestMetrics,
          averageDurationMs:
            artistRequestMetrics.completed + artistRequestMetrics.failed > 0
              ? Math.round(
                  artistRequestMetrics.totalDurationMs /
                    (artistRequestMetrics.completed +
                      artistRequestMetrics.failed),
                )
              : 0,
          concurrencyLimit: ARTIST_REQUEST_CONCURRENCY_LIMIT,
        },
        cacheMaintenance: {
          idleTimeoutMs: CACHE_PRUNE_IDLE_TIMEOUT_MS,
          intervalMs: CACHE_PRUNE_INTERVAL_MS,
          lastPrunedAt: lastCachePruneAt,
          runs: cachePruneRuns,
          scheduled:
            cachePruneTimer !== null ||
            cachePruneIdleHandle !== null,
        },
        bulkPlaySorts,
        sortedPlaybackStarts,
        activeSort: sortSession
          ? {
              metric: sortSession.sortState?.key || null,
              direction: sortSession.sortState?.direction || null,
              itemCount: sortSession.sortedItems.length,
              loadedMetrics: Array.from(sortSession.loadedMetrics),
              artistProgress: sortSession.artistProgress
                ? { ...sortSession.artistProgress }
                : null,
              playbackHookInstalled: Boolean(
                sortSession.playerPlayHandle,
              ),
              playbackStarts: sortSession.sortedPlaybackStarts,
            }
          : null,
        loadingSort: sortLoading
          ? {
              artistProgress: sortLoading.artistProgress
                ? { ...sortLoading.artistProgress }
                : null,
              metric: sortLoading.key || null,
              operationId: sortLoading.operationId,
            }
          : null,
        warnings: Array.from(loggedMessages),
      };
    }

    const runtime = {
      version: VERSION,
      init: initializeWhenReady,
      destroy,
      reconcile: reconcileAll,
      getStatus,
      pruneCaches,
    };

    return runtime;
  }

  return {
    VERSION,
    buildFallbackTemplate,
    buildMetricRecords,
    buildMissingRanges,
    buildSortedPlaybackContext,
    buildTopTrackIndex,
    buildTopTrackMap,
    createLimiter,
    extractTrackCounts,
    extractTrackInfoFromProps,
    findTopTrackRecord,
    fingerprintQueryOptions,
    findColumnTypeIndex,
    findMethodOwner,
    findTrackItem,
    formatPlayCount,
    getArtistSortConcurrency,
    getPlaybackContextUri,
    getCapturedPageOffset,
    buildPlaylistTemplate,
    insertTemplateColumn,
    isPlaylistPath,
    nextMetricSortState,
    normalizeTrackItem,
    normalizeTrackName,
    parseVarint,
    preferPlayCount,
    pruneTimedCache,
    removeNamedTemplateTrack,
    remapSortedPlaybackOptions,
    sortMetricRecords,
    selectMetricRecordValues,
    spotifyUriFromHref,
    start,
    stripTemplateColumn,
    toDurationMs,
    toPlayCount,
  };
});
