// stream() 入口：先用匿名歌曲详情补全曲名/歌手/时长，再交给网关选音源。
import { api, fail } from "./catalog/client.js";
import * as model from "./catalog/models.js";
import { resolveStream } from "./gateway/index.js";

async function trackOf(value) {
  const songId = String(value ?? "");
  if (!/^\d+$/.test(songId)) fail("unavailable", "无效的网易云资源编号");
  const cached = model.cachedMeta(songId);
  if (cached) return cached;
  try {
    const data = await api("/api/v3/song/detail", { c: JSON.stringify([{ id: songId }]) });
    const song = data.songs?.[0];
    if (song) return model.track(song);
  } catch (error) {
    // 详情失败不阻断播放：按 ID 取址的音源仍然能工作，只是关键词音源拿不到歌名。
    console.warn("[switch] track detail failed:", error?.message || error);
  }
  return { id: songId, name: "", artists: [], album: {}, duration: 0 };
}

export async function stream({ id, quality = "high" } = {}) {
  const track = await trackOf(id);
  return resolveStream({ track, quality });
}
