// GDStudio 关键词搜索：按 ID 取址失败时，用歌名 + 歌手搜同曲库的另一条记录。
// 只有严格匹配（版本限定语、歌手、时长）才会采用，避免把翻唱当成原曲。
import { budget, getJson } from "./http.js";
import { normalizeUrl } from "../url.js";
import { gdstudioBr, typeFromUrl } from "../quality.js";
import { artistText, keywordVariants, pickMatch } from "../match.js";

const API = "https://music-api.gdstudio.xyz/api.php";

const artistOf = (row) => (Array.isArray(row?.artist) ? row.artist.join(" ") : String(row?.artist || ""));

export default {
  id: "gdstudio-search",
  family: "gdstudio",
  label: "GDStudio 搜索",
  kind: "keyword",

  async resolve(ctx) {
    const track = ctx?.track;
    if (!track?.name) return null;
    const wantArtist = artistText(track);
    for (const keyword of keywordVariants(track)) {
      const list = await getJson(
        `${API}?types=search&source=netease&name=${encodeURIComponent(keyword)}&count=20&pages=1`,
        { timeout: budget(ctx), deadline: ctx.deadline },
      );
      if (!Array.isArray(list) || !list.length) continue;
      const hit = pickMatch(
        list,
        (row) => row?.name,
        artistOf,
        (row) => row?.duration || row?.interval || 0,
        track.name,
        wantArtist,
        track.duration,
      );
      if (!hit?.id) continue;
      const levels = ctx.quality === "lossless" ? [999, 320] : [gdstudioBr(ctx.quality)];
      for (const br of levels) {
        const data = await getJson(
          `${API}?types=url&source=netease&id=${encodeURIComponent(hit.id)}&br=${br}`,
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
    }
    return null;
  },
};
