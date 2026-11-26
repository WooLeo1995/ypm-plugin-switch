// 酷我搜索兜底：网易云曲库搜不到时，用酷我曲库补结果。
// 结果 id 形如 kw:<rid>，播放时网关直接按 rid 取址，不再依赖歌名关键词匹配。
import { searchKuwoKt } from "../gateway/sources/kuwo-search.js";
import { getText } from "../gateway/sources/http.js";
import { artistLink } from "./links.js";
import { normalizeName, versionKey } from "../gateway/match.js";
import * as model from "./models.js";
import { t } from "../i18n.js";

const PAGE = 50;
const STORAGE_KEY = "kuwoTracks";
const LIMIT = 200;
const COVER = "https://img1.kuwo.cn/star/albumcover/300/";
const SONG_PAGE = "https://www.kuwo.cn/play_detail/";
const PREFIX = "kw:";
const ALBUM_PREFIX = "kw-album:";

export function isKuwoTrackId(value) {
  return /^kw:\d+$/.test(String(value ?? ""));
}

export function kuwoTrackId(rid) {
  return `${PREFIX}${rid}`;
}

export function isKuwoAlbumId(value) {
  return /^kw-album:\d+$/.test(String(value ?? ""));
}

const text = (value) => String(value == null ? "" : value).trim();

function decode(value) {
  return text(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function ridOf(row) {
  const raw = String(row?.MUSICRID || "");
  const index = raw.lastIndexOf("_");
  const rid = index >= 0 ? raw.slice(index + 1) : raw;
  return /^\d+$/.test(rid) ? rid : "";
}

function artistsOf(raw) {
  const names = decode(raw)
    .split(/&|、|，|;|；/)
    .map((name) => name.trim())
    .filter(Boolean);
  return (names.length ? names : [t("未知歌手")]).map((name) => ({ id: artistLink(name), name }));
}

function coverOf(short) {
  const path = text(short);
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  const rest = path.replace(/^\d+\//, "");
  return rest ? `${COVER}${rest}` : "";
}

function durationOf(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}

// 酷我歌名常拼上「-《剧名》主题曲」这类说明；展示与匹配都用干净的歌名。
function cleanTitle(value) {
  return decode(value).replace(/[-—]\s*《[^》]*》[\s\S]*$/, "").trim();
}

function mapRow(row) {
  const rid = ridOf(row);
  if (!rid) return null;
  const cover = coverOf(row.web_albumpic_short);
  const artists = artistsOf(row.ARTIST || row.FARTIST);
  const albumId = String(row.ALBUMID || "");
  const track = {
    id: kuwoTrackId(rid),
    name: cleanTitle(row.SONGNAME || row.NAME) || t("未知歌曲"),
    artists,
    album: {
      id: /^\d+$/.test(albumId) && albumId !== "0" ? `${ALBUM_PREFIX}${albumId}` : "",
      name: decode(row.ALBUM) || t("未知专辑"),
      ...(cover ? { imageUrl: cover } : {}),
      artists,
    },
    duration: durationOf(row.DURATION),
    url: `${SONG_PAGE}${rid}`,
  };
  if (String(row.ONLINE || "1") === "0") track.unavailable = true;
  return track;
}

const FALLBACK_TTL = 30 * 60 * 1000;
const FALLBACK_LIMIT = 100;
const fallbackQueries = new Map();

const loose = (value) => String(value == null ? "" : value).toLowerCase()
  .replace(/[\s（）()【】\[\]·・\-—_.,，。!！?？:：;；'"“”‘’]/g, "");

// 网易云的结果可能只是同名翻唱/伴奏；要同时满足：
// 1) 歌名出现在查询里（或多个词的查询整个落在歌名上，如 "Love Story"）；
// 2) 多个词的查询还必须能对上歌手（如「林宥嘉 说谎」）；
// 3) 歌名里的版本限定语（Live、伴奏、cover…）也出现在查询里。
// 查询只有一个词时，歌名或歌手命中都算搜到。
export function hasRelevantTrack(tracks, query) {
  const list = Array.isArray(tracks) ? tracks : [];
  const compactQuery = loose(query);
  const tokens = String(query == null ? "" : query)
    .split(/[\s,，、;；/|]+/)
    .map(loose)
    .filter(Boolean);
  if (!compactQuery || !tokens.length) return true;

  // 先在结果里找出「查询里点名的歌手」（按歌手字段匹配，不看歌名，
  // 避免「林宥嘉suno说谎」这类把歌手写进标题的翻唱混进来）。
  const artistsInQuery = new Set();
  for (const track of list) {
    for (const artist of track?.artists || []) {
      const name = loose(artist?.name);
      if (name.length >= 2 && compactQuery.includes(name)) artistsInQuery.add(name);
    }
  }
  const artistOnlyQuery = [...artistsInQuery].some((artist) => artist === compactQuery);

  return list.some((track) => {
    const name = loose(normalizeName(track?.name));
    if (!name) return false;
    const artists = (track?.artists || []).map((artist) => loose(artist?.name)).filter(Boolean);
    // 查询只是在搜歌手：只认真正由这位歌手演唱的结果。
    if (artistOnlyQuery) return artists.some((artist) => artistsInQuery.has(artist));
    // 查询里点了歌手：结果必须真有这位歌手，才谈得上命中。
    if (artistsInQuery.size && !artists.some((artist) => artistsInQuery.has(artist))) return false;
    const nameHit = compactQuery.includes(name);
    const artistHit = artists.some((artist) => compactQuery.includes(artist));
    if (tokens.length === 1) {
      const artistOnly = artists.some((artist) => artist === compactQuery);
      return nameHit || artistOnly;
    }
    const extras = versionKey(track?.name).split("|").filter(Boolean);
    if (!extras.every((extra) => compactQuery.includes(loose(extra)))) return false;
    // 查询本身就是完整歌名（如英文 "Love Story"）：歌名和查询词按顺序完全拼得上才算。
    if (name === tokens.join("")) return true;
    return nameHit && (artistsInQuery.size || artistHit);
  });
}

const COVER_MARK = /(?:cover|翻自|翻唱|原唱)\s*[:：]?\s*([^()（）\[\]【】]+)/i;
const COVER_STOP = /^(?:the|a|an|version|ver|live|remix|伴奏|纯音乐|翻唱|cover)$/i;

function coverArtistsOf(tracks) {
  const found = new Set();
  for (const track of tracks.slice(0, 20)) {
    const source = `${track?.name || ""} ${track?.album?.name || ""}`;
    const match = COVER_MARK.exec(source);
    if (!match) continue;
    const artist = match[1].replace(/[\s)）\]】,，;；/|].*$/, "").trim();
    if (artist.length >= 2 && artist.length <= 24 && !COVER_STOP.test(artist)) found.add(artist);
  }
  return [...found];
}

// 单曲名搜索时，网易云第一页可能全是翻唱（原唱在第二页以后）。
// 从「Cover：某某 / 翻自 某某」里认出原唱歌手；如果第一页没有这位歌手的同名曲，
// 就认为这一页只搜到了翻唱，交给酷我兜底。
export function coverOnlyHint(tracks, query) {
  const list = Array.isArray(tracks) ? tracks : [];
  const keyword = String(query == null ? "" : query).trim();
  if (!keyword || /[\s,，、;；/|]+/.test(keyword) || !list.length) return { coverOnly: false, artists: [] };
  const artists = coverArtistsOf(list);
  if (!artists.length) return { coverOnly: false, artists: [] };
  return { coverOnly: !containsOriginalArtist(list, keyword, artists), artists };
}

export function containsOriginalArtist(tracks, title, artists) {
  const want = normalizeName(title);
  const names = new Set((Array.isArray(artists) ? artists : []).map((name) => String(name || "").trim()).filter(Boolean));
  if (!want || !names.size) return false;
  return (Array.isArray(tracks) ? tracks : []).some((track) => {
    if (normalizeName(track?.name) !== want) return false;
    return (track?.artists || []).some((artist) => names.has(String(artist?.name || "").trim()));
  });
}

function pruneFallbacks(now) {
  for (const [key, at] of fallbackQueries) {
    if (now - at > FALLBACK_TTL) fallbackQueries.delete(key);
  }
  while (fallbackQueries.size > FALLBACK_LIMIT) fallbackQueries.delete(fallbackQueries.keys().next().value);
}

export function rememberFallbackQuery(query) {
  const key = String(query == null ? "" : query).trim().toLowerCase();
  if (!key) return;
  const now = Date.now();
  fallbackQueries.delete(key);
  fallbackQueries.set(key, now);
  pruneFallbacks(now);
}

export function forgetFallbackQuery(query) {
  fallbackQueries.delete(String(query == null ? "" : query).trim().toLowerCase());
}

export function isFallbackQuery(query) {
  const key = String(query == null ? "" : query).trim().toLowerCase();
  if (!key) return false;
  const at = fallbackQueries.get(key);
  if (!at) return false;
  if (Date.now() - at > FALLBACK_TTL) {
    fallbackQueries.delete(key);
    return false;
  }
  return true;
}

function snapshot(track) {
  const cover = track.album?.imageUrl ? String(track.album.imageUrl) : "";
  return {
    id: String(track.id),
    name: String(track.name || ""),
    artists: (track.artists || []).map((artist) => ({ id: String(artist?.id || ""), name: String(artist?.name || "") })),
    album: {
      id: String(track.album?.id || ""),
      name: String(track.album?.name || ""),
      ...(cover ? { imageUrl: cover } : {}),
    },
    duration: Number(track.duration) || 0,
    url: String(track.url || ""),
  };
}

// 搜索结果里的酷我曲目按 id 记住元数据：宿主之后只传 id，
// 喜欢 / 添加到歌单时要靠这份快照补齐歌名与专辑。
const recent = new Map();
let loaded = false;

function normalizeStored(item) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id || "");
  if (!isKuwoTrackId(id)) return null;
  const cover = item.album?.imageUrl ? String(item.album.imageUrl) : "";
  return {
    id,
    name: String(item.name || t("未知歌曲")),
    artists: Array.isArray(item.artists) && item.artists.length
      ? item.artists.map((artist) => ({ id: String(artist?.id || artistLink(artist?.name)), name: String(artist?.name || t("未知歌手")) }))
      : [{ id: "", name: t("未知歌手") }],
    album: {
      id: String(item.album?.id || ""),
      name: String(item.album?.name || t("未知专辑")),
      ...(cover ? { imageUrl: cover } : {}),
    },
    duration: Number(item.duration) || 0,
    url: String(item.url || ""),
  };
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  const raw = host.storage.get(STORAGE_KEY);
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) return;
  for (const item of raw.items) {
    const track = normalizeStored(item);
    if (!track) continue;
    recent.set(track.id, track);
    model.rememberMeta(track);
  }
}

function remember(tracks) {
  ensureLoaded();
  for (const track of tracks) {
    recent.delete(track.id);
    recent.set(track.id, track);
    model.rememberMeta(track);
  }
  while (recent.size > LIMIT) recent.delete(recent.keys().next().value);
  try {
    host.storage.set(STORAGE_KEY, { items: [...recent.values()].reverse().map(snapshot) });
  } catch (_) {
    // 搜索兜底不因存储配额失败而中断。
  }
}

export function kuwoTrackById(value) {
  ensureLoaded();
  const id = String(value ?? "");
  return recent.get(id) || model.cachedMeta(id) || null;
}

// 酷我的专辑详情接口返回的是 Python 风格单引号对象，不是严格 JSON；
// 写一个小解析器，避免把正文里的引号替换坏。
function parseKuwoLoose(text) {
  const s = String(text);
  let i = 0;
  const skip = () => { while (i < s.length && /\s/.test(s[i])) i += 1; };
  const parseString = (quote) => {
    i += 1;
    let out = "";
    while (i < s.length) {
      const ch = s[i];
      if (ch === "\\" && i + 1 < s.length) {
        const next = s[i + 1];
        const map = { n: "\n", r: "\r", t: "\t", "\\": "\\", "'": "'", '"': '"' };
        out += Object.prototype.hasOwnProperty.call(map, next) ? map[next] : next;
        i += 2;
        continue;
      }
      if (ch === quote) { i += 1; return out; }
      out += ch;
      i += 1;
    }
    throw new Error("unterminated string");
  };
  const parseValue = () => {
    skip();
    const ch = s[i];
    if (ch === "'" || ch === '"') return parseString(ch);
    if (ch === "{") return parseObject();
    if (ch === "[") return parseArray();
    const start = i;
    while (i < s.length && !/[,}\]]/.test(s[i])) i += 1;
    return s.slice(start, i).trim();
  };
  const parseArray = () => {
    i += 1;
    const out = [];
    skip();
    if (s[i] === "]") { i += 1; return out; }
    while (i < s.length) {
      out.push(parseValue());
      skip();
      if (s[i] === ",") { i += 1; continue; }
      if (s[i] === "]") { i += 1; return out; }
      throw new Error("bad array");
    }
    return out;
  };
  const parseObject = () => {
    i += 1;
    const out = {};
    skip();
    if (s[i] === "}") { i += 1; return out; }
    while (i < s.length) {
      skip();
      if (s[i] !== "'" && s[i] !== '"') throw new Error("bad key");
      const key = parseString(s[i]);
      skip();
      if (s[i] !== ":") throw new Error("bad colon");
      i += 1;
      out[key] = parseValue();
      skip();
      if (s[i] === ",") { i += 1; continue; }
      if (s[i] === "}") { i += 1; return out; }
      throw new Error("bad object");
    }
    return out;
  };
  return parseValue();
}

function albumCover(value) {
  const raw = text(value);
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) return coverOf(raw);
  return raw.replace(/^http:\/\//i, "https://");
}

function albumKind(total) {
  if (total <= 1) return "single";
  if (total <= 5) return "ep";
  return "album";
}

function mapAlbumTrack(row, album) {
  const rid = text(row?.musicrid || row?.id);
  if (!/^\d+$/.test(rid)) return null;
  const artists = artistsOf(row?.artist);
  return {
    id: kuwoTrackId(rid),
    name: cleanTitle(row?.songname || row?.name) || t("未知歌曲"),
    artists,
    album: {
      id: album.id,
      name: album.name,
      ...(album.imageUrl ? { imageUrl: album.imageUrl } : {}),
      artists: album.artists,
    },
    duration: durationOf(row?.duration),
    url: `${SONG_PAGE}${rid}`,
  };
}

export async function kuwoAlbumDetail(value) {
  const albumId = String(value ?? "").slice(ALBUM_PREFIX.length);
  if (!/^\d+$/.test(albumId)) throw new Error(t("专辑暂不可用"));
  const url = `https://search.kuwo.cn/r.s?stype=albuminfo&albumid=${albumId}&encoding=utf8&rformat=json`;
  const body = await getText(url, { timeout: 8000 });
  if (!body) throw new Error(t("专辑暂不可用"));
  const data = parseKuwoLoose(body);
  const rows = Array.isArray(data?.musiclist) ? data.musiclist : [];
  if (!rows.length) throw new Error(t("专辑暂不可用"));
  const artistName = decode(data.artist) || decode(rows[0]?.artist);
  const cover = albumCover(data.hts_img || data.img || data.pic || rows[0]?.web_albumpic_short);
  const total = Number(data.songnum) || rows.length;
  const album = {
    id: `${ALBUM_PREFIX}${albumId}`,
    name: decode(data.name) || t("未知专辑"),
    imageUrl: cover,
    artists: artistName ? [{ id: artistLink(artistName), name: artistName }] : [],
    trackCount: total,
    released: text(data.pub),
    kind: albumKind(total),
  };
  const tracks = rows.map((row) => mapAlbumTrack(row, album)).filter(Boolean);
  remember(tracks);
  return { album, tracks };
}

export async function searchKuwoTracks({ query, offset = 0 } = {}) {
  const keyword = text(query);
  if (!keyword) return { tracks: [], more: false, total: 0 };
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const page = Math.floor(start / PAGE);
  let data;
  try {
    data = await searchKuwoKt(keyword, null, { pn: page, rn: PAGE });
  } catch (error) {
    console.warn("[switch] kuwo search failed:", error?.message || error);
    return { tracks: [], more: false, total: 0 };
  }
  const rows = data.rows;
  const total = data.total;
  let tracks = rows.map(mapRow).filter(Boolean);
  const skip = start % PAGE;
  if (skip) tracks = tracks.slice(skip);
  remember(tracks);
  return {
    tracks,
    more: total ? start + tracks.length < total : rows.length >= PAGE,
    total,
  };
}
