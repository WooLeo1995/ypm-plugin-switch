// 音源网关：排序 → 逐个解析 → 校验直链 → 自动回退。成功结果带 TTL 缓存。
import { flag, setting, t } from "../i18n.js";
import { orderedProviders } from "./registry.js";
import { probe } from "./probe.js";
import { cachedStream, clearStream, recentFailure, rememberFailure, rememberStream } from "./cache.js";
import * as health from "./health.js";
import { classify, qualityLabel, resolveQuality } from "./quality.js";

const BUDGET_MS = 22000;
const VERIFY_FRESH_MS = 2 * 60 * 1000;

// 同一首歌同一档位并发点播时只解析一次，避免重复请求音源和重复探测。
const inflight = new Map();

function unavailable(message, attempts = []) {
  const error = new Error(message);
  error.code = "unavailable";
  error.attempts = attempts;
  return error;
}

function audioStream(found, requested) {
  const bitRate = Number(found.bitRate) || 0;
  const type = String(found.type || "mp3").toLowerCase();
  let quality;
  if (type.includes("flac")) quality = "lossless";
  else if (bitRate > 0) quality = classify(bitRate, type);
  // 拿不到码率时，不把普通 mp3 标成无损；请求无损失败降级按 high 展示。
  else quality = requested === "lossless" ? "high" : requested;
  return {
    url: found.url,
    type,
    quality,
    ...(bitRate ? { bitRate } : {}),
    ...(Number(found.size) ? { size: Number(found.size) } : {}),
  };
}

export function resolveStream(options = {}) {
  const key = `${String(options?.track?.id || "")}:${String(options?.hostQuality || options?.quality || "")}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const task = resolveOnce(options).finally(() => {
    if (inflight.get(key) === task) inflight.delete(key);
  });
  inflight.set(key, task);
  return task;
}

async function resolveOnce({ track, quality, hostQuality } = {}) {
  const trackId = String(track?.id || "");
  if (!trackId) throw unavailable(t("无效的网易云资源编号"));
  const requested = resolveQuality(hostQuality || quality, setting("quality"));
  const verify = !flag("skipVerify");

  // 1. 缓存直链：短时间内直接复用；超过 2 分钟重新探测，避免把过期地址交给播放器。
  const cached = cachedStream(trackId, requested);
  if (cached) {
    if (!verify || Date.now() - (cached.verifiedAt || cached.at) < VERIFY_FRESH_MS) return cached.stream;
    const verdict = await probe(cached.stream.url, { timeout: 6000 });
    if (verdict.ok) {
      rememberStream(trackId, requested, { ...cached, verifiedAt: Date.now() });
      return cached.stream;
    }
    clearStream(trackId, requested);
    console.info(`[switch] cached url expired for ${trackId}: ${verdict.reason || verdict.status}`);
  }

  // 2. 刚刚确定无源的歌曲，短时间直接失败，避免连续点播时反复打音源。
  const failed = recentFailure(trackId, requested);
  if (failed) throw unavailable(t("没有可用音源，请稍后重试"), failed.reason ? [failed.reason] : []);

  const providers = orderedProviders();
  if (!providers.length) {
    throw unavailable(t("GDStudio 与酷我音源都被停用，请在插件设置中启用至少一个音源"), [t("没有启用的音源")]);
  }

  const deadline = Date.now() + BUDGET_MS;
  const attempts = [];

  // 3. 按顺序尝试；每个音源只负责给候选地址，是否可用由这里统一探测。
  for (const provider of providers) {
    if (Date.now() >= deadline) {
      attempts.push(`${t(provider.label)}:${t("超时")}`);
      break;
    }
    if (!health.available(provider.id)) {
      attempts.push(`${t(provider.label)}:${t("冷却中")}`);
      continue;
    }
    const started = Date.now();
    try {
      const found = await provider.resolve({ track, quality: requested, deadline });
      if (!found?.url) {
        health.recordMiss(provider.id);
        attempts.push(`${t(provider.label)}:${t("未命中")}`);
        continue;
      }
      if (verify) {
        const verdict = await probe(found.url, {
          timeout: Math.max(2500, Math.min(6000, deadline - Date.now())),
        });
        if (!verdict.ok) {
          health.recordFailure(provider.id, `probe ${verdict.reason || verdict.status || "failed"}`);
          attempts.push(`${t(provider.label)}:${t("直链不可用")}`);
          console.warn(`[switch] ${provider.id} probe failed:`, verdict.reason || verdict.status);
          continue;
        }
      }
      const stream = audioStream(found, requested);
      health.recordSuccess(provider.id, Date.now() - started);
      rememberStream(trackId, requested, {
        stream,
        provider: provider.id,
        verifiedAt: verify ? Date.now() : 0,
      });
      console.info(`[switch] ${trackId} <- ${provider.id} ${qualityLabel(stream.quality)} ${stream.type} ${Date.now() - started}ms`);
      return stream;
    } catch (error) {
      health.recordFailure(provider.id, error?.message || error);
      attempts.push(`${t(provider.label)}:${String(error?.message || error).slice(0, 80)}`);
      console.warn(`[switch] ${provider.id} failed:`, error?.message || error);
    }
  }

  rememberFailure(trackId, requested, attempts.join("; "));
  throw unavailable(t("没有可用音源，请稍后重试"), attempts);
}

// 给菜单与自检复用：把宿主传入的曲目对象规整成网关需要的形状。
export function trackForGateway(track) {
  return {
    id: String(track?.id || ""),
    name: String(track?.name || ""),
    artists: Array.isArray(track?.artists) ? track.artists.map((value) => ({ id: String(value?.id || ""), name: String(value?.name || "") })) : [],
    duration: Number(track?.duration) || 0,
    album: track?.album && typeof track.album === "object" ? track.album : {},
  };
}
