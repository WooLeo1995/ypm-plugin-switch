// 音源健康状态与熔断。连续硬失败按 30s / 2min / 10min 退避，成功即清零。
const STORAGE_KEY = "gatewayHealth";
const COOLDOWN = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000];

let state = null;

function load() {
  if (state) return state;
  const saved = host.storage.get(STORAGE_KEY);
  state = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  return state;
}

function persist() {
  try {
    host.storage.set(STORAGE_KEY, state);
  } catch (_) {
    // 存储写失败不影响播放，下次成功会再写。
  }
}

export function available(providerId, now = Date.now()) {
  const entry = load()[providerId];
  return !entry?.until || Number(entry.until) <= now;
}

export function recordSuccess(providerId, latencyMs) {
  load()[providerId] = {
    fails: 0,
    lastOkAt: Date.now(),
    latencyMs: Math.max(0, Math.floor(Number(latencyMs) || 0)),
  };
  persist();
}

export function recordMiss(providerId) {
  const entry = load()[providerId] || { fails: 0 };
  entry.lastMissAt = Date.now();
  load()[providerId] = entry;
  persist();
}

export function recordFailure(providerId, reason) {
  const entry = load()[providerId] || { fails: 0 };
  entry.fails = (Number(entry.fails) || 0) + 1;
  entry.lastFailAt = Date.now();
  entry.lastError = String(reason == null ? "" : reason).slice(0, 200);
  entry.until = Date.now() + (COOLDOWN[Math.min(entry.fails, COOLDOWN.length) - 1] || COOLDOWN[COOLDOWN.length - 1]);
  load()[providerId] = entry;
  persist();
}

export function snapshot(providerIds = []) {
  const data = load();
  const result = {};
  for (const providerId of providerIds) {
    const entry = data[providerId] || {};
    result[providerId] = {
      fails: Number(entry.fails) || 0,
      lastOkAt: Number(entry.lastOkAt) || 0,
      lastFailAt: Number(entry.lastFailAt) || 0,
      lastMissAt: Number(entry.lastMissAt) || 0,
      latencyMs: Number(entry.latencyMs) || 0,
      until: Number(entry.until) || 0,
      lastError: entry.lastError || "",
    };
  }
  return result;
}

export function reset() {
  state = {};
  persist();
}
