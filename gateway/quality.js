// 音质归一化与各音源档位映射。
export const QUALITIES = ["standard", "high", "lossless"];

// 插件设置优先；设置留空时跟随宿主传入的 quality；都没有就按 high。
export function resolveQuality(hostQuality, setting) {
  if (QUALITIES.includes(setting)) return setting;
  if (QUALITIES.includes(hostQuality)) return hostQuality;
  return "high";
}

export function gdstudioBr(quality) {
  if (quality === "lossless") return 999;
  if (quality === "standard") return 128;
  return 320;
}

export function kuwoBr(quality) {
  return quality === "standard" ? "128kmp3" : "320kmp3";
}

// 把音源返回的实际码率归回宿主的三档。
export function classify(bitRate, type) {
  const rate = Number(bitRate) || 0;
  const kind = String(type || "").toLowerCase();
  if (kind.includes("flac") || rate >= 700) return "lossless";
  if (rate >= 256) return "high";
  return "standard";
}

export function qualityLabel(quality) {
  if (quality === "lossless") return "无损";
  if (quality === "standard") return "标准";
  return "高音质";
}

export function typeFromUrl(url, fallback = "") {
  const path = String(url || "").split("?")[0].split("#")[0];
  const match = /\.([A-Za-z0-9]{2,5})$/.exec(path);
  if (!match) return fallback || "mp3";
  const extension = match[1].toLowerCase();
  if (["mp3", "flac", "m4a", "aac", "ogg", "opus", "wav"].includes(extension)) return extension;
  return fallback || "mp3";
}
