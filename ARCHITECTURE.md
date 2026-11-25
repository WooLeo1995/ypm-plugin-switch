# 架构

本插件把「曲库」和「音源」拆开：

- **曲库**（搜索、首页、歌手、专辑、歌单、歌词）全部来自网易云客户端的匿名 eapi 接口。
  不需要登录，也不保存任何凭据。
- **音源**（`stream()` 返回的音频直链）由一个网关解析。网关按顺序尝试多个互不相关的
  第三方音源，逐个校验直链确实可播，任一环节失败就自动切到下一个。所有音源都免登录。

音源实现移植自

- [`TIMER-err/qplayer-netease-plugin`](https://github.com/TIMER-err/qplayer-netease-plugin)
  的 `src/unblock.js`（`gdstudio`、`bodian`、`kuwo` 三条链路）
- [`TIMER-err/qplayer-qqmusic-plugin`](https://github.com/TIMER-err/qplayer-qqmusic-plugin)
  的 `src/unblock.js`（更严格的版本限定语匹配、波点 / 酷我 / GDStudio 搜索链路）

两者的第三方音源集合相同，本插件把「按 ID 取址」和「按关键词搜索匹配」两类链路都收进
网关，并按可用性排序。

## 目录

```
plugin.json                插件清单与网络权限
index.js                   宿主导出入口（只做转发与菜单）
i18n.js                    host.t 包装
catalog/                   网易云匿名曲库 + 本地歌单
  client.js                eapi 客户端（AES-128-ECB + MD5 摘要）
  models.js                Track / Album / Artist / Playlist 映射与元数据缓存
  library.js               search / home / browse / album / artist / playlist / lyrics
  playlists.js             免登录本地歌单：创建、改名、加歌、移歌、删除（host.storage）
gateway/                   音源网关
  index.js                 resolveStream：排序、预算、缓存、熔断、探测、回退
  registry.js              音源注册表与排序（读取设置）
  quality.js               宿主音质 → 各音源档位
  probe.js                 直链可用性探测（HEAD，必要时 Range GET）
  health.js                熔断与健康快照（host.storage 持久化）
  cache.js                 元数据 / 直链 / 失败短缓存
  match.js                 关键词搜索结果匹配（版本限定语 + 歌手 + 时长）
  selftest.js              逐个音源做端到端自检
  sources/
    http.js                统一的 fetch 辅助（超时、硬/软失败区分）
    gdstudio.js            按网易云 ID 取址
    gdstudio-search.js     按关键词搜索后取址
    kuwo-search.js         酷我搜索与匹配
    kuwo-bodian.js         酷我波点 audioUrl 接口
    kuwo-mobi.js           酷我移动 convert_url2 接口
    kuwo-des.js            酷我移动接口的 DES 变种加密（移植自参考实现）
stream.js                  stream() 入口：补全曲目元数据后交给网关
test/                      离线测试（mock host + mock fetch）
scripts/live-check.mjs     实网冒烟脚本（手动运行）
```

## 宿主导出的函数

| 函数 | 说明 |
| --- | --- |
| `search({ query, kind, offset })` | `tracks` / `albums` / `artists` / `playlists` |
| `suggest({ query })` | 搜索联想 |
| `hotSearches()` | 热门搜索 |
| `home()` | 推荐歌单、推荐新歌、发现入口 |
| `browse({ page })` | `""`、`charts`、`top:<id>`、`new-albums`、`playlists:<分类>:<偏移>`、`sources` |
| `album({ id })` / `artist({ id })` | 详情 |
| `playlist({ id })` | 详情；`local-<n>` 读本地歌单，数字编号读网易云歌单 |
| `playlists()` | 本地歌单列表（音乐库「歌单」页使用） |
| `createPlaylist({ name })` / `renamePlaylist({ id, name })` / `deletePlaylist({ id })` | 创建 / 改名 / 删除本地歌单 |
| `addToPlaylist({ id, trackIds })` / `removeFromPlaylist({ id, trackIds })` / `movePlaylistTrack({ id, from, to })` | 加歌 / 移歌 / 排序 |
| `lyrics({ id })` | 原文 + 翻译 LRC |
| `stream({ id, quality })` | 网关解析出的 `AudioStream` |
| `trackMenu({ track })` / `menuAction({ id, track })` | 复制直链 / 检测音源 |
| `testConnection({ settings })` | 3.1.0+，逐个音源自检 |

**不导出** `account` / `signIn` / `signOut` / `liked` / `playlists` / `recent` 等需要登录的
能力，安装后不会出现登录入口。

## 本地歌单

曲库来自网易云，但歌单写入没有账号可依赖，所以歌单完全存在插件自己的数据目录里：

- **存储**：`host.storage` 的 `localPlaylists` 键，结构为
  `{ next, items: [{ id: "local-<n>", name, createdAt, updatedAt, tracks: [快照] }] }`。
  歌曲快照只保留 `id / name / artists / album / duration / url`，不存音频、不上传。
- **编号**：只接受 `local-<n>`；`playlist(id)` 按前缀路由，数字编号仍走网易云歌单详情。
- **上限**：最多 100 个歌单、单个歌单最多 2000 首、序列化总量约 6 MB，超出时给出明确错误。
- **去重**：同一首歌重复加入会被跳过；`removeFromPlaylist` 按歌曲 id 移除。
- **容错**：storage 内容损坏时按空歌单处理，不影响插件其他功能。
- **宿主交互**：歌曲右键「添加到歌单 → 新建歌单」需要同时导出 `addToPlaylist` 与
  `createPlaylist`；音乐库「歌单」页直接展示 `playlists()`；`playlist(id)` 返回带
  `tracks` 的歌单。播放本地歌单里的歌仍然走音源网关，不依赖歌单里的快照是否能联网刷新。
- **不做**：不导出 `savePlaylist`（收藏别人的歌单需要账号），不把本地歌单同步到任何账号。

## 音源接口

每个音源模块默认导出一个对象：

```js
export default {
  id: "gdstudio",            // 稳定标识，用于健康状态与日志
  family: "gdstudio",        // gdstudio | kuwo，用于「优先音源」设置
  label: "GDStudio",         // 展示名
  kind: "id",                // id：只需曲目 ID；keyword：需要歌名/歌手
  async resolve(ctx) {},      // 返回 { url, type?, bitRate?, size? } 或 null
  async ping(),               // 可选：连通性检查，返回 true
};
```

`ctx` 结构：

```js
{
  track: { id, name, artists: [{ id, name }], duration, album },
  keyword,                    // "歌名-歌手"，可能为空
  quality,                    // standard | high | lossless
  deadline,                   // 绝对时间戳，音源内部请求应据此收紧超时
}
```

约定：

- **没有匹配到歌曲**返回 `null`，不抛错，不计入熔断。
- **网络错误、超时、5xx、返回体无法解析**抛错，网关计入熔断。
- 4xx（例如 GDStudio 对不支持的 source 返回 400）视为软失败，返回 `null`。
- 音源只返回候选地址，**不负责探测**；探测由网关统一做。

## 网关算法

```
resolveStream({ track, quality })
  1. 归一化音质（插件设置优先，其次宿主 quality，最后 high）
  2. 命中直链缓存：
       - 跳过校验 → 直接返回
       - 校验时间 < 2 分钟 → 直接返回
       - 否则探测缓存地址，可用则刷新校验时间并返回
  3. 命中失败短缓存（45 秒）→ 直接抛 unavailable
  4. 依据设置排出音源顺序，跳过熔断中的音源
  5. 对每个音源（总预算 22 秒）：
       a. 调 resolve()；null → 下一个
       b. 抛错 → 记录熔断，下一个
       c. 有地址 → probe()；失败 → 记录熔断，下一个
       d. 成功 → 记录健康、写缓存、返回 AudioStream
  6. 全部失败 → 写失败短缓存，抛 code=unavailable
```

熔断退避：连续第 1 / 2 / 3 次硬失败分别冷却 30 秒 / 2 分钟 / 10 分钟，成功即清零。
软失败（无匹配）只更新「最近未命中」，不冷却。

## 可用性探测

1. `HEAD` 请求，2xx 且 `Content-Type` 为音视频、`application/octet-stream`，
   或没有类型但有 `Content-Length` → 可用。
2. `Content-Type: text/html` → 视为失效（过期签名常返回错误页）。
3. `HEAD` 被拒绝（403 / 405 / 501）或抛错 → 用 `Range: bytes=0-0` 的 `GET` 再试一次，
   只看状态与响应头。
4. 4xx / 5xx → 不可用；超时 / 网络错误 → 不可用。

设置 `skipVerify` 为真时跳过第 5 步，直接采信音源返回值（默认不跳过）。

## 设置项

| key | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `quality` | select | `""` | 跟随播放器 / 标准 128k / 高音质 320k / 无损 FLAC |
| `prefer` | select | `auto` | 自动 / GDStudio 优先 / 酷我优先 |
| `skipVerify` | boolean | `""` | 跳过播放前校验（不推荐） |
| `disableGdstudio` | boolean | `""` | 停用 GDStudio 音源 |
| `disableKuwo` | boolean | `""` | 停用酷我音源 |

布尔项的「未设置」和「关闭」都是 `""`，所以一律用「停用 / 跳过」这种默认为假的语义。

## 已实测的音源事实

以下均为 2026-11 实测，实现时以这些参数为准。

### 网易云匿名 eapi

- 端点：`POST https://interfacepc.music.163.com/eapi/*`
- 请求：`params = AES-128-ECB(key=e82ckenh8dichen8, path + "-36cd479b6b5-" + body + "-36cd479b6b5-" + md5("nobody"+path+"use"+body+"md5forencrypt"))`
- 不需要 Cookie；`header` 里带 `os/appver/deviceId/...` 即可。
- 匿名可用：`/api/cloudsearch/pc`、`/api/search/suggest/web`、`/api/hotsearchlist/get`、
  `/api/v3/song/detail`、`/api/v6/playlist/detail`、`/api/v1/album/{id}`、
  `/api/v1/artist/{id}`、`/api/artist/albums/{id}`、`/api/personalized/playlist`、
  `/api/personalized/newsong`、`/api/toplist`、`/api/discovery/newAlbum`、
  `/api/playlist/list`、`/api/song/lyric`。
- 匿名 `/api/song/enhance/player/url/v1` 一律返回空 `url`，所以**不把官方直链接入网关**。

### GDStudio

- `GET https://music-api.gdstudio.xyz/api.php`
- 按 ID 取址：`?types=url&source=netease&id=<网易云ID>&br=<128|192|320|740|999>`
  → `{ url, br, size }`；`br=740/999` 返回 flac。没有版权时 `url` 为空字符串。
- 按关键词搜索：`?types=search&source=netease&name=<关键词>&count=20&pages=1`
  → 数组，元素 `{ id, name, artist: string[], album }`，**没有时长字段**。
- 只有 `source=netease` 可用：`joox` 能搜到但取址为空，`kuwo/tencent/qq/kugou` 返回 400。
- 音频 CDN 实测域名均为 `*.music.126.net`（`m7` / `m701` / `m801`）。
- 偶发 503 HTML 会由 `getJson` 重试一次；返回空 `url` 视为该曲在该音源无资源，直接换下一个音源，不重复请求。

### 酷我搜索

- `GET https://search.kuwo.cn/r.s?&correct=1&stype=comprehensive&encoding=utf8&rformat=json&mobi=1&show_copyright_off=1&searchapi=6&all=<关键词>`
- 结果：`content[1].musicpage.abslist[]`，字段 `SONGNAME`、`ARTIST`、`DURATION`（秒）、
  `MUSICRID`（`MUSIC_<数字>`）。
- 版权收紧后主流歌曲多为翻唱 / DJ / 伴奏，必须靠严格匹配拒绝错版本。

### 酷我波点

- `POST https://bd-api.kuwo.cn/api/service/advert/watch?uid=-1&token=&timestamp=1724306124436&sign=15a676d66285117ad714e8c8371691da`
  body `{"type":5,"subType":5,"musicId":0,"adToken":""}`；返回失败无妨，忽略。
- `GET https://bd-api.kuwo.cn/api/play/music/v2/audioUrl?&br=<128kmp3|320kmp3>&musicId=<rid>&timestamp=<ms>&sign=<md5>`
  - `sign = md5("kuwotest" + 排序后的「查询串仅保留字母数字」 + "/api/play/music/v2/audioUrl")`
  - 查询串必须包含 `timestamp` 后再算签名。
  - 返回 `data.audioUrl`（http）与 `data.audioHttpsUrl`（https）、`data.bitrate`、`data.size`。
- 请求头：`user-agent: Dart/2.19 (dart:io)`、`plat: ar`、`channel: aliopen`、`devid`、`ver: 3.9.0`、
  `qimei36`。不要手动设置 `Host`。
- `br=320kflac` 会静默降级成 128k mp3，所以只请求 mp3。

### 酷我移动

- `GET https://mobi.kuwo.cn/mobi.s?f=kuwo&q=<encodeURIComponent(base64(DES(query, "ylzsxkwm")))>`
  - `query = corp=kuwo&source=kwplayer_ar_5.1.0.0_B_jiakong_vh.apk&p2p=1&type=convert_url2&sig=0&format=mp3&rid=<rid>`
  - 返回文本 `format=mp3\r\nbitrate=320\r\nurl=<http 地址>...`
- 音频 CDN 实测域名 `*.kuwo.cn`（`bd-bj` / `bd-er` / `kw-bj` / `kw-er`），
  http 地址改成 https 后同样可播。

## 网络权限

`plugin.json` 声明：

```
interfacepc.music.163.com     网易云 eapi
music-api.gdstudio.xyz        GDStudio
*.music.126.net               GDStudio 返回的网易云 CDN（探测用）
search.kuwo.cn                酷我搜索
bd-api.kuwo.cn                酷我波点
mobi.kuwo.cn                  酷我移动
*.kuwo.cn                     酷我音频 CDN（探测用）
```

音频最终由宿主播放器拉取，不经过插件；插件只对候选直链做一次 HEAD/短 Range 探测。

## 测试约定

- 全部离线：`test/runtime.mjs` 提供 QuickJS 风格的 mock `host` 与可编程 `fetch`。
- 每个测试用**独立运行时**，避免模块级缓存 / 熔断状态串味。
- `test/runtime.mjs` 需要实现 `host.crypto.md5`、`host.crypto.aesEcbEncrypt`、
  `host.storage`、`host.setting`、`host.t`、`host.openURL`、`host.platform` 等。
- 测试不得访问真实网络。
- 运行：`node --experimental-vm-modules --test test/*.test.mjs`

## 验收

开发时用三层验证，全部在仓库内可复现：

1. **离线测试**：`node --experimental-vm-modules --test test/*.test.mjs`
   59 条，覆盖清单、曲库映射、本地歌单（创建 / 加歌 / 改名 / 删除 / 排序 / 上限 / 坏数据）、
   匹配规则、网关排序 / 熔断 / 缓存 / 探测、菜单、自检与 9 语言本地化，不访问真实网络。
2. **实网冒烟**：`node scripts/live-check.mjs`
   31 项，真实请求曲库与音源，校验搜索、三档音质、缓存命中、无源歌曲、自检页、设置
   顺序、运行期主机是否都在网络权限内；断网时明确失败并退出。
3. **真实应用验收**：在 YesPlayMusic 3.0.0 中把插件目录放进 `plugins/switch`，用应用
   内置 MCP 服务器（`127.0.0.1:18888/mcp`）执行 `list_sources` / `switch_source` /
   `search_music` / `play_tracks` / `get_lyrics`。已确认：
   - 插件在 QuickJS 中加载，`list_sources` 识别出 `switch` 及其 12 个能力；
   - 搜索、首页、歌词返回正确数据；
   - 播放真实出声，日志显示 `[switch] <id> <- gdstudio 高音质 mp3`，播放进度持续前进。
