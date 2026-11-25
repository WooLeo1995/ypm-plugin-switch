// 酷我波点（bd-api）取址：先 watch 广告拿权益（失败也继续），再按 md5 签名请求 audioUrl。
// 链路移植自参考插件的 src/unblock.js，仅把 qplayer.call 换成宿主 fetch 与 host.crypto.md5。
import { budget, getJson } from "./http.js";
import { findKuwoTrack, ridOf } from "./kuwo-search.js";
import { kuwoBr } from "../quality.js";

const AD_URL = "https://bd-api.kuwo.cn/api/service/advert/watch"
  + "?uid=-1&token=&timestamp=1724306124436&sign=15a676d66285117ad714e8c8371691da";
const PLAY_URL = "https://bd-api.kuwo.cn/api/play/music/v2/audioUrl";
const AUDIO_PATH = "/api/play/music/v2/audioUrl";
const HEADERS = {
  "user-agent": "Dart/2.19 (dart:io)",
  "plat": "ar",
  "channel": "aliopen",
  "devid": "48291736401",
  "ver": "3.9.0",
  "qimei36": "1e9970cbcdc20a031dee9f37100017e1840e",
};

function signUrl(url) {
  const stamped = `${url}&timestamp=${Date.now()}`;
  const query = stamped.slice(stamped.indexOf("?") + 1).replace(/[^a-zA-Z0-9]/g, "");
  const chars = query.split("").sort().join("");
  return `${stamped}&sign=${host.crypto.md5(`kuwotest${chars}${AUDIO_PATH}`)}`;
}

function sizeOf(value) {
  const match = /^([\d.]+)\s*([KMGT])?B?$/i.exec(String(value || "").trim());
  if (!match) return 0;
  const unit = String(match[2] || "").toUpperCase();
  const factor = unit === "T" ? 1024 ** 4 : unit === "G" ? 1024 ** 3 : unit === "M" ? 1024 ** 2 : unit === "K" ? 1024 : 1;
  return Math.round(Number(match[1]) * factor) || 0;
}

async function watchAd(ctx) {
  try {
    await fetch(AD_URL, {
      method: "POST",
      headers: { ...HEADERS, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ type: 5, subType: 5, musicId: 0, adToken: "" }),
      signal: AbortSignal.timeout(budget(ctx, 5000)),
    });
  } catch (_) {
    // 广告权益接口失败不影响取址，参考实现同样忽略。
  }
}

export default {
  id: "kuwo-bodian",
  family: "kuwo",
  // 酷我版权收紧后主流原曲大多搜不到；自检用波点链路确实在架的一首歌，
  // 避免把「曲库没有」误报成「音源坏了」。
  sample: {
    id: "0",
    name: "屋顶",
    artists: [{ id: "", name: "周杰伦 温岚 吴宗宪" }],
    duration: 322000,
    album: { id: "", name: "" },
  },
  label: "酷我",
  kind: "keyword",

  async resolve(ctx) {
    const hit = await findKuwoTrack(ctx?.track, ctx);
    const rid = hit ? ridOf(hit) : "";
    if (!rid) return null;
    await watchAd(ctx);
    const data = await getJson(signUrl(`${PLAY_URL}?&br=${kuwoBr(ctx.quality)}&musicId=${rid}`), {
      headers: HEADERS,
      timeout: budget(ctx),
      retries: 0,
      deadline: ctx.deadline,
    });
    if (Number(data?.code) !== 200) return null;
    const audio = data.data || {};
    const url = String(audio.audioHttpsUrl || audio.audioUrl || "").replace(/^http:\/\//i, "https://");
    if (!/^https:\/\//i.test(url)) return null;
    return {
      url,
      type: "mp3",
      bitRate: Number(audio.bitrate) || 0,
      size: sizeOf(audio.size),
    };
  },
};
