// 网关关键词匹配规则：宁可返回 null，也不能把伴奏 / DJ / 翻唱 / 同名不同歌手当成原曲。
import assert from "node:assert/strict";
import test from "node:test";
import { runtime } from "./runtime.mjs";

async function matcher() {
  // 只加载 match.js：这些是纯函数，不依赖宿主与网络。
  return runtime({ entry: "gateway/match.js" });
}

test("版本限定语必须逐字比较，未知限定语不能被忽略", async () => {
  const { plugin: m } = await matcher();

  assert.equal(m.versionKey("七里香"), "");
  assert.equal(m.versionKey("七里香（Live版）"), "live版");
  assert.equal(m.versionKey("七里香 (live 版)"), "live版");
  assert.equal(m.versionKey("七里香 [LIVE版]"), "live版");

  // 录音室版与 Live 版互斥，反向也不能通过。
  assert.equal(m.isMatch("七里香（Live版）", "周杰伦", "七里香", "周杰伦", 0, 0), false);
  assert.equal(m.isMatch("七里香", "周杰伦", "七里香（Live版）", "周杰伦", 0, 0), false);
  // 括号/大小写/空格写法不同但限定语一致，可以匹配。
  assert.equal(m.isMatch("七里香 (Live版)", "周杰伦", "七里香（live 版）", "周杰伦", 0, 0), true);
  // 横线版本限定与括号版本限定等价。
  assert.equal(m.isMatch("七里香 - Live", "周杰伦", "七里香（Live）", "周杰伦", 0, 0), true);

  // 未知限定语同样参与比较：原版不能匹配「宿命版」，「DJ 名龙版」不能匹配「DJ 哭包版」。
  assert.equal(m.isMatch("晴（宿命版）", "周杰伦", "晴", "周杰伦", 0, 0), false);
  assert.equal(m.isMatch("晴", "周杰伦", "晴（宿命版）", "周杰伦", 0, 0), false);
  assert.equal(m.isMatch("晴（DJ名龙版）", "DJ名龙", "晴（DJ哭包版）", "DJ哭包", 0, 0), false);

  // feat / remastered / 高音质这类不影响版本的标注被忽略。
  assert.equal(m.versionKey("晴天（feat. 五月天）"), "");
  assert.equal(m.versionKey("晴天 (Remastered)"), "");
  assert.equal(m.versionKey("晴天（高音质）"), "");
  assert.equal(m.isMatch("晴天 (Remastered)", "周杰伦", "晴天", "周杰伦", 0, 0), true);
});

test("酷我歌名后的「-《剧名》…」说明不影响匹配", async () => {
  const { plugin: m } = await matcher();
  assert.equal(m.normalizeName("脆弱一分钟-《爱情进化论》电视剧片头曲"), "脆弱一分钟");
  assert.equal(
    m.isMatch("脆弱一分钟-《爱情进化论》电视剧片头曲", "林宥嘉", "脆弱一分钟", "林宥嘉", 192992, 192000),
    true,
  );
  assert.equal(
    m.isMatch("说谎-《杜拉拉升职记》电视剧插曲|《针尖上的天使》电影主题曲", "林宥嘉", "说谎", "林宥嘉", 264000, 264000),
    true,
  );
});

test("封面、DJ、伴奏、纯音乐、翻唱等衍生版本一律拒绝", async () => {
  const { plugin: m } = await matcher();
  const want = ["起风了", "买辣椒也用券", 325000];

  for (const name of [
    "起风了（cover）",
    "起风了 (Cover: 某某)",
    "起风了（DJ版）",
    "起风了（伴奏）",
    "起风了（纯音乐）",
    "起风了（instrumental）",
    "起风了（翻唱）",
    "起风了（现场版）",
    "起风了（加速版）",
  ]) {
    assert.equal(
      m.isMatch(name, want[1], want[0], want[1], want[2], want[2]),
      false,
      `不应把 ${name} 当成原曲`,
    );
  }

  // 原本就是纯音乐/伴奏曲目，则同名同限定语可以匹配。
  assert.equal(m.isMatch("起风了（纯音乐）", "买辣椒也用券", "起风了（纯音乐）", "买辣椒也用券", 0, 0), true);
  assert.equal(m.isMatch("起风了", "买辣椒也用券", "起风了", "买辣椒也用券", 325000, 326000), true);
});

test("歌手重叠按分隔符与包含关系判断，同名不同歌手拒绝", async () => {
  const { plugin: m } = await matcher();

  assert.equal(m.artistsOverlap("周杰伦", "周杰伦"), true);
  assert.equal(m.artistsOverlap("周杰伦 费玉清", "周杰伦"), true);
  assert.equal(m.artistsOverlap("周杰伦", "周杰伦 费玉清"), true);
  assert.equal(m.artistsOverlap("周杰伦/费玉清", "费玉清、周杰伦"), true);
  assert.equal(m.artistsOverlap("Jay Chou", "jay chou"), true);
  assert.equal(m.artistsOverlap("周杰伦", "林俊杰"), false);
  assert.equal(m.artistsOverlap("", "周杰伦"), false);
  assert.equal(m.artistsOverlap("周杰伦", ""), false);

  assert.equal(m.isMatch("晴天", "周杰伦", "晴天", "林俊杰", 269000, 269000), false);
  // 候选缺歌手时不能采信；调用方没有歌手信息时只能信歌名与时长。
  assert.equal(m.isMatch("晴天", "", "晴天", "周杰伦", 269000, 269000), false);
  assert.equal(m.isMatch("晴天", "周杰伦", "晴天", "", 269000, 269000), true);
  assert.equal(m.isMatch("晴天", "", "晴天", "", 269000, 269000), true);
  assert.equal(m.isMatch("", "周杰伦", "晴天", "周杰伦", 0, 0), false);
  assert.equal(m.isMatch("晴天", "周杰伦", "", "周杰伦", 0, 0), false);
});

test("时长 8 秒容差，秒与毫秒单位自动归一", async () => {
  const { plugin: m } = await matcher();

  assert.equal(m.durationMsOf(269), 269000);
  assert.equal(m.durationMsOf("277"), 277000);
  assert.equal(m.durationMsOf(269000), 269000);
  assert.equal(m.durationMsOf(0), 0);
  assert.equal(m.durationMsOf(-5), 0);
  assert.equal(m.durationMsOf("不是数字"), 0);
  assert.equal(m.durationMsOf(undefined), 0);

  // 恰好 8 秒可以通过，多 1 毫秒就拒绝。
  assert.equal(m.isMatch("晴天", "周杰伦", "晴天", "周杰伦", 269000, 277000), true);
  assert.equal(m.isMatch("晴天", "周杰伦", "晴天", "周杰伦", 269000, 277001), false);
  assert.equal(m.isMatch("晴天", "周杰伦", "晴天", "周杰伦", 269000, 261000), true);
  assert.equal(m.isMatch("晴天", "周杰伦", "晴天", "周杰伦", 269000, 260999), false);

  // 缺时长时不因为容差误杀，但没有歌手又没有时长时必须放弃。
  assert.equal(m.isMatch("晴天", "周杰伦", "晴天", "周杰伦", 269000, 0), true);
  assert.equal(m.isMatch("晴天", "", "晴天", "", 269000, 0), false);
  assert.equal(m.isMatch("晴天", "", "晴天", "", 0, 0), true);
});

test("pickMatch 在候选中选版本与歌手都对、时长最接近的一首", async () => {
  const { plugin: m } = await matcher();
  const list = [
    { id: "wrong-artist", name: "晴天", artist: "翻唱歌手", duration: 269000 },
    { id: "live", name: "晴天（Live版）", artist: "周杰伦", duration: 269000 },
    { id: "far", name: "晴天", artist: "周杰伦", duration: 277000 },
    { id: "close", name: "晴天", artist: "周杰伦", duration: 270500 },
  ];
  const picked = m.pickMatch(
    list,
    (row) => row.name,
    (row) => row.artist,
    (row) => row.duration,
    "晴天",
    "周杰伦",
    269000,
  );
  assert.equal(picked?.id, "close");

  // 原版《起风了》的候选全是衍生版本时不能凑合。
  assert.equal(
    m.pickMatch(
      [{ id: "instrumental", name: "起风了（伴奏）", artist: "买辣椒也用券", duration: 325 }],
      (row) => row.name,
      (row) => row.artist,
      (row) => row.duration,
      "起风了",
      "买辣椒也用券",
      325000,
    ),
    null,
  );
  assert.equal(
    m.pickMatch([], (row) => row.name, (row) => row.artist, (row) => row.duration, "晴天", "周杰伦", 0),
    null,
  );

  // 时长以秒返回时也能正确打分。
  const seconds = m.pickMatch(
    [
      { id: "a", name: "晴天", artist: "周杰伦", duration: 269 },
      { id: "b", name: "晴天", artist: "周杰伦", duration: 270 },
    ],
    (row) => row.name,
    (row) => row.artist,
    (row) => row.duration,
    "晴天",
    "周杰伦",
    269000,
  );
  assert.equal(seconds?.id, "a");
});

test("搜索关键词由精确到宽松，最多两个变体", async () => {
  const { plugin: m } = await matcher();

  assert.deepEqual([...m.keywordVariants({ name: "晴天", artists: [{ name: "周杰伦" }] })], [
    "晴天-周杰伦",
    "晴天 周杰伦",
  ]);
  assert.deepEqual(
    [...m.keywordVariants({ name: "千里之外", artists: [{ name: "周杰伦" }, { name: "费玉清" }] })],
    ["千里之外-周杰伦 费玉清", "千里之外 周杰伦 费玉清"],
  );
  assert.deepEqual([...m.keywordVariants({ name: "晴天", artists: [] })], ["晴天"]);
  assert.deepEqual([...m.keywordVariants({ name: "晴天", artists: [{ name: "" }, null] })], ["晴天"]);
  assert.deepEqual([...m.keywordVariants({ name: "   ", artists: [{ name: "周杰伦" }] })], []);
  assert.deepEqual([...m.keywordVariants({})], []);

  assert.equal(m.artistText({ artists: [{ name: "周杰伦" }, { name: "" }, { name: "费玉清" }] }), "周杰伦 费玉清");
  assert.equal(m.artistText({}), "");
});
