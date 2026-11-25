// 播放前校验候选直链：HEAD 优先，被拒绝时用 1 字节 Range GET 兜底。
// 过期签名常见的表现是 403/404 或返回 HTML 错误页，都判为不可用。
import { normalizeUrl } from "./url.js";

const AUDIO_TYPE = /^(audio\/|video\/|application\/(octet-stream|binary-octet-stream|x-flac|x-ogg|ogg|mpeg|mp4|force-download|download))/i;

function header(response, name) {
  const headers = response?.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  return String(headers[name] || "");
}

function judge(response, via) {
  const status = Number(response?.status || 0);
  if (!status) return { ok: false, retry: via === "head", reason: "no-response" };
  if ([403, 405, 501].includes(status)) return { ok: false, retry: via === "head", status, reason: "head-blocked" };
  if (status !== 200 && status !== 206) return { ok: false, retry: false, status, reason: `http-${status}` };
  const type = header(response, "content-type").toLowerCase();
  const length = Number(header(response, "content-length") || 0);
  // 有类型就只认音视频 / 明确的可下载类型，避免把图片、PDF、HTML 错误页当成音频。
  if (type) {
    if (AUDIO_TYPE.test(type)) return { ok: true, status, type, length };
    return { ok: false, retry: via === "head", status, type, reason: "not-audio" };
  }
  // 没有类型但给了长度，或 2xx 什么都没有：宁可采信，避免误杀正常 CDN。
  return { ok: true, status, type, length, ...(length ? {} : { weak: true }) };
}

export async function probe(rawUrl, { timeout = 6000 } = {}) {
  const url = normalizeUrl(rawUrl);
  if (!url) return { ok: false, reason: "invalid-url", ms: 0 };
  const started = Date.now();
  let head = null;
  try {
    head = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(timeout) });
  } catch (_) {
    head = null;
  }
  let verdict = head ? judge(head, "head") : { ok: false, retry: true, reason: "head-error" };
  if (!verdict.ok && verdict.retry) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        redirect: "follow",
        signal: AbortSignal.timeout(timeout),
      });
      verdict = judge(response, "range");
    } catch (_) {
      verdict = { ok: false, reason: "range-error" };
    }
  }
  return { ...verdict, url, ms: Date.now() - started };
}
