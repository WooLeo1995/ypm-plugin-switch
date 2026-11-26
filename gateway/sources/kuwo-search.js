// 酷我搜索：波点与移动两条取址链路共用。版权收紧后搜索结果里翻唱/伴奏很多，
// 必须靠 match.js 的严格规则筛选，匹配不到就返回 null。
import { budget, getJson } from "./http.js";
import { artistText, keywordVariants, pickMatch } from "../match.js";

const SEARCH = "https://search.kuwo.cn/r.s";
const KT_PARAMS = "uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1"
  + "&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1";

export async function searchKuwo(keyword, ctx) {
  const url = `${SEARCH}?&correct=1&stype=comprehensive&encoding=utf8&rformat=json&mobi=1`
    + `&show_copyright_off=1&searchapi=6&all=${encodeURIComponent(keyword)}`;
  const data = await getJson(url, { timeout: budget(ctx), deadline: ctx.deadline });
  const list = data?.content?.[1]?.musicpage?.abslist;
  return Array.isArray(list) ? list : [];
}

// 旧的综合搜索一次只给几条，版权收紧后经常只剩翻唱/伴奏；用 KT 客户端的搜索
// 再兜一层，能拿到专辑、封面与更完整的匹配结果。只在旧接口没命中时才请求。
export async function searchKuwoKt(keyword, ctx, { pn = 0, rn = 50 } = {}) {
  const page = Math.max(0, Math.floor(Number(pn) || 0));
  const size = Math.max(1, Math.min(100, Math.floor(Number(rn) || 50)));
  const url = `${SEARCH}?client=kt&all=${encodeURIComponent(keyword)}&pn=${page}&rn=${size}&${KT_PARAMS}`;
  const data = await getJson(url, { timeout: budget(ctx, 8000), deadline: ctx?.deadline });
  return {
    rows: Array.isArray(data?.abslist) ? data.abslist : [],
    total: Number(data?.TOTAL) || 0,
  };
}

export async function findKuwoTrack(track, ctx) {
  if (!track?.name) return null;
  const wantArtist = artistText(track);
  const pick = (list) => pickMatch(
    list,
    (row) => row?.SONGNAME,
    (row) => row?.ARTIST,
    (row) => row?.DURATION,
    track.name,
    wantArtist,
    track.duration,
  );
  let lastError = null;
  for (const keyword of keywordVariants(track)) {
    let oldRows = [];
    try {
      oldRows = await searchKuwo(keyword, ctx);
    } catch (error) {
      lastError = error;
    }
    const hit = oldRows.length ? pick(oldRows) : null;
    if (hit) return hit;
    try {
      const { rows } = await searchKuwoKt(keyword, ctx, { rn: 50 });
      const ktHit = pick(rows);
      if (ktHit) return ktHit;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

// MUSICRID 形如 "MUSIC_77286775"；波点与移动接口都只要数字部分。
export function ridOf(row) {
  const raw = String(row?.MUSICRID || "");
  const index = raw.lastIndexOf("_");
  const rid = index >= 0 ? raw.slice(index + 1) : raw;
  return /^\d+$/.test(rid) ? rid : "";
}
