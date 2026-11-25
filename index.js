// 宿主入口：转发曲库能力、暴露网关播放、右键菜单与设置检测。
import { t } from "./i18n.js";
import { fail } from "./catalog/client.js";
import * as library from "./catalog/library.js";
import { qualityLabel } from "./gateway/quality.js";
import { resolveStream, trackForGateway } from "./gateway/index.js";
import { browseSources, runSelfTest } from "./gateway/selftest.js";

// 纯 ASCII：方便从应用标准输出确认插件确实被加载，也不进入本地化词表。
console.info("[switch] source gateway loaded");

export { search, suggest, hotSearches, home, album, artist, playlist, lyrics } from "./catalog/library.js";
export { stream } from "./stream.js";

export async function browse({ page = "" } = {}) {
  const value = String(page || "");
  if (value === "sources" || value.startsWith("sources:")) return browseSources();
  return library.browse({ page: value });
}

export function trackMenu({ track } = {}) {
  // 有曲目信息时只给自己的曲目加菜单；本地音乐或其他音源的 ID 不是网易云编号。
  // 宿主没传曲目（例如只问菜单定义）时照常返回条目。
  if (track) {
    if (!/^\d+$/.test(String(track.id ?? ""))) return [];
    if (track.source && track.source !== "switch") return [];
  }
  return [
    { id: "switch.copy", title: t("复制音源直链") },
    { id: "switch.test", title: t("检测音源可用性") },
  ];
}

export async function menuAction({ id: action, track } = {}) {
  if (action !== "switch.copy" && action !== "switch.test") fail("unsupported", "未知菜单操作");
  const stream = await resolveStream({ track: trackForGateway(track), quality: "high" });
  const quality = t(qualityLabel(stream.quality));
  if (action === "switch.copy") {
    return {
      copy: stream.url,
      toast: t("已获取音源直链（{quality}）", { quality }),
    };
  }
  return {
    toast: t("音源可用：{quality} · {bitRate}kbps", {
      quality,
      bitRate: stream.bitRate || "?",
    }),
  };
}

export async function testConnection() {
  const results = await runSelfTest();
  if (!results.length) throw Object.assign(new Error(t("没有启用的音源")), { code: "setup" });
  const failed = results.filter((result) => !result.ok);
  if (failed.length) {
    throw new Error(t("{count} 个音源不可用", { count: failed.length }));
  }
  return t("{count} 个音源可用", { count: results.length });
}
