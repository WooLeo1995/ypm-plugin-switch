// 免登录本地歌单与「我喜欢的音乐」。
// 歌单与曲目快照存在 host.storage；喜欢 = 默认固定歌单，播放仍走音源网关。
import { api, fail } from "./client.js";
import * as model from "./models.js";
import { t } from "../i18n.js";

const STORAGE_KEY = "localPlaylists";
const LIKED_ID = "local-liked";
const ID_PREFIX = "local-";
const MAX_PLAYLISTS = 100;
const MAX_TRACKS = 2000;
const MAX_STORED_CHARS = 6 * 1024 * 1024;
const PAGE = 50;
const SAVED_KEY = "savedPlaylists";
const MAX_SAVED = 500;

function emptyState() {
  return { next: 1, items: [] };
}

function loadSaved() {
  const raw = host.storage.get(SAVED_KEY);
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) return { items: [] };
  const items = raw.items
    .filter((item) => item && typeof item === "object" && /^\d+$/.test(String(item.id || "")))
    .map((item) => ({
      id: String(item.id),
      name: String(item.name || t("未命名歌单")).slice(0, 120),
      imageUrl: String(item.imageUrl || ""),
      owner: String(item.owner || ""),
      trackCount: Number(item.trackCount) || 0,
      savedAt: Number(item.savedAt) || 0,
    }));
  return { items };
}

function saveSaved(state) {
  try {
    host.storage.set(SAVED_KEY, state);
  } catch (_) {
    fail("failed", "歌单数据已满，请删除一些歌单或歌曲");
  }
}

function savedSummary(item) {
  return {
    id: item.id,
    name: item.name,
    imageUrl: item.imageUrl,
    description: "",
    owner: item.owner,
    trackCount: item.trackCount,
    plays: 0,
    mine: false,
    saved: true,
    fixed: false,
  };
}

export function isSavedPlaylist(value) {
  const id = String(value ?? "");
  return /^\d+$/.test(id) && loadSaved().items.some((item) => item.id === id);
}

async function fetchPlaylistCard(id) {
  const data = await api("/api/v6/playlist/detail", { id, n: 1, s: 0 });
  if (!data.playlist) fail("unavailable", "歌单不存在，或没有访问权限");
  const mapped = model.playlist(data.playlist);
  return {
    id: mapped.id,
    name: mapped.name,
    imageUrl: mapped.imageUrl,
    owner: mapped.owner,
    trackCount: mapped.trackCount,
    savedAt: Date.now(),
  };
}

const isNumericId = (value) => /^\d+$/.test(String(value ?? ""));

function normalizePlaylist(value) {
  const id = String(value.id);
  return {
    id,
    name: id === LIKED_ID ? "" : String(value.name || t("未命名歌单")).slice(0, 80),
    createdAt: Number(value.createdAt) || 0,
    updatedAt: Number(value.updatedAt) || 0,
    // 只允许内置的喜欢歌单是 fixed，避免手工数据造出删不掉的普通歌单。
    fixed: id === LIKED_ID,
    tracks: Array.isArray(value.tracks) ? value.tracks.filter((track) => track && typeof track.id === "string") : [],
  };
}

// 存储格式损坏时退回空歌单，不让整个插件启动失败。
function load() {
  const raw = host.storage.get(STORAGE_KEY);
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) return emptyState();
  const items = raw.items
    .filter((item) => item && typeof item === "object" && (item.id === LIKED_ID || /^local-\d+$/.test(String(item.id || ""))))
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

// 喜欢歌单是内置且始终存在的；不写盘也能读，真正喜欢第一首歌时才落库。
function ensureLiked(state) {
  let item = state.items.find((value) => value.id === LIKED_ID);
  if (!item) {
    item = { id: LIKED_ID, name: "", createdAt: 0, updatedAt: 0, fixed: true, tracks: [] };
    state.items.push(item);
  }
  item.fixed = true;
  return item;
}

function find(state, id) {
  return state.items.find((item) => item.id === String(id));
}

function requirePlaylist(state, id) {
  const item = find(state, id);
  if (!item) fail("unavailable", "歌单不存在，或没有访问权限");
  return item;
}

function requireEditable(state, id) {
  const item = requirePlaylist(state, id);
  if (item.fixed) fail("unsupported", "默认喜欢歌单不能改名或删除");
  return item;
}

export function isLocalPlaylistId(value) {
  return /^local-(liked|\d+)$/.test(String(value ?? ""));
}

function summary(item) {
  const cover = item.tracks.find((track) => track.album?.imageUrl)?.album.imageUrl || "";
  return {
    id: item.id,
    name: item.fixed ? t("我喜欢的音乐") : item.name,
    imageUrl: cover,
    description: "",
    owner: t("本地歌单"),
    trackCount: item.tracks.length,
    plays: 0,
    mine: true,
    saved: false,
    fixed: Boolean(item.fixed),
  };
}

function cloneTrack(track) {
  return {
    ...track,
    artists: (track.artists || []).map((artist) => ({ ...artist })),
    album: { ...(track.album || {}) },
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

// 只拉取缓存里没有的曲目元数据；已在歌单里的 id 不会走到这里。
async function loadTracks(ids) {
  const known = new Map();
  const missing = [];
  for (const id of ids) {
    const cached = model.cachedMeta(id);
    if (cached) known.set(id, cached);
    else missing.push(id);
  }
  if (missing.length) {
    for (const track of await fetchTracks(missing)) known.set(String(track.id), track);
  }
  return known;
}

// 在 state 上就地追加；先校验容量，失败时不会留下半截数据。
function appendTracks(state, item, ids, known, { newestFirst = false } = {}) {
  const existing = new Set(item.tracks.map((track) => track.id));
  const fresh = [];
  for (const id of ids) {
    const track = known.get(id);
    if (!track || existing.has(String(track.id))) continue;
    existing.add(String(track.id));
    fresh.push(snapshot(track));
  }
  if (!fresh.length) return 0;
  if (item.tracks.length + fresh.length > MAX_TRACKS) {
    fail("failed", t("单个歌单最多 {count} 首歌曲", { count: MAX_TRACKS }));
  }
  if (newestFirst) item.tracks.unshift(...fresh);
  else item.tracks.push(...fresh);
  item.updatedAt = Date.now();
  return fresh.length;
}

export function playlists() {
  const state = load();
  const liked = ensureLiked(state);
  const regular = state.items
    .filter((item) => item.id !== LIKED_ID)
    .slice()
    .sort((left, right) => (right.createdAt - left.createdAt) || 0);
  const saved = loadSaved().items
    .slice()
    .sort((left, right) => (right.savedAt - left.savedAt) || 0)
    .map(savedSummary);
  return [summary(liked), ...regular.map(summary), ...saved];
}

export function localPlaylist({ id } = {}) {
  const state = load();
  ensureLiked(state);
  const item = requirePlaylist(state, id);
  return { ...summary(item), tracks: item.tracks.map(cloneTrack) };
}

export function createPlaylist({ name } = {}) {
  const title = normalizeName(name);
  const state = load();
  ensureLiked(state);
  const count = state.items.filter((item) => !item.fixed).length;
  if (count >= MAX_PLAYLISTS) {
    return fail("failed", t("最多创建 {count} 个歌单", { count: MAX_PLAYLISTS }));
  }
  const now = Date.now();
  const item = { id: `${ID_PREFIX}${state.next}`, name: title, createdAt: now, updatedAt: now, fixed: false, tracks: [] };
  state.next += 1;
  state.items.unshift(item);
  save(state);
  return summary(item);
}

export function renamePlaylist({ id, name } = {}) {
  const title = normalizeName(name);
  const state = load();
  const item = requireEditable(state, id);
  item.name = title;
  item.updatedAt = Date.now();
  save(state);
  return summary(item);
}

export function deletePlaylist({ id } = {}) {
  const value = String(id ?? "");
  if (value === LIKED_ID) fail("unsupported", "默认喜欢歌单不能改名或删除");
  // 收藏的网易云歌单不是自己的，删除操作按「取消收藏」处理。
  if (/^\d+$/.test(value)) {
    const saved = loadSaved();
    if (saved.items.some((item) => item.id === value)) {
      saved.items = saved.items.filter((item) => item.id !== value);
      saveSaved(saved);
    }
    return {};
  }
  const state = load();
  const index = state.items.findIndex((item) => item.id === value);
  if (index < 0) return {};
  state.items.splice(index, 1);
  save(state);
  return {};
}

export async function addToPlaylist({ id, trackIds } = {}) {
  const state = load();
  ensureLiked(state);
  const item = requirePlaylist(state, id);
  const existing = new Set(item.tracks.map((track) => track.id));
  const ids = [...new Set((Array.isArray(trackIds) ? trackIds : []).map(String).filter(isNumericId))]
    .filter((value) => !existing.has(value));
  if (!ids.length) return summary(item);

  const known = await loadTracks(ids);
  if (!known.size) fail("unavailable", "歌曲暂不可用");

  // 元数据请求期间歌单可能变化，写回前重新读一次。
  const latest = load();
  ensureLiked(latest);
  const target = requirePlaylist(latest, id);
  const added = appendTracks(latest, target, ids, known, { newestFirst: Boolean(target.fixed) });
  if (added) save(latest);
  return summary(target);
}

export function removeFromPlaylist({ id, trackIds } = {}) {
  const state = load();
  ensureLiked(state);
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
  ensureLiked(state);
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

// ── 收藏歌单 ─────────────────────────────────────────────────────────────

export async function savePlaylist({ id, on } = {}) {
  const playlistId = String(id ?? "");
  if (!/^\d+$/.test(playlistId)) fail("unavailable", "无效的网易云资源编号");
  const state = loadSaved();
  const existing = state.items.find((item) => item.id === playlistId);
  if (!on) {
    if (existing) {
      state.items = state.items.filter((item) => item.id !== playlistId);
      saveSaved(state);
    }
    return {};
  }
  if (existing) return savedSummary(existing);
  if (state.items.length >= MAX_SAVED) fail("failed", t("最多收藏 {count} 个歌单", { count: MAX_SAVED }));

  // 拉取歌单卡片所需的元数据；请求期间可能有别的收藏写入，落库前重新读。
  const card = await fetchPlaylistCard(playlistId);
  const latest = loadSaved();
  if (latest.items.some((item) => item.id === playlistId)) return savedSummary(latest.items.find((item) => item.id === playlistId));
  if (latest.items.length >= MAX_SAVED) fail("failed", t("最多收藏 {count} 个歌单", { count: MAX_SAVED }));
  latest.items.unshift(card);
  saveSaved(latest);
  return savedSummary(card);
}

// ── 喜欢 ────────────────────────────────────────────────────────────────

export function liked({ offset = 0 } = {}) {
  const state = load();
  const item = ensureLiked(state);
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  return {
    tracks: item.tracks.slice(start, start + PAGE).map(cloneTrack),
    more: start + PAGE < item.tracks.length,
  };
}

export function isLiked({ ids } = {}) {
  const state = load();
  const likedIds = new Set(ensureLiked(state).tracks.map((track) => track.id));
  const result = {};
  for (const id of (Array.isArray(ids) ? ids : [])) result[String(id)] = likedIds.has(String(id));
  return result;
}

export async function like({ id, on } = {}) {
  const trackId = String(id ?? "");
  if (!isNumericId(trackId)) fail("unavailable", "无效的网易云资源编号");
  const state = load();
  const item = ensureLiked(state);
  if (!on) {
    const before = item.tracks.length;
    item.tracks = item.tracks.filter((track) => track.id !== trackId);
    if (item.tracks.length !== before) {
      item.updatedAt = Date.now();
      save(state);
    }
    return {};
  }
  if (item.tracks.some((track) => track.id === trackId)) return {};

  const known = await loadTracks([trackId]);
  if (!known.size) fail("unavailable", "歌曲暂不可用");
  const latest = load();
  const target = ensureLiked(latest);
  if (appendTracks(latest, target, [trackId], known, { newestFirst: true })) save(latest);
  return {};
}
