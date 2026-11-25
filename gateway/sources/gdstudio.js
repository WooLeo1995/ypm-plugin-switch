// GDStudio：按网易云 ID 直接取址。这是命中率最高、最快的一条链路。
import { budget, getJson } from "./http.js";
import { normalizeUrl } from "../url.js";
import { gdstudioBr, typeFromUrl } from "../quality.js";

const API = "https://music-api.gdstudio.xyz/api.php";

export default {
  id: "gdstudio",
  family: "gdstudio",
  label: "GDStudio",
  kind: "id",

  async resolve(ctx) {
    const songId = String(ctx?.track?.id || "");
    if (!/^\d+$/.test(songId)) return null;
    // 请求无损但上游没有 FLAC 时，回到 320k MP3，避免整条链路直接失败。
    const levels = ctx.quality === "lossless" ? [999, 320] : [gdstudioBr(ctx.quality)];
    for (const br of levels) {
      const data = await getJson(
        `${API}?types=url&source=netease&id=${encodeURIComponent(songId)}&br=${br}`,
        { timeout: budget(ctx), deadline: ctx.deadline },
      );
      const url = normalizeUrl(data?.url);
      if (!url) continue;
      return {
        url,
        type: typeFromUrl(url),
        bitRate: Number(data.br) || 0,
        size: Number(data.size) || 0,
      };
    }
    return null;
  },
};
