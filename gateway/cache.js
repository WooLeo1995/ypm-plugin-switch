// 直链缓存与失败短缓存。直链带时效，超过 10 分钟一律丢弃；失败缓存 45 秒。
const STREAM_TTL = 10 * 60 * 1000;
const FAIL_TTL = 45 * 1000;

const streams = new Map();
const failures = new Map();

const keyOf = (id, quality) => `${id}:${quality}`;

export function cachedStream(id, quality) {
  const key = keyOf(id, quality);
  const entry = streams.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > STREAM_TTL) {
    streams.delete(key);
    return null;
  }
  return entry;
}

export function rememberStream(id, quality, entry) {
  streams.set(keyOf(id, quality), { ...entry, at: Date.now() });
}

export function recentFailure(id, quality) {
  const key = keyOf(id, quality);
  const entry = failures.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > FAIL_TTL) {
    failures.delete(key);
    return null;
  }
  return entry;
}

export function rememberFailure(id, quality, reason) {
  failures.set(keyOf(id, quality), { at: Date.now(), reason: String(reason || "") });
}

export function clearStream(id, quality) {
  streams.delete(keyOf(id, quality));
}
