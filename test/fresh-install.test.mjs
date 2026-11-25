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
