// 音源网关：顺序、软/硬失败、熔断、缓存、探测与音质映射。全部走离线 fetch。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { json, networkError, runtime, status, text } from "./runtime.mjs";

const TRACK = {
  id: "42",
  name: "晴天",
  artists: [{ id: "6452", name: "周杰伦" }],
  duration: 269000,
  album: { id: "1", name: "叶惠美" },
};
const GD_URL = "https://m701.music.126.net/gd.mp3";
const GD_FLAC = "https://m701.music.126.net/gd.flac";
const BODIAN_URL = "https://bd-bj.kuwo.cn/bodian.mp3";
const MOBI_URL = "https://bd-bj.kuwo.cn/mobi.mp3";

const track = (id = TRACK.id) => ({ ...TRACK, id });
const plain = (value) => JSON.parse(JSON.stringify(value));
const hostOf = (request) => new URL(request.url).host;
const hosts = (requests) => requests.map(hostOf);

async function gateway(options = {}) {
  // 直接加载网关模块，避免依赖尚未落盘的 index.js / stream.js。
  return runtime({ entry: "gateway/index.js", ...options });
}

// 按请求里的 br 返回对应码率，方便断言音质映射。
function stubGdstudio(r, overrides = {}) {
  r.route("music-api.gdstudio.xyz", (request) => {
    const params = new URL(request.url).searchParams;
    if (params.get("types") === "search") {
      return json([{ id: "9001", name: "晴天", artist: ["周杰伦"], album: "叶惠美" }]);
    }
    const br = Number(params.get("br")) || 320;
    const url = br >= 700 ? GD_FLAC : GD_URL;
    return json({ url, br, size: 1024, ...overrides });
  });
}

function stubKuwoSearch(r, rows) {
  r.route("search.kuwo.cn", () => json({ content: [{}, { musicpage: { abslist: rows } }] }));
}

const KUWO_ROW = { SONGNAME: "晴天", ARTIST: "周杰伦", DURATION: 269, MUSICRID: "MUSIC_123" };

function stubBodian(r, { code = 200, audioUrl = BODIAN_URL } = {}) {
  r.route("bd-api.kuwo.cn/api/service/advert/watch", () => json({ code: 200 }));
  r.route("bd-api.kuwo.cn/api/play/music/v2/audioUrl", () => json({
    code,
    data: { audioUrl, audioHttpsUrl: audioUrl, bitrate: 320, size: "4.2MB" },
  }));
}

function stubMobi(r, { url = MOBI_URL } = {}) {
  r.route("mobi.kuwo.cn", () => text(`format=mp3\r\nbitrate=320\r\nurl=${url}\r\n`));
}

function stubKuwoSuccess(r) {
  stubKuwoSearch(r, [KUWO_ROW]);
  stubBodian(r);
  stubMobi(r);
}

test("auto 默认顺序：GDStudio 按 ID 先取址，再 HEAD 探测并返回", async () => {
  const r = await gateway();
  stubGdstudio(r);

  const stream = await r.plugin.resolveStream({ track: track(), quality: "high" });

  assert.deepEqual(hosts(r.requests), ["music-api.gdstudio.xyz", "m701.music.126.net"]);
  assert.deepEqual(plain(r.requests.map((request) => request.method)), ["GET", "HEAD"]);
  const url = new URL(r.requests[0].url);
  assert.equal(url.searchParams.get("types"), "url");
  assert.equal(url.searchParams.get("source"), "netease");
  assert.equal(url.searchParams.get("id"), "42");
  assert.equal(url.searchParams.get("br"), "320");
  assert.equal(r.requests[1].url, GD_URL);
  assert.equal(r.requests[1].headers.range, undefined);

  assert.deepEqual(plain(stream), {
    url: GD_URL,
    type: "mp3",
    quality: "high",
    bitRate: 320,
    size: 1024,
  });
});

test("prefer 与停用开关：酷我优先 / GDStudio 优先 / 单族停用", async () => {
  const r = await gateway({ settings: { prefer: "kuwo" } });
  stubGdstudio(r);
  stubKuwoSuccess(r);

  // 1) 酷我优先：第一条请求应该落在酷我搜索，波点链路成功。
  let stream = await r.plugin.resolveStream({ track: track("201"), quality: "high" });
  assert.equal(hostOf(r.requests[0]), "search.kuwo.cn");
  assert.deepEqual(hosts(r.requests), [
    "search.kuwo.cn",
    "bd-api.kuwo.cn",
    "bd-api.kuwo.cn",
    "bd-bj.kuwo.cn",
  ]);
  assert.deepEqual(plain(stream), {
    url: BODIAN_URL,
    type: "mp3",
    quality: "high",
    bitRate: 320,
    size: Math.round(4.2 * 1024 ** 2),
  });

  // 2) GDStudio 优先：即使酷我可用也先走 GDStudio。
  const start = r.requests.length;
  r.state.settings.prefer = "gdstudio";
  stream = await r.plugin.resolveStream({ track: track("202"), quality: "high" });
  assert.equal(hostOf(r.requests[start]), "music-api.gdstudio.xyz");
  assert.equal(stream.url, GD_URL);

  // 3) 停用 GDStudio：整族不出现，只有酷我请求。
  const gdStart = r.requests.length;
  r.state.settings.disableGdstudio = "true";
  r.state.settings.prefer = "auto";
  stream = await r.plugin.resolveStream({ track: track("203"), quality: "high" });
  const gdSlice = r.requests.slice(gdStart);
  assert.ok(gdSlice.some((request) => hostOf(request) === "search.kuwo.cn"));
  assert.ok(!gdSlice.some((request) => hostOf(request) === "music-api.gdstudio.xyz"));
  assert.equal(stream.url, BODIAN_URL);

  // 4) 停用酷我：整族不出现，GDStudio 直接成功。
  const kuwoStart = r.requests.length;
  r.state.settings.disableGdstudio = "";
  r.state.settings.disableKuwo = "true";
  stream = await r.plugin.resolveStream({ track: track("204"), quality: "high" });
  const kuwoSlice = r.requests.slice(kuwoStart);
  assert.equal(hostOf(kuwoSlice[0]), "music-api.gdstudio.xyz");
  for (const host of ["search.kuwo.cn", "bd-api.kuwo.cn", "mobi.kuwo.cn"]) {
    assert.ok(!kuwoSlice.some((request) => hostOf(request) === host), `不应请求 ${host}`);
  }
  assert.equal(stream.url, GD_URL);
});

test("返回 null 属于软失败：按默认顺序继续下一个，不进入熔断", async () => {
  const r = await gateway();
  // GDStudio 返回空地址 → 酷我波点有匹配但 audioUrl 为空 → 酷我移动成功。
  r.route("music-api.gdstudio.xyz", (request) => {
    const params = new URL(request.url).searchParams;
    return params.get("types") === "url" ? json({ url: "" }) : json([]);
  });
  stubKuwoSearch(r, [KUWO_ROW]);
  r.route("bd-api.kuwo.cn/api/service/advert/watch", () => json({ code: 200 }));
  r.route("bd-api.kuwo.cn/api/play/music/v2/audioUrl", () => json({
    code: 200,
    data: { audioUrl: "", audioHttpsUrl: "", bitrate: 0, size: "" },
  }));
  stubMobi(r);

  const stream = await r.plugin.resolveStream({ track: track(), quality: "high" });

  assert.deepEqual(hosts(r.requests), [
    "music-api.gdstudio.xyz",
    "search.kuwo.cn",
    "bd-api.kuwo.cn",
    "bd-api.kuwo.cn",
    "search.kuwo.cn",
    "mobi.kuwo.cn",
    "bd-bj.kuwo.cn",
  ]);
  assert.deepEqual(plain(r.requests.map((request) => request.method)), [
    "GET", "GET", "POST", "GET", "GET", "GET", "HEAD",
  ]);
  assert.equal(stream.url, MOBI_URL);

  const health = await r.module("gateway/health.js");
  const snapshot = plain(health.snapshot(["gdstudio", "kuwo-bodian", "kuwo-mobi"]));
  assert.equal(snapshot.gdstudio.fails, 0);
  assert.equal(snapshot.gdstudio.lastMissAt, r.clock.now());
  assert.equal(snapshot.gdstudio.until, 0);
  assert.equal(snapshot["kuwo-bodian"].fails, 0);
  assert.equal(snapshot["kuwo-bodian"].lastMissAt, r.clock.now());
  assert.equal(snapshot["kuwo-mobi"].fails, 0);
  assert.equal(snapshot["kuwo-mobi"].lastOkAt, r.clock.now());
});

test("音源抛错计入熔断：冷却 30 秒内跳过，恢复后成功清零", async () => {
  const r = await gateway();
  r.state.gdstudioDown = true;
  r.route("music-api.gdstudio.xyz", () => {
    if (r.state.gdstudioDown) throw new Error("gdstudio down");
    return json({ url: GD_URL, br: 320, size: 2048 });
  });
  stubKuwoSuccess(r);

  // 第一次：GDStudio 网络错误（getJson 会重试一次），冷却 30 秒后由酷我兜底。
  let stream = await r.plugin.resolveStream({ track: track("301"), quality: "high" });
  assert.equal(stream.url, BODIAN_URL);
  const health = await r.module("gateway/health.js");
  let snapshot = plain(health.snapshot(["gdstudio"]));
  assert.equal(snapshot.gdstudio.fails, 1);
  assert.equal(snapshot.gdstudio.until - r.clock.now(), 30000);
  assert.equal(health.available("gdstudio"), false);

  // 冷却期内再解析：不应再请求 GDStudio。
  const before = r.requests.length;
  stream = await r.plugin.resolveStream({ track: track("302"), quality: "high" });
  assert.equal(stream.url, BODIAN_URL);
  assert.ok(!r.requests.slice(before).some((request) => hostOf(request) === "music-api.gdstudio.xyz"));

  // 冷却结束后恢复；成功一次即清零。
  r.clock.advance(30000);
  r.state.gdstudioDown = false;
  stream = await r.plugin.resolveStream({ track: track("303"), quality: "high" });
  assert.equal(stream.url, GD_URL);
  snapshot = plain(health.snapshot(["gdstudio"]));
  assert.equal(snapshot.gdstudio.fails, 0);
  assert.equal(snapshot.gdstudio.lastOkAt, r.clock.now());
  assert.equal(snapshot.gdstudio.until, 0);
});

test("连续硬失败按 30 秒 / 2 分钟 / 10 分钟退避并封顶", async () => {
  const r = await gateway();
  r.route("music-api.gdstudio.xyz", () => {
    throw new Error("still down");
  });
  stubKuwoSuccess(r);
  const health = await r.module("gateway/health.js");

  const expected = [30000, 120000, 600000, 600000];
  for (let index = 0; index < expected.length; index += 1) {
    const stream = await r.plugin.resolveStream({ track: track(String(400 + index)), quality: "high" });
    assert.equal(stream.url, BODIAN_URL);
    const snapshot = plain(health.snapshot(["gdstudio"]));
    assert.equal(snapshot.gdstudio.fails, index + 1, `第 ${index + 1} 次失败`);
    assert.equal(snapshot.gdstudio.until - r.clock.now(), expected[index], `第 ${index + 1} 次冷却`);
    assert.equal(health.available("gdstudio"), false);
    r.clock.advance(expected[index]);
    assert.equal(health.available("gdstudio"), true);
  }
});

test("探测失败计入熔断：404 不做 Range 重试，直接换下一个音源", async () => {
  const r = await gateway();
  stubGdstudio(r);
  stubKuwoSuccess(r);
  // 只让 GDStudio 返回的地址探测失败，酷我链路仍然可用。
  r.state.probe.head = (request) => (request.url === GD_URL
    ? status(404)
    : status(200, { headers: { "content-type": "audio/mpeg", "content-length": "2048" } }));

  const stream = await r.plugin.resolveStream({ track: track(), quality: "high" });

  assert.equal(stream.url, BODIAN_URL);
  const gdRequests = r.requests.slice(0, 2);
  assert.equal(hostOf(gdRequests[0]), "music-api.gdstudio.xyz");
  assert.equal(gdRequests[1].method, "HEAD");
  assert.equal(gdRequests[1].url, GD_URL);
  // 404 不在 403/405/501 的重试范围内，不应该发 Range GET。
  assert.equal(r.requests.filter((request) => request.headers.range).length, 0);

  const health = await r.module("gateway/health.js");
  const snapshot = plain(health.snapshot(["gdstudio"]));
  assert.equal(snapshot.gdstudio.fails, 1);
  assert.equal(snapshot.gdstudio.until - r.clock.now(), 30000);
});

test("HEAD 被 403 拒绝时用 1 字节 Range GET 兜底", async () => {
  const r = await gateway();
  stubGdstudio(r);
  r.state.probe.head = status(403);

  const stream = await r.plugin.resolveStream({ track: track(), quality: "high" });

  assert.equal(stream.url, GD_URL);
  assert.deepEqual(hosts(r.requests), [
    "music-api.gdstudio.xyz",
    "m701.music.126.net",
    "m701.music.126.net",
  ]);
  assert.deepEqual(plain(r.requests.map((request) => request.method)), ["GET", "HEAD", "GET"]);
  assert.equal(r.requests[1].headers.range, undefined);
  assert.equal(r.requests[2].headers.range, "bytes=0-0");
});

test("直链缓存：2 分钟内直接命中，过期后重新探测，探测失败才重新取址", async () => {
  const r = await gateway();
  stubGdstudio(r, { url: GD_URL });

  const first = await r.plugin.resolveStream({ track: track(), quality: "high" });
  assert.deepEqual(hosts(r.requests), ["music-api.gdstudio.xyz", "m701.music.126.net"]);
  assert.equal(first.url, GD_URL);

  // 2 分钟内：完全不发请求。
  const second = await r.plugin.resolveStream({ track: track(), quality: "high" });
  assert.deepEqual(plain(second), plain(first));
  assert.equal(r.requests.length, 2);

  // 超过 2 分钟：只重新探测缓存地址，不重新取址。
  r.clock.advance(2 * 60 * 1000 + 1);
  const third = await r.plugin.resolveStream({ track: track(), quality: "high" });
  assert.equal(r.requests.length, 3);
  assert.equal(r.requests[2].method, "HEAD");
  assert.equal(r.requests[2].url, GD_URL);
  assert.deepEqual(plain(third), plain(first));

  // 缓存地址再次过期且探测失败：清缓存、重新取址，探测通过后返回新直链。
  r.clock.advance(2 * 60 * 1000 + 1);
  let probes = 0;
  r.state.probe.head = () => {
    probes += 1;
    return probes === 1
      ? status(404)
      : status(200, { headers: { "content-type": "audio/mpeg", "content-length": "2048" } });
  };
  const fourth = await r.plugin.resolveStream({ track: track(), quality: "high" });
  assert.equal(fourth.url, GD_URL);
  assert.deepEqual(hosts(r.requests.slice(3)), [
    "m701.music.126.net",
    "music-api.gdstudio.xyz",
    "m701.music.126.net",
  ]);
  assert.deepEqual(plain(r.requests.slice(3).map((request) => request.method)), ["HEAD", "GET", "HEAD"]);

  // 重新取址后缓存再次生效。
  const before = r.requests.length;
  await r.plugin.resolveStream({ track: track(), quality: "high" });
  assert.equal(r.requests.length, before);
});

test("45 秒失败短缓存：连续点播不重复打音源，过期后重新尝试", async () => {
  const r = await gateway();
  const gdEmpty = () => json({ url: "" });
  r.route("music-api.gdstudio.xyz", (request) => {
    const params = new URL(request.url).searchParams;
    return params.get("types") === "search" ? json([]) : gdEmpty();
  });
  stubKuwoSearch(r, []);
  stubMobi(r);

  const bare = { ...track(), artists: [], duration: 0 };
  let error = await r.plugin.resolveStream({ track: bare, quality: "high" }).catch((value) => value);
  assert.equal(error.code, "unavailable");
  assert.equal(error.message, r.host.t("没有可用音源，请稍后重试"));
  assert.deepEqual(hosts(r.requests), [
    "music-api.gdstudio.xyz",
    "search.kuwo.cn",
    "search.kuwo.cn",
    "music-api.gdstudio.xyz",
  ]);
  const firstCount = r.requests.length;

  // 45 秒内直接失败，不再发请求。
  error = await r.plugin.resolveStream({ track: bare, quality: "high" }).catch((value) => value);
  assert.equal(error.code, "unavailable");
  assert.equal(r.requests.length, firstCount);

  // 45 秒后重试，会重新依次请求所有音源。
  r.clock.advance(45 * 1000 + 1);
  error = await r.plugin.resolveStream({ track: bare, quality: "high" }).catch((value) => value);
  assert.equal(error.code, "unavailable");
  assert.equal(r.requests.length, firstCount * 2);
});

test("skipVerify 跳过播放前探测；不跳过时探测失败会换源", async () => {
  const skip = await gateway({ settings: { skipVerify: "true" } });
  stubGdstudio(skip);
  skip.state.probe.head = status(404);
  const stream = await skip.plugin.resolveStream({ track: track(), quality: "high" });
  assert.equal(stream.url, GD_URL);
  assert.equal(skip.requests.length, 1);
  assert.equal(skip.requests[0].method, "GET");
  assert.equal(skip.requests.filter((request) => request.method === "HEAD").length, 0);

  const verify = await gateway();
  stubGdstudio(verify);
  stubKuwoSuccess(verify);
  verify.state.probe.head = (request) => (request.url === GD_URL
    ? status(404)
    : status(200, { headers: { "content-type": "audio/mpeg", "content-length": "2048" } }));
  const fallback = await verify.plugin.resolveStream({ track: track(), quality: "high" });
  assert.equal(fallback.url, BODIAN_URL);
  assert.deepEqual(
    verify.requests.filter((request) => request.method === "HEAD").map((request) => request.url),
    [GD_URL, BODIAN_URL],
  );
});

test("音质映射：设置优先于宿主，128/320/FLAC 各自取正确档位", async () => {
  const r = await gateway();
  stubGdstudio(r);
  const requestBr = () => {
    const request = r.requests.filter((item) => hostOf(item) === "music-api.gdstudio.xyz").at(-1);
    return new URL(request.url).searchParams.get("br");
  };

  // 设置 standard 覆盖宿主 lossless。
  r.state.settings.quality = "standard";
  let stream = await r.plugin.resolveStream({ track: track("501"), quality: "lossless" });
  assert.equal(requestBr(), "128");
  assert.equal(stream.quality, "standard");
  assert.equal(stream.type, "mp3");
  assert.equal(stream.bitRate, 128);

  // 同一首歌换音质设置不会被上一档缓存命中。
  r.state.settings.quality = "lossless";
  stream = await r.plugin.resolveStream({ track: track("501"), quality: "standard" });
  assert.equal(requestBr(), "999");
  assert.equal(stream.quality, "lossless");
  assert.equal(stream.type, "flac");
  assert.equal(stream.bitRate, 999);

  // 设置留空时跟随宿主；无法识别时默认 high。
  r.state.settings.quality = "";
  stream = await r.plugin.resolveStream({ track: track("502"), quality: "standard" });
  assert.equal(requestBr(), "128");
  assert.equal(stream.quality, "standard");

  stream = await r.plugin.resolveStream({ track: track("503"), quality: "lossless" });
  assert.equal(requestBr(), "999");
  assert.equal(stream.quality, "lossless");

  stream = await r.plugin.resolveStream({ track: track("504"), quality: "bogus" });
  assert.equal(requestBr(), "320");
  assert.equal(stream.quality, "high");

  // 酷我档位：standard → 128kmp3，lossless 只能要 320kmp3，再按实际码率归回 high。
  const kuwo = await gateway({ settings: { quality: "standard", prefer: "kuwo" } });
  stubGdstudio(kuwo);
  stubKuwoSuccess(kuwo);
  const playUrls = () => kuwo.requests
    .filter((request) => request.url.includes("/api/play/music/v2/audioUrl"))
    .map((request) => new URL(request.url).searchParams.get("br"));
  await kuwo.plugin.resolveStream({ track: track("505"), quality: "high" });
  assert.deepEqual(playUrls(), ["128kmp3"]);
  kuwo.state.settings.quality = "lossless";
  stream = await kuwo.plugin.resolveStream({ track: track("506"), quality: "standard" });
  assert.deepEqual(playUrls(), ["128kmp3", "320kmp3"]);
  assert.equal(stream.quality, "high");
  assert.equal(stream.bitRate, 320);
});

test("波点签名：按排序后的查询串做 md5，320/128 档位与时间戳可控", async () => {
  const r = await gateway({ settings: { quality: "high", prefer: "kuwo" } });
  stubKuwoSuccess(r);
  const { default: kuwoBodian } = await r.module("gateway/sources/kuwo-bodian.js");

  const result = await kuwoBodian.resolve({
    track: track(),
    quality: "high",
    deadline: r.clock.now() + 8000,
  });
  assert.equal(result.url, BODIAN_URL);
  assert.equal(result.bitRate, 320);
  assert.equal(result.size, Math.round(4.2 * 1024 ** 2));

  const request = r.requests.find((item) => item.url.includes("/api/play/music/v2/audioUrl"));
  const url = new URL(request.url);
  assert.equal(url.searchParams.get("br"), "320kmp3");
  assert.equal(url.searchParams.get("musicId"), "123");
  assert.equal(url.searchParams.get("timestamp"), String(r.clock.now()));
  const rawQuery = request.url.slice(request.url.indexOf("?") + 1);
  const beforeSign = rawQuery.split("&sign=")[0];
  const sorted = beforeSign.replace(/[^a-zA-Z0-9]/g, "").split("").sort().join("");
  const expected = createHash("md5")
    .update(`kuwotest${sorted}/api/play/music/v2/audioUrl`)
    .digest("hex");
  assert.equal(url.searchParams.get("sign"), expected);

  // 广告权益接口失败也不影响取址。
  r.routes.length = 0;
  stubKuwoSearch(r, [KUWO_ROW]);
  r.route("bd-api.kuwo.cn/api/service/advert/watch", () => networkError("ad down"));
  r.route("bd-api.kuwo.cn/api/play/music/v2/audioUrl", () => json({
    code: 200,
    data: { audioUrl: BODIAN_URL, audioHttpsUrl: BODIAN_URL, bitrate: 320, size: "4.2MB" },
  }));
  r.requests.length = 0;
  const again = await kuwoBodian.resolve({
    track: track("777"),
    quality: "high",
    deadline: r.clock.now() + 8000,
  });
  assert.equal(again.url, BODIAN_URL);
});

test("音源全部停用或曲目编号无效时明确报错且不发请求", async () => {
  const disabled = await gateway({ settings: { disableGdstudio: "true", disableKuwo: "true" } });
  const error = await disabled.plugin.resolveStream({ track: track(), quality: "high" }).catch((value) => value);
  assert.equal(error.code, "unavailable");
  assert.equal(error.message, disabled.host.t("GDStudio 与酷我音源都被停用，请在插件设置中启用至少一个音源"));
  assert.equal(disabled.requests.length, 0);

  const invalid = await gateway();
  const invalidError = await invalid.plugin.resolveStream({ track: { id: "" }, quality: "high" }).catch((value) => value);
  assert.equal(invalidError.code, "unavailable");
  assert.equal(invalidError.message, invalid.host.t("无效的网易云资源编号"));
  assert.equal(invalid.requests.length, 0);
});
