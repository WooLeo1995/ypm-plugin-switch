// 酷我移动端 convert_url2 取址：查询串用自定义 3DES 加密，返回文本里带直链。
import { budget, getText } from "./http.js";
import { findKuwoTrack, ridOf } from "./kuwo-search.js";
import { encryptQuery } from "./kuwo-des.js";

const MOBI_URL = "https://mobi.kuwo.cn/mobi.s";
const SOURCE = "kwplayer_ar_5.1.0.0_B_jiakong_vh.apk";

export default {
  id: "kuwo-mobi",
  family: "kuwo",
  // 酷我版权收紧后主流原曲大多搜不到；自检用移动链路确实在架的一首歌，
  // 避免把「曲库没有」误报成「音源坏了」。
  sample: {
    id: "0",
    name: "可惜没如果",
    artists: [{ id: "", name: "林俊杰" }],
    duration: 298000,
    album: { id: "", name: "" },
  },
  label: "酷我移动",
  kind: "keyword",

  async resolve(ctx) {
    const hit = await findKuwoTrack(ctx?.track, ctx);
    const rid = hit ? ridOf(hit) : "";
    if (!rid) return null;
    const query = `corp=kuwo&source=${SOURCE}&p2p=1&type=convert_url2&sig=0&format=mp3&rid=${rid}`;
    const body = await getText(`${MOBI_URL}?f=kuwo&q=${encodeURIComponent(encryptQuery(query))}`, {
      headers: { "User-Agent": "okhttp/3.10.0" },
      timeout: budget(ctx),
    });
    const textBody = String(body || "");
    const match = /url=(https?:\/\/[^\s\r\n]+)/.exec(textBody);
    if (!match) return null;
    const bitRate = Number((/bitrate=(\d+)/.exec(textBody) || [])[1]) || 0;
    return {
      // 实测把 http 换成 https 后同一 CDN 仍可播放。
      url: match[1].replace(/^http:\/\//i, "https://"),
      type: "mp3",
      bitRate,
    };
  },
};
