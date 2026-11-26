# 第三方说明

本项目的原创代码使用 [MIT 许可](LICENSE)，版权归 ypm-plugin-switch contributors 所有。以下第三方代码、接口实现与商标分别归其权利人所有。

## 音源解析逻辑的来源

多音源网关中的第三方音源解析逻辑（GDStudio、酷我波点、酷我移动等链路，按关键词搜索与严格匹配的规则，以及酷我移动接口的 DES 变种加密）移植并改写自：

| 上游项目 | 使用的部分 | 许可 |
| --- | --- | --- |
| [TIMER-err/qplayer-netease-plugin](https://github.com/TIMER-err/qplayer-netease-plugin) | `src/unblock.js` 中的 GDStudio、波点、酷我三条链路 | MIT，Copyright (c) 2026 TIMER-err |
| [TIMER-err/qplayer-qqmusic-plugin](https://github.com/TIMER-err/qplayer-qqmusic-plugin) | `src/unblock.js` 中更严格的版本限定语匹配、波点 / 酷我 / GDStudio 搜索链路 | MIT，Copyright (c) 2026 TIMER-err |

## 曲库与工程结构的参考

网易云匿名曲库的接口约定与 YesPlayMusic 插件工程结构参考了：

| 上游项目 | 参考内容 | 许可 |
| --- | --- | --- |
| [lymzzyh/ypm-plugin-netease](https://github.com/lymzzyh/ypm-plugin-netease) | 网易云 eapi 端点、请求参数与曲库字段映射的公开实现 | MIT，Copyright (c) 2026 lymzzyh |
| [lymzzyh/ypm-plugin-qqmusic](https://github.com/lymzzyh/ypm-plugin-qqmusic) | YesPlayMusic 插件 ABI 的用法与工程结构 | MIT，Copyright (c) 2026 lymzzyh |
| [TIMER-err/qplayer-qqmusic-plugin](https://github.com/TIMER-err/qplayer-qqmusic-plugin) | `src/main.js` 中 QQ 音乐 musicu、smartbox 与匿名歌词接口的用法（歌手页专辑补全） | MIT，Copyright (c) 2026 TIMER-err |

以上上游项目均以 MIT 许可发布。本项目的曲库客户端、数据映射、QQ 专辑补全与网关均为自行实现，两个 ypm-plugin 项目没有代码被直接复制；qplayer 的两个插件只有上述音源解析部分被移植改写，QQ 曲库接口为按其公开用法重写。所有上游项目与本项目没有隶属或背书关系。

## MIT 许可声明

The MIT License (MIT)

Copyright (c) 2026 ypm-plugin-switch contributors
Copyright (c) 2026 TIMER-err
Copyright (c) 2026 lymzzyh

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## 商标与内容

- **网易云音乐**、网易云音乐图标及相关标识是网易云音乐及其权利人的商标或资产。
- **QQ 音乐**、QQ 音乐图标及相关标识是腾讯音乐娱乐集团及其权利人的商标或资产。
- **酷我音乐**、酷我及相关标识是酷我音乐及其权利人的商标或资产。
- **GDStudio** 及其接口、标识归 GDStudio 及其权利人所有。
- **YesPlayMusic** 及其图标归 YesPlayMusic 项目及 qier222 所有。

本插件是独立的社区项目，与上述公司、服务或项目没有隶属、合作或背书关系。插件只调用公开可访问的第三方接口，不声称拥有任何曲库或音频的版权。

本项目**不包含、不缓存、不下载、不重新分发任何音频文件**，也不包含任何账号凭据、Cookie、Token 或用户数据；酷我波点链路的公开设备参数（`devid`、`qimei36` 等）与广告权益请求参数沿用参考实现。播放时，音频由 YesPlayMusic 的播放器直接向音源返回的 CDN 地址请求；插件本身只对候选直链做轻量可用性探测。曲库元数据来自网易云公开的匿名接口，其版权归原权利人所有。

第三方接口与音源随时可能变更、限流或停止服务，本项目不保证任何音源长期可用，也不对第三方服务的内容与合法性负责。

插件图标 `icon.png` 为用户提供的图片素材（由 96×96 原图放大到 256×256），不在本项目的 MIT 许可范围内；再分发前请自行确认素材权利。

## Trademarks and content (English)

This is an independent community plugin. NetEase Cloud Music (网易云音乐), QQ Music, Kuwo Music, GDStudio, YesPlayMusic and their logos are trademarks or assets of their respective owners. The plugin is not affiliated with, endorsed by, or sponsored by any of them.

The plugin bundles no audio files, credentials, cookies or tokens, and it neither caches nor redistributes audio. Playback requests go from the YesPlayMusic player directly to the CDN URLs returned by the third-party sources; the plugin only performs an availability probe on candidate URLs. Audio and catalog metadata remain the property of their respective rights holders.

The plugin icon `icon.png` is a user-supplied image (upscaled from 96×96 to 256×256) and is not covered by this project's MIT license; verify its rights before redistributing.
