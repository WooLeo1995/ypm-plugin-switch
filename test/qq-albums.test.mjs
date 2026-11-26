// QQ 音乐曲库补全：歌手页专辑列表、专辑详情、曲目播放 / 歌词 / 喜欢 / 歌单。
import assert from "node:assert/strict";
import test from "node:test";
import { json, runtime, status, text } from "./runtime.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));

const QQ_ALBUM = {
  albumMid: "000z1DIM3sRMSp",
  albumName: "脆弱一分钟",
  albumType: "Single",
  publishDate: "2018-07-24",
  singerName: "林宥嘉",
  totalNum: 1,
};
const QQ_DUPLICATE = {
  albumMid: "000gTwDE3gj4DO",
  albumName: "美妙生活",
  albumType: "Album",
  publishDate: "2011-05-06",
  singerName: "林宥嘉",
  totalNum: 0,
};
const QQ_SONG = {
  mid: "001tIvDL3161CU",
  name: "脆弱一分钟",
  interval: 192,
  singer: [{ name: "林宥嘉" }],
  album: { mid: "000z1DIM3sRMSp", name: "脆弱一分钟", time_public: "2018-07-24" },
};
const BODIAN_URL = "https://bd-bj.kuwo.cn/qq-fragile.mp3";

function stubNeteaseArtist(r) {
  r.route("/eapi/v1/artist/3685", () => json({
    code: 200,
    artist: { id: 3685, name: "林宥嘉", picUrl: "http://p1.music.126.net/artist.jpg" },
    hotSongs: [],
  }));
  r.route("/eapi/artist/albums/3685", () => json({
    code: 200,
    hotAlbums: [{
      id: 10757,
      name: "美妙生活",
      picUrl: "http://p2.music.126.net/album.jpg",
      artists: [{ id: 3685, name: "林宥嘉" }],
      size: 11,
      publishTime: 1304524800000,
      type: "专辑",
    }],
  }));
}

function stubQQ(r, { albumList = [QQ_ALBUM, QQ_DUPLICATE] } = {}) {
  r.route("c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg", () => json({
    code: 0,
    data: { singer: { itemlist: [{ mid: "001f0VyZ1hmWZ1", name: "林宥嘉" }] } },
  }));
  r.route("u.y.qq.com/cgi-bin/musicu.fcg", (request) => {
    const body = JSON.parse(String(request.body || "{}"));
    if (body.req?.module === "music.musichallAlbum.AlbumListServer") {
      return json({ req: { code: 0, data: { albumList, total: albumList.length } } });
    }
    if (body.info || body.songs) {
      return json({
        info: {
          code: 0,
          data: { basicInfo: { albumName: "脆弱一分钟", publishDate: "2018-07-24", albumType: "Single" } },
        },
        songs: { code: 0, data: { songList: [{ songInfo: QQ_SONG }], totalNum: 1 } },
      });
    }
    if (body.d?.module === "music.pf_song_detail_svr") {
      return json({ d: { code: 0, data: { track_info: QQ_SONG } } });
    }
    throw new Error(`unexpected musicu request: ${String(request.body).slice(0, 120)}`);
  });
}

function stubKuwo(r) {
  r.route("music-api.gdstudio.xyz", (request) => {
    const params = new URL(request.url).searchParams;
    return params.get("types") === "search" ? json([]) : json({ url: "" });
  });
  r.route("search.kuwo.cn", (request) => {
    const params = new URL(request.url).searchParams;
    if (params.get("client") === "kt") {
      return json({
        PN: "0", RN: "50", SHOW: "1", TOTAL: "1",
        abslist: [{ SONGNAME: "脆弱一分钟", ARTIST: "林宥嘉", DURATION: "192", MUSICRID: "MUSIC_52844341" }],
      });
    }
    return json({ content: [{}, { musicpage: { abslist: [] } }] });
  });
  r.route("bd-api.kuwo.cn/api/service/advert/watch", () => json({ code: 200 }));
  r.route("bd-api.kuwo.cn/api/play/music/v2/audioUrl", () => json({
    code: 200,
    data: { audioUrl: BODIAN_URL, audioHttpsUrl: BODIAN_URL, bitrate: 320, size: "1MB" },
  }));
}

const QQ_TRACK = {
  id: "qq:001tIvDL3161CU",
  source: "switch",
  name: "脆弱一分钟",
  artists: [{ id: "", name: "林宥嘉" }],
  duration: 192000,
  album: { id: "qq-album:000z1DIM3sRMSp", name: "脆弱一分钟" },
};

test("artist：把 QQ 专辑补进歌手页，同名网易云专辑不重复", async () => {
  const r = await runtime();
  stubNeteaseArtist(r);
  stubQQ(r);

  const detail = await r.plugin.artist({ id: "3685" });
  const albums = plain(detail.albums);

  assert.deepEqual(albums.map((album) => album.name), ["美妙生活", "脆弱一分钟"]);
  assert.deepEqual(albums.map((album) => album.id), ["10757", "qq-album:000z1DIM3sRMSp"]);
  const fragile = albums.find((album) => album.id.startsWith("qq-album:"));
  assert.deepEqual(fragile, {
    id: "qq-album:000z1DIM3sRMSp",
    name: "脆弱一分钟",
    imageUrl: "https://y.gtimg.cn/music/photo_new/T002R300x300M000000z1DIM3sRMSp.jpg",
    artists: [{ id: "", name: "林宥嘉" }],
    trackCount: 1,
    released: "2018-07-24",
    kind: "single",
  });
});

test("artist：QQ 接口失败时仍返回网易云专辑", async () => {
  const r = await runtime();
  stubNeteaseArtist(r);
  r.route("c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg", () => status(500));

  const detail = await r.plugin.artist({ id: "3685" });
  assert.deepEqual(plain(detail.albums.map((album) => album.id)), ["10757"]);
});

test("album：QQ 专辑详情映射为 qq:<mid> 曲目并写入缓存", async () => {
  const r = await runtime();
  stubQQ(r);

  const detail = await r.plugin.album({ id: "qq-album:000z1DIM3sRMSp" });
  const album = plain(detail.album);
  const tracks = plain(detail.tracks);

  assert.equal(album.name, "脆弱一分钟");
  assert.equal(album.kind, "single");
  assert.equal(album.released, "2018-07-24");
  assert.equal(album.imageUrl, "https://y.gtimg.cn/music/photo_new/T002R300x300M000000z1DIM3sRMSp.jpg");
  assert.equal(tracks.length, 1);
  assert.deepEqual(tracks[0], {
    id: "qq:001tIvDL3161CU",
    name: "脆弱一分钟",
    artists: [{ id: "", name: "林宥嘉" }],
    album: {
      id: "qq-album:000z1DIM3sRMSp",
      name: "脆弱一分钟",
      imageUrl: "https://y.gtimg.cn/music/photo_new/T002R300x300M000000z1DIM3sRMSp.jpg",
    },
    duration: 192000,
    url: "https://y.qq.com/n/ryqq/songDetail/001tIvDL3161CU",
  });

  const stored = plain(r.store.get("qqTracks"));
  assert.deepEqual(stored.items.map((item) => item.id), ["qq:001tIvDL3161CU"]);
});

test("album：QQ 专辑不可用时返回明确错误", async () => {
  const r = await runtime();
  r.route("u.y.qq.com/cgi-bin/musicu.fcg", () => json({}));

  const error = await r.plugin.album({ id: "qq-album:000z1DIM3sRMSp" }).catch((value) => value);
  assert.equal(error.code, "unavailable");
  assert.equal(error.message, r.host.t("专辑暂不可用"));
});

test("stream：qq:<mid> 用 QQ 元数据走酷我关键词取址，不请求 QQ 播放接口", async () => {
  const r = await runtime();
  stubQQ(r);
  stubKuwo(r);
  await r.plugin.album({ id: "qq-album:000z1DIM3sRMSp" });
  const before = r.requests.length;

  const stream = await r.plugin.stream({ id: "qq:001tIvDL3161CU", quality: "high" });

  assert.equal(stream.url, BODIAN_URL);
  assert.equal(stream.quality, "high");
  assert.equal(stream.bitRate, 320);
  const after = r.requests.slice(before);
  assert.ok(after.some((request) => new URL(request.url).host === "search.kuwo.cn"));
  assert.ok(!after.some((request) => new URL(request.url).host === "u.y.qq.com"), "缓存命中时不应再请求 QQ");
});

test("stream：没有元数据时先查 QQ 歌曲详情，再走酷我", async () => {
  const r = await runtime();
  stubQQ(r);
  stubKuwo(r);

  const stream = await r.plugin.stream({ id: "qq:001tIvDL3161CU", quality: "high" });
  assert.equal(stream.url, BODIAN_URL);
  assert.ok(r.requests.some((request) => request.url.includes("u.y.qq.com/cgi-bin/musicu.fcg")));
});

test("lyrics：qq:<mid> 走 QQ 匿名歌词接口", async () => {
  const r = await runtime();
  r.route("c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg", () => json({
    retcode: 0,
    lyric: "[00:00.00]脆弱一分钟",
    trans: "[00:00.00]translation",
  }));

  const lyrics = await r.plugin.lyrics({ id: "qq:001tIvDL3161CU" });
  assert.deepEqual(plain(lyrics), { lrc: "[00:00.00]脆弱一分钟", translation: "[00:00.00]translation" });
});

test("喜欢 / 本地歌单：qq:<mid> 使用缓存元数据", async () => {
  const r = await runtime();
  stubQQ(r);
  await r.plugin.album({ id: "qq-album:000z1DIM3sRMSp" });
  r.plugin.createPlaylist({ name: "本地" });

  const before = r.requests.length;
  await r.plugin.like({ id: "qq:001tIvDL3161CU", on: true });
  await r.plugin.addToPlaylist({ id: "local-1", trackIds: ["qq:001tIvDL3161CU"] });
  assert.equal(r.requests.length, before, "缓存中的 QQ 曲目不应再联网");

  assert.deepEqual(plain((await r.plugin.liked({ offset: 0 })).tracks.map((track) => track.id)), ["qq:001tIvDL3161CU"]);
  assert.deepEqual(plain(r.plugin.trackPlaylists({ trackId: "qq:001tIvDL3161CU" })).sort(), ["local-1", "local-liked"]);
  assert.deepEqual(plain((await r.plugin.playlist({ id: "local-1" })).tracks.map((track) => track.id)), ["qq:001tIvDL3161CU"]);
});

test("右键菜单：qq:<mid> 有复制 / 检测入口", async () => {
  const r = await runtime();
  const entries = plain(r.plugin.trackMenu({ track: QQ_TRACK }));
  assert.deepEqual(entries.map((entry) => entry.id), ["switch.copy", "switch.test"]);
});
