// 免登录本地歌单：创建 / 列表 / 路由 / 加歌 / 改名 / 删除 / 排序 / 上限 / 损坏存储。
import assert from "node:assert/strict";
import test from "node:test";
import { json, runtime } from "./runtime.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const STORAGE_KEY = "localPlaylists";

const song = (id, overrides = {}) => ({
  id,
  name: `歌曲${id}`,
  dt: 240000,
  ar: [{ id: "7", name: "歌手" }],
  al: { id: "8", name: "专辑", picUrl: "http://p1.music.126.net/cover.jpg" },
  ...overrides,
});

const snapshotJson = (r) => plain(r.store.get(STORAGE_KEY));
const playlistOf = async (r, id = "local-1") => r.plugin.playlist({ id });
const trackIdsOf = async (r, id = "local-1") => plain((await playlistOf(r, id)).tracks.map((item) => item.id));

function stubSongDetail(r, songs) {
  r.route("/eapi/v3/song/detail", (request) => {
    const ids = JSON.parse(request.payload.c).map((item) => String(item.id));
    return json({ code: 200, songs: ids.map((id) => songs[id]).filter(Boolean) });
  });
}

function stubRemotePlaylist(r, body) {
  r.route("/eapi/v6/playlist/detail", () => json({ code: 200, privileges: [], ...body }));
}

async function rejects(promise, code, messagePart) {
  const error = await promise.then(() => null, (value) => value);
  assert.ok(error, "应当抛错");
  if (code) assert.equal(error.code, code);
  if (messagePart) assert.ok(error.message.includes(messagePart), `错误信息应包含 ${messagePart}，实际：${error.message}`);
  return error;
}

test("createPlaylist：id 形如 local-N、mine=true、trackCount=0，空名称报错", async () => {
  const r = await runtime();
  const first = plain(r.plugin.createPlaylist({ name: "我的歌单" }));
  assert.deepEqual(first, {
    id: "local-1",
    name: "我的歌单",
    imageUrl: "",
    description: "",
    owner: "本地歌单",
    trackCount: 0,
    plays: 0,
    mine: true,
    saved: false,
    fixed: false,
  });

  r.clock.advance(1000);
  const second = plain(r.plugin.createPlaylist({ name: "第二个歌单" }));
  assert.equal(second.id, "local-2");
  assert.equal(second.mine, true);
  assert.equal(second.trackCount, 0);

  // 名称去空白、截断到 80 字符。
  assert.equal(plain(r.plugin.createPlaylist({ name: "  周末歌单  " })).name, "周末歌单");
  assert.equal(plain(r.plugin.createPlaylist({ name: "长".repeat(100) })).name.length, 80);

  const state = snapshotJson(r);
  assert.equal(state.next, 5);
  assert.deepEqual(state.items.map((item) => item.id), ["local-4", "local-3", "local-2", "local-1"]);
  assert.deepEqual(plain(state.items[3]), {
    id: "local-1",
    name: "我的歌单",
    createdAt: r.clock.now() - 1000,
    updatedAt: r.clock.now() - 1000,
    tracks: [],
  });
  assert.equal(state.items[0].createdAt, r.clock.now());

  const before = r.requests.length;
  for (const name of [undefined, "", "   "]) {
    await rejects(Promise.resolve().then(() => r.plugin.createPlaylist({ name })), "failed", "歌单名称不能为空");
  }
  assert.equal(snapshotJson(r).items.length, 4);
  assert.equal(r.requests.length, before);
});

test("playlists() 新歌单在前；playlist(local-id) 返回本地曲目，数字 id 仍走网易云", async () => {
  const r = await runtime();
  for (const [index, name] of ["最早", "中间", "最新"].entries()) {
    r.clock.advance(1000);
    r.plugin.createPlaylist({ name: `${name}-${index}` });
  }

  const list = plain(r.plugin.playlists());
  assert.deepEqual(list.map((item) => item.id), ["local-3", "local-2", "local-1"]);
  assert.deepEqual(list.map((item) => item.name), ["最新-2", "中间-1", "最早-0"]);
  assert.ok(list.every((item) => item.mine === true && item.trackCount === 0));

  stubSongDetail(r, { 42: song(42), 43: song(43) });
  await r.plugin.addToPlaylist({ id: "local-1", trackIds: [42, 43] });

  const before = r.requests.length;
  const local = await playlistOf(r);
  assert.equal(local.id, "local-1");
  assert.equal(local.name, "最早-0");
  assert.equal(local.trackCount, 2);
  assert.deepEqual(plain(local.tracks.map((track) => track.id)), ["42", "43"]);
  assert.equal(local.owner, "本地歌单");
  assert.equal(r.requests.length, before, "本地歌单详情不应发请求");

  // 数字 id 继续走网易云歌单详情。
  stubRemotePlaylist(r, {
    playlist: {
      id: 3778678,
      name: "网易云热歌榜",
      coverImgUrl: "http://p3.music.126.net/list.jpg",
      trackCount: 0,
      trackIds: [],
      tracks: [],
    },
  });
  const remote = await r.plugin.playlist({ id: "3778678" });
  assert.equal(remote.name, "网易云热歌榜");
  assert.equal(remote.trackCount, 0);
  const remoteRequest = r.requests.find((request) => request.url.endsWith("/eapi/v6/playlist/detail"));
  assert.equal(remoteRequest.payload.id, "3778678");

  // local-abc 不是合法本地编号，按网易云编号校验后报错。
  await rejects(r.plugin.playlist({ id: "local-abc" }), "unavailable", "无效的网易云资源编号");
  await rejects(r.plugin.playlist({ id: "local-999" }), "unavailable", "歌单不存在，或没有访问权限");
});

test("addToPlaylist：首次拉 eapi 详情写快照，去重，缓存命中不再请求", async () => {
  const r = await runtime();
  r.plugin.createPlaylist({ name: "加歌测试" });
  stubSongDetail(r, { 42: song(42), 43: song(43), 44: song(44) });

  await r.plugin.addToPlaylist({ id: "local-1", trackIds: [42, 43, 42] });
  assert.equal(r.requests.filter((request) => request.url.endsWith("/eapi/v3/song/detail")).length, 1);
  const detailRequest = r.requests.find((request) => request.url.endsWith("/eapi/v3/song/detail"));
  assert.deepEqual(JSON.parse(detailRequest.payload.c), [{ id: "42" }, { id: "43" }]);

  const listSummary = plain(r.plugin.playlists())[0];
  assert.equal(listSummary.trackCount, 2);
  assert.equal(listSummary.imageUrl, "https://p1.music.126.net/cover.jpg");

  const state = snapshotJson(r);
  assert.equal(state.items[0].tracks.length, 2);
  assert.deepEqual(state.items[0].tracks[0], {
    id: "42",
    name: "歌曲42",
    artists: [{ id: "7", name: "歌手" }],
    album: { id: "8", name: "专辑", imageUrl: "https://p1.music.126.net/cover.jpg" },
    duration: 240000,
    url: "https://music.163.com/song?id=42",
  });

  // 重复添加：元数据已在缓存里，不再请求 eapi。
  let count = r.requests.length;
  let summary = await r.plugin.addToPlaylist({ id: "local-1", trackIds: [42] });
  assert.equal(summary.trackCount, 2);
  assert.equal(r.requests.length, count);

  // 混合添加：只请求缓存里没有的 44。
  count = r.requests.length;
  summary = await r.plugin.addToPlaylist({ id: "local-1", trackIds: [43, 44] });
  assert.equal(summary.trackCount, 3);
  assert.equal(r.requests.length, count + 1);
  assert.deepEqual(JSON.parse(r.requests.at(-1).payload.c), [{ id: "44" }]);

  // 空/非法 trackIds：不发请求、不报错。
  count = r.requests.length;
  for (const trackIds of [undefined, [], ["abc", "-1", "local-1"], "42"]) {
    summary = await r.plugin.addToPlaylist({ id: "local-1", trackIds });
    assert.equal(summary.trackCount, 3);
  }
  assert.equal(r.requests.length, count);

  // 歌单不存在：先报 unavailable，不请求 eapi。
  count = r.requests.length;
  await rejects(r.plugin.addToPlaylist({ id: "local-9", trackIds: [42] }), "unavailable", "歌单不存在，或没有访问权限");
  assert.equal(r.requests.length, count);

  // eapi 一首都没返回：明确报歌曲暂不可用。
  stubSongDetail(r, {});
  await rejects(r.plugin.addToPlaylist({ id: "local-1", trackIds: [999] }), "unavailable", "歌曲暂不可用");
});

test("addToPlaylist：已有元数据缓存时不请求 eapi，缺省字段写成占位快照", async () => {
  const r = await runtime();
  r.plugin.createPlaylist({ name: "缓存测试" });
  const models = await r.module("catalog/models.js");
  models.rememberMeta({
    id: "77",
    name: "",
    artists: [],
    album: {},
    duration: 0,
  });

  let count = r.requests.length;
  const summary = await r.plugin.addToPlaylist({ id: "local-1", trackIds: [77] });
  assert.equal(summary.trackCount, 1);
  assert.equal(r.requests.length, count, "缓存命中不应请求 eapi");

  const track = plain((await playlistOf(r)).tracks[0]);
  assert.equal(track.id, "77");
  assert.equal(track.name, "未知歌曲");
  assert.deepEqual(track.artists, []);
  assert.deepEqual(track.album, { id: "", name: "未知专辑" });
  assert.equal(track.duration, 0);
  assert.equal("url" in track, false);

  // 模拟重启后元数据缓存为空：已在歌单里的曲目直接去重，不应再请求详情。
  const restarted = await runtime({
    storage: {
      [STORAGE_KEY]: {
        next: 2,
        items: [{
          id: "local-1",
          name: "重启歌单",
          createdAt: 1,
          updatedAt: 1,
          tracks: [{ id: "42", name: "旧快照", artists: [], album: {}, duration: 0 }],
        }],
      },
    },
  });
  stubSongDetail(restarted, { 42: song(42) });
  const requestsBefore = restarted.requests.length;
  const deduped = await restarted.plugin.addToPlaylist({ id: "local-1", trackIds: [42] });
  assert.equal(deduped.trackCount, 1);
  assert.equal(restarted.requests.length, requestsBefore, "已在歌单里的曲目不应请求 eapi");
  assert.equal(plain(restarted.store.get(STORAGE_KEY)).items[0].tracks.length, 1);
  assert.equal(plain(restarted.store.get(STORAGE_KEY)).items[0].tracks[0].name, "旧快照");
});

test("addToPlaylist：元数据请求期间歌单被删除时安全失败", async () => {
  const r = await runtime();
  r.plugin.createPlaylist({ name: "并发测试" });
  r.route("/eapi/v3/song/detail", () => {
    // 模拟 await 期间另一个操作清空了本地歌单。
    r.store.set(STORAGE_KEY, { next: 1, items: [] });
    return json({ code: 200, songs: [song(42)] });
  });
  await rejects(r.plugin.addToPlaylist({ id: "local-1", trackIds: [42] }), "unavailable", "歌单不存在，或没有访问权限");
  assert.deepEqual(plain(r.store.get(STORAGE_KEY)).items, []);
});

test("renamePlaylist：改名保留创建时间并更新时间；非法名称/不存在报错", async () => {
  const r = await runtime();
  const created = plain(r.plugin.createPlaylist({ name: "旧名字" }));
  const before = snapshotJson(r).items[0];
  r.clock.advance(5000);

  const renamed = plain(r.plugin.renamePlaylist({ id: "local-1", name: "  新名字  " }));
  assert.equal(renamed.id, created.id);
  assert.equal(renamed.name, "新名字");
  assert.equal(renamed.trackCount, 0);

  const stored = snapshotJson(r).items[0];
  assert.equal(stored.name, "新名字");
  assert.equal(stored.createdAt, before.createdAt);
  assert.equal(stored.updatedAt, before.createdAt + 5000);

  await rejects(
    Promise.resolve().then(() => r.plugin.renamePlaylist({ id: "local-1", name: "   " })),
    "failed",
    "歌单名称不能为空",
  );
  await rejects(
    Promise.resolve().then(() => r.plugin.renamePlaylist({ id: "local-9", name: "新名字" })),
    "unavailable",
    "歌单不存在，或没有访问权限",
  );
  assert.equal(plain(r.plugin.playlists())[0].name, "新名字");
});

test("deletePlaylist：删除后从列表消失，不存在的 id 幂等返回空对象", async () => {
  const r = await runtime();
  r.plugin.createPlaylist({ name: "保留" });
  r.plugin.createPlaylist({ name: "删除" });

  assert.deepEqual(plain(r.plugin.deletePlaylist({ id: "local-2" })), {});
  assert.deepEqual(plain(r.plugin.playlists()).map((item) => item.id), ["local-1"]);
  assert.deepEqual(snapshotJson(r).items.map((item) => item.id), ["local-1"]);

  // 幂等：再删一次、删不存在/非法 id 都返回空对象，不影响其它歌单。
  for (const id of ["local-2", "local-999", "不存在", 123, undefined]) {
    assert.deepEqual(plain(r.plugin.deletePlaylist({ id })), {});
  }
  assert.deepEqual(plain(r.plugin.playlists()).map((item) => item.id), ["local-1"]);

  assert.deepEqual(plain(r.plugin.deletePlaylist({ id: "local-1" })), {});
  assert.deepEqual(plain(r.plugin.playlists()), []);
  assert.equal(snapshotJson(r).items.length, 0);
});

test("removeFromPlaylist：按 trackId 移除；空数组与不存在曲目是 no-op", async () => {
  const r = await runtime();
  r.plugin.createPlaylist({ name: "移除测试" });
  stubSongDetail(r, { 42: song(42), 43: song(43), 44: song(44) });
  await r.plugin.addToPlaylist({ id: "local-1", trackIds: [42, 43, 44] });

  let updatedAt = snapshotJson(r).items[0].updatedAt;
  r.clock.advance(1000);
  let summary = r.plugin.removeFromPlaylist({ id: "local-1", trackIds: ["42"] });
  assert.equal(summary.trackCount, 2);
  assert.deepEqual(await trackIdsOf(r), ["43", "44"]);
  assert.equal(snapshotJson(r).items[0].updatedAt, updatedAt + 1000);

  // 空数组、不存在的曲目：不改 updatedAt，也不抛错。
  updatedAt = snapshotJson(r).items[0].updatedAt;
  r.clock.advance(1000);
  for (const trackIds of [undefined, [], ["999"], [], ["nope"]]) {
    summary = r.plugin.removeFromPlaylist({ id: "local-1", trackIds });
    assert.equal(summary.trackCount, 2);
  }
  assert.equal(snapshotJson(r).items[0].updatedAt, updatedAt);
  assert.deepEqual(await trackIdsOf(r), ["43", "44"]);

  // 数字 trackId 也按字符串匹配。
  summary = r.plugin.removeFromPlaylist({ id: "local-1", trackIds: [43] });
  assert.equal(summary.trackCount, 1);
  assert.deepEqual(await trackIdsOf(r), ["44"]);

  await rejects(
    Promise.resolve().then(() => r.plugin.removeFromPlaylist({ id: "local-9", trackIds: [] })),
    "unavailable",
    "歌单不存在，或没有访问权限",
  );
});

test("movePlaylistTrack：移动、越界钳制、非法参数与越界起点 no-op", async () => {
  const r = await runtime();
  r.plugin.createPlaylist({ name: "排序测试" });
  stubSongDetail(r, { 42: song(42), 43: song(43), 44: song(44) });
  await r.plugin.addToPlaylist({ id: "local-1", trackIds: [42, 43, 44] });
  assert.deepEqual(await trackIdsOf(r), ["42", "43", "44"]);

  r.clock.advance(1000);
  let summary = r.plugin.movePlaylistTrack({ id: "local-1", from: 0, to: 2 });
  assert.equal(summary.trackCount, 3);
  assert.deepEqual(await trackIdsOf(r), ["43", "44", "42"]);
  let updatedAt = snapshotJson(r).items[0].updatedAt;

  // 目标越界向上钳制到末尾。
  summary = r.plugin.movePlaylistTrack({ id: "local-1", from: 1, to: 99 });
  assert.equal(summary.trackCount, 3);
  assert.deepEqual(await trackIdsOf(r), ["43", "42", "44"]);

  // 目标越界向下钳制到开头。
  summary = r.plugin.movePlaylistTrack({ id: "local-1", from: 2, to: -5 });
  assert.deepEqual(await trackIdsOf(r), ["44", "43", "42"]);

  // 起点越界 / 参数非整数 / 原地移动：no-op，不更新时间。
  updatedAt = snapshotJson(r).items[0].updatedAt;
  r.clock.advance(1000);
  for (const [from, to] of [[3, 0], [5, 1], [-1, 0], [0, 0], ["abc", 1], [0, "abc"], [0, 1.5], [1.2, 0]]) {
    summary = r.plugin.movePlaylistTrack({ id: "local-1", from, to });
    assert.equal(summary.trackCount, 3);
    assert.deepEqual(await trackIdsOf(r), ["44", "43", "42"]);
  }
  assert.equal(snapshotJson(r).items[0].updatedAt, updatedAt);

  await rejects(
    Promise.resolve().then(() => r.plugin.movePlaylistTrack({ id: "local-9", from: 0, to: 1 })),
    "unavailable",
    "歌单不存在，或没有访问权限",
  );
});

test("上限：最多 100 个歌单；创建失败时 storage 不变", async () => {
  const items = Array.from({ length: 100 }, (_, index) => ({
    id: `local-${index + 1}`,
    name: `歌单 ${index + 1}`,
    createdAt: 1700000000000 + index,
    updatedAt: 1700000000000 + index,
    tracks: [],
  }));
  const r = await runtime({ storage: { [STORAGE_KEY]: { next: 101, items } } });
  assert.equal(r.plugin.playlists().length, 100);

  await rejects(Promise.resolve().then(() => r.plugin.createPlaylist({ name: "第 101 个" })), "failed", "最多创建 100 个歌单");
  assert.equal(snapshotJson(r).items.length, 100);
  assert.equal(snapshotJson(r).next, 101);

  // 删掉一个后可以重新创建，编号继续递增。
  r.plugin.deletePlaylist({ id: "local-1" });
  r.clock.advance(1000);
  const created = plain(r.plugin.createPlaylist({ name: "补位" }));
  assert.equal(created.id, "local-101");
  assert.equal(r.plugin.playlists().length, 100);
});

test("上限：单个歌单最多 2000 首；已有曲目仍可重复添加/移除", async () => {
  const tracks = Array.from({ length: 2000 }, (_, index) => ({
    id: String(index + 1),
    name: `歌曲 ${index + 1}`,
    artists: [],
    album: { id: "", name: "" },
    duration: 0,
  }));
  const r = await runtime({
    storage: { [STORAGE_KEY]: { next: 2, items: [{ id: "local-1", name: "满歌单", createdAt: 1, updatedAt: 1, tracks }] } },
  });
  stubSongDetail(r, { 3001: song(3001) });

  await rejects(
    r.plugin.addToPlaylist({ id: "local-1", trackIds: [3001] }),
    "failed",
    "单个歌单最多 2000 首歌曲",
  );
  assert.equal(snapshotJson(r).items[0].tracks.length, 2000);

  // 已存在曲目属于去重 no-op，不触发上限错误（元数据直接走缓存，不发 eapi）。
  const models = await r.module("catalog/models.js");
  for (const id of ["1", "2"]) {
    models.rememberMeta({ id, name: `缓存歌曲 ${id}`, artists: [], album: {}, duration: 0 });
  }
  const summary = await r.plugin.addToPlaylist({ id: "local-1", trackIds: [1, 2] });
  assert.equal(summary.trackCount, 2000);
  r.plugin.removeFromPlaylist({ id: "local-1", trackIds: [1] });
  assert.equal(plain(r.plugin.playlists())[0].trackCount, 1999);
});

test("上限：序列化超过 6MB 时保存失败且不覆盖原数据", async () => {
  const big = "x".repeat(6 * 1024 * 1024 + 100);
  // 歌单名会被截断到 80 字符，所以用曲目快照把序列化体积撑到 6MB 以上。
  const items = [{ id: "local-1", name: "大数据", createdAt: 1, updatedAt: 1, tracks: [{ id: "1", name: big }] }];
  const r = await runtime({ storage: { [STORAGE_KEY]: { next: 2, items } } });

  await rejects(Promise.resolve().then(() => r.plugin.createPlaylist({ name: "新歌单" })), "failed", "歌单数据已满，请删除一些歌单或歌曲");
  const stored = plain(r.store.get(STORAGE_KEY));
  assert.equal(stored.items.length, 1);
  assert.equal(stored.items[0].id, "local-1");
});

test("损坏 storage：字符串/缺 items/非法 id 返回空列表，并能重新创建歌单", async () => {
  const cases = [
    ["字符串", "broken"],
    ["数字", 42],
    ["空对象", {}],
    ["items 不是数组", { next: 3, items: {} }],
    ["元素非法", { next: 9, items: [null, "x", { id: 123, name: "数字 id" }, { id: null }, { name: "没有 id" }, { id: "local-abc", name: "幽灵歌单" }] }],
    ["缺 tracks", { next: 1, items: [{ id: "local-2", name: "缺 tracks", createdAt: 1, updatedAt: 1 }] }],
  ];

  for (const [label, value] of cases) {
    const r = await runtime({ storage: { [STORAGE_KEY]: value } });
    let list;
    try {
      list = plain(r.plugin.playlists());
    } catch (error) {
      assert.fail(`${label}: playlists() 不应抛错：${error.message}`);
    }
    assert.ok(Array.isArray(list), `${label}: 应返回数组`);
    if (label === "缺 tracks") {
      assert.deepEqual(list.map((item) => item.id), ["local-2"]);
      assert.equal(list[0].trackCount, 0);
    } else {
      assert.deepEqual(list, [], `${label}: 应返回空列表`);
    }

    const created = plain(r.plugin.createPlaylist({ name: "重建歌单" }));
    assert.ok(/^local-\d+$/.test(created.id), `${label}: 新编号合法`);
    assert.equal(plain(r.plugin.playlists())[0].name, "重建歌单");
    const stored = plain(r.store.get(STORAGE_KEY));
    assert.ok(Array.isArray(stored.items), `${label}: storage 应被修复为对象`);
    assert.equal(stored.items[0].id, created.id);
  }
});
