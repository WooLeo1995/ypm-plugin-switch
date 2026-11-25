// 酷我搜索：波点与移动两条取址链路共用。版权收紧后搜索结果里翻唱/伴奏很多，
// 必须靠 match.js 的严格规则筛选，匹配不到就返回 null。
import { budget, getJson } from "./http.js";
import { artistText, keywordVariants, pickMatch } from "../match.js";

const SEARCH = "https://search.kuwo.cn/r.s";

export async function searchKuwo(keyword, ctx) {
  const url = `${SEARCH}?&correct=1&stype=comprehensive&encoding=utf8&rformat=json&mobi=1`
    + `&show_copyright_off=1&searchapi=6&all=${encodeURIComponent(keyword)}`;
  const data = await getJson(url, { timeout: budget(ctx), deadline: ctx.deadline });
  const list = data?.content?.[1]?.musicpage?.abslist;
  return Array.isArray(list) ? list : [];
}

export async function findKuwoTrack(track, ctx) {
  if (!track?.name) return null;
  const wantArtist = artistText(track);
  for (const keyword of keywordVariants(track)) {
    const list = await searchKuwo(keyword, ctx);
    if (!list.length) continue;
    const hit = pickMatch(
      list,
      (row) => row?.SONGNAME,
      (row) => row?.ARTIST,
      (row) => row?.DURATION,
      track.name,
      wantArtist,
      track.duration,
    );
    if (hit) return hit;
  }
  return null;
}

// MUSICRID 形如 "MUSIC_77286775"；波点与移动接口都只要数字部分。
export function ridOf(row) {
  const raw = String(row?.MUSICRID || "");
  const index = raw.lastIndexOf("_");
  const rid = index >= 0 ? raw.slice(index + 1) : raw;
  return /^\d+$/.test(rid) ? rid : "";
}
