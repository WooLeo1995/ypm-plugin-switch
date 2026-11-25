// 音源请求的统一辅助：超时、软失败（4xx / 无结果）与硬失败（网络 / 5xx / 解析失败）分开。
// 硬失败抛 SourceError，由网关计入熔断；软失败返回 null，换下一个音源但不冷却。
import { t } from "../../i18n.js";

export class SourceError extends Error {
  constructor(message) {
    super(String(message));
    this.name = "SourceError";
  }
}

const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
};

// 音源自定义头要能覆盖默认头；HTTP 头名大小写不敏感，不能两个都发出去。
function mergeHeaders(overrides = {}) {
  const merged = { ...DEFAULT_HEADERS };
  const custom = new Set(Object.keys(overrides).map((key) => key.toLowerCase()));
  for (const key of Object.keys(merged)) {
    if (custom.has(key.toLowerCase())) delete merged[key];
  }
  return { ...merged, ...overrides };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

// 音源内部请求不能超过网关的总预算。
export function budget(ctx, fallback = 8000) {
  const left = Number(ctx?.deadline) - Date.now();
  if (!Number.isFinite(left)) return fallback;
  return Math.max(1200, Math.min(fallback, Math.floor(left)));
}

function hostOf(url) {
  try {
    return new URL(String(url)).host;
  } catch (_) {
    return "音源";
  }
}

async function fetchText(url, headers, timeout) {
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: mergeHeaders(headers),
      redirect: "follow",
      signal: AbortSignal.timeout(Math.max(1000, Number(timeout) || 8000)),
    });
  } catch (error) {
    throw new SourceError(t("无法连接 {host}", { host: hostOf(url) }) + `: ${String(error?.message || error).slice(0, 80)}`);
  }
  const status = Number(response.status);
  if (status >= 500 || status === 429) throw new SourceError(`${hostOf(url)} HTTP ${status}`);
  if (status < 200 || status >= 300) return null;
  try {
    return await response.text();
  } catch (error) {
    throw new SourceError(`${t("音源返回了无法识别的响应")}: ${String(error?.message || error).slice(0, 80)}`);
  }
}

export async function getText(url, { headers = {}, timeout = 8000 } = {}) {
  return fetchText(url, headers, timeout);
}

export async function getJson(url, { headers = {}, timeout = 8000, retries = 1, deadline } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(300 + attempt * 200);
    // 重试也要落在网关总预算里，不能每次都用完整超时。
    const left = Number(deadline) - Date.now();
    const attemptTimeout = Number.isFinite(left) ? Math.max(1000, Math.min(timeout, left)) : timeout;
    try {
      const body = await fetchText(url, headers, attemptTimeout);
      if (body == null) return null;
      return JSON.parse(body);
    } catch (error) {
      lastError = error instanceof SourceError ? error : new SourceError("invalid json");
    }
  }
  throw lastError || new SourceError("request failed");
}
