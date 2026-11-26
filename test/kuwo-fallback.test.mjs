// 搜索兜底：网易云整库搜不到时补酷我结果，kw:<rid> 直接走酷我取址；
// 同时验证喜欢 / 本地歌单 / 右键菜单 / 歌词 / 分页与失败降级。
import assert from "node:assert/strict";
import test from "node:test";
import { json, runtime, status, text } from "./runtime.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const hosts = (requests) => requests.map((request) => new URL(request.url).host);

const NETEASE_SONG = {
  id: 186016,
  name: "晴天",
  dt: 269000,
  ar: [{ id: 6452, name: "周杰伦" }],
  al: { id: 18905, name: "叶惠美", picUrl: "http://p2.music.126.net/album.jpg" },
  privilege: { st: 0 },
};

const KUWO_ROW = {
  SONGNAME: "冷门情歌",
  ARTIST: "某歌手&另一位",
  ALBUM: "测试专辑",
  ALBUMID: "9527",
  DURATION: "201",
  MUSICRID: "MUSIC_777",
  ONLINE: "1",
  web_albumpic_short: "120/s3s1/1/cover.jpg",
};

function stubEmptyNetease(r) {
  r.route("/eapi/cloudsearch/pc", () => json({ code: 200, result: { songs: [], songCount: 0 } }));
}

function stubKuwo(r, handler = () => json({
  PN: "0",
  RN: "50",
  SHOW: "1",
  TOTAL: "1",
  abslist: [KUWO_ROW],
})) {
  r.route("search.kuwo.cn", handler);
}

function stubBodian(r, url = "https://bd-er.kuwo.cn/test.mp3") {
  r.route("bd-api.kuwo.cn/api/service/advert/watch", () => json({ code: 200 }));
  r.route("bd-api.kuwo.cn/api/play/music/v2/audioUrl", () => json({
    code: 200,
    data: { audioUrl: url, audioHttpsUrl: url, bitrate: 320, size: "4.2MB" },
  }));
}

const KW_TRACK = {
  id: "kw:777",
  source: "switch",
  name: "冷门情歌",
  artists: [{ id: "", name: "某歌手" }],
  duration: 201000,
  album: { id: "", name: "测试专辑" },
};

test("search：酷我歌名里的「-《剧名》…」后缀会去掉", async () => {
  const r = await runtime();
  stubEmptyNetease(r);
  stubKuwo(r, () => json({
    PN: "0", RN: "50", SHOW: "1", TOTAL: "1",
    abslist: [{ ...KUWO_ROW, SONGNAME: "冷门情歌-《某剧》片头曲", MUSICRID: "MUSIC_777" }],
  }));

  const result = await r.plugin.search({ query: "冷门情歌", kind: "tracks", offset: 0 });
  assert.equal(result.tracks[0].name, "冷门情歌");
});

test("search：网易云 0 结果时用酷我兜底，映射 kw:<rid>（含封面、歌手拆分、分页参数）", async () => {
  const r = await runtime();
  stubEmptyNetease(r);
  let captured = null;
  stubKuwo(r, (request) => {
    captured = new URL(request.url);
    return json({ PN: "0", RN: "50", SHOW: "1", TOTAL: "1", abslist: [KUWO_ROW] });
  });

  const result = await r.plugin.search({ query: "冷门情歌", kind: "tracks", offset: 0 });

  assert.deepEqual(plain(result.tracks), [{
    id: "kw:777",
    name: "冷门情歌",
    artists: [{ id: "", name: "某歌手" }, { id: "", name: "另一位" }],
    album: {
      id: "",
      name: "测试专辑",
      imageUrl: "https://img1.kuwo.cn/star/albumcover/300/s3s1/1/cover.jpg",
    },
    duration: 201000,
    url: "https://www.kuwo.cn/play_detail/777",
  }]);
  assert.equal(result.more, false);
  assert.equal(result.total, 1);

  assert.equal(captured.searchParams.get("all"), "冷门情歌");
  assert.equal(captured.searchParams.get("pn"), "0");
  assert.equal(captured.searchParams.get("rn"), "50");
  assert.equal(captured.searchParams.get("vermerge"), "1");

  // 元数据快照落盘，宿主稍后只传 id 时还能补齐喜欢 / 歌单信息。
  const stored = plain(r.store.get("kuwoTracks"));
  assert.deepEqual(stored.items.map((item) => item.id), ["kw:777"]);
  assert.equal(stored.items[0].album.name, "测试专辑");
  assert.equal(stored.items[0].artists.length, 2);
});

test("search：网易云有结果时不请求酷我；分页结束的空页也不兜底", async () => {
  const r = await runtime();
  let kuwoRequests = 0;
  r.route("/eapi/cloudsearch/pc", (request) => {
    const offset = request.payload?.offset ?? 0;
    if (offset === 0) {
      return json({ code: 200, result: { songs: [NETEASE_SONG], songCount: 1 } });
    }
    return json({ code: 200, result: { songs: [], songCount: 120 } });
  });
  stubKuwo(r, () => {
    kuwoRequests += 1;
    return json({ PN: "0", RN: "50", SHOW: "0", TOTAL: "0", abslist: [] });
  });

  const first = await r.plugin.search({ query: "晴天", kind: "tracks", offset: 0 });
  assert.equal(first.tracks[0].id, "186016");
  assert.equal(kuwoRequests, 0);

  // offset > 0 且网易云 total > 0：这是翻页结束的空页，不能混入酷我结果。
  const second = await r.plugin.search({ query: "晴天", kind: "tracks", offset: 50 });
  assert.deepEqual(plain(second), { tracks: [], more: true, total: 120 });
  assert.equal(kuwoRequests, 0);
});

test("search：网易云只有同名翻唱、没有查询里的歌手时兜底酷我", async () => {
  const r = await runtime();
  let kuwoRequests = 0;
  r.route("/eapi/cloudsearch/pc", () => json({
    code: 200,
    result: {
      songs: [{ ...NETEASE_SONG, name: "说谎", ar: [{ id: 1, name: "翻唱歌手" }] }],
      songCount: 1,
    },
  }));
  stubKuwo(r, () => {
    kuwoRequests += 1;
    return json({
      PN: "0",
      RN: "50",
      SHOW: "1",
      TOTAL: "1",
      abslist: [{ ...KUWO_ROW, SONGNAME: "说谎", ARTIST: "林宥嘉", MUSICRID: "MUSIC_888" }],
    });
  });

  const result = await r.plugin.search({ query: "说谎 林宥嘉", kind: "tracks", offset: 0 });
  assert.equal(kuwoRequests, 1);
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].id, "kw:888");
  assert.equal(result.tracks[0].name, "说谎");
  assert.deepEqual(plain(result.tracks[0].artists), [{ id: "", name: "林宥嘉" }]);
});

test("search：网易云有原曲时保留网易云结果（即使官方直链取不到）", async () => {
  const r = await runtime();
  let kuwoRequests = 0;
  r.route("/eapi/cloudsearch/pc", () => json({
    code: 200,
    result: {
      songs: [
        { ...NETEASE_SONG, id: 1338278424, name: "脆弱一分钟 (Cover：林宥嘉)", ar: [{ id: 1, name: "Freddieee" }] },
        { ...NETEASE_SONG, id: 1294910319, name: "脆弱一分钟", ar: [{ id: 6452, name: "林宥嘉" }], dt: 193000 },
      ],
      songCount: 46,
    },
  }));
  stubKuwo(r, () => {
    kuwoRequests += 1;
    return json({ PN: "0", RN: "50", SHOW: "0", TOTAL: "0", abslist: [] });
  });

  const result = await r.plugin.search({ query: "脆弱一分钟 林宥嘉", kind: "tracks", offset: 0 });
  assert.equal(kuwoRequests, 0);
  assert.equal(result.tracks[1].id, "1294910319");
});

test("search：艺人名查询命中网易云时不兜底", async () => {
  const r = await runtime();
  let kuwoRequests = 0;
  r.route("/eapi/cloudsearch/pc", () => json({
    code: 200,
    result: {
      songs: [{ ...NETEASE_SONG, name: "说谎", ar: [{ id: 6452, name: "林宥嘉" }] }],
      songCount: 1,
    },
  }));
  stubKuwo(r, () => {
    kuwoRequests += 1;
    return json({ PN: "0", RN: "50", SHOW: "0", TOTAL: "0", abslist: [] });
  });

  const result = await r.plugin.search({ query: "林宥嘉", kind: "tracks", offset: 0 });
  assert.equal(kuwoRequests, 0);
  assert.equal(result.tracks[0].id, "186016");
});

test("search：多词歌名（英文标题）整体命中网易云时不兜底", async () => {
  const r = await runtime();
  let kuwoRequests = 0;
  r.route("/eapi/cloudsearch/pc", () => json({
    code: 200,
    result: {
      songs: [{ ...NETEASE_SONG, name: "Love Story", ar: [{ id: 1, name: "Taylor Swift" }] }],
      songCount: 1,
    },
  }));
  stubKuwo(r, () => {
    kuwoRequests += 1;
    return json({ PN: "0", RN: "50", SHOW: "0", TOTAL: "0", abslist: [] });
  });

  const result = await r.plugin.search({ query: "Love Story", kind: "tracks", offset: 0 });
  assert.equal(kuwoRequests, 0);
  assert.equal(result.tracks[0].name, "Love Story");
});

test("search：网易云只有伴奏版时不当作命中，兜底酷我原曲", async () => {
  const r = await runtime();
  r.route("/eapi/cloudsearch/pc", () => json({
    code: 200,
    result: {
      songs: [{ ...NETEASE_SONG, name: "残酷月光（伴奏）", ar: [{ id: 6452, name: "林宥嘉" }] }],
      songCount: 1,
    },
  }));
  stubKuwo(r, () => json({
    PN: "0",
    RN: "50",
    SHOW: "1",
    TOTAL: "1",
    abslist: [{ ...KUWO_ROW, SONGNAME: "残酷月光", ARTIST: "林宥嘉", MUSICRID: "MUSIC_999" }],
  }));

  const result = await r.plugin.search({ query: "残酷月光 林宥嘉", kind: "tracks", offset: 0 });
  assert.equal(result.tracks[0].id, "kw:999");
  assert.equal(result.tracks[0].name, "残酷月光");
});

test("search：歌手名写进标题的翻唱不能冒充命中", async () => {
  const r = await runtime();
  r.route("/eapi/cloudsearch/pc", () => json({
    code: 200,
    result: {
      songs: [
        { ...NETEASE_SONG, name: "想自由 林宥嘉", ar: [{ id: 1, name: "苏珊" }] },
        { ...NETEASE_SONG, name: "成全", ar: [{ id: 6452, name: "林宥嘉" }] },
      ],
      songCount: 2,
    },
  }));
  stubKuwo(r, () => json({
    PN: "0",
    RN: "50",
    SHOW: "1",
    TOTAL: "1",
    abslist: [{ ...KUWO_ROW, SONGNAME: "想自由", ARTIST: "林宥嘉", MUSICRID: "MUSIC_666" }],
  }));

  const result = await r.plugin.search({ query: "想自由 林宥嘉", kind: "tracks", offset: 0 });
  assert.equal(result.tracks[0].id, "kw:666");
  assert.equal(result.tracks[0].name, "想自由");
});

test("search：一旦走酷我兜底，后续分页不再请求网易云", async () => {
  const r = await runtime();
  let eapiCalls = 0;
  const pages = [];
  r.route("/eapi/cloudsearch/pc", () => {
    eapiCalls += 1;
    return json({
      code: 200,
      result: {
        songs: [{ ...NETEASE_SONG, name: "无关结果", ar: [{ id: 1, name: "别人" }] }],
        songCount: 100,
      },
    });
  });
  stubKuwo(r, (request) => {
    const pn = Number(new URL(request.url).searchParams.get("pn"));
    pages.push(pn);
    return json({
      PN: String(pn),
      RN: "50",
      SHOW: "1",
      TOTAL: "120",
      abslist: [{ ...KUWO_ROW, SONGNAME: "说谎", ARTIST: "林宥嘉", MUSICRID: `MUSIC_${pn + 1}` }],
    });
  });

  const first = await r.plugin.search({ query: "说谎 林宥嘉", kind: "tracks", offset: 0 });
  assert.equal(first.tracks[0].id, "kw:1");
  assert.equal(eapiCalls, 1);

  const second = await r.plugin.search({ query: "说谎 林宥嘉", kind: "tracks", offset: 50 });
  assert.equal(second.tracks[0].id, "kw:2");
  assert.equal(eapiCalls, 1, "兜底后翻页不应再打网易云");
  assert.deepEqual(pages, [0, 1]);
});

test("search：酷我也没有结果时保留网易云结果，不把搜索变空", async () => {
  const r = await runtime();
  r.route("/eapi/cloudsearch/pc", () => json({
    code: 200,
    result: {
      songs: [{ ...NETEASE_SONG, name: "说谎", ar: [{ id: 1, name: "翻唱歌手" }] }],
      songCount: 1,
    },
  }));
  stubKuwo(r, () => json({ PN: "0", RN: "50", SHOW: "0", TOTAL: "0", abslist: [] }));

  const result = await r.plugin.search({ query: "说谎 林宥嘉", kind: "tracks", offset: 0 });
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].id, "186016");
});

test("search：网易云不匹配、酷我也不匹配时保留网易云结果", async () => {
  const r = await runtime();
  r.route("/eapi/cloudsearch/pc", () => json({
    code: 200,
    result: {
      songs: [{ ...NETEASE_SONG, name: "无关结果", ar: [{ id: 1, name: "别人" }] }],
      songCount: 1,
    },
  }));
  stubKuwo(r, () => json({
    PN: "0",
    RN: "50",
    SHOW: "1",
    TOTAL: "1",
    abslist: [{ ...KUWO_ROW, SONGNAME: "另一首无关结果", ARTIST: "另一位", MUSICRID: "MUSIC_555" }],
  }));

  const result = await r.plugin.search({ query: "说谎 林宥嘉", kind: "tracks", offset: 0 });
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].id, "186016");
});

test("search：酷我兜底分页按 offset 取对应页", async () => {
  const r = await runtime();
  stubEmptyNetease(r);
  const pages = [];
  stubKuwo(r, (request) => {
    const pn = Number(new URL(request.url).searchParams.get("pn"));
    pages.push(pn);
    return json({
      PN: String(pn),
      RN: "50",
      SHOW: "1",
      TOTAL: "120",
      abslist: [{ ...KUWO_ROW, SONGNAME: pn === 0 ? "第一页" : "第二页", MUSICRID: `MUSIC_${pn + 1}` }],
    });
  });

  const first = await r.plugin.search({ query: "冷门", kind: "tracks", offset: 0 });
  assert.equal(first.tracks[0].name, "第一页");
  assert.equal(first.tracks[0].id, "kw:1");
  assert.equal(first.more, true);
  assert.equal(first.total, 120);

  const second = await r.plugin.search({ query: "冷门", kind: "tracks", offset: 50 });
  assert.equal(second.tracks[0].name, "第二页");
  assert.equal(second.tracks[0].id, "kw:2");
  assert.deepEqual(pages, [0, 1]);
});

test("search：酷我失败时降级为空结果，不把搜索页打挂", async () => {
  const r = await runtime();
  stubEmptyNetease(r);
  stubKuwo(r, () => status(500));

  const result = await r.plugin.search({ query: "冷门", kind: "tracks", offset: 0 });
  assert.deepEqual(plain(result), { tracks: [], more: false, total: 0 });

  // 其它搜索类型不受兜底影响。
  const other = await runtime();
  other.route("/eapi/cloudsearch/pc", () => json({ code: 200, result: { albums: [], albumCount: 0 } }));
  const albums = await other.plugin.search({ query: "冷门", kind: "albums", offset: 0 });
  assert.deepEqual(plain(albums), { albums: [], more: false, total: 0 });
});

test("search：空关键词不发请求", async () => {
  const r = await runtime();
  const before = r.requests.length;
  assert.deepEqual(plain(await r.plugin.search({ query: "   ", kind: "tracks" })), { tracks: [], more: false });
  assert.equal(r.requests.length, before);
});

test("stream：kw:<rid> 绕过网易云详情和酷我关键词搜索，直接按 rid 取址", async () => {
  const r = await runtime({ settings: { disableGdstudio: "true" } });
  stubBodian(r);

  const stream = await r.plugin.stream({ id: "kw:777", quality: "high" });

  assert.deepEqual(plain(stream), {
    url: "https://bd-er.kuwo.cn/test.mp3",
    type: "mp3",
    quality: "high",
    bitRate: 320,
    size: Math.round(4.2 * 1024 ** 2),
  });
  assert.deepEqual(hosts(r.requests), ["bd-api.kuwo.cn", "bd-api.kuwo.cn", "bd-er.kuwo.cn"]);
  assert.ok(!r.requests.some((request) => request.url.includes("interfacepc.music.163.com")));
  assert.ok(!r.requests.some((request) => request.url.includes("search.kuwo.cn")));
  const audio = r.requests.find((request) => request.url.includes("/api/play/music/v2/audioUrl"));
  assert.equal(new URL(audio.url).searchParams.get("musicId"), "777");
});

test("右键菜单：kw:<rid> 曲目有复制 / 检测，复制拿到的就是酷我直链", async () => {
  const r = await runtime({ settings: { disableGdstudio: "true" } });
  stubBodian(r);

  const entries = plain(r.plugin.trackMenu({ track: KW_TRACK }));
  assert.deepEqual(entries.map((entry) => entry.id), ["switch.copy", "switch.test"]);

  const copied = await r.plugin.menuAction({ id: "switch.copy", track: KW_TRACK });
  assert.equal(copied.copy, "https://bd-er.kuwo.cn/test.mp3");
  assert.ok(String(copied.toast).includes("高音质"));
});

test("喜欢：酷我兜底曲目按缓存元数据加入「我喜欢的音乐」", async () => {
  const r = await runtime();
  stubEmptyNetease(r);
  stubKuwo(r);
  await r.plugin.search({ query: "冷门", kind: "tracks", offset: 0 });

  const before = r.requests.length;
  await r.plugin.like({ id: "kw:777", on: true });
  assert.equal(r.requests.length, before, "喜欢不应再请求网易云详情");

  const liked = plain(await r.plugin.liked({ offset: 0 }));
  assert.deepEqual(liked.tracks.map((track) => track.id), ["kw:777"]);
  assert.equal(liked.tracks[0].name, "冷门情歌");
  assert.equal(liked.tracks[0].album.name, "测试专辑");
  assert.deepEqual(plain(r.plugin.isLiked({ ids: ["kw:777", "42"] })), { "kw:777": true, "42": false });

  await r.plugin.like({ id: "kw:777", on: false });
  assert.equal(plain(await r.plugin.liked({ offset: 0 })).tracks.length, 0);
});

test("本地歌单：kw:<rid> 可加入、列出，并用于「已在歌单」判断", async () => {
  const r = await runtime();
  r.plugin.createPlaylist({ name: "本地" });
  stubEmptyNetease(r);
  stubKuwo(r);
  await r.plugin.search({ query: "冷门", kind: "tracks", offset: 0 });

  const before = r.requests.length;
  await r.plugin.addToPlaylist({ id: "local-1", trackIds: ["kw:777"] });
  assert.equal(r.requests.length, before, "已缓存的酷我曲目不应再请求详情");

  const local = await r.plugin.playlist({ id: "local-1" });
  assert.deepEqual(plain(local.tracks.map((track) => track.id)), ["kw:777"]);
  assert.equal(local.tracks[0].name, "冷门情歌");
  assert.deepEqual(plain(r.plugin.trackPlaylists({ trackId: "kw:777" })), ["local-1"]);
});

test("持久化：重启后仍能用落盘的酷我元数据加入歌单", async () => {
  const r = await runtime();
  stubEmptyNetease(r);
  stubKuwo(r);
  await r.plugin.search({ query: "冷门", kind: "tracks", offset: 0 });
  const stored = plain(r.store.get("kuwoTracks"));

  const restarted = await runtime({ storage: { kuwoTracks: stored } });
  restarted.plugin.createPlaylist({ name: "本地" });
  const before = restarted.requests.length;
  await restarted.plugin.addToPlaylist({ id: "local-1", trackIds: ["kw:777"] });
  assert.equal(restarted.requests.length, before);
  const local = await restarted.plugin.playlist({ id: "local-1" });
  assert.equal(plain(local.tracks[0]).id, "kw:777");
  assert.equal(plain(local.tracks[0]).name, "冷门情歌");
});

test("歌词：kw:<rid> 返回空歌词且不发网易云请求", async () => {
  const r = await runtime();
  const before = r.requests.length;
  const lyrics = await r.plugin.lyrics({ id: "kw:777" });
  assert.deepEqual(plain(lyrics), { lrc: "", translation: "" });
  assert.equal(r.requests.length, before);
});
