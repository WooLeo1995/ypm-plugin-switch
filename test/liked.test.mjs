// 「我喜欢的音乐」固定歌单：初始状态、like/isLiked/liked、分页、unlike、固定保护与损坏存储。
import assert from "node:assert/strict";
import test from "node:test";
import { json, runtime } from "./runtime.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const STORAGE_KEY = "localPlaylists";
const LIKED_ID = "local-liked";

const song = (id, overrides = {}) => ({
  id,
  name: `歌曲${id}`,
  dt: 200000,
  ar: [{ id: "7", name: "歌手" }],
  al: { id: "8", name: "专辑", picUrl: "http://p1.music.126.net/cover.jpg" },
  ...overrides,
});

const snapshot = (id, name = `歌曲${id}`) => ({
  id: String(id),
  name,
  artists: [],
  album: {},
  duration: 0,
});

function stubSongDetail(r, songs) {
  r.route("/eapi/v3/song/detail", (request) => {
    const ids = JSON.parse(request.payload.c).map((item) => String(item.id));
    return json({ code: 200, songs: ids.map((id) => songs[id]).filter(Boolean) });
  });
}

function stored(r) {
  return plain(r.store.get(STORAGE_KEY));
}

async function rejects(promise, code, messagePart) {
  const error = await promise.then(() => null, (value) => value);
  assert.ok(error, "应当抛错");
  if (code) assert.equal(error.code, code);
  if (messagePart) assert.ok(error.message.includes(messagePart), `错误信息应包含 ${messagePart}，实际：${error.message}`);
  return error;
}

test("初始状态：playlists() 第一位是固定的「我喜欢的音乐」，普通歌单创建不受影响", async () => {
  const r = await runtime();
  assert.deepEqual(plain(r.plugin.playlists()), [{
    id: LIKED_ID,
    name: "我喜欢的音乐",
    imageUrl: "",
    description: "",
    owner: "本地歌单",
    trackCount: 0,
    plays: 0,
    mine: true,
    saved: false,
    fixed: true,
  }]);
  // 只读视图不应该落盘。
  assert.equal(r.store.has(STORAGE_KEY), false);

  const likedPlaylist = await r.plugin.playlist({ id: LIKED_ID });
  assert.equal(likedPlaylist.id, LIKED_ID);
  assert.equal(likedPlaylist.name, "我喜欢的音乐");
  assert.equal(likedPlaylist.fixed, true);
  assert.deepEqual(plain(likedPlaylist.tracks), []);
  assert.equal(r.requests.length, 0);

  r.clock.advance(1000);
  r.plugin.createPlaylist({ name: "普通一" });
  r.clock.advance(1000);
  r.plugin.createPlaylist({ name: "普通二" });

  const list = plain(r.plugin.playlists());
  assert.deepEqual(list.map((item) => item.id), [LIKED_ID, "local-2", "local-1"]);
  assert.deepEqual(list.map((item) => item.fixed), [true, false, false]);
  assert.equal(list[0].name, "我喜欢的音乐");
  assert.equal(list[0].trackCount, 0);

  // 喜欢歌单始终在第一，且创建普通歌单后仍然只有它一个 fixed。
  assert.equal(list.filter((item) => item.fixed).length, 1);
  assert.deepEqual(plain(stored(r).items.map((item) => item.id)), ["local-2", "local-1", LIKED_ID]);
});

test("like：首次请求 eapi 详情并写快照，新歌在前，重复 like 幂等", async () => {
  const r = await runtime();
  stubSongDetail(r, { 42: song(42), 43: song(43) });

  assert.deepEqual(plain(await r.plugin.like({ id: "42", on: true })), {});
  assert.equal(r.requests.filter((request) => request.url.endsWith("/eapi/v3/song/detail")).length, 1);
  assert.deepEqual(JSON.parse(r.requests.at(-1).payload.c), [{ id: "42" }]);

  let liked = plain((await r.plugin.playlist({ id: LIKED_ID })).tracks);
  assert.equal(liked.length, 1);
  assert.deepEqual(liked[0], {
    id: "42",
    name: "歌曲42",
    artists: [{ id: "7", name: "歌手" }],
    album: { id: "8", name: "专辑", imageUrl: "https://p1.music.126.net/cover.jpg" },
    duration: 200000,
    url: "https://music.163.com/song?id=42",
  });
  let state = stored(r);
  assert.equal(state.items[0].id, LIKED_ID);
  assert.equal(state.items[0].fixed, true);
  assert.equal(state.items[0].tracks.length, 1);

  r.clock.advance(1000);
  await r.plugin.like({ id: 43, on: true });
  liked = plain((await r.plugin.playlist({ id: LIKED_ID })).tracks);
  assert.deepEqual(liked.map((track) => track.id), ["43", "42"], "新喜欢的歌在最前");

  // 重复 like（数字/字符串/已缓存）不再请求、不重复插入。
  let count = r.requests.length;
  assert.deepEqual(plain(await r.plugin.like({ id: "42", on: true })), {});
  assert.deepEqual(plain(await r.plugin.like({ id: 43, on: true })), {});
  assert.equal(r.requests.length, count);
  assert.equal((await r.plugin.playlist({ id: LIKED_ID })).trackCount, 2);

  // 列表摘要同步：fixed、trackCount、封面。
  const summary = plain(r.plugin.playlists())[0];
  assert.equal(summary.id, LIKED_ID);
  assert.equal(summary.fixed, true);
  assert.equal(summary.trackCount, 2);
  assert.equal(summary.imageUrl, "https://p1.music.126.net/cover.jpg");

  // 非法编号 / eapi 无结果。
  await rejects(r.plugin.like({ id: "abc", on: true }), "unavailable", "无效的网易云资源编号");
  stubSongDetail(r, {});
  await rejects(r.plugin.like({ id: 999, on: true }), "unavailable", "歌曲暂不可用");
  assert.equal((await r.plugin.playlist({ id: LIKED_ID })).trackCount, 2);
});

test("liked 初始为空、isLiked 返回对应布尔；like 后 liked 新→旧", async () => {
  const r = await runtime();
  assert.deepEqual(plain(r.plugin.liked({})), { tracks: [], more: false });
  assert.deepEqual(plain(r.plugin.isLiked({ ids: [42, 43] })), { 42: false, 43: false });
  assert.deepEqual(plain(r.plugin.isLiked({})), {});
  assert.deepEqual(plain(r.plugin.isLiked({ ids: [] })), {});
  assert.deepEqual(plain(r.plugin.isLiked({ ids: "42" })), {});

  stubSongDetail(r, { 42: song(42), 43: song(43) });
  await r.plugin.like({ id: 42, on: true });
  await r.plugin.like({ id: 43, on: true });

  assert.deepEqual(plain(r.plugin.isLiked({ ids: [42, "43", 999] })), {
    42: true,
    43: true,
    999: false,
  });
  const page = plain(r.plugin.liked({}));
  assert.deepEqual(page.tracks.map((track) => track.id), ["43", "42"]);
  assert.equal(page.more, false);
  assert.equal(page.tracks[0].name, "歌曲43");
});

test("liked 分页：每页 50 首，超过 50 首 more=true，offset 归一", async () => {
  const tracks = Array.from({ length: 51 }, (_, index) => snapshot(51 - index));
  const r = await runtime({
    storage: { [STORAGE_KEY]: { next: 1, items: [{ id: LIKED_ID, name: "", createdAt: 0, updatedAt: 0, tracks }] } },
  });

  const first = plain(r.plugin.liked({ offset: 0 }));
  assert.equal(first.tracks.length, 50);
  assert.equal(first.tracks[0].id, "51");
  assert.equal(first.tracks[49].id, "2");
  assert.equal(first.more, true);

  const second = plain(r.plugin.liked({ offset: 50 }));
  assert.equal(second.tracks.length, 1);
  assert.equal(second.tracks[0].id, "1");
  assert.equal(second.more, false);

  assert.deepEqual(plain(r.plugin.liked({ offset: 100 })), { tracks: [], more: false });
  assert.deepEqual(plain(r.plugin.liked({ offset: -1 })).tracks.map((track) => track.id), first.tracks.map((track) => track.id));
  assert.deepEqual(plain(r.plugin.liked({ offset: "abc" })).tracks.map((track) => track.id), first.tracks.map((track) => track.id));

  // 恰好 50 首：more=false。
  const exact = await runtime({
    storage: { [STORAGE_KEY]: { next: 1, items: [{
      id: LIKED_ID,
      name: "",
      createdAt: 0,
      updatedAt: 0,
      tracks: Array.from({ length: 50 }, (_, index) => snapshot(index + 1)),
    }] } },
  });
  assert.equal(plain(exact.plugin.liked({})).more, false);
});

test("unlike：like(on=false) 移除并更新 isLiked；不存在的歌幂等", async () => {
  const r = await runtime();
  stubSongDetail(r, { 42: song(42), 43: song(43) });
  await r.plugin.like({ id: 42, on: true });
  r.clock.advance(1000);
  await r.plugin.like({ id: 43, on: true });

  const before = stored(r).items[0].updatedAt;
  r.clock.advance(1000);
  assert.deepEqual(plain(await r.plugin.like({ id: 42, on: false })), {});
  assert.deepEqual(plain((await r.plugin.playlist({ id: LIKED_ID })).tracks.map((track) => track.id)), ["43"]);
  assert.deepEqual(plain(r.plugin.isLiked({ ids: [42, 43] })), { 42: false, 43: true });
  assert.equal(stored(r).items[0].updatedAt, before + 1000);

  // 取消不存在的喜欢：不报错、不写盘。
  const updatedAt = stored(r).items[0].updatedAt;
  r.clock.advance(1000);
  assert.deepEqual(plain(await r.plugin.like({ id: 999, on: false })), {});
  assert.equal(stored(r).items[0].updatedAt, updatedAt);
  assert.deepEqual(plain(r.plugin.liked({})).tracks.map((track) => track.id), ["43"]);
});

test("addToPlaylist / removeFromPlaylist 对 local-liked 与 like 行为一致", async () => {
  const r = await runtime();
  stubSongDetail(r, { 42: song(42), 43: song(43), 44: song(44) });

  // 先 like 一首作为初始数据。
  await r.plugin.like({ id: 42, on: true });

  // addToPlaylist 到固定歌单：最新在前。
  let summary = await r.plugin.addToPlaylist({ id: LIKED_ID, trackIds: [43] });
  assert.equal(summary.id, LIKED_ID);
  assert.equal(summary.fixed, true);
  assert.equal(summary.trackCount, 2);
  await r.plugin.like({ id: 44, on: true });
  assert.deepEqual(plain((await r.plugin.playlist({ id: LIKED_ID })).tracks.map((track) => track.id)), ["44", "43", "42"]);
  assert.deepEqual(plain(r.plugin.isLiked({ ids: [42, 43, 44] })), { 42: true, 43: true, 44: true });

  // 重复 add 已有曲目：不发 eapi、不重复。
  const count = r.requests.length;
  summary = await r.plugin.addToPlaylist({ id: LIKED_ID, trackIds: [42, 44] });
  assert.equal(summary.trackCount, 3);
  assert.equal(r.requests.length, count);

  // removeFromPlaylist 等价取消喜欢。
  summary = r.plugin.removeFromPlaylist({ id: LIKED_ID, trackIds: ["43"] });
  assert.equal(summary.trackCount, 2);
  assert.deepEqual(plain(r.plugin.isLiked({ ids: [43] })), { 43: false });
  assert.deepEqual(plain((await r.plugin.playlist({ id: LIKED_ID })).tracks.map((track) => track.id)), ["44", "42"]);

  // 空移除 no-op。
  const likedItem = stored(r).items.find((item) => item.id === LIKED_ID);
  const updatedAt = likedItem.updatedAt;
  r.clock.advance(1000);
  summary = r.plugin.removeFromPlaylist({ id: LIKED_ID, trackIds: [] });
  assert.equal(summary.trackCount, 2);
  assert.equal(stored(r).items.find((item) => item.id === LIKED_ID).updatedAt, updatedAt);

  // like(on=false) 与 removeFromPlaylist 结果一致。
  await r.plugin.like({ id: 42, on: false });
  r.plugin.removeFromPlaylist({ id: LIKED_ID, trackIds: ["44"] });
  assert.deepEqual(plain(r.plugin.liked({})), { tracks: [], more: false });
});

test("rename/delete local-liked 抛 unsupported；普通歌单不受影响", async () => {
  const r = await runtime();
  r.plugin.createPlaylist({ name: "普通歌单" });

  await rejects(
    Promise.resolve().then(() => r.plugin.renamePlaylist({ id: LIKED_ID, name: "新名字" })),
    "unsupported",
    "默认喜欢歌单不能改名或删除",
  );
  await rejects(
    Promise.resolve().then(() => r.plugin.deletePlaylist({ id: LIKED_ID })),
    "unsupported",
    "默认喜欢歌单不能改名或删除",
  );
  // 空名称先触发通用校验，不影响“固定歌单仍存在”。
  await rejects(
    Promise.resolve().then(() => r.plugin.renamePlaylist({ id: LIKED_ID, name: "  " })),
    "failed",
    "歌单名称不能为空",
  );

  assert.deepEqual(plain(r.plugin.playlists()).map((item) => item.id), [LIKED_ID, "local-1"]);
  assert.equal(plain(r.plugin.playlists())[0].name, "我喜欢的音乐");

  // 普通歌单改名/删除一切照旧。
  assert.equal(plain(r.plugin.renamePlaylist({ id: "local-1", name: "改过的歌单" })).name, "改过的歌单");
  assert.deepEqual(plain(r.plugin.deletePlaylist({ id: "local-1" })), {});
  assert.deepEqual(plain(r.plugin.playlists()).map((item) => item.id), [LIKED_ID]);
});

test("损坏 storage：伪造 fixed:true 的普通歌单被规范化，幽灵编号被丢弃", async () => {
  const r = await runtime({
    storage: {
      [STORAGE_KEY]: {
        next: 5,
        items: [
          { id: "local-1", name: "被篡改", fixed: true, createdAt: 2, updatedAt: 2, tracks: [] },
          { id: LIKED_ID, name: "伪造名字", fixed: false, createdAt: 1, updatedAt: 1, tracks: [snapshot(42)] },
          { id: "local-abc", name: "幽灵", fixed: true, createdAt: 3, updatedAt: 3, tracks: [] },
        ],
      },
    },
  });

  const list = plain(r.plugin.playlists());
  assert.deepEqual(list.map((item) => item.id), [LIKED_ID, "local-1"]);
  assert.deepEqual(list.map((item) => item.fixed), [true, false]);
  assert.equal(list[0].name, "我喜欢的音乐");
  assert.equal(list[0].trackCount, 1);
  assert.equal(list[1].name, "被篡改");
  assert.equal(list[1].fixed, false, "伪造的 fixed 必须被规范化，否则普通歌单删不掉");

  // 普通歌单可以正常改名/删除，伪造 fixed 不会阻止操作。
  assert.equal(plain(r.plugin.renamePlaylist({ id: "local-1", name: "正常了" })).name, "正常了");
  assert.deepEqual(plain(r.plugin.deletePlaylist({ id: "local-1" })), {});
  assert.deepEqual(plain(r.plugin.playlists()).map((item) => item.id), [LIKED_ID]);
});


test("全新安装即可直接对 local-liked 增删改：不再报歌单不存在", async () => {
  const r = await runtime();
  stubSongDetail(r, { 42: song(42) });

  // 未 like 过任何歌，直接 add：自动创建喜欢歌单并请求一次 eapi 详情。
  const summary = await r.plugin.addToPlaylist({ id: LIKED_ID, trackIds: [42] });
  assert.equal(summary.id, LIKED_ID);
  assert.equal(summary.fixed, true);
  assert.equal(summary.trackCount, 1);
  assert.equal(r.requests.filter((request) => request.url.endsWith("/eapi/v3/song/detail")).length, 1);

  // liked()/isLiked() 立即可见，storage 中喜欢歌单已落盘。
  assert.deepEqual(plain(r.plugin.liked({})).tracks.map((track) => track.id), ["42"]);
  assert.deepEqual(plain(r.plugin.isLiked({ ids: [42, 43] })), { 42: true, 43: false });
  assert.equal(stored(r).items.find((item) => item.id === LIKED_ID).fixed, true);
  assert.equal(plain(r.plugin.playlists())[0].trackCount, 1);

  // remove 同样可在 like 之前使用（直接移除刚 add 的歌）。
  const removed = r.plugin.removeFromPlaylist({ id: LIKED_ID, trackIds: [42] });
  assert.equal(removed.id, LIKED_ID);
  assert.equal(removed.trackCount, 0);
  assert.deepEqual(plain(r.plugin.liked({})), { tracks: [], more: false });

  // 另一个全新 runtime：remove 空曲目也是 no-op，不抛 unavailable、不写盘。
  const fresh = await runtime();
  const noop = fresh.plugin.removeFromPlaylist({ id: LIKED_ID, trackIds: [99] });
  assert.equal(noop.id, LIKED_ID);
  assert.equal(noop.fixed, true);
  assert.equal(noop.trackCount, 0);
  assert.equal(fresh.store.has("localPlaylists"), false);
});

test("全新安装对 local-liked 调 movePlaylistTrack 不报错，空曲目为 no-op", async () => {
  const r = await runtime();
  for (const [from, to] of [[0, 0], [0, 3], [-1, 2], ["abc", 1]]) {
    const summary = r.plugin.movePlaylistTrack({ id: LIKED_ID, from, to });
    assert.equal(summary.id, LIKED_ID);
    assert.equal(summary.fixed, true);
    assert.equal(summary.trackCount, 0);
  }
  assert.equal(r.requests.length, 0);
  assert.equal(r.store.has("localPlaylists"), false);

  // 未 like 过也可以先 add 再 move。
  stubSongDetail(r, { 42: song(42), 43: song(43) });
  await r.plugin.addToPlaylist({ id: LIKED_ID, trackIds: [42, 43] });
  const moved = r.plugin.movePlaylistTrack({ id: LIKED_ID, from: 0, to: 1 });
  assert.equal(moved.trackCount, 2);
  assert.deepEqual(plain(r.plugin.liked({})).tracks.map((track) => track.id), ["43", "42"]);
});
