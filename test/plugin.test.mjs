// 插件清单、宿主导出、权限与入口集成（菜单 / 自检 / stream）。
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { json, root, runtime, status, text } from "./runtime.mjs";

const manifest = JSON.parse(readFileSync(path.join(root, "plugin.json"), "utf8"));
const plain = (value) => JSON.parse(JSON.stringify(value));

const TRACK = {
  id: "42",
  name: "晴天",
  artists: [{ id: "6452", name: "周杰伦" }],
  duration: 269000,
  album: { id: "1", name: "叶惠美" },
};
const track = (id = TRACK.id) => ({ ...TRACK, id });
const GD_URL = "https://m701.music.126.net/gd.mp3";
const GD_SEARCH_URL = "https://m801.music.126.net/search.mp3";

function versionAtLeast(value, baseline) {
  const left = String(value).split(".").map(Number);
  const right = String(baseline).split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] || 0;
    const b = right[index] || 0;
    if (a !== b) return a > b;
  }
  return true;
}

function stubGdstudio(r) {
  r.route("music-api.gdstudio.xyz", (request) => {
    const params = new URL(request.url).searchParams;
    if (params.get("types") === "search") {
      return json([{ id: "9001", name: "海阔天空", artist: ["Beyond"], album: "" }]);
    }
    const br = Number(params.get("br")) || 320;
    return json({ url: br >= 700 ? "https://m701.music.126.net/gd.flac" : GD_URL, br, size: 1024 });
  });
}

// 四个音源的自检样例全部命中：GDStudio 按 ID、两条酷我、GDStudio 搜索。
function stubSelfTestSuccess(r) {
  r.route("music-api.gdstudio.xyz", (request) => {
    const params = new URL(request.url).searchParams;
    if (params.get("types") === "search") {
      return json([{ id: "9001", name: "海阔天空", artist: ["Beyond"], album: "" }]);
    }
    return json({ url: params.get("id") === "9001" ? GD_SEARCH_URL : GD_URL, br: 320, size: 1024 });
  });
  r.route("search.kuwo.cn", () => json({
    content: [{}, {
      musicpage: {
        abslist: [
          { SONGNAME: "屋顶", ARTIST: "周杰伦 温岚 吴宗宪", DURATION: 322, MUSICRID: "MUSIC_1" },
          { SONGNAME: "可惜没如果", ARTIST: "林俊杰", DURATION: 298, MUSICRID: "MUSIC_2" },
        ],
      },
    }],
  }));
  r.route("bd-api.kuwo.cn/api/service/advert/watch", () => json({ code: 200 }));
  r.route("bd-api.kuwo.cn/api/play/music/v2/audioUrl", (request) => {
    const musicId = new URL(request.url).searchParams.get("musicId");
    return json({
      code: 200,
      data: {
        audioUrl: `https://bd-bj.kuwo.cn/bodian-${musicId}.mp3`,
        audioHttpsUrl: `https://bd-bj.kuwo.cn/bodian-${musicId}.mp3`,
        bitrate: 320,
        size: "1MB",
      },
    });
  });
  r.route("mobi.kuwo.cn", () => text("format=mp3\r\nbitrate=320\r\nurl=https://bd-bj.kuwo.cn/mobi.mp3\r\n"));
}

test("plugin.json：id、入口文件、图标、版本与播放能力合法", () => {
  assert.equal(manifest.id, "switch");
  assert.match(manifest.id, /^[a-z][a-z0-9-]*$/);
  assert.equal(manifest.name, "音源网关");
  assert.ok(manifest.description.includes("免登录"));
  assert.equal(manifest.author, "ypm-plugin-switch");
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);

  assert.equal(manifest.main, "index.js");
  assert.ok(existsSync(path.join(root, manifest.main)), "main 必须存在");
  assert.equal(manifest.icon, "icon.png");
  assert.ok(existsSync(path.join(root, manifest.icon)), "icon 必须存在");
  assert.ok(statSync(path.join(root, manifest.icon)).size > 0, "icon 不能为空文件");

  assert.equal(manifest.playback, "stream");
  assert.equal(manifest.minAppVersion, "3.0.0");
  assert.ok(versionAtLeast(manifest.minAppVersion, "3.0.0"));
});

test("plugin.json：导航不出现登录页，设置项与默认值完整", () => {
  assert.ok(Array.isArray(manifest.navigation) && manifest.navigation.length >= 2);
  assert.ok(manifest.navigation.some((entry) => entry.builtin === "home"));
  const sources = manifest.navigation.find((entry) => entry.page === "sources");
  assert.equal(sources.title, "音源网关");
  // 登录相关内置页面（我的音乐、收藏专辑等）不能出现。
  for (const entry of manifest.navigation) {
    if (entry.builtin) assert.equal(entry.builtin, "home", `不应暴露 ${entry.builtin} 登录页`);
  }

  assert.deepEqual(manifest.settings.map((item) => item.key), [
    "quality",
    "prefer",
    "skipVerify",
    "disableGdstudio",
    "disableKuwo",
  ]);
  const byKey = Object.fromEntries(manifest.settings.map((item) => [item.key, item]));
  assert.equal(byKey.quality.type, "select");
  assert.equal(byKey.quality.default, "");
  assert.deepEqual(byKey.quality.options.map((option) => option.value), ["", "standard", "high", "lossless"]);
  assert.deepEqual(byKey.prefer.options.map((option) => option.value), ["auto", "gdstudio", "kuwo"]);
  assert.equal(byKey.prefer.default, "auto");
  for (const key of ["skipVerify", "disableGdstudio", "disableKuwo"]) {
    assert.equal(byKey[key].type, "boolean");
    // 布尔项「未设置」与「关闭」都是空串，因此不写 default。
    assert.equal(byKey[key].default, undefined, `${key} 不应有 default`);
    assert.ok(byKey[key].help.length > 0, `${key} 应有说明`);
  }
});

test("plugin.json：网络权限覆盖全部曲库与音源域名，且不申请额外权限", () => {
  assert.deepEqual(Object.keys(manifest.permissions), ["network"]);
  assert.deepEqual([...manifest.permissions.network].sort(), [
    "*.kuwo.cn",
    "*.music.126.net",
    "bd-api.kuwo.cn",
    "interfacepc.music.163.com",
    "mobi.kuwo.cn",
    "music-api.gdstudio.xyz",
    "search.kuwo.cn",
  ].sort());
  assert.equal(manifest.permissions.process, undefined, "本插件不需要运行本机程序");
});

test("index.js：宿主函数齐全，且不导出任何登录能力", async () => {
  const r = await runtime();
  const api = r.plugin;

  for (const name of [
    "search", "suggest", "hotSearches", "home", "browse",
    "album", "artist", "playlist", "lyrics", "stream",
    "trackMenu", "menuAction", "testConnection",
  ]) {
    assert.equal(typeof api[name], "function", `缺少导出 ${name}`);
  }
  for (const name of [
    "account", "signIn", "signOut", "liked", "playlists", "recent",
    "isLiked", "like", "savedAlbums", "saveAlbum", "login", "logout", "user", "cloud",
  ]) {
    assert.equal(name in api, false, `不应导出登录能力 ${name}`);
  }

  // 加载模块本身不能发请求或写凭据。
  assert.equal(r.requests.length, 0);
  assert.equal(r.store.size, 0);
});

test("trackMenu / menuAction：复制直链与检测音源", async () => {
  const r = await runtime();
  const menu = [
    { id: "switch.copy", title: "复制音源直链" },
    { id: "switch.test", title: "检测音源可用性" },
  ];
  assert.deepEqual(plain(r.plugin.trackMenu()), menu, "宿主只问菜单定义时照常返回");
  assert.deepEqual(plain(r.plugin.trackMenu({ track: track() })), menu);
  assert.deepEqual(plain(r.plugin.trackMenu({ track: { id: "local-1" } })), [], "非网易云编号不加菜单");
  assert.deepEqual(
    plain(r.plugin.trackMenu({ track: { id: "42", source: "qqmusic" } })),
    [],
    "其他音源的曲目不加菜单",
  );
  assert.deepEqual(plain(r.plugin.trackMenu({ track: { id: "42", source: "switch" } })), menu);

  await assert.rejects(
    r.plugin.menuAction({ id: "unknown", track: track() }),
    (error) => error.code === "unsupported" && error.message === "未知菜单操作",
  );
  assert.equal(r.requests.length, 0);

  stubGdstudio(r);
  const copy = await r.plugin.menuAction({ id: "switch.copy", track: track() });
  assert.deepEqual(plain(copy), {
    copy: GD_URL,
    toast: "已获取音源直链（高音质）",
  });
  // 菜单直接使用宿主传入的曲目信息，不再请求曲库详情。
  assert.ok(!r.requests.some((request) => request.url.includes("interfacepc.music.163.com")));
  const gdRequest = r.requests.find((request) => request.url.includes("types=url"));
  assert.equal(new URL(gdRequest.url).searchParams.get("id"), "42");
  assert.equal(new URL(gdRequest.url).searchParams.get("br"), "320");

  const check = await r.plugin.menuAction({ id: "switch.test", track: track("43") });
  assert.deepEqual(plain(check), { toast: "音源可用：高音质 · 320kbps" });
});

test("testConnection 与 sources 页：逐个音源自检并展示回退顺序", async () => {
  const r = await runtime();
  stubSelfTestSuccess(r);

  assert.equal(await r.plugin.testConnection(), "4 个音源可用");

  const page = await r.plugin.browse({ page: "sources" });
  assert.equal(page.title, "音源网关");
  assert.equal(page.subtitle, "每个音源用一首样例曲目解析并校验直链，重新进入本页会再次检测。");
  assert.equal(page.sections.length, 2);
  assert.equal(page.sections[0].title, "音源自检");
  assert.deepEqual(plain(page.sections[0].links.map((link) => link.title)), [
    "GDStudio",
    "酷我",
    "酷我移动",
    "GDStudio 搜索",
  ]);
  for (const link of page.sections[0].links) {
    assert.match(link.subtitle, /^可用 · \d+ms · /);
    assert.equal(link.page, "sources");
  }
  assert.equal(page.sections[1].title, "回退顺序");
  assert.deepEqual(plain(page.sections[1].links.map((link) => link.title)), [
    "1. GDStudio",
    "2. 酷我",
    "3. 酷我移动",
    "4. GDStudio 搜索",
  ]);
  assert.deepEqual(plain(page.sections[1].links.map((link) => link.subtitle)), [
    "GDStudio 音源",
    "酷我音源",
    "酷我音源",
    "GDStudio 音源",
  ]);

  // 关键词音源没搜到样例曲目不算故障（接口可达），只有取址失败的音源计为失败。
  const partial = await runtime();
  partial.route("music-api.gdstudio.xyz", (request) => {
    const params = new URL(request.url).searchParams;
    if (params.get("types") === "search") return json([]);
    return json({ url: GD_URL, br: 320, size: 1024 });
  });
  partial.route("search.kuwo.cn", () => json({ content: [{}, { musicpage: { abslist: [] } }] }));
  partial.state.probe.head = (request) => (request.url === GD_URL
    ? status(404)
    : status(200, { headers: { "content-type": "audio/mpeg", "content-length": "2048" } }));
  await assert.rejects(
    partial.plugin.testConnection(),
    (error) => error.message === "1 个音源不可用",
  );

  // 两个音源族都停用：明确提示没有启用的音源。
  const disabled = await runtime({ settings: { disableGdstudio: "true", disableKuwo: "true" } });
  await assert.rejects(
    disabled.plugin.testConnection(),
    (error) => error.code === "setup" && error.message === "没有启用的音源",
  );
});

test("stream()：先补全曲目元数据再做网关解析，元数据缓存避免重复请求", async () => {
  const r = await runtime();
  r.route("/eapi/v3/song/detail", {
    code: 200,
    songs: [{
      id: 42,
      name: "晴天",
      dt: 269000,
      ar: [{ id: 6452, name: "周杰伦" }],
      al: { id: 18905, name: "叶惠美" },
    }],
  });
  stubGdstudio(r);

  const first = await r.plugin.stream({ id: "42", quality: "high" });
  assert.deepEqual(plain(first), {
    url: GD_URL,
    type: "mp3",
    quality: "high",
    bitRate: 320,
    size: 1024,
  });
  const detail = r.requests.find((request) => request.url.endsWith("/eapi/v3/song/detail"));
  assert.deepEqual(JSON.parse(detail.payload.c), [{ id: "42" }]);
  const gd = r.requests.find((request) => request.url.includes("music-api.gdstudio.xyz"));
  assert.equal(new URL(gd.url).searchParams.get("id"), "42");

  // 换音质绕过直链缓存，但曲目元数据直接命中缓存，不再请求详情。
  const second = await r.plugin.stream({ id: "42", quality: "standard" });
  assert.equal(second.quality, "standard");
  assert.equal(r.requests.filter((request) => request.url.endsWith("/eapi/v3/song/detail")).length, 1);
});

test("stream()：详情失败不影响按 ID 取址；非法编号直接拒绝", async () => {
  const r = await runtime();
  r.route("/eapi/v3/song/detail", status(500));
  stubGdstudio(r);

  const stream = await r.plugin.stream({ id: "42", quality: "high" });
  assert.equal(stream.url, GD_URL);
  assert.ok(r.requests.some((request) => request.url.endsWith("/eapi/v3/song/detail")));

  const before = r.requests.length;
  await assert.rejects(
    r.plugin.stream({ id: "abc", quality: "high" }),
    (error) => error.code === "unavailable" && error.message === "无效的网易云资源编号",
  );
  assert.equal(r.requests.length, before);
});
