// 宿主数据结构映射。歌曲一律不因版权标记 unavailable：能否播放由网关音源决定。
import { t } from "../i18n.js";

const sid = (value) => (value == null ? "" : String(value));
const image = (value) => String(value || "").replace(/^http:\/\//, "https://");
const date = (value) => (value > 0 ? new Date(value).toISOString().slice(0, 10) : "");

// 供网关按 ID 取元数据，避免 stream() 再请求一次详情。
const META_LIMIT = 512;
const meta = new Map();

export function artist(value = {}) {
  return {
    id: sid(value.id),
    name: value.name || t("未知歌手"),
    imageUrl: image(value.picUrl || value.img1v1Url || value.avatar),
  };
}

export function album(value = {}) {
  const artists = value.artists || (value.artist ? [value.artist] : []);
  const type = String(value.type || "").toLowerCase();
  return {
    id: sid(value.id),
    name: value.name || t("未知专辑"),
    imageUrl: image(value.picUrl || value.blurPicUrl || value.picUrl_str),
    artists: artists.map(artist),
    trackCount: value.size ?? value.songCount ?? value.trackCount ?? 0,
    released: date(value.publishTime),
    copyright: value.copyright || "",
    kind: type.includes("single") ? "single" : type === "ep" ? "ep" : "album",
  };
}

export function track(value = {}) {
  const songId = sid(value.id);
  const mapped = {
    id: songId,
    name: value.name || t("未知歌曲"),
    artists: (value.ar || value.artists || []).map(artist),
    album: album(value.al || value.album || {}),
    duration: Number(value.dt ?? value.duration ?? 0) || 0,
    url: songId ? `https://music.163.com/song?id=${songId}` : "",
  };
  if (!songId) return { ...mapped, unavailable: true };
  rememberMeta(mapped);
  return mapped;
}

export function playlist(value = {}) {
  return {
    id: sid(value.id),
    name: value.name || t("未命名歌单"),
    imageUrl: image(value.coverImgUrl || value.picUrl),
    description: value.description || "",
    owner: value.creator?.nickname || "",
    trackCount: value.trackCount ?? value.tracks?.length ?? 0,
    plays: value.playCount || 0,
    mine: false,
    saved: false,
    fixed: false,
  };
}

export function rememberMeta(value) {
  const songId = sid(value?.id);
  if (!songId) return value;
  meta.delete(songId);
  meta.set(songId, value);
  while (meta.size > META_LIMIT) meta.delete(meta.keys().next().value);
  return value;
}

export function cachedMeta(songId) {
  return meta.get(sid(songId)) || null;
}
