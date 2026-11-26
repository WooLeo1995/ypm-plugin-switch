// 匿名曲库：搜索、发现、详情、歌词。所有请求都走 eapi，无需登录。
import { api, fail, id } from "./client.js";
import * as model from "./models.js";
import { containsOriginalArtist, coverOnlyHint, forgetFallbackQuery, hasRelevantTrack, isFallbackQuery, isKuwoTrackId, rememberFallbackQuery, searchKuwoTracks } from "./kuwo.js";
import { isQqAlbumId, isQqTrackId, qqAlbumDetail, qqAlbumsForArtist, qqLyrics } from "./qq.js";
import { normalizeName } from "../gateway/match.js";
import { t } from "../i18n.js";

const PAGE = 50;
const offsetOf = (value) => Math.max(0, Math.floor(Number(value) || 0));

export async function search({ query = "", kind = "tracks", offset = 0 }) {
  const keyword = String(query).trim();
  if (!keyword) return { [kind]: [], more: false };
  const types = { tracks: 1, albums: 10, artists: 100, playlists: 1000 };
  const names = { tracks: "songs", albums: "albums", artists: "artists", playlists: "playlists" };
  const counts = { tracks: "songCount", albums: "albumCount", artists: "artistCount", playlists: "playlistCount" };
  const mappers = {
    tracks: model.track,
    albums: model.album,
    artists: model.artist,
    playlists: (value) => model.playlist(value),
  };
  if (!types[kind]) fail("unsupported", "不支持这种搜索类型");
  const start = offsetOf(offset);

  // 已经判定该查询要走酷我时，后续分页直接向酷我翻页，不再请求网易云，
  // 避免两边结果混排、offset 对不上。
  if (kind === "tracks" && start > 0 && isFallbackQuery(keyword)) {
    return searchKuwoTracks({ query: keyword, offset: start });
  }

  const result = await api("/api/cloudsearch/pc", {
    s: keyword,
    type: types[kind],
    limit: PAGE,
    offset: start,
    total: true,
  });
  const data = result.result || {};
  const items = data[names[kind]] || [];
  const mapped = items.map((value) => mappers[kind](value));
  const total = data[counts[kind]];
  const netease = {
    [kind]: mapped,
    more: typeof total === "number" ? start + items.length < total : Boolean(data.hasMore),
    ...(typeof total === "number" ? { total } : {}),
  };

  if (kind === "tracks") {
    const empty = mapped.length === 0;
    const zero = total === 0 || (total == null && start === 0);
    // 有结果但一条都不沾查询词（例如只搜到同名翻唱、DJ 版）也算没搜到。
    // 只在第一页判断「结果不沾边」；后续页结果不相关也不混入酷我，
    // 否则会把两边的分页结果拼在一起。
    const irrelevant = start === 0 && !empty && !hasRelevantTrack(mapped, keyword);
    // 单曲名搜索的另一种情况：第一页全是翻唱，原唱被排到第二页以后。
    // 从「Cover：某某 / 翻自 某某」识别出原唱，第一页却没有这位歌手的同名曲。
    const cover = start === 0 && !empty ? coverOnlyHint(mapped, keyword) : null;
    const coverOnly = Boolean(cover?.coverOnly);
    if (empty ? zero : (irrelevant || coverOnly)) {
      const fallback = await searchKuwoTracks({ query: keyword, offset: start });
      // 网易云有结果、但只是同名翻唱时，酷我也得真能对上这首歌才替换，
      // 否则保留网易云结果，别把搜索换成另一批不相干的结果。
      const coverHit = coverOnly && containsOriginalArtist(fallback.tracks, keyword, cover.artists);
      const usable = fallback.tracks.length
        && (empty || (coverOnly ? coverHit : hasRelevantTrack(fallback.tracks, keyword)));
      if (usable) {
        rememberFallbackQuery(keyword);
        console.info(`[switch] search fallback to kuwo: ${fallback.tracks.length} tracks`);
        return fallback;
      }
      // 酷我没有结果或请求失败时，保留网易云的结果；完全空才返回空。
      if (!empty) return netease;
      return { tracks: [], more: false, total: 0 };
    }
    if (start === 0) forgetFallbackQuery(keyword);
  }
  return netease;
}

export async function suggest({ query = "" }) {
  if (!String(query).trim()) return [];
  const result = await api("/api/search/suggest/web", { s: String(query).trim() });
  return [...new Set([
    ...(result.result?.songs || []).map((value) => value.name),
    ...(result.result?.artists || []).map((value) => value.name),
    ...(result.result?.albums || []).map((value) => value.name),
  ].filter(Boolean))].slice(0, 10);
}

export async function hotSearches() {
  try {
    const result = await api("/api/hotsearchlist/get", {});
    const words = (result.data || []).map((value) => String(value.searchWord || "").trim()).filter(Boolean);
    return [...new Set(words)].slice(0, 20);
  } catch (error) {
    // 热搜只是锦上添花，接口波动不应让搜索框报错。
    console.warn("[switch] hotSearches failed:", error?.message || error);
    return [];
  }
}

export async function home() {
  const [recommended, newest] = await Promise.all([
    api("/api/personalized/playlist", { limit: 24, total: true, n: 1000 }),
    api("/api/personalized/newsong", { limit: 12 }).catch(() => null),
  ]);
  const sections = [];
  const tracks = (newest?.result || []).map((value) => model.track(value.song || value)).filter((value) => value.id);
  if (tracks.length) sections.push({ title: t("推荐新歌"), style: "songs", tracks });
  sections.push({
    title: t("推荐歌单"),
    style: "shelf",
    playlists: (recommended.result || []).map((value) => model.playlist(value)),
  });
  sections.push({
    title: t("发现音乐"),
    links: [
      { title: t("排行榜"), page: "charts" },
      { title: t("最新专辑"), page: "new-albums" },
      { title: t("热门歌单"), page: "playlists:全部:0" },
      { title: t("音源网关"), page: "sources" },
    ],
  });
  return { title: t("网易云音乐"), subtitle: t("免登录曲库 · 自动切换音源"), sections };
}

async function details(ids) {
  const result = [];
  for (let index = 0; index < ids.length; index += 500) {
    const batch = ids.slice(index, index + 500).map(id);
    const data = await api("/api/v3/song/detail", { c: JSON.stringify(batch.map((value) => ({ id: value }))) });
    const songs = new Map((data.songs || []).map((value) => [String(value.id), model.track(value)]));
    for (const value of batch) {
      result.push(songs.get(value) || { id: value, name: t("歌曲暂不可用"), artists: [], album: {}, duration: 0, unavailable: true });
    }
  }
  return result;
}

async function playlistDetail(value) {
  const data = await api("/api/v6/playlist/detail", { id: id(value), n: 1000, s: 0 });
  if (!data.playlist) fail("unavailable", "歌单不存在，或没有访问权限");
  const raw = data.playlist;
  const ids = (raw.trackIds || []).map((value) => String(value.id));
  if (ids.length > 10000) fail("unsupported", "该歌单超过一万首，暂不支持一次载入，请拆分后再打开");
  const known = new Map((raw.tracks || []).map((value) => [String(value.id), model.track(value)]));
  const missing = ids.filter((value) => !known.has(value));
  for (const value of await details(missing)) known.set(value.id, value);
  const tracks = ids.length ? ids.map((value) => known.get(value)).filter(Boolean) : [...known.values()];
  return { ...model.playlist(raw), tracks, trackCount: raw.trackCount ?? tracks.length };
}

export async function playlist({ id: value }) {
  return playlistDetail(value);
}

export async function album({ id: value }) {
  // 歌手页补进来的 QQ 专辑：走 QQ 的匿名专辑详情，曲目播放仍交给网关。
  if (isQqAlbumId(value)) {
    try {
      return await qqAlbumDetail(value);
    } catch (error) {
      console.warn("[switch] qq album failed:", error?.message || error);
      fail("unavailable", "专辑暂不可用");
    }
  }
  const data = await api(`/api/v1/album/${id(value)}`);
  const mapped = model.album(data.album);
  return {
    album: mapped,
    tracks: (data.songs || []).map((value) => ({ ...model.track(value), album: mapped })),
  };
}

const albumKey = (album) => normalizeName(album?.name || "").toLowerCase()
  .replace(/[\s（）()【】\[\]·・\-—_.,，。!！?？:：;；'"“”‘’]/g, "");

function similarAlbum(existing, candidate) {
  if (!existing || !candidate) return false;
  if (existing === candidate) return true;
  const [longer, shorter] = existing.length >= candidate.length ? [existing, candidate] : [candidate, existing];
  return longer.length - shorter.length <= 4 && longer.includes(shorter);
}

function mergeAlbums(base, extra) {
  const merged = [...base];
  const keys = base.map(albumKey).filter(Boolean);
  for (const album of extra) {
    const key = albumKey(album);
    if (!key || keys.some((existing) => similarAlbum(existing, key))) continue;
    keys.push(key);
    merged.push(album);
  }
  return merged;
}

export async function artist({ id: value }) {
  const artistId = id(value);
  const [detail, albums] = await Promise.all([
    api(`/api/v1/artist/${artistId}`),
    api(`/api/artist/albums/${artistId}`, { limit: 100, offset: 0, total: true }).catch(() => null),
  ]);
  const artist = model.artist(detail.artist);
  const baseAlbums = (albums?.hotAlbums || []).map((value) => model.album(value));
  let merged = baseAlbums;
  if (artist.name && artist.name !== "未知歌手") {
    try {
      const extra = await qqAlbumsForArtist(artist.name);
      merged = mergeAlbums(baseAlbums, extra);
      if (merged.length > baseAlbums.length) {
        console.info(`[switch] artist ${artist.name}: +${merged.length - baseAlbums.length} qq albums`);
      }
    } catch (error) {
      console.warn("[switch] qq artist albums failed:", error?.message || error);
    }
  }
  return {
    artist,
    tracks: (detail.hotSongs || []).map((value) => model.track(value)),
    albums: merged,
    related: [],
  };
}

export async function lyrics({ id: value }) {
  // QQ 专辑里的曲目走 QQ 的匿名歌词接口。
  if (isQqTrackId(value)) return qqLyrics(value);
  // 酷我搜索兜底的曲目没有接入歌词接口；返回空歌词，由播放器显示「暂无歌词」。
  if (isKuwoTrackId(value)) return { lrc: "", translation: "" };
  const data = await api("/api/song/lyric", {
    id: id(value), tv: -1, lv: -1, rv: -1, kv: -1, _nmclfl: 1,
  });
  return { lrc: data.lrc?.lyric || "", translation: data.tlyric?.lyric || "" };
}

const CATEGORIES = ["全部", "华语", "欧美", "日语", "韩语", "轻音乐", "古典", "电子"];

export async function browse({ page = "" } = {}) {
  const value = String(page || "");

  if (value === "sources" || value.startsWith("sources:")) fail("unsupported", "音源网关页面由插件入口处理");
  if (value === "daily") fail("unsupported", "每日推荐需要登录，本插件不支持登录");

  if (value === "charts") {
    const data = await api("/api/toplist");
    return {
      title: t("排行榜"),
      sections: [{ style: "grid", playlists: (data.list || []).map((item) => model.playlist(item)) }],
    };
  }

  if (value.startsWith("top:")) {
    const target = value.slice(4);
    if (!/^\d+$/.test(target)) fail("unsupported", "不支持这个发现页面");
    const detail = await playlistDetail(target);
    return { title: detail.name, sections: [{ tracks: detail.tracks }] };
  }

  if (value === "new-albums") {
    const data = await api("/api/discovery/newAlbum");
    return {
      title: t("最新专辑"),
      sections: [{ style: "grid", albums: (data.albums || []).map((item) => model.album(item)) }],
    };
  }

  const [prefix, category = "全部", offset = "0"] = value.split(":");
  if (value && prefix !== "playlists") fail("unsupported", "不支持这个发现页面");
  const start = offsetOf(offset);
  const data = await api("/api/playlist/list", {
    cat: CATEGORIES.includes(category) ? category : "全部",
    order: "hot",
    limit: 30,
    offset: start,
    total: true,
  });
  const sections = [{ style: "grid", playlists: (data.playlists || []).map((item) => model.playlist(item)) }];
  if (data.more) {
    sections.push({ links: [{ title: t("下一页"), page: `playlists:${category}:${start + 30}` }] });
  }
  return {
    title: t("热门歌单"),
    sections,
    tabs: CATEGORIES.map((title) => ({ title: t(title), page: `playlists:${title}:0`, selected: title === category })),
  };
}
