// 本地化：源码与 plugin.json 中的中文 UI 文案必须被 9 个语言文件完整覆盖。
// key 抽取规则（docs-i18n 的 locales 必须与此完全一致）：
//   1. 扫描 index.js、stream.js、i18n.js 与 catalog/、gateway/ 下全部 .js；
//   2. 只取双引号字符串字面量中包含中文（U+3400-U+9FFF）的值；
//   3. 排除页面 id（"playlists:全部:0"）与音源自检样例曲目元数据（不是 UI 文案）。
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { root, runtime } from "./runtime.mjs";

export const LOCALE_NAMES = ["de", "en", "es", "fr", "ja", "ko", "ru", "zh-CN", "zh-TW"];
const CJK = /[\u3400-\u9fff]/;
// 非 UI 文案：页面 id 会被宿主当作不透明参数回传；样例曲目是音乐元数据，保留原文。
const NON_UI = new Set([
  "playlists:全部:0",
  "海阔天空",
  "屋顶",
  "周杰伦 温岚 吴宗宪",
  "可惜没如果",
  "林俊杰",
]);

function walk(dir, files) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (name.endsWith(".js")) files.push(path.relative(root, full));
  }
}

function sourceFiles() {
  const files = ["index.js", "stream.js", "i18n.js"].filter((file) => existsSync(path.join(root, file)));
  for (const dir of ["catalog", "gateway"]) {
    const full = path.join(root, dir);
    if (existsSync(full)) walk(full, files);
  }
  return files;
}

export function expectedKeys() {
  const keys = new Set();
  for (const file of sourceFiles()) {
    const source = readFileSync(path.join(root, file), "utf8");
    for (const match of source.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
      const value = match[1];
      if (!CJK.test(value) || NON_UI.has(value)) continue;
      keys.add(value);
    }
  }
  const manifest = JSON.parse(readFileSync(path.join(root, "plugin.json"), "utf8"));
  keys.add(manifest.name);
  keys.add(manifest.description);
  for (const entry of manifest.navigation || []) if (entry.title) keys.add(entry.title);
  for (const item of manifest.settings || []) {
    keys.add(item.label);
    if (item.help) keys.add(item.help);
    for (const option of item.options || []) keys.add(option.label);
  }
  return [...keys].sort();
}

function readLocales() {
  const dir = path.join(root, "locales");
  if (!existsSync(dir)) return new Map();
  const result = new Map();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    result.set(name.slice(0, -5), JSON.parse(readFileSync(path.join(dir, name), "utf8")));
  }
  return result;
}

const slots = (value) => [...String(value).matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)]
  .map((match) => match[1]).sort();

const keys = expectedKeys();
const locales = readLocales();

test("源码与 plugin.json 的中文 UI 文案 key 集合稳定，样例元数据与页面 id 不计入", () => {
  assert.ok(keys.length > 60, `key 数量异常偏少：${keys.length}`);
  assert.equal(keys.length, new Set(keys).size);
  for (const excluded of NON_UI) assert.ok(!keys.includes(excluded), `不应把非 UI 文案当作 key：${excluded}`);
  for (const key of [
    "音源网关", "未知歌曲", "没有可用音源，请稍后重试", "GDStudio 音源", "音源",
    // catalog/playlists.js 的本地歌单 / 喜欢歌单文案也必须进入词表。
    "本地歌单", "歌单名称不能为空", "最多创建 {count} 个歌单", "单个歌单最多 {count} 首歌曲",
    "我喜欢的音乐", "默认喜欢歌单不能改名或删除",
    // 收藏网易云歌单的文案。
    "收藏歌单", "取消收藏歌单", "已收藏歌单", "已取消收藏", "最多收藏 {count} 个歌单",
    "收藏歌单：{name}", "取消收藏歌单：{name}",
  ]) {
    assert.ok(keys.includes(key), `缺少预期 key：${key}`);
  }
  assert.ok(keys.every((key) => key.length > 0 && CJK.test(key)));
});

test("locales 下恰好是 9 个语言文件且都是合法 JSON 对象", () => {
  assert.deepEqual([...locales.keys()].sort(), [...LOCALE_NAMES].sort());
  for (const [locale, dictionary] of locales) {
    assert.equal(typeof dictionary, "object", locale);
    assert.ok(dictionary && !Array.isArray(dictionary), locale);
  }
});

test("9 种语言与源码 key 集合完全一致，占位符一致，zh-CN 保留原文", () => {
  for (const locale of LOCALE_NAMES) {
    const dictionary = locales.get(locale);
    assert.ok(dictionary, `缺少 locales/${locale}.json`);
    const actual = Object.keys(dictionary).sort();
    const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(dictionary, key));
    const extra = actual.filter((key) => !keys.includes(key));
    assert.deepEqual(missing, [], `${locale} 缺少 ${missing.length} 个 key：${missing.slice(0, 5).join(" | ")}`);
    assert.deepEqual(extra, [], `${locale} 多出 ${extra.length} 个 key：${extra.slice(0, 5).join(" | ")}`);
    for (const key of keys) {
      const value = dictionary[key];
      assert.equal(typeof value, "string", `${locale}: ${key} 必须是字符串`);
      assert.ok(value.length > 0, `${locale}: ${key} 不能为空`);
      assert.deepEqual(slots(value), slots(key), `${locale}: ${key} 的占位符不一致`);
      if (locale === "zh-CN") assert.equal(value, key, `zh-CN 应保留原文：${key}`);
    }
  }
});

test("t() 只替换已知占位符，$& 等替换符不会二次展开", async () => {
  const r = await runtime({ language: "zh-CN" });
  const i18n = await r.i18n();

  assert.equal(
    i18n.t("已获取音源直链（{quality}）", { quality: "无损" }),
    "已获取音源直链（无损）",
  );
  assert.equal(
    i18n.t("网易云请求失败（{code}）：{message}", { code: 404, message: "服务端消息 {status}" }),
    "网易云请求失败（404）：服务端消息 {status}",
  );
  assert.equal(
    i18n.t("网易云请求失败（{code}）：{message}", { code: 1, message: "$& $1 {code}" }),
    "网易云请求失败（1）：$& $1 {code}",
  );
  assert.equal(
    i18n.t("音源可用：{quality} · {bitRate}kbps", { quality: "高音质" }),
    "音源可用：高音质 · {bitRate}kbps",
  );
  assert.equal(i18n.t("没有启用的音源", { unused: "x" }), "没有启用的音源");
});

test("setting() 把 null/undefined 归一为空串，flag() 只认字符串 true", async () => {
  const r = await runtime({ language: "zh-CN" });
  const i18n = await r.i18n();

  assert.equal(i18n.setting("quality"), "");
  r.state.settings.quality = "high";
  assert.equal(i18n.setting("quality"), "high");
  r.state.settings.quality = 0;
  assert.equal(i18n.setting("quality"), "0");
  r.state.settings.quality = null;
  assert.equal(i18n.setting("quality"), "");

  r.state.settings.skipVerify = "true";
  assert.equal(i18n.flag("skipVerify"), true);
  r.state.settings.skipVerify = "TRUE";
  assert.equal(i18n.flag("skipVerify"), false);
  r.state.settings.skipVerify = "";
  assert.equal(i18n.flag("skipVerify"), false);
  delete r.state.settings.skipVerify;
  assert.equal(i18n.flag("skipVerify"), false);
});

test("未知语言或缺失翻译时原样返回，切换语言立即生效", { skip: !locales.has("en") }, async () => {
  const r = await runtime({ language: "zh-CN" });
  assert.equal(r.host.t("未知歌曲"), "未知歌曲");

  r.state.language = "en";
  const dictionary = locales.get("en");
  assert.equal(r.host.t("未知歌曲"), dictionary["未知歌曲"]);
  assert.equal(r.host.t("不存在的 key"), "不存在的 key");

  const missing = await runtime({ language: "xx-YY" });
  assert.equal(missing.host.t("未知歌曲"), "未知歌曲");
});
