// 匿名曲库：eapi 请求、搜索与分页、详情映射、发现页。全部离线。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { json, runtime, status, text } from "./runtime.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));

const rawSong = (overrides = {}) => ({
  id: 186016,
  name: "晴天",
  dt: 269000,
  ar: [{ id: 6452, name: "周杰伦", picUrl: "http://p1.music.126.net/artist.jpg" }],
  al: {
    id: 18905,
    name: "叶惠美",
    picUrl: "http://p2.music.126.net/album.jpg",
    publishTime: 1059321600000,
    type: "专辑",
    size: 11,
    artists: [{ id: 6452, name: "周杰伦" }],
  },
  privilege: { st: 0 },
  ...overrides,
});

const rawAlbum = (overrides = {}) => ({
  id: 18905,
  name: "叶惠美",
  picUrl: "http://p2.music.126.net/album.jpg",
  artists: [{ id: 6452, name: "周杰伦" }],
  size: 11,
  publishTime: 1059321600000,
  type: "专辑",
  ...overrides,
});

const rawPlaylist = (overrides = {}) => ({
  id: 999,
  name: "测试歌单",
  coverImgUrl: "http://p3.music.126.net/cover.jpg",
  description: "歌单描述",
  creator: { nickname: "测试用户" },
  trackCount: 3,
  playCount: 12345,
  subscribed: true,
  specialType: 5,
  ...overrides,
});

async function catalog(options = {}) {
  return runtime({ entry: "catalog/library.js", ...options });
}

// 给某个 eapi 路径挂固定响应；reply 可以是对象或 (request) => response spec。
function eapi(r, path, reply) {
  r.route(`/eapi${path}`, (request) => (
    typeof reply === "function" ? reply(request) : json(reply)
  ));
  return r;
}

function eapiRequest(r, path, last = false) {
  const all = r.requests.filter((request) => request.url.endsWith(`/eapi${path}`));
  return last ? all.at(-1) : all[0];
}

async function rejects(promise, code, messagePart) {
  const error = await promise.then(() => null, (value) => value);
  assert.ok(error, "应当抛错");
  if (code) assert.equal(error.code, code);
  if (messagePart) assert.ok(error.message.includes(messagePart), `错误信息应包含 ${messagePart}，实际：${error.message}`);
  return error;
}

test("eapi 请求：匿名、AES 参数三段格式、md5 摘要与 deviceId 持久化", async () => {
  const r = await catalog();
  eapi(r, "/cloudsearch/pc", { code: 200, result: { songs: [], songCount: 0 } });

  await r.plugin.search({ query: "  晴天  ", kind: "tracks", offset: 0 });

  const request = eapiRequest(r, "/cloudsearch/pc");
  assert.equal(request.url, "https://interfacepc.music.163.com/eapi/cloudsearch/pc");
  assert.equal(request.method, "POST");
  assert.equal(request.headers["content-type"], "application/x-www-form-urlencoded");
  assert.ok(request.headers["user-agent"].includes("Mozilla/5.0"));
  assert.equal(request.headers.cookie, undefined, "匿名请求不应携带 Cookie");
  assert.match(String(request.body), /^params=[0-9a-f]{64}$/);

  assert.equal(r.aesCalls.length, 1);
  const call = r.aesCalls[0];
  assert.equal(call.key, "e82ckenh8dichen8");
  assert.equal(call.path, "/api/cloudsearch/pc");
  const body = JSON.parse(call.body);
  assert.equal(body.s, "晴天");
  assert.equal(body.type, 1);
  assert.equal(body.limit, 50);
  assert.equal(body.offset, 0);
  assert.equal(body.total, true);
  assert.equal(body.header.os, "pc");
  assert.equal(body.header.appver, "3.1.11");
  assert.equal(body.header.__csrf, "");
  assert.match(body.header.deviceId, /^[0-9a-f]{32}$/);
  assert.equal(r.store.get("deviceId"), body.header.deviceId);
  assert.equal(
    call.digest,
    createHash("md5").update(`nobody/api/cloudsearch/pcuse${call.body}md5forencrypt`).digest("hex"),
  );
  assert.deepEqual(call.payload, body);

  // 第二次请求复用同一个 deviceId，且没有留下任何登录凭据。
  await r.plugin.search({ query: "晴天", kind: "tracks", offset: 50 });
  assert.equal(r.aesCalls.length, 2);
  assert.equal(JSON.parse(r.aesCalls[1].body).header.deviceId, body.header.deviceId);
  assert.equal(r.store.has("cookies"), false);
  assert.equal(r.store.has("account"), false);
});

test("search 分页与歌曲映射，空关键词与非法类型不发请求", async () => {
  const r = await catalog();
  eapi(r, "/cloudsearch/pc", (request) => ({
    code: 200,
    result: { songs: [rawSong()], songCount: 51 },
  }));

  const first = await r.plugin.search({ query: " 晴天 ", kind: "tracks", offset: 0 });
  assert.equal(first.more, true);
  assert.equal(first.total, 51);
  assert.equal(first.tracks.length, 1);
  const mapped = plain(first.tracks[0]);
  assert.equal(mapped.id, "186016");
  assert.equal(mapped.name, "晴天");
  assert.equal(mapped.duration, 269000);
  assert.equal(mapped.url, "https://music.163.com/song?id=186016");
  assert.deepEqual(mapped.artists, [{
    id: "6452",
    name: "周杰伦",
    imageUrl: "https://p1.music.126.net/artist.jpg",
  }]);
  assert.deepEqual(mapped.album, {
    id: "18905",
    name: "叶惠美",
    imageUrl: "https://p2.music.126.net/album.jpg",
    artists: [{ id: "6452", name: "周杰伦", imageUrl: "" }],
    trackCount: 11,
    released: new Date(1059321600000).toISOString().slice(0, 10),
    copyright: "",
    kind: "album",
  });
  assert.equal("unavailable" in first.tracks[0], false, "曲库不再标记版权不可用");

  const payload = eapiRequest(r, "/cloudsearch/pc").payload;
  assert.equal(payload.s, "晴天");
  assert.equal(payload.type, 1);
  assert.equal(payload.limit, 50);
  assert.equal(payload.offset, 0);

  // 第二页：offset 透传，offset + 本页数量到达 total 后 more=false。
  const second = await r.plugin.search({ query: "晴天", kind: "tracks", offset: 50 });
  assert.equal(second.more, false);
  assert.equal(eapiRequest(r, "/cloudsearch/pc", true).payload.offset, 50);

  // 非法 offset 归一到 0。
  await r.plugin.search({ query: "晴天", kind: "tracks", offset: -20 });
  assert.equal(eapiRequest(r, "/cloudsearch/pc", true).payload.offset, 0);

  const before = r.requests.length;
  assert.deepEqual(plain(await r.plugin.search({ query: "   ", kind: "tracks" })), { tracks: [], more: false });
  assert.equal(r.requests.length, before);

  const error = await rejects(r.plugin.search({ query: "晴天", kind: "videos" }), "unsupported", "不支持这种搜索类型");
  assert.equal(r.requests.length, before);
  assert.ok(error);
});

test("search 的专辑、歌手、歌单类型与映射", async () => {
  const r = await catalog();
  r.route("/eapi/cloudsearch/pc", (request) => {
    const type = request.payload.type;
    if (type === 10) {
      return json({
        code: 200,
        result: {
          albums: [rawAlbum({ type: "EP" })],
          albumCount: 1,
          hasMore: false,
        },
      });
    }
    if (type === 100) {
      return json({
        code: 200,
        result: { artists: [{ id: 6452, name: "周杰伦", picUrl: "http://p1.music.126.net/a.jpg" }], artistCount: 1 },
      });
    }
    if (type === 1000) {
      return json({ code: 200, result: { playlists: [rawPlaylist()], playlistCount: 1 } });
    }
    throw new Error(`unexpected type ${type}`);
  });

  const albums = await r.plugin.search({ query: "叶惠美", kind: "albums" });
  assert.equal(eapiRequest(r, "/cloudsearch/pc", true).payload.type, 10);
  assert.equal(albums.albums.length, 1);
  assert.deepEqual(plain(albums.albums[0]), {
    id: "18905",
    name: "叶惠美",
    imageUrl: "https://p2.music.126.net/album.jpg",
    artists: [{ id: "6452", name: "周杰伦", imageUrl: "" }],
    trackCount: 11,
    released: new Date(1059321600000).toISOString().slice(0, 10),
    copyright: "",
    kind: "ep",
  });
  assert.equal(albums.more, false);
  assert.equal(albums.total, 1);

  const artists = await r.plugin.search({ query: "周杰伦", kind: "artists" });
  assert.equal(eapiRequest(r, "/cloudsearch/pc", true).payload.type, 100);
  assert.deepEqual(plain(artists.artists[0]), {
    id: "6452",
    name: "周杰伦",
    imageUrl: "https://p1.music.126.net/a.jpg",
  });

  const playlists = await r.plugin.search({ query: "测试", kind: "playlists" });
  assert.equal(eapiRequest(r, "/cloudsearch/pc", true).payload.type, 1000);
  assert.deepEqual(plain(playlists.playlists[0]), {
    id: "999",
    name: "测试歌单",
    imageUrl: "https://p3.music.126.net/cover.jpg",
    description: "歌单描述",
    owner: "测试用户",
    trackCount: 3,
    plays: 12345,
    mine: false,
    saved: false,
    fixed: false,
  });

  // 缺少 total 时用 hasMore 字段；结果里不出现 total 属性。
  r.routes.length = 0;
  eapi(r, "/cloudsearch/pc", { code: 200, result: { songs: [rawSong()], hasMore: true } });
  const fallback = await r.plugin.search({ query: "晴天", kind: "tracks" });
  assert.equal(fallback.more, true);
  assert.equal(Object.prototype.hasOwnProperty.call(fallback, "total"), false);
});

test("eapi 错误映射：HTTP、登录限制、安全验证、坏 JSON 与网络错误", async () => {
  const r = await catalog();
  let reply = () => json({ code: 200, result: { songs: [], songCount: 0 } });
  r.route("/eapi/cloudsearch/pc", () => reply());

  const cases = [
    [() => status(503), "failed", "HTTP 503", true],
    [() => status(401), "unavailable", "网易云接口要求登录，本插件不支持登录", false],
    [() => json({ code: 301 }), "unavailable", "网易云接口要求登录或已限制访问", false],
    [() => json({ code: -462 }), "failed", "网易云要求安全验证，请稍后重试", false],
    [() => json({ code: 500, message: "boom" }), "failed", "网易云请求失败（500）：boom", false],
    [() => text("<html>bad gateway</html>"), "failed", "网易云返回了无法识别的响应，请稍后重试", true],
    [() => { throw new Error("offline"); }, "failed", "无法连接网易云音乐，请检查网络或稍后重试", true],
  ];
  for (const [makeReply, code, message, retryable] of cases) {
    reply = makeReply;
    const error = await rejects(r.plugin.search({ query: "晴天", kind: "tracks" }), code, message);
    assert.equal(Boolean(error.retryable), retryable, message);
  }

  // 内部参数校验：路径与编号不合法时不发请求。
  const client = await r.module("catalog/client.js");
  const before = r.requests.length;
  await assert.rejects(client.api("bad/path"), (error) => error.code === "failed" && error.message === "无效的接口路径");
  await assert.rejects(async () => client.id("abc"), (error) => error.code === "unavailable" && error.message === "无效的网易云资源编号");
  assert.equal(client.id(42), "42");
  assert.equal(r.requests.length, before);
});

test("playlist：按 trackIds 顺序补全缺失曲目，详情失败与超大数据有明确错误", async () => {
  const r = await catalog();
  eapi(r, "/v6/playlist/detail", {
    code: 200,
    playlist: rawPlaylist({
      trackIds: [{ id: 1 }, { id: 2 }, { id: 3 }],
      tracks: [rawSong({ id: 1, name: "第一首" })],
    }),
  });
  eapi(r, "/v3/song/detail", { code: 200, songs: [rawSong({ id: 2, name: "第二首" })] });

  const detail = await r.plugin.playlist({ id: "999" });
  assert.equal(detail.name, "测试歌单");
  assert.equal(detail.id, "999");
  assert.equal(detail.trackCount, 3);
  assert.equal(detail.tracks.length, 3);
  assert.deepEqual(detail.tracks.map((item) => item.id), ["1", "2", "3"]);
  assert.equal(detail.tracks[0].name, "第一首");
  assert.equal(detail.tracks[1].name, "第二首");
  const missing = plain(detail.tracks[2]);
  assert.equal(missing.id, "3");
  assert.equal(missing.unavailable, true);
  assert.deepEqual(missing.artists, []);
  assert.deepEqual(missing.album, {});
  assert.equal(missing.duration, 0);

  assert.equal(eapiRequest(r, "/v6/playlist/detail").payload.id, "999");
  assert.equal(eapiRequest(r, "/v6/playlist/detail").payload.n, 1000);
  assert.equal(eapiRequest(r, "/v6/playlist/detail").payload.s, 0);
  assert.deepEqual(JSON.parse(eapiRequest(r, "/v3/song/detail").payload.c), [{ id: "2" }, { id: "3" }]);

  // 曲目已内嵌时不再请求详情。
  r.routes.length = 0;
  r.requests.length = 0;
  eapi(r, "/v6/playlist/detail", {
    code: 200,
    playlist: rawPlaylist({ trackIds: [{ id: 1 }], tracks: [rawSong({ id: 1 })] }),
  });
  await r.plugin.playlist({ id: "999" });
  assert.equal(eapiRequest(r, "/v3/song/detail"), undefined);

  // 歌单不存在。
  r.routes.length = 0;
  eapi(r, "/v6/playlist/detail", { code: 200, playlist: null });
  await rejects(r.plugin.playlist({ id: "999" }), "unavailable", "歌单不存在，或没有访问权限");

  // 超过一万首直接拒绝，不发详情请求。
  r.routes.length = 0;
  r.requests.length = 0;
  eapi(r, "/v6/playlist/detail", {
    code: 200,
    playlist: rawPlaylist({ trackCount: 10001, trackIds: Array.from({ length: 10001 }, (_, index) => ({ id: index + 1 })), tracks: [] }),
  });
  await rejects(r.plugin.playlist({ id: "999" }), "unsupported", "该歌单超过一万首");
  assert.equal(r.requests.length, 1);

  // 非法编号不发请求。
  r.requests.length = 0;
  await rejects(r.plugin.playlist({ id: "abc" }), "unavailable", "无效的网易云资源编号");
  assert.equal(r.requests.length, 0);
});

test("album：专辑与曲目映射，曲目沿用同一个专辑对象", async () => {
  const r = await catalog();
  eapi(r, "/v1/album/18905", {
    code: 200,
    album: rawAlbum({ type: "EP" }),
    songs: [rawSong({ id: 11, name: "以父之名" }), rawSong({ id: 12, name: "晴天" })],
  });

  const detail = await r.plugin.album({ id: 18905 });
  assert.deepEqual(plain(detail.album), {
    id: "18905",
    name: "叶惠美",
    imageUrl: "https://p2.music.126.net/album.jpg",
    artists: [{ id: "6452", name: "周杰伦", imageUrl: "" }],
    trackCount: 11,
    released: new Date(1059321600000).toISOString().slice(0, 10),
    copyright: "",
    kind: "ep",
  });
  assert.equal(detail.tracks.length, 2);
  assert.equal(detail.tracks[0].name, "以父之名");
  assert.equal(detail.tracks[0].album.id, "18905");
  assert.deepEqual(plain(detail.tracks[0].album), plain(detail.album));

  r.requests.length = 0;
  await rejects(r.plugin.album({ id: "abc" }), "unavailable", "无效的网易云资源编号");
  assert.equal(r.requests.length, 0);
});

test("artist：歌手、热门歌曲、专辑；专辑列表失败可容忍", async () => {
  const r = await catalog();
  eapi(r, "/v1/artist/6452", {
    code: 200,
    artist: { id: 6452, name: "周杰伦", picUrl: "http://p1.music.126.net/artist.jpg" },
    hotSongs: [rawSong()],
  });
  eapi(r, "/artist/albums/6452", {
    code: 200,
    hotAlbums: [rawAlbum()],
  });

  const detail = await r.plugin.artist({ id: "6452" });
  assert.deepEqual(plain(detail.artist), {
    id: "6452",
    name: "周杰伦",
    imageUrl: "https://p1.music.126.net/artist.jpg",
  });
  assert.deepEqual(detail.tracks.map((item) => item.id), ["186016"]);
  assert.deepEqual(plain(detail.albums.map((item) => item.id)), ["18905"]);
  assert.deepEqual(plain(detail.related), []);
  const albumsRequest = eapiRequest(r, "/artist/albums/6452");
  assert.equal(albumsRequest.payload.limit, 100);
  assert.equal(albumsRequest.payload.offset, 0);
  assert.equal(albumsRequest.payload.total, true);

  // 专辑列表接口失败时，歌手页仍然可用，只是没有专辑。
  r.routes.length = 0;
  eapi(r, "/v1/artist/6452", { code: 200, artist: { id: 6452, name: "周杰伦" }, hotSongs: [] });
  eapi(r, "/artist/albums/6452", () => status(500));
  const tolerated = await r.plugin.artist({ id: "6452" });
  assert.equal(tolerated.artist.name, "周杰伦");
  assert.deepEqual(plain(tolerated.albums), []);

  r.requests.length = 0;
  await rejects(r.plugin.artist({ id: "abc" }), "unavailable", "无效的网易云资源编号");
  assert.equal(r.requests.length, 0);
});

test("lyrics：返回原文与翻译 LRC，缺失时给空字符串", async () => {
  const r = await catalog();
  eapi(r, "/song/lyric", {
    code: 200,
    lrc: { lyric: "[00:01.00]晴天\n[00:02.00]故事的小黄花" },
    tlyric: { lyric: "[00:01.00]Sunny day" },
  });

  const result = await r.plugin.lyrics({ id: 186016 });
  assert.deepEqual(plain(result), {
    lrc: "[00:01.00]晴天\n[00:02.00]故事的小黄花",
    translation: "[00:01.00]Sunny day",
  });
  const payload = eapiRequest(r, "/song/lyric").payload;
  assert.equal(payload.id, "186016");
  assert.equal(payload.lv, -1);
  assert.equal(payload.tv, -1);
  assert.equal(payload.rv, -1);
  assert.equal(payload.kv, -1);

  r.routes.length = 0;
  eapi(r, "/song/lyric", { code: 200 });
  assert.deepEqual(plain(await r.plugin.lyrics({ id: "186016" })), { lrc: "", translation: "" });

  r.requests.length = 0;
  await rejects(r.plugin.lyrics({ id: "abc" }), "unavailable", "无效的网易云资源编号");
  assert.equal(r.requests.length, 0);
});

test("home：推荐歌单、推荐新歌与发现入口，新歌失败不影响首页", async () => {
  const r = await catalog();
  eapi(r, "/personalized/playlist", { code: 200, result: [rawPlaylist()] });
  eapi(r, "/personalized/newsong", { code: 200, result: [{ song: rawSong() }] });

  const home = await r.plugin.home();
  assert.equal(home.title, "网易云音乐");
  assert.equal(home.subtitle, "免登录曲库 · 自动切换音源");
  assert.equal(home.sections.length, 3);
  assert.equal(home.sections[0].title, "推荐新歌");
  assert.equal(home.sections[0].style, "songs");
  assert.equal(home.sections[0].tracks[0].id, "186016");
  assert.equal(home.sections[1].title, "推荐歌单");
  assert.equal(home.sections[1].style, "shelf");
  assert.equal(home.sections[1].playlists[0].name, "测试歌单");
  assert.equal(home.sections[2].title, "发现音乐");
  assert.deepEqual(plain(home.sections[2].links), [
    { title: "排行榜", page: "charts" },
    { title: "最新专辑", page: "new-albums" },
    { title: "热门歌单", page: "playlists:全部:0" },
    { title: "音源网关", page: "sources" },
  ]);
  assert.equal(eapiRequest(r, "/personalized/playlist").payload.limit, 24);
  assert.equal(eapiRequest(r, "/personalized/playlist").payload.total, true);
  assert.equal(eapiRequest(r, "/personalized/newsong").payload.limit, 12);

  // 推荐新歌接口失败：降级为两段，不阻塞整个首页。
  r.routes.length = 0;
  eapi(r, "/personalized/playlist", { code: 200, result: [] });
  eapi(r, "/personalized/newsong", () => status(503));
  const degraded = await r.plugin.home();
  assert.deepEqual(plain(degraded.sections.map((section) => section.title)), ["推荐歌单", "发现音乐"]);

  // 推荐歌单失败是硬错误。
  r.routes.length = 0;
  eapi(r, "/personalized/playlist", () => status(503));
  await rejects(r.plugin.home(), "failed", "HTTP 503");
});

test("browse：排行榜、新专辑、top 详情与非法页面", async () => {
  const r = await catalog();
  eapi(r, "/toplist", { code: 200, list: [rawPlaylist({ id: 3778678, name: "热歌榜" })] });
  eapi(r, "/discovery/newAlbum", { code: 200, albums: [rawAlbum()] });

  const charts = await r.plugin.browse({ page: "charts" });
  assert.equal(charts.title, "排行榜");
  assert.equal(charts.sections[0].style, "grid");
  assert.equal(charts.sections[0].playlists[0].name, "热歌榜");

  const newest = await r.plugin.browse({ page: "new-albums" });
  assert.equal(newest.title, "最新专辑");
  assert.equal(newest.sections[0].style, "grid");
  assert.equal(newest.sections[0].albums[0].id, "18905");

  // 默认页等价于 playlists:全部:0。
  eapi(r, "/playlist/list", { code: 200, playlists: [rawPlaylist()], more: false });
  const defaultPage = await r.plugin.browse({});
  assert.equal(defaultPage.title, "热门歌单");
  const defaultPayload = eapiRequest(r, "/playlist/list", true).payload;
  assert.equal(defaultPayload.cat, "全部");
  assert.equal(defaultPayload.offset, 0);
  assert.equal(defaultPayload.limit, 30);
  assert.equal(defaultPayload.order, "hot");

  // top:<id> 复用歌单详情。
  eapi(r, "/v6/playlist/detail", {
    code: 200,
    playlist: rawPlaylist({ trackIds: [{ id: 1 }], tracks: [rawSong({ id: 1 })] }),
  });
  const top = await r.plugin.browse({ page: "top:3778678" });
  assert.equal(top.title, "测试歌单");
  assert.equal(top.sections[0].tracks[0].id, "1");
  assert.equal(eapiRequest(r, "/v6/playlist/detail", true).payload.id, "3778678");

  // 非法页面：不发请求。
  r.requests.length = 0;
  for (const page of ["bogus", "top:abc", "top:", "daily", "sources"]) {
    const error = await rejects(r.plugin.browse({ page }), "unsupported");
    assert.ok(error.message.length > 0);
  }
  assert.equal(r.requests.length, 0);
});

test("browse playlists 分页：分类、偏移、tabs 与下一页链接", async () => {
  const r = await catalog();
  eapi(r, "/playlist/list", { code: 200, playlists: [rawPlaylist()], more: true });

  const page = await r.plugin.browse({ page: "playlists:华语:30" });
  assert.equal(page.title, "热门歌单");
  assert.equal(page.sections[0].style, "grid");
  assert.equal(page.sections[0].playlists[0].id, "999");
  assert.deepEqual(plain(page.sections[1].links), [
    { title: "下一页", page: "playlists:华语:60" },
  ]);
  const payload = eapiRequest(r, "/playlist/list").payload;
  assert.equal(payload.cat, "华语");
  assert.equal(payload.offset, 30);
  assert.equal(payload.limit, 30);

  assert.deepEqual(plain(page.tabs.map((tab) => tab.title)), ["全部", "华语", "欧美", "日语", "韩语", "轻音乐", "古典", "电子"]);
  assert.deepEqual(plain(page.tabs.map((tab) => tab.page)), [
    "playlists:全部:0",
    "playlists:华语:0",
    "playlists:欧美:0",
    "playlists:日语:0",
    "playlists:韩语:0",
    "playlists:轻音乐:0",
    "playlists:古典:0",
    "playlists:电子:0",
  ]);
  assert.deepEqual(plain(page.tabs.filter((tab) => tab.selected).map((tab) => tab.title)), ["华语"]);

  // 未知分类回退到「全部」。
  await r.plugin.browse({ page: "playlists:不存在的分类:0" });
  assert.equal(eapiRequest(r, "/playlist/list", true).payload.cat, "全部");

  // 没有更多时不追加下一页链接。
  r.routes.length = 0;
  eapi(r, "/playlist/list", { code: 200, playlists: [], more: false });
  const last = await r.plugin.browse({ page: "playlists:华语:0" });
  assert.equal(last.sections.length, 1);
});

test("models：缺省字段、release/kind 与元数据缓存上限", async () => {
  const r = await catalog();
  const models = await r.module("catalog/models.js");

  assert.deepEqual(plain(models.artist({})), { id: "", name: "未知歌手", imageUrl: "" });
  assert.deepEqual(plain(models.artist({ id: 1, name: "歌手", img1v1Url: "http://x/a.jpg" })), {
    id: "1",
    name: "歌手",
    imageUrl: "https://x/a.jpg",
  });
  assert.equal(models.album({ type: "Single" }).kind, "single");
  assert.equal(models.album({ type: "EP" }).kind, "ep");
  assert.equal(models.album({ type: "专辑" }).kind, "album");
  assert.equal(models.album({ publishTime: 0 }).released, "");

  const mapped = models.track({ id: 7, name: "歌曲", ar: [], al: {}, dt: "180000" });
  assert.equal(mapped.duration, 180000);
  assert.equal(mapped.url, "https://music.163.com/song?id=7");
  assert.equal(mapped.name, "歌曲");
  assert.equal(models.cachedMeta("7").name, "歌曲");
  assert.equal(models.cachedMeta(7).id, "7");

  const unknown = models.track({});
  assert.equal(unknown.id, "");
  assert.equal(unknown.unavailable, true);
  assert.equal(unknown.url, "");

  // 只保留最近 512 条元数据：插入 512 条后刚好占满，最先进来的 id=7 被淘汰。
  for (let index = 0; index < 512; index += 1) {
    models.rememberMeta({ id: `cache-${index}`, name: `歌曲 ${index}` });
  }
  assert.equal(models.cachedMeta("7"), null);
  assert.equal(models.cachedMeta("cache-0").name, "歌曲 0");
  assert.equal(models.cachedMeta("cache-511").name, "歌曲 511");
  // 再插入 1 条，淘汰最旧的 cache-0，其余保持不动。
  models.rememberMeta({ id: "cache-512", name: "歌曲 512" });
  assert.equal(models.cachedMeta("cache-0"), null);
  assert.equal(models.cachedMeta("cache-1").name, "歌曲 1");
  assert.equal(models.cachedMeta("cache-511").name, "歌曲 511");
  assert.equal(models.cachedMeta("cache-512").name, "歌曲 512");
});

test("suggest 与 hotSearches：去重、截断与失败降级", async () => {
  const r = await catalog();
  eapi(r, "/search/suggest/web", {
    code: 200,
    result: {
      songs: [{ name: "晴天" }, { name: "晴天" }],
      artists: [{ name: "周杰伦" }, { name: "" }],
      albums: [{ name: "叶惠美" }],
    },
  });
  assert.deepEqual(plain(await r.plugin.suggest({ query: " 晴天 " })), ["晴天", "周杰伦", "叶惠美"]);
  assert.equal(eapiRequest(r, "/search/suggest/web").payload.s, "晴天");

  const before = r.requests.length;
  assert.deepEqual(plain(await r.plugin.suggest({ query: "  " })), []);
  assert.equal(r.requests.length, before);

  // 热搜去重、去空白并截断到 20 条。
  const words = Array.from({ length: 25 }, (_, index) => ({ searchWord: `  热词${index}  ` }));
  words.push({ searchWord: "热词0" }, { searchWord: "" });
  r.routes.length = 0;
  eapi(r, "/hotsearchlist/get", { code: 200, data: words });
  const hot = await r.plugin.hotSearches();
  assert.equal(hot.length, 20);
  assert.equal(hot[0], "热词0");
  assert.equal(hot[19], "热词19");

  // 热搜接口失败只返回空数组。
  r.routes.length = 0;
  eapi(r, "/hotsearchlist/get", () => status(503));
  assert.deepEqual(plain(await r.plugin.hotSearches()), []);
});
