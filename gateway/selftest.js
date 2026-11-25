// 音源自检：用固定样例曲目逐个音源解析并探测直链，结果渲染在「音源网关」页。
// 纯只读，不写健康熔断状态，避免自检影响用户正常播放的排序。
import { orderedProviders, providerList } from "./registry.js";
import { probe } from "./probe.js";
import { classify, qualityLabel } from "./quality.js";
import { t } from "../i18n.js";

// 347230《海阔天空》/ Beyond，网易云匿名接口可查到，GDStudio 通常有 320k 直链。
const SAMPLE = {
  id: "347230",
  name: "海阔天空",
  artists: [{ id: "", name: "Beyond" }],
  duration: 326000,
  album: { id: "", name: "" },
};

async function testProvider(provider) {
  const started = Date.now();
  try {
    const found = await provider.resolve({
      track: provider.sample || SAMPLE,
      quality: "high",
      deadline: Date.now() + 9000,
    });
    if (!found?.url) {
      // 关键词音源没搜到样例原曲只说明曲库没有这首歌，不代表接口坏了。
      const reachable = provider.kind === "keyword";
      return {
        ok: reachable,
        reached: reachable,
        detail: reachable ? t("接口可达，样例曲目未命中") : t("样例曲目取址失败"),
        ms: Date.now() - started,
      };
    }
    const verdict = await probe(found.url, { timeout: 6000 });
    return {
      ok: verdict.ok,
      reached: true,
      detail: verdict.ok
        ? t("直链可播放（{quality}）", {
          quality: t(qualityLabel(classify(Number(found.bitRate) || 0, found.type))),
        })
        : t("直链不可用（{reason}）", { reason: verdict.reason || String(verdict.status || "") }),
      ms: Date.now() - started,
    };
  } catch (error) {
    return { ok: false, reached: false, detail: String(error?.message || error).slice(0, 120), ms: Date.now() - started };
  }
}

export async function runSelfTest() {
  return Promise.all(providerList().map(async (provider) => ({
    provider,
    ...(await testProvider(provider)),
  })));
}

export async function browseSources() {
  const results = await runSelfTest();
  const order = orderedProviders();
  return {
    title: t("音源网关"),
    subtitle: t("每个音源用一首样例曲目解析并校验直链，重新进入本页会再次检测。"),
    sections: [
      {
        title: t("音源自检"),
        links: results.map((result) => ({
          title: t(result.provider.label),
          subtitle: `${result.ok ? t("可用") : t("不可用")} · ${result.ms}ms · ${result.detail}`,
          page: "sources",
        })),
      },
      {
        title: t("回退顺序"),
        links: order.map((provider, index) => ({
          title: `${index + 1}. ${t(provider.label)}`,
          subtitle: provider.family === "gdstudio" ? t("GDStudio 音源") : t("酷我音源"),
          page: "sources",
        })),
      },
    ],
  };
}
