#!/usr/bin/env node
// 实网冒烟：用最小 host stub 加载真实插件模块，对真实网络跑通搜索、解析、缓存、
// 三档音质、无源、自检与设置生效，并校验运行期请求主机都被 plugin.json 的网络权限覆盖。
//
// 用法：node scripts/live-check.mjs
// 退出码：0 全部通过；1 有检查失败；2 全局硬超时。
// 说明：不打印带签名的完整直链，只记录主机名与状态，避免把时效签名写进日志。
import { createCipheriv, createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ENTRY = path.join(ROOT, "index.js");
const MANIFEST_PATH = path.join(ROOT, "plugin.json");

const NET_TIMEOUT_MS = 15000; // fetch 兜底超时（插件自身也带 AbortSignal.timeout）
const CHECK_WATCHDOG_MS = 300000; // 全局硬超时，断网/挂起时强制退出
const SEARCH_TIMEOUT_MS = 25000;
const STREAM_TIMEOUT_MS = 60000; // 详情 15s + 网关预算 22s，留足余量
const SELFTEST_TIMEOUT_MS = 90000;
const UNAVAILABLE_LIMIT_MS = 30000;

// ---------------------------------------------------------------------------
// 结果记录
// ---------------------------------------------------------------------------
const results = [];
const totalStarted = Date.now();
let passCount = 0;

function mark(ok, name, detail = "", ms = 0) {
  results.push({ ok, name, detail: String(detail), ms });
  if (ok) passCount += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name} — ${detail}${ms ? ` (${ms}ms)` : ""}`);
  return ok;
}

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    return mark(true, name, detail == null ? "" : String(detail), Date.now() - started);
  } catch (error) {
    return mark(false, name, String(error?.message || error), Date.now() - started);
  }
}

function withTimeout(task, ms, label) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve().then(task), guard]).finally(() => clearTimeout(timer));
}

// 插件日志单独收集，正常输出保持 PASS/FAIL 清单；失败时附在汇总里。
const pluginLogs = [];
for (const level of ["info", "warn"]) {
  console[level] = (...args) => {
    pluginLogs.push(`[${level}] ${args.map((value) => String(value)).join(" ")}`);
  };
}

// ---------------------------------------------------------------------------
// 最小 host stub：storage / setting / t / crypto
// ---------------------------------------------------------------------------
let settings = {};
const store = new Map();

globalThis.host = {
  platform: "darwin",
  arch: "amd64",
  dir: ROOT,
  setting: (key) => (settings[key] == null ? "" : String(settings[key])),
  t: (message) => String(message),
  storage: {
    get: (key) => store.get(key),
    set: (key, value) => { store.set(key, value); },
    remove: (key) => { store.delete(key); },
  },
  crypto: {
    md5: (value) => createHash("md5").update(String(value)).digest("hex"),
    aesEcbEncrypt: (key, plain) => {
      const cipher = createCipheriv("aes-128-ecb", Buffer.from(String(key), "utf8"), null);
      return Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()])
        .toString("hex").toUpperCase();
    },
  },
  openURL: () => {},
};

function setSettings(next) {
  settings = { ...(next || {}) };
}

// ---------------------------------------------------------------------------
// fetch 观测：记录每个请求的主机、状态与耗时；兜底附加超时
// ---------------------------------------------------------------------------
const requests = [];
const realFetch = globalThis.fetch;
if (typeof realFetch !== "function") {
  console.error("[FAIL] 需要 Node.js 18+（缺少内置 fetch）");
  process.exit(1);
}

function hostnameOf(value) {
  try {
    return new URL(String(value)).hostname.toLowerCase();
  } catch (_) {
    return "";
  }
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : String(input?.url ?? input ?? "");
  const method = String(init?.method || input?.method || "GET").toUpperCase();
  const entry = {
    url,
    method,
    host: hostnameOf(url),
    timeoutSource: init.signal ? "caller" : "wrapper",
    startedAt: Date.now(),
  };
  requests.push(entry);
  const options = { ...init, signal: init.signal || AbortSignal.timeout(NET_TIMEOUT_MS) };
  try {
    const response = await realFetch(input, options);
    entry.status = response.status;
    entry.ms = Date.now() - entry.startedAt;
    if (response.url) {
      entry.finalHost = hostnameOf(response.url);
      entry.finalUrl = response.url;
    }
    return response;
  } catch (error) {
    entry.error = String(error?.name || error?.message || error);
    entry.ms = Date.now() - entry.startedAt;
    throw error;
  }
};

// ---------------------------------------------------------------------------
// plugin.json 静态校验
// ---------------------------------------------------------------------------
let manifest = null;
try {
  manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
} catch (error) {
  console.error(`[FAIL] 无法读取 plugin.json：${error?.message || error}`);
  process.exit(1);
}
const networkRules = Array.isArray(manifest?.permissions?.network) ? manifest.permissions.network : [];

function matchesNetworkRule(hostname, rule) {
  const host = String(hostname || "").toLowerCase();
  const value = String(rule || "").trim().toLowerCase();
  if (!host || !value) return false;
  if (value.startsWith("*.")) {
    const suffix = value.slice(1); // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === value;
}

function coveredByNetwork(hostname) {
  return networkRules.some((rule) => matchesNetworkRule(hostname, rule));
}

const KNOWN_ENDPOINTS = [
  ["interfacepc.music.163.com", "网易云 eapi"],
  ["music-api.gdstudio.xyz", "GDStudio API"],
  ["search.kuwo.cn", "酷我搜索"],
  ["bd-api.kuwo.cn", "酷我波点"],
  ["mobi.kuwo.cn", "酷我移动"],
  ["m701.music.126.net", "GDStudio 网易 CDN"],
  ["bd-lv.kuwo.cn", "酷我音频 CDN"],
];

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------
const SOURCE_HOSTS = new Map([
  ["music-api.gdstudio.xyz", "gdstudio"],
  ["search.kuwo.cn", "kuwo"],
  ["bd-api.kuwo.cn", "kuwo"],
  ["mobi.kuwo.cn", "kuwo"],
]);

function plain(value) {
  return String(value == null ? "" : value).toLowerCase()
    .replace(/[\s（）()【】[\]·・\-—_]/g, "");
}

function artistTextOf(track) {
  return (track?.artists || []).map((artist) => artist?.name || "").filter(Boolean).join(" ");
}

function familyOfUrl(url) {
  const host = hostnameOf(url);
  if (/(^|\.)music\.126\.net$/.test(host)) return "gdstudio";
  if (/(^|\.)kuwo\.cn$/.test(host)) return "kuwo";
  return "unknown";
}

// 按实际发出的 API 请求判断最后胜出的音源（探测 CDN 请求不算）。
function describeProvider(reqs) {
  const sources = reqs.filter((request) => SOURCE_HOSTS.has(request.host));
  if (!sources.length) return "unknown";
  const last = sources[sources.length - 1];
  if (last.host === "bd-api.kuwo.cn") return "kuwo-bodian";
  if (last.host === "mobi.kuwo.cn") return "kuwo-mobi";
  if (last.host === "search.kuwo.cn") return "kuwo-search";
  const searched = sources.some((request) => request.host === "music-api.gdstudio.xyz"
    && String(request.url).includes("types=search"));
  return searched ? "gdstudio-search" : "gdstudio";
}

function sourceFamilySequence(reqs) {
  return reqs.map((request) => SOURCE_HOSTS.get(request.host)).filter(Boolean);
}

function compress(sequence) {
  const out = [];
  for (const value of sequence) {
    if (out[out.length - 1] !== value) out.push(value);
  }
  return out;
}

// 直链探测：HEAD；403/405/501 或网络错误时用 Range GET 再试一次。
async function headStatus(url, timeout = 8000) {
  const started = Date.now();
  let head = null;
  try {
    head = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    head = null;
  }
  if (head && head.status >= 200 && head.status < 300) {
    return { ok: true, status: head.status, type: head.headers.get("content-type") || "", ms: Date.now() - started };
  }
  const shouldRetry = !head || [403, 405, 501].includes(head.status);
  if (head && !shouldRetry) {
    return {
      ok: false,
      status: head.status,
      type: head.headers.get("content-type") || "",
      ms: Date.now() - started,
    };
  }
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeout),
    });
    return {
      ok: response.status === 200 || response.status === 206,
      status: response.status,
      type: response.headers.get("content-type") || "",
      ms: Date.now() - started,
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error), ms: Date.now() - started };
  }
}

function validateQuality(requested, stream) {
  const quality = String(stream?.quality || "");
  const type = String(stream?.type || "").toLowerCase();
  const bitRate = Number(stream?.bitRate) || 0;
  const types = ["mp3", "flac", "m4a", "aac", "ogg", "opus", "wav"];
  if (!["standard", "high", "lossless"].includes(quality)) return { ok: false, reason: `非法 quality=${quality}` };
  if (!stream?.url || !/^https?:\/\//i.test(stream.url)) return { ok: false, reason: "缺少合法 url" };
  if (!types.includes(type)) return { ok: false, reason: `异常 type=${type}` };
  if (quality === "lossless" && type !== "flac") return { ok: false, reason: `lossless 但 type=${type}` };
  if (quality === "high" && bitRate && bitRate < 256) return { ok: false, reason: `high 但 bitRate=${bitRate}` };
  if (quality === "standard" && bitRate && bitRate > 192) return { ok: false, reason: `standard 但 bitRate=${bitRate}` };
  if (requested === "standard" && quality !== "standard") return { ok: false, reason: `请求 standard 实际 ${quality}` };
  if (requested === "high" && !["high", "lossless"].includes(quality)) return { ok: false, reason: `请求 high 实际 ${quality}` };
  if (requested === "lossless" && !["lossless", "high"].includes(quality)) return { ok: false, reason: `请求 lossless 实际 ${quality}` };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 全局硬超时
// ---------------------------------------------------------------------------
const watchdog = setTimeout(() => {
  console.error(`\n[FAIL] 全局硬超时 ${CHECK_WATCHDOG_MS}ms，网络可能挂起，强制退出`);
  process.exit(2);
}, CHECK_WATCHDOG_MS);
watchdog.unref?.();

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
let plugin = null;

const CANDIDATES = [
  { query: "海阔天空 Beyond", name: "海阔天空", artist: "Beyond" },
  { query: "平凡之路 朴树", name: "平凡之路", artist: "朴树" },
  { query: "演员 薛之谦", name: "演员", artist: "薛之谦" },
  { query: "光年之外 邓紫棋", name: "光年之外", artist: "邓紫棋" },
];

function pickTrack(tracks, candidate) {
  const wantName = plain(candidate.name);
  const wantArtist = plain(candidate.artist);
  const hasArtist = (track) => plain(artistTextOf(track)).includes(wantArtist);
  return tracks.find((track) => plain(track?.name) === wantName && hasArtist(track))
    || tracks.find((track) => plain(track?.name).startsWith(wantName) && hasArtist(track))
    || null;
}

async function runStreamAttempt(track, quality, label) {
  const before = requests.length;
  const started = Date.now();
  let stream = null;
  let error = null;
  try {
    stream = await withTimeout(
      () => plugin.stream({ id: String(track.id), quality }),
      STREAM_TIMEOUT_MS,
      label,
    );
  } catch (caught) {
    error = caught;
  }
  const ms = Date.now() - started;
  const attemptRequests = requests.slice(before);
  if (!stream?.url) {
    const attempts = Array.isArray(error?.attempts) ? error.attempts : [];
    mark(false, label, `解析失败 code=${error?.code || "?"} ${String(error?.message || "").slice(0, 80)} attempts=${attempts.length}`, ms);
    return { ok: false, ms, error };
  }
  const provider = describeProvider(attemptRequests);
  const head = await headStatus(stream.url);
  const ok = head.ok;
  const headText = head.status ? `${head.status}${head.type ? ` ${head.type}` : ""}` : head.error;
  mark(ok, label, `provider=${provider} quality=${stream.quality} type=${stream.type} bitRate=${stream.bitRate ?? "?"} ${ms}ms HEAD=${headText}`, ms);
  return { ok, stream, ms, provider, head, quality };
}

async function checkCached(track, quality, first) {
  const before = requests.length;
  const started = Date.now();
  try {
    const again = await withTimeout(
      () => plugin.stream({ id: String(track.id), quality }),
      15000,
      "缓存二次 stream",
    );
    const ms = Date.now() - started;
    const added = requests.length - before;
    if (again.url !== first.stream.url) throw new Error("二次返回的 URL 与首次不同");
    if (added !== 0) throw new Error(`二次仍发起 ${added} 次网络请求，未命中直链缓存`);
    if (!(ms < first.ms)) throw new Error(`二次 ${ms}ms 未快于首次 ${first.ms}ms`);
    return mark(true, `缓存命中《${track.name}》`, `二次 ${ms}ms < 首次 ${first.ms}ms，URL 相同，0 网络请求`, ms);
  } catch (error) {
    return mark(false, `缓存命中《${track.name}》`, String(error?.message || error), Date.now() - started);
  }
}

async function main() {
  // 1. 清单与权限静态检查
  await check("plugin.json 结构与网络权限声明", () => {
    if (manifest?.main !== "index.js") throw new Error(`main=${manifest?.main}，期望 index.js`);
    if (!networkRules.length) throw new Error("permissions.network 为空");
    if (!manifest?.playback) throw new Error("缺少 playback 声明");
    return `${networkRules.length} 条规则，playback=${manifest.playback}`;
  });

  await check("plugin.json 权限覆盖已知音源端点", () => {
    const missing = KNOWN_ENDPOINTS.filter(([hostname]) => !coveredByNetwork(hostname));
    if (missing.length) {
      throw new Error(`未覆盖：${missing.map(([hostname, why]) => `${hostname}（${why}）`).join("、")}`);
    }
    return `${KNOWN_ENDPOINTS.length} 个已知端点全部覆盖`;
  });

  // 2. 网络预检：DNS 都不通就不必逐项等超时
  const online = await check("网络预检（DNS 解析）", async () => {
    const started = Date.now();
    await withTimeout(
      Promise.all([
        lookup("interfacepc.music.163.com"),
        lookup("music-api.gdstudio.xyz"),
        lookup("search.kuwo.cn"),
      ]),
      10000,
      "DNS 预检",
    );
    return `${Date.now() - started}ms`;
  });
  if (!online) {
    console.error("网络不可用，跳过后续实网检查（未启动的检查计为失败）");
    mark(false, "实网检查未能执行", "DNS 预检失败");
    return;
  }

  // 3. 动态加载插件与内部模块
  try {
    plugin = await import(pathToFileURL(ENTRY).href);
  } catch (error) {
    mark(false, "加载插件 index.js", String(error?.stack || error).slice(0, 300));
    return;
  }
  const modules = {};
  try {
    modules.registry = await import(pathToFileURL(path.join(ROOT, "gateway/registry.js")).href);
    modules.cache = await import(pathToFileURL(path.join(ROOT, "gateway/cache.js")).href);
    modules.health = await import(pathToFileURL(path.join(ROOT, "gateway/health.js")).href);
  } catch (error) {
    mark(false, "加载网关内部模块", String(error?.message || error));
    return;
  }

  await check("插件导出的宿主页接口", () => {
    const required = [
      "search", "stream", "browse", "testConnection", "trackMenu", "menuAction",
      "playlists", "playlist", "createPlaylist", "addToPlaylist",
      "liked", "isLiked", "like", "savePlaylist",
    ];
    const missing = required.filter((name) => typeof plugin[name] !== "function");
    if (missing.length) throw new Error(`缺少导出：${missing.join(", ")}`);
    const irrelevant = ["account", "signIn", "signOut"].filter((name) => typeof plugin[name] === "function");
    if (irrelevant.length) throw new Error(`不应导出账号能力：${irrelevant.join(", ")}`);
    return "曲库 / 网关 / 本地歌单 / 喜欢 / 收藏接口齐全，无账号能力";
  });

  // 4. 真实搜索（4 位不同歌手）
  const discovered = [];
  for (const candidate of CANDIDATES) {
    await check(`搜索「${candidate.query}」`, async () => {
      const data = await withTimeout(
        () => plugin.search({ query: candidate.query, kind: "tracks", offset: 0 }),
        SEARCH_TIMEOUT_MS,
        "搜索",
      );
      const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
      if (!tracks.length) throw new Error("返回 0 条歌曲");
      const hit = pickTrack(tracks, candidate);
      if (!hit) throw new Error(`前 ${Math.min(tracks.length, 3)} 条中没有 ${candidate.artist}《${candidate.name}》`);
      discovered.push({ candidate, track: hit });
      return `${tracks.length} 条，选中 ${hit.id}《${hit.name}》- ${artistTextOf(hit)}`;
    });
  }

  await check("搜索覆盖至少 3 位不同歌手", () => {
    if (discovered.length < 3) throw new Error(`只找到 ${discovered.length} 首`);
    const artists = new Set(discovered.map(({ track }) => plain(artistTextOf(track))));
    if (artists.size < 3) throw new Error(`只有 ${artists.size} 位不同歌手`);
    return `${discovered.length} 首 / ${artists.size} 位歌手`;
  });

  // 网易云搜索全挂通常意味着断网；此时提前结束，避免后续逐项等超时。
  if (!discovered.length) {
    mark(false, "实网检查提前结束", "网易云搜索全部失败，跳过 stream / 音质 / 自检 / 设置检查");
    return;
  }

  // 5. 逐首 stream + 缓存命中
  const successes = [];
  for (const { track } of discovered) {
    const result = await runStreamAttempt(track, "high", `stream《${track.name}》- ${artistTextOf(track)}`);
    if (result.ok) {
      successes.push({ ...result, track });
      await checkCached(track, "high", result);
    }
  }

  await check("至少 3 首不同歌手解析成功", () => {
    if (successes.length < 3) throw new Error(`只有 ${successes.length} 首解析成功`);
    const artists = new Set(successes.map(({ track }) => plain(artistTextOf(track))));
    if (artists.size < 3) throw new Error(`只有 ${artists.size} 位不同歌手的歌曲成功`);
    const providers = [...new Set(successes.map((item) => item.provider))];
    return `${successes.length} 首成功 / ${artists.size} 位歌手 / 命中音源 ${providers.join(", ")}`;
  });

  // 6. 三档音质（同一首基准歌，逐档清缓存后真实解析）
  const baseTrack = successes[0]?.track || null;
  for (const quality of ["standard", "high", "lossless"]) {
    if (!baseTrack) {
      mark(false, `quality=${quality}`, "没有可用的基准歌曲");
      continue;
    }
    modules.cache.clearStream(String(baseTrack.id), quality);
    modules.health.reset();
    const before = requests.length;
    const started = Date.now();
    let stream = null;
    let error = null;
    try {
      stream = await withTimeout(
        () => plugin.stream({ id: String(baseTrack.id), quality }),
        STREAM_TIMEOUT_MS,
        `quality=${quality}`,
      );
    } catch (caught) {
      error = caught;
    }
    const ms = Date.now() - started;
    if (!stream?.url) {
      mark(false, `quality=${quality}`, `解析失败 code=${error?.code || "?"} ${String(error?.message || "").slice(0, 80)}`, ms);
      continue;
    }
    const provider = describeProvider(requests.slice(before));
    const head = await headStatus(stream.url);
    const verdict = validateQuality(quality, stream);
    const headText = head.status ? `${head.status}${head.type ? ` ${head.type}` : ""}` : head.error;
    mark(
      verdict.ok && head.ok,
      `quality=${quality}`,
      `${provider} quality=${stream.quality} type=${stream.type} bitRate=${stream.bitRate ?? "?"} ${ms}ms HEAD=${headText}${verdict.ok ? "" : ` · ${verdict.reason}`}`,
      ms,
    );
  }

  // 7. 确定无源的歌：186016《晴天》
  await check("无源歌曲 186016《晴天》→ unavailable", async () => {
    const started = Date.now();
    try {
      const stream = await withTimeout(
        () => plugin.stream({ id: "186016", quality: "high" }),
        UNAVAILABLE_LIMIT_MS + 15000,
        "晴天 stream",
      );
      throw new Error(`意外解析成功：provider=${describeProvider(requests.slice(-6))} type=${stream.type} quality=${stream.quality}`);
    } catch (error) {
      if (String(error?.message || "").startsWith("意外解析成功")) throw error;
      if (error?.code !== "unavailable") {
        throw new Error(`error.code=${error?.code ?? "(无)"}，期望 unavailable：${String(error?.message || error).slice(0, 120)}`);
      }
      const attempts = Array.isArray(error?.attempts) ? error.attempts : [];
      if (!attempts.length) throw new Error("error.attempts 为空");
      const ms = Date.now() - started;
      if (ms > UNAVAILABLE_LIMIT_MS) throw new Error(`失败耗时 ${ms}ms，超过 ${UNAVAILABLE_LIMIT_MS}ms`);
      return `${ms}ms attempts=${attempts.length} [${attempts.join("; ").slice(0, 180)}]`;
    }
  });

  // 8. 音源自检页
  await check("browse({page:'sources'}) 自检 4 个音源", async () => {
    const page = await withTimeout(() => plugin.browse({ page: "sources" }), SELFTEST_TIMEOUT_MS, "音源自检");
    const links = page?.sections?.[0]?.links;
    if (!Array.isArray(links) || links.length !== 4) {
      throw new Error(`自检结果 ${Array.isArray(links) ? links.length : "缺失"} 条，期望 4 条`);
    }
    if (links.some((link) => !link?.title || !link?.subtitle)) throw new Error("有自检结果缺少标题或说明");
    const states = links.map((link) => ({ title: String(link.title), state: String(link.subtitle).split("·")[0].trim() }));
    const okCount = states.filter((item) => item.state === "可用").length;
    const summary = states.map((item) => `${item.title}=${item.state}`).join(" / ");
    if (!okCount) throw new Error(`4 个音源全部不可用：${summary}`);
    return `${okCount}/4 可用：${summary}`;
  });

  // 9. 设置：优先音源 / 两个停用开关各实跑一次
  const VARIANTS = [
    {
      name: "prefer=kuwo",
      settings: { prefer: "kuwo" },
      expected: ["kuwo-bodian", "kuwo-mobi", "gdstudio", "gdstudio-search"],
      firstFamily: "kuwo",
      disabled: null,
    },
    {
      name: "disableGdstudio",
      settings: { disableGdstudio: "true" },
      expected: ["kuwo-bodian", "kuwo-mobi"],
      firstFamily: "kuwo",
      disabled: "gdstudio",
    },
    {
      name: "disableKuwo",
      settings: { disableKuwo: "true" },
      expected: ["gdstudio", "gdstudio-search"],
      firstFamily: "gdstudio",
      disabled: "kuwo",
    },
  ];

  for (let index = 0; index < VARIANTS.length; index += 1) {
    const variant = VARIANTS[index];
    setSettings(variant.settings);
    await check(`设置 ${variant.name}：音源顺序`, () => {
      const list = modules.registry.orderedProviders().map((provider) => provider.id);
      if (JSON.stringify(list) !== JSON.stringify(variant.expected)) {
        throw new Error(`实际 [${list.join(" → ")}]，期望 [${variant.expected.join(" → ")}]`);
      }
      return `[${list.join(" → ")}]`;
    });

    const success = successes[index % Math.max(successes.length, 1)];
    if (!success) {
      mark(false, `设置 ${variant.name}：实跑一次`, "没有可用的基准歌曲");
      continue;
    }
    // 每个变体用不同歌曲（不足时换音质），避免失败短缓存影响判断。
    const quality = index < successes.length ? "high" : ["standard", "lossless"][index - successes.length] || "high";
    modules.cache.clearStream(String(success.track.id), quality);
    modules.health.reset();
    const before = requests.length;
    const started = Date.now();
    let stream = null;
    let error = null;
    try {
      stream = await withTimeout(
        () => plugin.stream({ id: String(success.track.id), quality }),
        STREAM_TIMEOUT_MS,
        `设置 ${variant.name}`,
      );
    } catch (caught) {
      error = caught;
    }
    const ms = Date.now() - started;
    const runRequests = requests.slice(before);
    const sequence = sourceFamilySequence(runRequests);
    const firstFamily = sequence[0];
    const problems = [];
    if (!sequence.length) problems.push("没有发出任何音源请求");
    if (variant.disabled && sequence.includes(variant.disabled)) problems.push(`已停用的 ${variant.disabled} 仍被请求`);
    if (firstFamily && firstFamily !== variant.firstFamily) problems.push(`首个音源族=${firstFamily}，期望 ${variant.firstFamily}`);
    if (stream?.url && variant.disabled && familyOfUrl(stream.url) === variant.disabled) {
      problems.push(`返回直链来自已停用的 ${variant.disabled}`);
    }
    const outcome = stream
      ? `${describeProvider(runRequests)} ${stream.type}/${stream.quality}`
      : `unavailable code=${error?.code || "?"}`;
    const detail = `${outcome} ${ms}ms 请求族=[${compress(sequence).join(",")}]${problems.length ? ` · ${problems.join("；")}` : ""}`;
    mark(!problems.length, `设置 ${variant.name}：实跑一次`, detail, ms);
  }

  setSettings({});
  modules.health.reset();

  // 10. 运行期主机权限覆盖 + 超时保护
  await check("network 权限覆盖运行期所有请求主机", () => {
    const counts = new Map();
    const uncovered = new Set();
    for (const request of requests) {
      for (const hostname of [request.host, request.finalHost]) {
        if (!hostname) continue;
        counts.set(hostname, (counts.get(hostname) || 0) + 1);
        if (!coveredByNetwork(hostname)) uncovered.add(hostname);
      }
    }
    const summary = [...counts.entries()].sort((a, b) => b[1] - a[1])
      .map(([hostname, count]) => `${hostname}×${count}`).join(", ");
    if (uncovered.size) {
      throw new Error(`未覆盖：${[...uncovered].join(", ")}；已观测：${summary}`);
    }
    if (!counts.size) throw new Error("没有观测到任何网络请求");
    return `${counts.size} 个主机全部覆盖：${summary}`;
  });

  await check("所有请求都带超时保护", () => {
    if (!requests.length) throw new Error("没有观测到任何网络请求");
    const fallback = requests.filter((request) => request.timeoutSource === "wrapper");
    if (fallback.length) throw new Error(`${fallback.length} 个请求未自带 AbortSignal（脚本兜底加了超时）`);
    return `${requests.length} 个请求均自带超时`;
  });
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
function finish() {
  clearTimeout(watchdog);
  const failed = results.filter((result) => !result.ok);
  const totalMs = Date.now() - totalStarted;
  const hosts = [...new Set(requests.map((request) => request.host).filter(Boolean))].sort();
  console.log("\n===== 实网冒烟汇总 =====");
  console.log(`PASS ${passCount} / FAIL ${failed.length} / 共 ${results.length} 项，耗时 ${(totalMs / 1000).toFixed(2)}s`);
  console.log(`观测网络主机 ${hosts.length} 个：${hosts.join(", ") || "(无)"}`);
  if (failed.length) {
    console.log("失败项：");
    for (const item of failed) console.log(` - [FAIL] ${item.name} — ${item.detail}`);
    if (pluginLogs.length) {
      console.log(`插件日志 ${pluginLogs.length} 条，末 20 条：`);
      for (const line of pluginLogs.slice(-20)) console.log(`   ${line}`);
    }
  }
  const exitCode = failed.length ? 1 : 0;
  process.exitCode = exitCode;
  // 若因超时检查留下了未结束的请求，最多再等 300ms 后强制退出，避免挂起。
  setTimeout(() => process.exit(exitCode), 300).unref();
}

main()
  .catch((error) => {
    mark(false, "脚本未捕获异常", String(error?.stack || error).slice(0, 400));
  })
  .finally(finish);
