// 宿主入口：转发曲库能力、暴露网关播放、右键菜单与设置检测。
import { t } from "./i18n.js";
import { fail } from "./catalog/client.js";
import * as library from "./catalog/library.js";
import * as localPlaylists from "./catalog/playlists.js";
import { qualityLabel } from "./gateway/quality.js";
import { resolveStream, trackForGateway } from "./gateway/index.js";
import { browseSources, runSelfTest } from "./gateway/selftest.js";

// 纯 ASCII：方便从应用标准输出确认插件确实被加载，也不进入本地化词表。
console.info("[switch] source gateway loaded");

export { search, suggest, hotSearches, home, album, artist, lyrics } from "./catalog/library.js";
export {
  playlists,
  createPlaylist,
  renamePlaylist,
  deletePlaylist,
  addToPlaylist,
  removeFromPlaylist,
  movePlaylistTrack,
  liked,
  isLiked,
  like,
  savePlaylist,
} from "./catalog/playlists.js";
export { stream } from "./stream.js";

// 网易云歌单（数字编号）与本地歌单（local-<n>）共用宿主这个入口。
export async function playlist({ id } = {}) {
  if (localPlaylists.isLocalPlaylistId(id)) {
    localPlaylists.clearPlaylistContext();
    return localPlaylists.localPlaylist({ id });
  }
  const detail = await library.playlist({ id });
  // 记录上下文，供「收藏歌单」右键菜单判断（宿主对其他人的歌单不传 playlist id）。
  localPlaylists.rememberPlaylistContext(detail);
  // 宿主歌单「更多」菜单用 saved 决定显示「收藏歌单」还是「取消收藏歌单」。
  return { ...detail, saved: localPlaylists.isSavedPlaylist(detail.id) };
}

function saveTargetFor(track, playlistId) {
  const param = String(playlistId ?? "");
  // 宿主显式传了歌单 id：数字是网易云歌单，其余（local-*、喜欢歌单）都不可收藏，
  // 不能回退到「最近打开的歌单」上下文。
  if (param) return /^\d+$/.test(param) ? { id: param, name: "" } : null;
  return localPlaylists.playlistContextFor(track?.id);
}

export async function browse({ page = "" } = {}) {
  const value = String(page || "");
  if (value === "sources" || value.startsWith("sources:")) return browseSources();
  return library.browse({ page: value });
}

export function trackMenu({ track, playlist } = {}) {
  // 有曲目信息时只给自己的曲目加菜单；本地音乐或其他音源的 ID 不是网易云编号。
  // 宿主没传曲目（例如只问菜单定义）时照常返回条目。
  if (track) {
    if (!/^\d+$/.test(String(track.id ?? ""))) return [];
    if (track.source && track.source !== "switch") return [];
  }
  const items = [
    { id: "switch.copy", title: t("复制音源直链") },
    { id: "switch.test", title: t("检测音源可用性") },
  ];
  // 正在看某个网易云歌单时，给「收藏 / 取消收藏歌单」一个入口。
  // 本地歌单与喜欢歌单不能收藏；只读内存与 storage，不联网。
  const target = saveTargetFor(track, playlist);
  if (target) {
    const saved = localPlaylists.isSavedPlaylist(target.id);
    const title = target.name
      ? t(saved ? "取消收藏歌单：{name}" : "收藏歌单：{name}", { name: target.name })
      : t(saved ? "取消收藏歌单" : "收藏歌单");
    items.push({ id: "switch.save-playlist", title });
  }
  return items;
}

export async function menuAction({ id: action, track, playlist } = {}) {
  if (action === "switch.save-playlist") {
    const target = saveTargetFor(track, playlist);
    if (!target) fail("unsupported", "未知菜单操作");
    const saved = localPlaylists.isSavedPlaylist(target.id);
    await localPlaylists.savePlaylist({ id: target.id, on: !saved });
    return { toast: saved ? t("已取消收藏") : t("已收藏歌单") };
  }
  if (action !== "switch.copy" && action !== "switch.test") fail("unsupported", "未知菜单操作");
  const stream = await resolveStream({ track: trackForGateway(track), quality: "high" });
  const quality = t(qualityLabel(stream.quality));
  if (action === "switch.copy") {
    return {
      copy: stream.url,
      toast: t("已获取音源直链（{quality}）", { quality }),
    };
  }
  return {
    toast: t("音源可用：{quality} · {bitRate}kbps", {
      quality,
      bitRate: stream.bitRate || "?",
    }),
  };
}

export async function testConnection() {
  const results = await runSelfTest();
  if (!results.length) throw Object.assign(new Error(t("没有启用的音源")), { code: "setup" });
  const failed = results.filter((result) => !result.ok);
  if (failed.length) {
    throw new Error(t("{count} 个音源不可用", { count: failed.length }));
  }
  return t("{count} 个音源可用", { count: results.length });
}
