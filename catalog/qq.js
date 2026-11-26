// QQ 音乐匿名接口：歌手专辑列表、专辑详情与歌词（免登录）。
// 这里只补「曲库元数据」；播放仍走网关，把曲目交给酷我 / GDStudio 的关键词链路。
import { normalizeName, artistsOverlap } from "../gateway/match.js";
import * as model from "./models.js";
import { artistLink } from "./links.js";
import { t } from "../i18n.js";

const MUSICU = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const SMARTBOX = "https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg";
const LYRIC = "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1";
const COMM = {
  ct: 24, cv: 4747474, format: "json", inCharset: "utf-8", outCharset: "utf-8",
  notice: 0, platform: "yqq.json", needNewCode: 1, uin: "0", g_tk: 0, g_tk_new_20200303: 0,
};
const ALBUM_PREFIX = "qq-album:";
const TRACK_PREFIX = "qq:";
const STORAGE_KEY = "qqTracks";
const LIMIT = 300;

export function isQqTrackId(value) {
  return /^qq:[A-Za-z0-9]+$/.test(String(value ?? ""));
}

export function isQqAlbumId(value) {
  return /^qq-album:[A-Za-z0-9]+$/.test(String(value ?? ""));
}

export function qqAlbumId(mid) {
  return `${ALBUM_PREFIX}${mid}`;
}

export function qqTrackId(mid) {
  return `${TRACK_PREFIX}${mid}`;
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

function coverOf(albumMid) {
  const mid = text(albumMid);
  return mid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${mid}.jpg` : "";
}

function kindOf(raw, total) {
  const type = String(raw?.albumType || "").toLowerCase();
  if (type.includes("single")) return "single";
  if (type.includes("ep")) return "ep";
  if (type.includes("compilation")) return "compilation";
  if (!type && Number(total) === 1) return "single";
  return "album";
}

function mapAlbum(raw) {
  const mid = text(raw?.albumMid || raw?.mid);
  if (!mid) return null;
  const name = decode(raw?.albumName || raw?.name);
  const singer = decode(raw?.singerName || raw?.singer);
  const total = Number(raw?.totalNum) || 0;
  return {
    id: qqAlbumId(mid),
    name: name || t("未知专辑"),
    imageUrl: coverOf(mid),
    artists: [{ id: artistLink(singer), name: singer || t("未知歌手") }],
    trackCount: total,
    released: text(raw?.publishDate),
    kind: kindOf(raw, total),
  };
}

function mapTrack(song, album) {
  const mid = text(song?.mid || song?.songmid);
  if (!mid) return null;
  const singers = Array.isArray(song?.singer) ? song.singer : [];
  const mapped = {
    id: qqTrackId(mid),
    name: decode(song?.name || song?.title) || t("未知歌曲"),
    artists: (singers.length ? singers : [{ name: t("未知歌手") }])
      .map((singer) => ({ id: artistLink(decode(singer?.name)), name: decode(singer?.name) || t("未知歌手") })),
    album: album
      ? { id: album.id, name: album.name, imageUrl: album.imageUrl }
      : { id: "", name: decode(song?.album?.name) || t("未知专辑") },
    duration: Number(song?.interval) > 0 ? Number(song.interval) * 1000 : 0,
    url: `https://y.qq.com/n/ryqq/songDetail/${mid}`,
  };
  return mapped;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    redirect: "follow",
    ...options,
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`QQ Music HTTP ${response.status}`);
  return response.json();
}

async function musicu(requests) {
  return fetchJson(MUSICU, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Referer": "https://y.qq.com/",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ comm: COMM, ...requests }),
  });
}

// 歌手名 → QQ singerMid。smartbox 是匿名接口，取不到就放弃补全。
const singers = new Map();
async function singerMid(name) {
  const key = normalizeName(name).toLowerCase();
  if (!key) return "";
  if (singers.has(key)) return singers.get(key);
  let mid = "";
  try {
    const data = await fetchJson(`${SMARTBOX}?key=${encodeURIComponent(name)}&format=json`, {
      headers: { "User-Agent": UA, "Referer": "https://y.qq.com/" },
    });
    const list = data?.data?.singer?.itemlist || [];
    const exact = list.find((item) => normalizeName(item?.name).toLowerCase() === key);
    const overlap = list.find((item) => artistsOverlap(name, item?.name));
    const chosen = exact || overlap || (list.length === 1 ? list[0] : null);
    mid = text(chosen?.mid);
  } catch (error) {
    console.warn("[switch] qq singer lookup failed:", error?.message || error);
  }
  singers.set(key, mid);
  return mid;
}

export async function qqAlbumsForArtist(name) {
  const mid = await singerMid(name);
  if (!mid) return [];
  const data = await musicu({
    req: {
      module: "music.musichallAlbum.AlbumListServer",
      method: "GetAlbumList",
      param: { singerMid: mid, begin: 0, num: 100, order: 1 },
    },
  });
  const list = data?.req?.data?.albumList || [];
  const albums = [];
  const seen = new Set();
  for (const raw of list) {
    const album = mapAlbum(raw);
    if (!album || seen.has(album.id)) continue;
    seen.add(album.id);
    albums.push(album);
  }
  return albums;
}

export async function qqAlbumDetail(value) {
  const mid = String(value ?? "").slice(ALBUM_PREFIX.length);
  if (!mid) throw new Error(t("专辑暂不可用"));
  const data = await musicu({
    info: {
      module: "music.musichallAlbum.AlbumInfoServer",
      method: "GetAlbumDetail",
      param: { albumMid: mid },
    },
    songs: {
      module: "music.musichallAlbum.AlbumSongList",
      method: "GetAlbumSongList",
      param: { albumMid: mid, begin: 0, num: 100, order: 1 },
    },
  });
  const basic = data?.info?.data?.basicInfo || {};
  const rows = (data?.songs?.data?.songList || []).map((row) => row?.songInfo).filter(Boolean);
  if (!rows.length && !basic.albumName) throw new Error(t("专辑暂不可用"));
  const singer = (rows[0]?.singer || []).map((item) => item?.name).filter(Boolean).join("/");
  const album = mapAlbum({
    albumMid: mid,
    albumName: basic.albumName || rows[0]?.album?.name,
    singerName: singer,
    publishDate: basic.publishDate || rows[0]?.album?.time_public,
    albumType: basic.albumType,
    totalNum: rows.length,
  });
  if (!album) throw new Error(t("专辑暂不可用"));
  const tracks = rows.map((song) => mapTrack(song, album)).filter(Boolean);
  rememberTracks(tracks);
  return { album, tracks };
}

async function trackDetail(mid) {
  const data = await musicu({
    d: {
      module: "music.pf_song_detail_svr",
      method: "get_song_detail_yqq",
      param: { song_mid: mid },
    },
  });
  const info = data?.d?.data?.track_info;
  if (!info) return null;
  const rawAlbum = info.album || {};
  const album = rawAlbum.mid
    ? mapAlbum({
      albumMid: rawAlbum.mid,
      albumName: rawAlbum.name,
      singerName: (info.singer || []).map((item) => item?.name).filter(Boolean).join("/"),
      publishDate: rawAlbum.time_public,
      totalNum: 0,
    })
    : null;
  return mapTrack(info, album);
}

export async function qqTrackById(value) {
  ensureLoaded();
  const id = String(value ?? "");
  if (!isQqTrackId(id)) return null;
  const cached = recent.get(id) || model.cachedMeta(id) || null;
  if (cached) return cached;
  const mid = id.slice(TRACK_PREFIX.length);
  try {
    const track = await trackDetail(mid);
    if (track) {
      rememberTracks([track]);
      return track;
    }
  } catch (error) {
    console.warn("[switch] qq track detail failed:", error?.message || error);
  }
  return null;
}

function decodeLyric(value) {
  let out = text(value);
  if (!out) return "";
  if (!out.includes("[") && /^[A-Za-z0-9+/=\s]+$/.test(out) && typeof atob === "function") {
    try {
      out = atob(out);
    } catch (_) {
      // 不是 base64 就原样返回。
    }
  }
  return out;
}

export async function qqLyrics(value) {
  const id = String(value ?? "");
  if (!isQqTrackId(id)) return { lrc: "", translation: "" };
  const mid = id.slice(TRACK_PREFIX.length);
  try {
    const data = await fetchJson(
      `${LYRIC}?songmid=${encodeURIComponent(mid)}&format=json&nobase64=1&g_tk=5381`,
      { headers: { "User-Agent": UA, "Referer": "https://y.qq.com/portal/player.html" } },
    );
    return { lrc: decodeLyric(data?.lyric), translation: decodeLyric(data?.trans) };
  } catch (error) {
    console.warn("[switch] qq lyric failed:", error?.message || error);
    return { lrc: "", translation: "" };
  }
}

export async function qqArtist(name) {
  const mid = await singerMid(name);
  if (!mid) return null;
  const data = await musicu({
    info: {
      module: "music.musichallSinger.SingerInfoInter",
      method: "GetSingerDetail",
      param: { singer_mids: [mid], pic: 1, group_singer: 1, wiki_singer: 1, ex_singer: 1 },
    },
    songs: {
      module: "musichall.song_list_server",
      method: "GetSingerSongList",
      param: { singerMid: mid, begin: 0, num: 50, order: 1 },
    },
  });
  const singer = data?.info?.data?.singer_list?.[0] || {};
  const basic = singer.basic_info || {};
  const rows = (data?.songs?.data?.songList || []).map((row) => row?.songInfo).filter(Boolean);
  const singerName = decode(basic.name) || name;
  const pmid = text(basic.singer_pmid) || mid;
  const artist = {
    id: `qq-artist:${mid}`,
    name: singerName,
    imageUrl: `https://y.gtimg.cn/music/photo_new/T001R300x300M000${pmid}.jpg`,
  };
  const tracks = rows.map((song) => {
    const album = song?.album?.mid
      ? mapAlbum({
        albumMid: song.album.mid,
        albumName: song.album.name,
        singerName,
        publishDate: song.album.time_public,
        totalNum: 0,
      })
      : null;
    return mapTrack(song, album);
  }).filter(Boolean);
  rememberTracks(tracks);
  const albums = await qqAlbumsForArtist(singerName).catch(() => []);
  return { artist, tracks, albums, related: [] };
}

// 宿主之后只传 id；喜欢 / 本地歌单 / 歌词需要靠这份快照补齐元数据。
const recent = new Map();
let loaded = false;

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

function normalizeStored(item) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id || "");
  if (!isQqTrackId(id)) return null;
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

function rememberTracks(tracks) {
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
    // 存储满时不影响浏览与播放。
  }
}
