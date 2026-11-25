// 回归：全新安装直接操作 local-liked；删除已收藏的网易云歌单等价取消收藏。
import assert from "node:assert/strict";
import test from "node:test";
import { json, runtime } from "./runtime.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const STORAGE_KEY = "localPlaylists";
const SAVED_KEY = "savedPlaylists";

const song = (id) => ({
  id,
  name: `歌曲${id}`,
  dt: 200000,
  ar: [{ id: "7", name: "歌手" }],
  al: { id: "8", name: "专辑", picUrl: "http://p1.music.126.net/cover.jpg" },
});

test("全新安装直接对 local-liked 加歌 / 移歌 / 排序：不再报歌单不存在", async () => {
  const r = await runtime();
  r.route("/eapi/v3/song/detail", (request) => {
    const ids = JSON.parse(request.payload.c).map((item) => String(item.id));
    return json({ code: 200, songs: ids.map((id) => song(id)) });
  });

  // 还没点过任何红心，storage 里没有 local-liked，但它是内置歌单。
  const added = await r.plugin.addToPlaylist({ id: "local-liked", trackIds: ["42"] });
  assert.equal(added.id, "local-liked");
  assert.equal(added.fixed, true);
  assert.equal(added.trackCount, 1);
  assert.equal(plain(await r.plugin.isLiked({ ids: ["42"] }))["42"], true);

  const removed = r.plugin.removeFromPlaylist({ id: "local-liked", trackIds: ["42"] });
  assert.equal(removed.trackCount, 0);
  assert.equal(plain(await r.plugin.isLiked({ ids: ["42"] }))["42"], false);

  const moved = r.plugin.movePlaylistTrack({ id: "local-liked", from: 0, to: 1 });
  assert.equal(moved.id, "local-liked");
  assert.equal(moved.fixed, true);
  assert.ok(Array.isArray(plain(r.store.get(STORAGE_KEY)).items));
});

test("删除已收藏的网易云歌单 = 取消收藏；未收藏的数字 id 幂等", async () => {
  const r = await runtime();
  r.route("/eapi/v6/playlist/detail", () => json({
    code: 200,
    playlist: {
      id: 3778678,
      name: "热歌榜",
      coverImgUrl: "http://p3.music.126.net/hot.jpg",
      trackCount: 200,
      creator: { nickname: "网易云音乐" },
    },
  }));

  await r.plugin.savePlaylist({ id: "3778678", on: true });
  const saved = plain(r.plugin.playlists()).find((item) => item.id === "3778678");
  assert.equal(saved.saved, true);
  assert.equal(saved.mine, false);

  r.plugin.deletePlaylist({ id: "3778678" });
  assert.equal(plain(r.plugin.playlists()).some((item) => item.id === "3778678"), false);
  assert.deepEqual(plain(r.store.get(SAVED_KEY)), { items: [] });

  // 未收藏的数字 id 再删一次也不报错，且不会误删本地歌单。
  r.plugin.deletePlaylist({ id: "999" });
  assert.equal(plain(r.plugin.playlists())[0].id, "local-liked");
});

test("显式本地歌单参数不会回退到最近打开的歌单上下文", async () => {
  const r = await runtime();
  r.route("/eapi/v6/playlist/detail", () => json({
    code: 200,
    playlist: {
      id: 3778678,
      name: "热歌榜",
      coverImgUrl: "http://p3.music.126.net/hot.jpg",
      trackCount: 1,
      creator: { nickname: "网易云音乐" },
      trackIds: [{ id: 42 }],
      tracks: [{ id: 42, name: "晴天", dt: 269000, ar: [{ id: "6452", name: "周杰伦" }], al: { id: "1", name: "叶惠美" } }],
    },
  }));

  // 先打开网易云歌单，让上下文里包含曲目 42。
  const detail = await r.plugin.playlist({ id: 3778678 });
  assert.equal(detail.tracks.length, 1);

  const track = { id: "42", name: "晴天", artists: [{ id: "6452", name: "周杰伦" }], duration: 269000 };
  const titles = (playlist) => plain(r.plugin.trackMenu({ track, playlist })).map((item) => item.title);

  // playlist 为空：按上下文显示收藏入口。
  assert.ok(titles("").some((title) => title.includes("收藏歌单")));
  // 显式本地歌单：不可收藏，即使曲目在最近打开的歌单里也不能显示。
  assert.ok(!titles("local-liked").some((title) => title.includes("收藏歌单")));
  assert.ok(!titles("local-1").some((title) => title.includes("收藏歌单")));
  assert.ok(!titles("unknown").some((title) => title.includes("收藏歌单")));
});

test("playlist() 返回宿主菜单需要的 saved 收藏状态", async () => {
  const r = await runtime();
  r.route("/eapi/v6/playlist/detail", () => json({
    code: 200,
    playlist: {
      id: 3778678,
      name: "热歌榜",
      coverImgUrl: "http://p3.music.126.net/hot.jpg",
      trackCount: 0,
      creator: { nickname: "网易云音乐" },
      trackIds: [],
      tracks: [],
    },
  }));

  assert.equal(plain(await r.plugin.playlist({ id: 3778678 })).saved, false);
  await r.plugin.savePlaylist({ id: "3778678", on: true });
  assert.equal(plain(await r.plugin.playlist({ id: 3778678 })).saved, true);
  r.plugin.deletePlaylist({ id: "3778678" });
  assert.equal(plain(await r.plugin.playlist({ id: 3778678 })).saved, false);
});

test("trackPlaylists：返回已经包含该曲目的歌单，供宿主过滤添加菜单", async () => {
  const r = await runtime();
  r.route("/eapi/v3/song/detail", (request) => {
    const ids = JSON.parse(request.payload.c).map((item) => String(item.id));
    return json({ code: 200, songs: ids.map((id) => song(id)) });
  });
  const first = plain(r.plugin.createPlaylist({ name: "歌单一" }));
  const second = plain(r.plugin.createPlaylist({ name: "歌单二" }));
  await r.plugin.addToPlaylist({ id: first.id, trackIds: ["42"] });
  await r.plugin.addToPlaylist({ id: second.id, trackIds: ["43"] });

  assert.deepEqual(plain(r.plugin.trackPlaylists({ trackId: "42" })), [first.id]);
  assert.deepEqual(plain(r.plugin.trackPlaylists({ trackId: "43" })), [second.id]);
  assert.deepEqual(plain(r.plugin.trackPlaylists({ trackId: "99" })), []);
  assert.deepEqual(plain(r.plugin.trackPlaylists({})), []);
  assert.deepEqual(plain(r.plugin.trackPlaylists({ trackId: "abc" })), []);

  // 喜欢歌单也算：宿主会再把 fixed 歌单过滤掉，但数据本身要正确。
  await r.plugin.like({ id: "42", on: true });
  assert.deepEqual(plain(r.plugin.trackPlaylists({ trackId: "42" })).sort(), [first.id, "local-liked"].sort());
});
