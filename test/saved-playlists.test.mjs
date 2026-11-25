// 网易云歌单收藏：savePlaylist/取消收藏、playlists() 顺序与 saved 标记、菜单入口、上限、损坏存储。
import assert from "node:assert/strict";
import test from "node:test";
import { json, runtime, status } from "./runtime.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const SAVED_KEY = "savedPlaylists";
const LOCAL_KEY = "localPlaylists";
const LIKED_ID = "local-liked";

const TRACK = {
  id: "42",
  name: "晴天",
  artists: [{ id: "6452", name: "周杰伦" }],
  duration: 269000,
  album: { id: "1", name: "叶惠美" },
};

const rawPlaylist = (id, overrides = {}) => ({
  id,
  name: `网易云歌单${id}`,
  coverImgUrl: `http://p3.music.126.net/${id}.jpg`,
  creator: { nickname: "创建者" },
  trackCount: 12,
  ...overrides,
});

const savedCard = (id, overrides = {}) => ({
  id: String(id),
  name: `收藏歌单${id}`,
  imageUrl: "",
  owner: "",
  trackCount: 1,
  savedAt: 1,
  ...overrides,
});

const localItem = (index, overrides = {}) => ({
  id: `local-${index}`,
  name: `本地歌单 ${index}`,
  createdAt: 1000 + index,
  updatedAt: 1000 + index,
  tracks: [],
  ...overrides,
});

const storedSaved = (r) => plain(r.store.get(SAVED_KEY));

function stubPlaylistDetail(r, playlists) {
  r.route("/eapi/v6/playlist/detail", (request) => {
    const id = String(request.payload.id);
    const playlist = playlists[id];
    return json({ code: 200, privileges: [], playlist: playlist ?? null });
  });
}

async function rejects(promise, code, messagePart) {
  const error = await promise.then(() => null, (value) => value);
  assert.ok(error, "应当抛错");
  if (code) assert.equal(error.code, code);
  if (messagePart) assert.ok(error.message.includes(messagePart), `错误信息应包含 ${messagePart}，实际：${error.message}`);
  return error;
}

test("savePlaylist：拉取网易云歌单卡片并落库，重复收藏不重复请求", async () => {
  const r = await runtime();
  stubPlaylistDetail(r, { 3778678: rawPlaylist(3778678) });

  const card = plain(await r.plugin.savePlaylist({ id: "3778678", on: true }));
  assert.deepEqual(card, {
    id: "3778678",
    name: "网易云歌单3778678",
    imageUrl: "https://p3.music.126.net/3778678.jpg",
    description: "",
    owner: "创建者",
    trackCount: 12,
    plays: 0,
    mine: false,
    saved: true,
    fixed: false,
  });

  const detailRequest = r.requests.find((request) => request.url.endsWith("/eapi/v6/playlist/detail"));
  assert.equal(detailRequest.payload.id, "3778678");
  assert.equal(detailRequest.payload.n, 1);
  assert.equal(detailRequest.payload.s, 0);
  assert.deepEqual(storedSaved(r), {
    items: [{
      id: "3778678",
      name: "网易云歌单3778678",
      imageUrl: "https://p3.music.126.net/3778678.jpg",
      owner: "创建者",
      trackCount: 12,
      savedAt: r.clock.now(),
    }],
  });

  // 重复收藏：不联网、不重复落库。
  const count = r.requests.length;
  assert.deepEqual(plain(await r.plugin.savePlaylist({ id: 3778678, on: true })), card);
  assert.equal(r.requests.length, count);
  assert.equal(storedSaved(r).items.length, 1);

  // 无效编号 / 歌单不存在。
  await rejects(r.plugin.savePlaylist({ id: "abc", on: true }), "unavailable", "无效的网易云资源编号");
  assert.equal(r.requests.length, count);
  await rejects(r.plugin.savePlaylist({ id: "999", on: true }), "unavailable", "歌单不存在，或没有访问权限");
  assert.equal(storedSaved(r).items.length, 1);

  // 第一次保存不碰本地歌单 storage。
  assert.equal(r.store.has(LOCAL_KEY), false);
});

test("取消收藏：on=false 移除并幂等；重新收藏后按 savedAt 排到最前", async () => {
  const r = await runtime();
  stubPlaylistDetail(r, { 101: rawPlaylist(101), 102: rawPlaylist(102) });

  await r.plugin.savePlaylist({ id: 101, on: true });
  r.clock.advance(1000);
  await r.plugin.savePlaylist({ id: 102, on: true });
  assert.deepEqual(storedSaved(r).items.map((item) => item.id), ["102", "101"]);

  // 回看列表：收藏项在本地歌单之后，最近收藏在前，标记正确。
  assert.deepEqual(plain(r.plugin.playlists()).map((item) => item.id), [LIKED_ID, "102", "101"]);
  assert.deepEqual(plain(r.plugin.playlists()).slice(1).map((item) => item.saved), [true, true]);
  assert.deepEqual(plain(r.plugin.playlists()).slice(1).map((item) => item.mine), [false, false]);

  // 重复收藏不改变顺序/savedAt。
  await r.plugin.savePlaylist({ id: 101, on: true });
  assert.deepEqual(storedSaved(r).items.map((item) => item.id), ["102", "101"]);

  r.clock.advance(1000);
  assert.deepEqual(plain(await r.plugin.savePlaylist({ id: "101", on: false })), {});
  assert.deepEqual(storedSaved(r).items.map((item) => item.id), ["102"]);
  // 幂等取消：不抛错、storage 不变。
  assert.deepEqual(plain(await r.plugin.savePlaylist({ id: "101", on: false })), {});
  assert.deepEqual(storedSaved(r).items.map((item) => item.id), ["102"]);

  r.clock.advance(1000);
  await r.plugin.savePlaylist({ id: 101, on: true });
  assert.deepEqual(storedSaved(r).items.map((item) => item.id), ["101", "102"]);
  assert.equal(storedSaved(r).items[0].savedAt, r.clock.now());
});

test("playlists() 顺序：liked → 自建新→旧 → 收藏最近在前", async () => {
  const r = await runtime();
  stubPlaylistDetail(r, { 201: rawPlaylist(201, { trackCount: 31 }), 202: rawPlaylist(202) });

  r.clock.advance(1000);
  r.plugin.createPlaylist({ name: "本地一" });
  r.clock.advance(1000);
  r.plugin.createPlaylist({ name: "本地二" });
  r.clock.advance(1000);
  await r.plugin.savePlaylist({ id: 201, on: true });
  r.clock.advance(1000);
  await r.plugin.savePlaylist({ id: 202, on: true });

  const list = plain(r.plugin.playlists());
  assert.deepEqual(list.map((item) => item.id), [LIKED_ID, "local-2", "local-1", "202", "201"]);
  assert.deepEqual(list.map((item) => item.name), ["我喜欢的音乐", "本地二", "本地一", "网易云歌单202", "网易云歌单201"]);
  assert.deepEqual(list.map((item) => item.fixed), [true, false, false, false, false]);
  assert.deepEqual(list.map((item) => item.mine), [true, true, true, false, false]);
  assert.deepEqual(list.map((item) => item.saved), [false, false, false, true, true]);
  assert.deepEqual(list.map((item) => item.trackCount), [0, 0, 0, 12, 31]);
});

test("收藏不占自建 100 上限；收藏本身最多 500 个", async () => {
  const local = Array.from({ length: 99 }, (_, index) => localItem(index + 1));
  const saved = Array.from({ length: 500 }, (_, index) => savedCard(1000 + index, {
    savedAt: 1000 + index,
  }));
  const r = await runtime({
    storage: {
      [LOCAL_KEY]: { next: 100, items: local },
      [SAVED_KEY]: { items: saved },
    },
  });
  stubPlaylistDetail(r, { 501: rawPlaylist(501) });

  // 99 个自建 + 内置喜欢 + 500 收藏。
  assert.equal(r.plugin.playlists().length, 600);

  // 第 501 个收藏：未请求就失败，storage 不变。
  const count = r.requests.length;
  await rejects(r.plugin.savePlaylist({ id: 501, on: true }), "failed", "最多收藏 500 个歌单");
  assert.equal(r.requests.length, count);
  assert.equal(storedSaved(r).items.length, 500);

  // 收藏不占 100 个自建上限：第 100 个本地歌单可以创建。
  const created = plain(r.plugin.createPlaylist({ name: "第 100 个" }));
  assert.equal(created.id, "local-100");
  assert.equal(created.fixed, false);
  await rejects(
    Promise.resolve().then(() => r.plugin.createPlaylist({ name: "第 101 个" })),
    "failed",
    "最多创建 100 个歌单",
  );

  // 取消一个收藏后可以再收藏第 501 个。
  await r.plugin.savePlaylist({ id: 1000, on: false });
  const card = plain(await r.plugin.savePlaylist({ id: 501, on: true }));
  assert.equal(card.id, "501");
  assert.equal(storedSaved(r).items.length, 500);
  assert.equal(storedSaved(r).items[0].id, "501");
});

test("trackMenu：网易云歌单上下文出现收藏入口，本地歌单/空上下文不出现", async () => {
  const r = await runtime();
  const menu = (options) => plain(r.plugin.trackMenu(options));
  const base = [
    { id: "switch.copy", title: "复制音源直链" },
    { id: "switch.test", title: "检测音源可用性" },
  ];

  // 未收藏 → 收藏歌单；只读 storage，不联网。
  assert.deepEqual(menu({ track: TRACK, playlist: "3778678" }), [
    ...base,
    { id: "switch.save-playlist", title: "收藏歌单" },
  ]);
  assert.equal(r.requests.length, 0);

  stubPlaylistDetail(r, { 3778678: rawPlaylist(3778678) });
  await r.plugin.savePlaylist({ id: 3778678, on: true });
  const count = r.requests.length;
  assert.deepEqual(menu({ track: TRACK, playlist: "3778678" }), [
    ...base,
    { id: "switch.save-playlist", title: "取消收藏歌单" },
  ]);
  assert.equal(r.requests.length, count, "trackMenu 不应联网");

  // 没有曲目上下文时菜单定义照常，歌单入口仍在。
  assert.deepEqual(menu({ playlist: 3778678 }), [
    ...base,
    { id: "switch.save-playlist", title: "取消收藏歌单" },
  ]);

  // 本地歌单 / 喜欢歌单 / 空 / 非数字 playlist 都不出现收藏入口。
  for (const playlist of ["local-liked", "local-1", "", undefined, "abc", "0abc"]) {
    assert.deepEqual(menu({ track: TRACK, playlist }), base, `playlist=${playlist}`);
  }
  // 非本插件曲目仍然不显示任何菜单。
  assert.deepEqual(menu({ track: { id: "local-1" }, playlist: "3778678" }), []);
  assert.deepEqual(menu({ track: { id: "42", source: "qqmusic" }, playlist: "3778678" }), []);
});

test("menuAction：收藏/取消收藏歌单只走 storage 与 eapi，返回对应 toast", async () => {
  const r = await runtime();
  stubPlaylistDetail(r, { 3778678: rawPlaylist(3778678) });

  assert.deepEqual(plain(await r.plugin.menuAction({ id: "switch.save-playlist", playlist: "3778678" })), {
    toast: "已收藏歌单",
  });
  assert.equal(storedSaved(r).items.length, 1);
  assert.deepEqual(storedSaved(r).items[0], {
    id: "3778678",
    name: "网易云歌单3778678",
    imageUrl: "https://p3.music.126.net/3778678.jpg",
    owner: "创建者",
    trackCount: 12,
    savedAt: r.clock.now(),
  });

  // 再次触发 → 取消收藏。
  assert.deepEqual(plain(await r.plugin.menuAction({ id: "switch.save-playlist", playlist: 3778678 })), {
    toast: "已取消收藏",
  });
  assert.deepEqual(storedSaved(r).items, []);

  // 第三次 → 重新收藏（savedAt 前推，顺序仍第一）。
  r.clock.advance(1000);
  assert.deepEqual(plain(await r.plugin.menuAction({ id: "switch.save-playlist", playlist: "3778678" })), {
    toast: "已收藏歌单",
  });
  assert.equal(storedSaved(r).items[0].savedAt, r.clock.now());

  // 非法/本地 playlist 上下文：unsupported，且不联网。
  const count = r.requests.length;
  for (const playlist of [undefined, "", "abc", "local-liked", "local-1"]) {
    await rejects(
      r.plugin.menuAction({ id: "switch.save-playlist", playlist }),
      "unsupported",
      "未知菜单操作",
    );
  }
  assert.equal(r.requests.length, count);
});

test("损坏 savedPlaylists：字符串/缺 items/非法 id 不拖垮列表，合法项被规范化", async () => {
  const cases = [
    ["字符串", "broken", []],
    ["缺 items", { items: {} }, []],
    ["非法元素", { items: [null, "x", { id: "abc" }, { id: null }, { name: "无 id" }] }, []],
    ["合法项缺字段", {
      items: [
        { id: "12", name: "", trackCount: "7", savedAt: "abc" },
        { id: 13, name: "数字 id" },
      ],
    }, ["12", "13"]],
  ];

  for (const [label, value, expectedIds] of cases) {
    const r = await runtime({ storage: { [SAVED_KEY]: value } });
    let list;
    try {
      list = plain(r.plugin.playlists());
    } catch (error) {
      assert.fail(`${label}: playlists() 不应抛错：${error.message}`);
    }
    assert.deepEqual(list.map((item) => item.id), [LIKED_ID, ...expectedIds], label);
    if (expectedIds.length) {
      const saved = list.find((item) => item.id === "12");
      assert.equal(saved.name, "未命名歌单");
      assert.equal(saved.trackCount, 7);
      assert.equal(saved.saved, true);
      assert.equal(saved.mine, false);
      const numeric = list.find((item) => item.id === "13");
      if (numeric) {
        assert.equal(numeric.name, "数字 id");
        assert.equal(typeof numeric.id, "string");
      }
    }

    // 损坏数据下仍然可以继续收藏。
    stubPlaylistDetail(r, { 777: rawPlaylist(777) });
    const card = plain(await r.plugin.savePlaylist({ id: 777, on: true }));
    assert.equal(card.id, "777");
    assert.deepEqual(storedSaved(r).items.map((item) => item.id), ["777", ...expectedIds]);
  }
});

test("savePlaylist：请求期间已被并发收藏时去重，不覆盖已有卡片", async () => {
  const r = await runtime();
  r.route("/eapi/v6/playlist/detail", () => {
    // 模拟 await 期间另一个收藏操作先落库。
    r.store.set(SAVED_KEY, { items: [savedCard(42, { name: "并发写入", savedAt: 5 })] });
    return json({ code: 200, playlist: rawPlaylist(42) });
  });

  const card = plain(await r.plugin.savePlaylist({ id: 42, on: true }));
  assert.equal(card.id, "42");
  assert.equal(card.name, "并发写入");
  assert.equal(storedSaved(r).items.length, 1);
  assert.equal(storedSaved(r).items[0].name, "并发写入");
});

test("savePlaylist：eapi 失败时不落库", async () => {
  const r = await runtime();
  r.route("/eapi/v6/playlist/detail", () => status(503));
  await rejects(r.plugin.savePlaylist({ id: 42, on: true }), "failed", "HTTP 503");
  assert.equal(r.store.has(SAVED_KEY), false);

  r.routes.length = 0;
  r.route("/eapi/v6/playlist/detail", () => json({ code: 200, playlist: null }));
  await rejects(r.plugin.savePlaylist({ id: 42, on: true }), "unavailable", "歌单不存在，或没有访问权限");
  assert.equal(r.store.has(SAVED_KEY), false);
});

test("savePlaylist：请求期间收藏数达到 500 时拒绝落库", async () => {
  const initial = Array.from({ length: 499 }, (_, index) => savedCard(1000 + index, {
    savedAt: 1000 + index,
  }));
  const r = await runtime({ storage: { [SAVED_KEY]: { items: initial } } });
  r.route("/eapi/v6/playlist/detail", () => {
    // 模拟 await 期间另一个收藏先落库，占满第 500 个位置。
    r.store.set(SAVED_KEY, { items: [...initial, savedCard(2000, { savedAt: 2001 })] });
    return json({ code: 200, playlist: rawPlaylist(42) });
  });

  await rejects(r.plugin.savePlaylist({ id: 42, on: true }), "failed", "最多收藏 500 个歌单");
  assert.equal(storedSaved(r).items.length, 500);
  assert.equal(storedSaved(r).items.some((item) => item.id === "42"), false);
});

test("取消收藏不需要联网：已收藏歌单在离线时也能移除", async () => {
  const r = await runtime({ storage: { [SAVED_KEY]: { items: [savedCard(42)] } } });
  // 不配置任何 fetch 路由；如果实现发请求，runtime 会直接抛 unexpected fetch。
  assert.deepEqual(plain(await r.plugin.savePlaylist({ id: "42", on: false })), {});
  assert.deepEqual(storedSaved(r).items, []);
  assert.equal(r.requests.length, 0);
});


test("deletePlaylist 对收藏的网易云歌单等价取消收藏", async () => {
  const r = await runtime();
  r.plugin.createPlaylist({ name: "本地保留" });
  stubPlaylistDetail(r, { 3778678: rawPlaylist(3778678) });
  await r.plugin.savePlaylist({ id: 3778678, on: true });
  assert.equal(storedSaved(r).items.length, 1);
  assert.ok(plain(r.plugin.playlists()).some((item) => item.id === "3778678"));

  assert.deepEqual(plain(r.plugin.deletePlaylist({ id: "3778678" })), {});
  assert.deepEqual(storedSaved(r).items, []);
  assert.ok(!plain(r.plugin.playlists()).some((item) => item.id === "3778678"));
  // 本地歌单与喜欢歌单不受影响。
  assert.deepEqual(plain(r.plugin.playlists()).map((item) => item.id), ["local-liked", "local-1"]);

  // 未收藏的数字 id：幂等返回 {}，不联网。
  const count = r.requests.length;
  for (const id of ["999999", 42, "0"]) {
    assert.deepEqual(plain(r.plugin.deletePlaylist({ id })), {});
  }
  assert.equal(r.requests.length, count);
  assert.deepEqual(storedSaved(r).items, []);
});
