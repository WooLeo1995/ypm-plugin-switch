// 免登录本地歌单：歌单与曲目快照存在 host.storage，播放时仍走音源网关。
// 只接受本插件自己生成的 local-<n> 歌单编号，避免和网易云数字歌单编号混淆。
import { api, fail } from "./client.js";
import * as model from "./models.js";
import { t } from "../i18n.js";

const STORAGE_KEY = "localPlaylists";
const ID_PREFIX = "local-";
const MAX_PLAYLISTS = 100;
const MAX_TRACKS = 2000;
const MAX_STORED_CHARS = 6 * 1024 * 1024;

function emptyState() {
  return { next: 1, items: [] };
}

function normalizePlaylist(value) {
  return {
    id: String(value.id),
    name: String(value.name || t("未命名歌单")).slice(0, 80),
    createdAt: Number(value.createdAt) || 0,
    updatedAt: Number(value.updatedAt) || 0,
    tracks: Array.isArray(value.tracks) ? value.tracks.filter((track) => track && typeof track.id === "string") : [],
  };
}

// 存储格式损坏时退回空歌单，不让整个插件启动失败。
function load() {
  const raw = host.storage.get(STORAGE_KEY);
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) return emptyState();
  const items = raw.items
    .filter((item) => item && typeof item === "object" && /^local-\d+$/.test(String(item.id || "")))
    .map(normalizePlaylist);
  const maxId = items.reduce((max, item) => Math.max(max, Number(item.id.slice(ID_PREFIX.length)) || 0), 0);
  const storedNext = Number(raw.next) || 0;
  return { next: Math.max(storedNext, maxId + 1, 1), items };
}

function save(state) {
  let text;
  try {
    text = JSON.stringify(state);
  } catch (_) {
    fail("failed", "歌单数据已满，请删除一些歌单或歌曲");
  }
  if (text.length > MAX_STORED_CHARS) fail("failed", "歌单数据已满，请删除一些歌单或歌曲");
  try {
    host.storage.set(STORAGE_KEY, state);
  } catch (_) {
    fail("failed", "歌单数据已满，请删除一些歌单或歌曲");
  }
}

export function isLocalPlaylistId(value) {
  return /^local-\d+$/.test(String(value ?? ""));
}

function find(state, id) {
  return state.items.find((item) => item.id === String(id));
}

function requirePlaylist(state, id) {
  const item = find(state, id);
  if (!item) fail("unavailable", "歌单不存在，或没有访问权限");
  return item;
}

function summary(item) {
  const cover = item.tracks.find((track) => track.album?.imageUrl)?.album.imageUrl || "";
  return {
    id: item.id,
    name: item.name,
    imageUrl: cover,
    description: "",
    owner: t("本地歌单"),
    trackCount: item.tracks.length,
    plays: 0,
    mine: true,
    saved: false,
    fixed: false,
  };
}

function snapshot(track) {
  return {
    id: String(track.id),
    name: String(track.name || t("未知歌曲")),
    artists: (track.artists || []).map((artist) => ({
      id: String(artist?.id || ""),
      name: String(artist?.name || t("未知歌手")),
    })),
    album: {
      id: String(track.album?.id || ""),
      name: String(track.album?.name || t("未知专辑")),
      ...(track.album?.imageUrl ? { imageUrl: String(track.album.imageUrl) } : {}),
    },
    duration: Number(track.duration) || 0,
    ...(track.url ? { url: String(track.url) } : {}),
  };
}

function normalizeName(value) {
  const name = String(value ?? "").trim().slice(0, 80);
  if (!name) fail("failed", "歌单名称不能为空");
  return name;
}

async function fetchTracks(ids) {
  const result = [];
  for (let index = 0; index < ids.length; index += 500) {
    const batch = ids.slice(index, index + 500);
    const data = await api("/api/v3/song/detail", {
      c: JSON.stringify(batch.map((id) => ({ id }))),
    });
    const songs = new Map((data.songs || []).map((song) => [String(song.id), model.track(song)]));
    for (const id of batch) {
      const song = songs.get(String(id));
      if (song) result.push(song);
    }
  }
  return result;
}

export function playlists() {
  return load().items
    .slice()
    .sort((left, right) => (right.createdAt - left.createdAt) || 0)
    .map(summary);
}

export function localPlaylist({ id } = {}) {
  const item = requirePlaylist(load(), id);
  return { ...summary(item), tracks: item.tracks.map((track) => ({ ...track })) };
}

export function createPlaylist({ name } = {}) {
  const title = normalizeName(name);
  const state = load();
  if (state.items.length >= MAX_PLAYLISTS) {
    return fail("failed", t("最多创建 {count} 个歌单", { count: MAX_PLAYLISTS }));
  }
  const now = Date.now();
  const item = { id: `${ID_PREFIX}${state.next}`, name: title, createdAt: now, updatedAt: now, tracks: [] };
  state.next += 1;
  state.items.unshift(item);
  save(state);
  return summary(item);
}

export function renamePlaylist({ id, name } = {}) {
  const title = normalizeName(name);
  const state = load();
  const item = requirePlaylist(state, id);
  item.name = title;
  item.updatedAt = Date.now();
  save(state);
  return summary(item);
}

export function deletePlaylist({ id } = {}) {
  const state = load();
  const index = state.items.findIndex((item) => item.id === String(id));
  if (index < 0) return {};
  state.items.splice(index, 1);
  save(state);
  return {};
}

export async function addToPlaylist({ id, trackIds } = {}) {
  const state = load();
  requirePlaylist(state, id);
  const existingIds = new Set(requirePlaylist(state, id).tracks.map((track) => track.id));
  const ids = [...new Set((Array.isArray(trackIds) ? trackIds : []).map(String).filter((value) => /^\d+$/.test(value)))]
    .filter((value) => !existingIds.has(value));
  if (!ids.length) return summary(requirePlaylist(state, id));

  const known = new Map();
  const missing = [];
  for (const trackId of ids) {
    const cached = model.cachedMeta(trackId);
    if (cached) known.set(trackId, cached);
    else missing.push(trackId);
  }
  if (missing.length) {
    for (const track of await fetchTracks(missing)) known.set(String(track.id), track);
  }
  if (!known.size) fail("unavailable", "歌曲暂不可用");

  // 元数据请求期间歌单可能变化，写回前重新读一次。
  const latest = load();
  const item = requirePlaylist(latest, id);
  const existing = new Set(item.tracks.map((track) => track.id));
  const added = [];
  for (const trackId of ids) {
    const track = known.get(trackId);
    if (!track || existing.has(String(track.id))) continue;
    if (item.tracks.length + added.length >= MAX_TRACKS) {
      fail("failed", t("单个歌单最多 {count} 首歌曲", { count: MAX_TRACKS }));
    }
    const stored = snapshot(track);
    existing.add(stored.id);
    added.push(stored);
  }
  if (!added.length) return summary(item);
  item.tracks.push(...added);
  item.updatedAt = Date.now();
  save(latest);
  return summary(item);
}

export function removeFromPlaylist({ id, trackIds } = {}) {
  const state = load();
  const item = requirePlaylist(state, id);
  const removing = new Set((Array.isArray(trackIds) ? trackIds : []).map(String));
  const before = item.tracks.length;
  item.tracks = item.tracks.filter((track) => !removing.has(track.id));
  if (item.tracks.length !== before) {
    item.updatedAt = Date.now();
    save(state);
  }
  return summary(item);
}

export function movePlaylistTrack({ id, from, to } = {}) {
  const state = load();
  const item = requirePlaylist(state, id);
  const start = Number(from);
  const end = Number(to);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return summary(item);
  if (start < 0 || start >= item.tracks.length) return summary(item);
  const target = Math.max(0, Math.min(item.tracks.length - 1, end));
  if (start === target) return summary(item);
  const [moved] = item.tracks.splice(start, 1);
  item.tracks.splice(target, 0, moved);
  item.updatedAt = Date.now();
  save(state);
  return summary(item);
}
