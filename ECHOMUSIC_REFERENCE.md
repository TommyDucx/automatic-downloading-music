# EchoMusic 音源架构调研笔记

调研时间：2026（本会话）
调研方式：GitHub 在线浏览 + 读取原始代码（main 分支）
仓库：https://github.com/hoowhoami/EchoMusic （Electron + Vue3 第三方酷狗概念版播放器，GPL-3.0）
结论先行：**音源 = 酷狗官方 API 逆向（内嵌子模块 KuGouMusicApi）+ 行为指纹模拟反风控；其余 7 家平台只做"歌单导入"，播放仍统一走酷狗**。

## 1. 总体架构：一层播放器 + 一个音源

```
┌─────────────────────────────────────────────────────────┐
│ EchoMusic (Electron 主进程)                             │
│  src/main/server.ts ── 内嵌加载 KuGouMusicApi 子模块     │
│    扫描 server/module/*.js → 按路由 lazy require        │
│    复现 Express 分发逻辑（IPC 内调用，不起 HTTP 服务）   │
│    设备指纹持久化: guid/mac/mid/webglHash → KV store     │
└───────────────┬─────────────────────────────────────────┘
                │ /song/url /privilege/lite /search ...
                ▼
┌─────────────────────────────────────────────────────────┐
│ KuGouMusicApi (git submodule → MakcRe/KuGouMusicApi)    │
│  模拟 Android 客户端直连酷狗官方网关 gateway.kugou.com   │
│  MD5 盐值签名(android/web/register) + kg-* 内部标识头    │
│  SSA 验证码 → generate_simulate 生成 sid/edt 行为指纹    │
└─────────────────────────────────────────────────────────┘
```

- 子模块声明在 `.gitmodules`：`server → https://github.com/MakcRe/KuGouMusicApi.git`（908★）。
- `src/main/server.ts` 把 KuGouMusicApi 原本的 Express 服务"内联化"：扫描 `server/module/` 目录按路由懒加载，复现 cookie/query/签名注入逻辑，通过 IPC 暴露给渲染进程——**不 spawn 子进程、不起本地端口**。
- 音质档位走"概念版 lite"平台：`process.env.platform='lite'`，与标准版使用不同的 appid/clientver/签名盐（见 §3）。

## 2. 音源获取主链路（播放时）

渲染进程 `src/renderer/stores/player/resolver.ts`（762 行）的 `resolveAudioUrl` 是核心，顺序如下：

1. **权限/音质探测**：`GET /privilege/lite?hash=&album_id=` → 返回 `relate_goods` 列表（每首歌各音质档对应的**独立 hash** + 权限）。首次按 `hash:albumId` 做请求合并去重。
2. **音质候选降级链**：`getSongQualityCandidates(preferred)` —— `AUDIO_QUALITY_ORDER = ['128','320','flac','high','viper_tape']`，从偏好档向下枚举，逐档在 relate_goods 里找匹配 hash 再 `GET /song/url?hash=&quality=`。
3. **效果音轨（人声/伴奏分离）**：quality 传 `magic_piano / magic_acappella / magic_subwoofer / magic_ancient / magic_dj / magic_surnay`，返回 MKV 多音轨 → Rust 原生播放器按关键字（vocal/人声、accompaniment/伴奏）选 `audioTrackId`。
4. **兼容模式兜底**：relate_goods 全部失败时 `GET /song/url?hash=`（默认 128）→ 再换 ppage_id 试一次。
5. **云盘兜底**：`GET /user/cloud/url`（用户云盘匹配文件）。
6. **插件音源**：5 个阶段可介入 —— `before-catalog → catalog → after-catalog → cloud → final-fallback`（见 §6）。
7. 全部失败才返回空 URL。

另有两套增强接口：`song_url_auth`（先 `/song/auth` 拿 `auth + open_time` 再取 URL，疑似会员/高价权限）与 `song_url_new`（POST tracker.kugou.com `/v6/priv_url`，带 `vip_token`、MD5(hash+盐+appid+mid+userid) 的 tracker_param key）。

## 3. 签名与设备指纹（KuGouMusicApi util/）

- `util/helper.js` 三种签名，均为 **MD5(盐值+排序参数字符串+盐值)**：
  - web 盐 `NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt`
  - android 盐（标准版 `OIlwieks28dk2k092lksi2UIkp` / lite 版 `LnT6xpN3khm36zse0QzvmgTZ3waWdRSA`），支持把 POST body 计入哈希
  - register 盐 `1014`
  - `signKey`：`MD5(hash + 盐(185672dd…/57ae12eb…) + appid + mid + userid)`
- `util/request.js` 注入默认参数：`dfid/mid/uuid/appid/clientver/clienttime`，请求头带 `kg-rc:1, kg-thash:5d816a0, kg-rec:1, kg-rf:B9EDA08A64250DEFFBCADDEE00F8F25F`，UA 伪装 `Android15-1070-11083-46-0-…`。
- `util/config.json` 提供 appid/clientver（标准版与 lite 版两套）。
- **设备指纹**：`guid = MD5(getGuid())`、`mid = calculateMid(guid)`、`webglHash = generateWebGLHash()`、MAC 取真实网卡地址（非内部网卡优先）；**全部持久化到本地 KV**（EchoMusic `src/main/server.ts` + persistedStores），重启复用同一身份 → 降低风控触发率。

## 4. 反风控：SSA 验证码 → 模拟行为指纹（重点借鉴区）

- 酷狗接口在需要二次验证时返回响应头 `ssa-code`。`request.js` 捕获后自动调用 `util/generate_simulate.js` 生成 `sid/edt` 附加到响应体。
- `generate_simulate.js`（351 行）**在服务端模拟浏览器 WASM 的行为指纹采集**：
  - 生成模拟事件流：窗口 load/resize（type 6）、3 次不规则滚动（type 5）、**三阶贝塞尔曲线的鼠标移动轨迹**（type 3，8–50ms 随机间隔，每 12 帧插一次滚动），每事件后跟哨兵记录（0xFFFFFFFF 附近随机值）。
  - 事件串编码为 `type,时间差,子索引,X,Y` 冒号分隔文本 → **AES-128-CBC 加密**得 `edt`（IV 固定为 `kugousecurity123`）→ AES 密钥用 **RSA-OAEP SHA-256** 加密得 `sid`（RSA 公钥是从酷狗 WASM 二进制里提取的，硬编码在源码中）。
- EchoMusic 侧还有一层：`kugouVerification.ts` 处理 `/get/verify/info` 挑战（TX 腾讯 / GT 极验 / KG 酷狗滑块 / KG2 旋转 / SM 数美 / YD 易盾 / SMS / LOGIN 等），提交验证码时调 **`/sidedt`**——"桌面端无法采集浏览器行为指纹，统一交由服务端 `/sidedt` 模拟生成 sid/edt 并完成校验"。
- 启示：风控不是只靠"伪装 UA + 签名"，还要**模拟真实人机交互轨迹 + 加密传输**；且把指纹生成下沉到服务端（/sidedt）是巧妙的架构决策。

## 5. 多平台"歌单导入"（external providers）——与音源解耦

`src/main/external/providers/` 有 8 个 provider：`netease / qqmusic / kuwo / kugou / qishui(汽水) / spotify / apple / text`。

- 它们**只负责把"分享链接/文本"解析成 `ExternalPlaylist`（歌名+歌手+时长）**，不提供任何音频 URL：
  - 网易云：`music.163.com/api/v6/playlist/detail` + `/api/v3/song/detail` 批量补全（playlist/detail 只回前若干首，按 trackIds 分批 500 补齐）。
  - 汽水：解析页面 SSR 的 `_ROUTER_DATA` 嵌入 JSON。
  - Spotify：`open.spotify.com/embed/playlist/{id}` 解析 `__NEXT_DATA__`。
  - 酷狗：移动端页面 `window.$output` / PC 分享页 `dataFromSmarty` / 短链 302 跟踪。
  - 文本：直接按行拆分 `歌手 - 歌名`。
- 导入后的播放仍然走酷狗：按"歌名+歌手"在酷狗搜索匹配 hash。**即：多平台只是"找歌单"，音源单一（酷狗）**。

## 6. 插件音源系统（可插拔 resolve/transform 管道）

`src/renderer/plugins/audioSource.ts`（372 行）定义统一音源解析协议：

- `PluginAudioSourcePosition = 'before-catalog' | 'after-catalog' | 'final-fallback'`，加 catalog/cloud 共 5 个 transform 阶段。
- 插件贡献 `{ id, order, position, match, resolve, transformStages, transform }`：
  - `resolve` 在指定位置产出候选 URL；
  - `transform` 对每个候选可**替换 / 加工 / 拒绝**（返回 null=保持、false=拒绝并继续兜底链、string=替换 URL、对象=字段合并）。
- 播放器内部同一协议复用：catalog（酷狗）、cloud（云盘）都经过 transform 管道，插件可插在任意阶段改写。
- 另有 `kugou.ts` 给插件暴露 `api.<namespace>.<fn>` 的懒加载 Proxy 酷狗 API。

## 7. 对我们项目（GD 音乐台下载器）的借鉴结论

我们场景：**批量下载 FLAC + metaflac 内嵌元数据**，音源是 GD 音乐台（gdstudio 聚合酷我/网易/QQ/咪咕等多源）。EchoMusic 是流媒体播放器，直接搬源码不现实（GPL、Electron、依赖酷狗账号体系），但以下思路可直接借鉴：

| # | 借鉴点 | 出处 | 落地方向（gdstudio 下载器） |
|---|--------|------|---------------------------|
| 1 | **音质候选降级链 + 先探测后取址** | resolver.ts + getSongQualityCandidates | GD 台 `types=url&br=` 有 128/320/740/999 档，目前我们是"指定 br 失败即失败"；可改为**按 999→740→320→128 逐档尝试**（配合现有 --delay 限流），提高成功率 |
| 2 | **多平台歌单导入（URL → 曲目列表）** | external/providers/*.ts | 用户给网易云/QQ 歌单链接即可批量下载——新增"歌单解析 + GD 台搜索匹配"步骤，是最实用的借鉴点 |
| 3 | **行为指纹模拟 + /sidedt 服务端代验思路** | generate_simulate.js + kugouVerification.ts | GD 台 401/验证码目前只做指数退避；若未来 GD 台加验证，可借鉴"把挑战转交一次人工/服务端生成指纹"而非死等 |
| 4 | **设备/请求身份持久化复用** | server.ts persistedStores | GD 台 crc32 签名每次动态算（无状态），目前不需要；但可持久化缓存签名上下文与失败记录，降低重复请求 |
| 5 | **统一 resolve/transform 管道** | audioSource.ts | 多源（kuwo/netease/qq/migu）下载可统一成"候选源队列 + 每源尝试 + 失败降级/换源"的管道，而非现在的 if-else 链 |
| 6 | **云盘/本地缓存兜底** | resolver cloud fallback | 我们已有 `.gd-flac-cache`（同思路）：下载前先查本地缓存避免重复拉取 |

不建议借鉴：直接逆向酷狗官方协议（法律风险高、clientver/盐值易腐化、需账号体系）——GD 台聚合接口是更省心的上层方案；EchoMusic 的 Electron/Rust 播放器部分与本项目无关。

## 8. 关键文件索引（供后续阅读）

- EchoMusic：`src/main/server.ts`（内嵌 server）、`src/renderer/stores/player/resolver.ts`（音质链路）、`src/renderer/plugins/audioSource.ts`（音源管道）、`src/renderer/utils/kugouVerification.ts`（验证码）、`src/main/external/providers/*.ts`（歌单导入）
- KuGouMusicApi：`util/request.js`（签名/请求）、`util/helper.js`（签名算法）、`util/generate_simulate.js`（行为指纹）、`module/song_url.js / song_url_new.js / song_url_auth_merge.js`（URL 获取）、`module/search.js`

---

# 补充（2026-10-11）：实测复现 + 内嵌信息 / 歌词链路

> 本节是**实跑结论**，不是读码推断。所有 ✅ 都有当日实测证据；❌ 是当天确定不通的路，
> 别再重复投入。方法论见 `逆向工程方法论-2026-10.md`。

## 9. 免登录可用通道（实测证据）

EchoMusic 走的是**酷狗概念版（`platform=lite`）登录态 + SSA 行为指纹**，我们复现不了登录。
但实测发现有**一条完全免登录、免签名、免风控的可用链路**，已固化为
`kugou-downloader.js`（零第三方依赖，纯 Node 内置 `crypto`/`fetch`/`zlib`）：

| 环节 | 端点 | 签名 | 结果 |
|---|---|---|---|
| 搜索 | `complexsearch.kugou.com/v2/search/song`，`platform=WebFilter` | **web 盐**（见下） | ✅ 可用，返回完整字段 |
| 取流 | `m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=<H>&from=mkugou` | **无** | ✅ 免费曲目直出 `sharefs.kugou.com` CDN 直链 |
| 歌词 | `krcs.kugou.com/search?keyword=<歌名>` → `/download?fmt=krc` | **无** | ✅ KRC 逐字歌词（XOR+zlib 解出） |
| 封面 | 搜索结果 `Image` 字段 → `imge.kugou.com/stdmusic/{size}/…` | 无 | ✅ `{size}` 换 `480` 即可 |

**web 签名算法**（与 §3 的 `signatureWebParams` 一致，双盐三明治）：
```
signature = MD5( "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt"
               + 所有参数按 key 排序后拼 "k=v"（无分隔符）
               + "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt" ).toUpperCase()
```
搜索必需参数：`keyword / page / pagesize / platform=WebFilter / clientver=2000 /
clienttime(毫秒) / dfid='-' / mid=MD5(guid) / uuid=String(Date.now()) /
srcappid=2919 / appid=1014 / iscorrection=1 / privilege_filter=0 / userid=0 / token='' / bitrate=0 / inputtype=0`

**实测能力边界**：
- ✅ **免费曲目**（搜索结果 `Privilege / HQPrivilege / SQPrivilege` 为 0）可以下到**真无损**：
  实测 周杰伦《千山万水》`SQFileHash` → 32.8MB、1061kbps、魔数 `664c6143`（fLaC）；
  《安妮的仙境》→ 7.9MB FLAC。
- ❌ **VIP 曲目**（`Privilege=10`，如《晴天》《海阔天空》）`m.kugou` 返回 `status:0`，
  web 侧 `wwwapi` 返回 `err_code 30020` + `SSA-CODE`（风控）。概念版「免费听」要登录态，本脚本不做登录。
- 结论定位：**酷狗是「补缺渠道」**（无 CF、无 key、纯 HTTP），主渠道仍是 GD 音乐台。
- 曲库现实：主流华语热歌多为 VIP 免费档拿不到，**免费档集中在独立音乐 / 部分老歌 / 翻唱版本**。

**当天确认走不通的路（省得重复试）**：

| 路 | 现象 |
|---|---|
| `gateway.kugou.com` + `AndroidFilter`（android 盐，KuGouMusicApi 默认走法） | 恒 `error_code 152 Parameter Error` —— **android 盐已失效** |
| 同上换 lite 盐 / 各种 `appid × clientver`（12 组） | 仍 152；换 lite 盐反而回到 `20006 err signature` |
| 身份参数变体（`dfid` ∈ `-`/24随机/32hex/guid、`uuid`、`mid` 形态，11 组） | 恒 152 ⇒ **与身份参数无关** |
| `wwwapi.kugou.com/play/songinfo`（web 签名） | `30020` 风控（**签名是对的**，撞人机验证） |
| `trackercdn.kugou.com/i/v2/?key=md5(hash+kgcloudv2)` | 小写 hash → `Bad key`；大写 → `status:2`（无权限） |
| `lyrics.kugou.com/v1/search` | 恒 0 字节空响应（任何 appid/clientver 组合） |
| `krcs.kugou.com/search` 带 `hash` + `album_audio_id` | 恒 404；**只有 `keyword=` 能命中** |
| 本地起 KuGouMusicApi（`npm install`） | 沙箱内被 SIGTERM；**用纯 HTTP 实测即可，不必起服务** |

**错误码语义（重要）**：`20006 err signature` = 没带/格式不对；
`152 Parameter Error` = 签名**值**不对或平台参数错；`30020` + `SSA-CODE` = 签名正确但撞风控。
——把 `152` 当成"业务参数写错"会走一大段冤枉路（见方法论 §3）。

## 10. EchoMusic 如何拿「内嵌信息」与「歌词」

| 需求 | EchoMusic 的做法 | 我们的等价实现 |
|---|---|---|
| 读**本地文件内嵌标签** | npm `music-metadata` 的 `parseFile(path,{duration:true,skipCovers:true})` → title/artist/album/year/track/disk/genre（`src/main/media/audioMetadata.ts`）；文件名 `歌手 - 歌名` 作为兜底解析 | `flac_metadata_embedder.py` + `metaflac`（只做 FLAC；非 FLAC 用 `download_lyrics.py` + mutagen） |
| 写**内嵌标签** | EchoMusic 不写标签（它是播放器，不落盘分发） | 我们反过来：metaflac `--set-tag` + `--import-picture-from` |
| 取**歌词** | `GET /search/lyric?hash&duration&man=no` → 取 `id`+`accesskey` → `GET /lyric?id&accesskey&decode=true&fmt=krc`，**解码在服务端完成**（KuGouMusicApi `util/util.js::decodeLyrics`），客户端直接拿 `decodeContent` | 本脚本在 Node 侧自己解：base64 → 丢前 4 字节 → 16 字节密钥循环 XOR → `zlib.inflateSync` → 把 KRC `[start,dur]<off,dur,0>字…` 转成标准 `[mm:ss.xx]` LRC |
| 取**封面** | 搜索结果 `pic` 字段拼 `imge.kugou.com/{尺寸}/{pic}`（`src/renderer/views/search/searchHelpers.ts`） | 同左；`Image` 字段里的 `{size}` 占位符替换成 `480` |

**KRC 解码密钥**（16 字节循环，来自 `KuGouMusicApi/util/util.js`）：
```
[64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105]
```
→ 该能力补上了本项目原本没有的**逐字（word-level）歌词**来源；对「山灵只读同名 .lrc」
的场景尤其有用，且比纯 LRC 更容易做时间轴对齐。

**歌词匹配的两个坑（实测）**：
1. `keyword` **只能放歌名**：`晴天 周杰伦` → 404，`晴天` → 200；
2. krcs 只按名字检索，会混入**同名异曲 / 翻唱**（实测《海阔天空》匹配到翻唱版，
   歌词首行带"本歌曲翻唱由 …提供生产能力"）。→ 脚本加了两道闸门：
   **候选歌名必须重合** + **时长差 ≤ 6s**，否则宁可不要（防止播放器整首错位）。
   酷狗曲库对部分歌确实没有歌词（如《千山万水》→404），此时回落
   `flac_metadata_embedder.py` 的 Lrclib / NetEase 路径。

## 11. 对 §7 结论的修正

原 §7 的表格（音质降级链 / 歌单导入 / 指纹模拟…）仍然成立，但**结论行要改**：

> ~~不建议直接逆向酷狗官方协议（法律风险高、clientver/盐值易腐化、需账号体系）~~

修正为：**值得做，但只做「免登录的免费曲目」这一段**——
- 代价极低：零第三方依赖、无浏览器、无 WAF、无 key（对比 GD 要过 Cloudflare、ChKSz 要 apikey）；
- 收益明确：GD 台缺的免费曲目（含真无损）+ 独有的逐字歌词；
- 边界清晰：VIP 曲目不碰（不逆向登录/SSA），盐值失效时按 §9 的表横向换端；
- **不引入**生成 `sid/edt` 的行为指纹模拟（`generate_simulate.js` 那套）——那是登录/风控路径的专用武器，
  我们走免签名端点不需要它，也就没有相应的法律与维护成本。

---

# 补充（2026-10-17）：反向接入——把 GD 音乐台做成 EchoMusic 的音源插件

> 与前面几节方向相反：不是「从 EchoMusic 学下载」，而是**把 GD 音乐台塞进 EchoMusic 当第二音源**，
> 解决 EchoMusic 只有酷狗一家、VIP/无版权曲目「无法播放」的问题。
> 成品：仓库根目录 `echomusic-plugin-gdstudio/`（manifest + index.js + README）。

## 12. EchoMusic 插件系统（官方文档在 `hoowhoami/EchoMusicPlugins`）

- 插件 = 一个目录（`manifest.json` + 入口 ESM `index.js`），放进
  `~/Library/Application Support/echo-music/plugins/`，在「插件管理」里启用。
- 关键能力：`capabilities.audioSource`（音源）、`.unrestrictedNetwork`（主进程 Axios，可改 UA/Referer）。
- **音源挂载点**（`ctx.player.audioSource.register`）：

  ```text
  before-catalog → catalog（内置酷狗 song/url）→ after-catalog → cloud → final-fallback
  ```

  `after-catalog` **正是「酷狗解析失败后」**——VIP/无版权曲目就落在这里，是兜底接入的最佳位置。
  `position` 只约束 `resolve`；`transform` 用 `transformStages` 单独声明，且可返回 `false` 拒绝候选。
- 注册项返回的清理函数要保存，禁用/改配置时调用，否则重复注册会叠加。
- 网络：`ctx.net.fetch` 是浏览器 fetch（受 CORS，`api.php` 无 CORS 头 → 必挂）；
  必须用 `ctx.net.request`（主进程 Axios / Node HTTP，返回 `{status, headers, data}`）。

## 13. 三条实测结论（2026-10-17，Intel Mac + 系统代理 127.0.0.1:51279）

| 通道 | 结果 |
|---|---|
| `music.gdstudio.org/api.php`（签名） | ✅ **直连可用**（Node fetch / 主进程 Axios 都行），`/time` 200，`tencent/kuwo/netease/tidal/apple/ytmusic/bilibili` 均能搜+取流 |
| `music.gdstudio.xyz/api.php` | ❌ 本机超时（此前「xyz 直连可用」的结论按网络环境而异，需现场复测）→ 插件把它做成可切换的备用站 |
| `music-api.gdstudio.xyz/api.php`（免签名 mirror） | ✅ 可用但**只有 netease / joox**；`joox` 搜得到《晴天》却取流为空 |

**音源可用性（org 站点）**：`migu / kugou / spotify / deezer / ximalaya` 返回
`Value of source is not supported.`（与「国内版音源被下架过一部分」的记录一致）。

**签名可以在纯 JS 里跑，不需要 Node 的 `vm`**（这是插件能成立的关键）：
把 `crc32.min.js` 用 `new Function("sandbox", "with(sandbox){...}")` 执行，
`sandbox` 是一个 `has:()=>true` 的 Proxy——未声明的标识符先落到 sandbox（提供
`location.hostname` / `mkPlayer.version` / 假 `XMLHttpRequest` 返回当前秒级时间戳），
缺失的再从真实 `globalThis` 兜底。这样站点升级加新依赖也不会立刻炸，且渲染进程未启用 CSP 限制 `unsafe-eval`。

**两个新踩的坑（此前文档没有）**：

1. **`br` 是标称档位，不是真实码率**。`types=url&br=999` 返回 `br:999`，但《晴天》55,397,039 字节 / 269 秒
   反推是 **1647kbps**。如果用 `size*8/br` 估时长来做版本校验，会把真无损全部判成「时长不符」而丢掉
   （实测导致 5 首里 4 首降级成 128k、1 首直接无结果）。
   正确做法：`实际码率 = size*8/播放器已知时长`，再按档位区间校验（999→420~4600、320→230~400、128→88~175）。
2. **签名入参只能编码一次**。查询串里用 `encodeURIComponent(name)`，签名也对该编码串计算；
   若再经 `URLSearchParams` 二次编码，服务端解出来的值对不上 → 一律 `{"detail":"Invalid request."}`
   （`types=url` 的主参数是 `id` 而不是 `name`；`joox` 的 id 含 `+ / =`，这大概就是它取流为空的原因之一）。

## 14. 插件设计要点

- **模式**：兜底（`after-catalog`，默认）/ 优先（`before-catalog`）/ 关闭；改模式重新注册。
- **匹配**：曲名/歌手归一化（繁→简、去标点）+ 二元组 Dice；查询未写 Live/Remix 而候选带 → 重罚。
- **省配额**：请求串行 300ms 间隔 + 搜索缓存 30min + 地址缓存 20min（站点限流口径 50 次/5 分钟）。
- **特效音轨**（人声/伴奏分离）GD 没有，`match` 里直接放行给宿主。
- 实测 6 首（晴天/稻香/富士山下/Bohemian Rhapsody/海阔天空/起风了）全部命中，5 首真 FLAC，
  单首 2.2~6.3 秒；6 首里包括 EchoMusic 原本会失败的两首 VIP 曲目。

---

# 补充（2026-10-17 下午）：下载 + 页面 + 代理（v1.1.0）

> 在音源兜底之上加了「单曲/批量下载 + 侧边栏前端 + 代理面板」。本节只记**平台事实**与坑。

## 15. 插件 UI 与下载 API（以 v2.3.2-beta.16 为准）

| 需求 | 正确入口 | 备注 |
|---|---|---|
| 注册整页 | `ctx.ui.addPage({ id, title, icon, order, component, sidebar })` | **没有** `ctx.ui.pages.register`；`sidebar` 传 `true` 或 `{section:'plugins', title}` 才会出现在侧边栏 |
| 注入样式 | `ctx.css.inject(cssText, { id })` | 第二个参数是 `{id}`，不是字符串 |
| 选保存目录 | `ctx.fs.requestDirectory({access:'read-write', purpose, persist})` | 返回 `{ok:true,canceled:false,directory}`，`DirectoryRef` 带 `id/displayPath` |
| 大文件下载 | `ctx.net.download({url, target:{directoryId, relativePath}, headers, name, conflict:'rename'})` | 返回 handle：`subscribe/getSnapshot/wait/pause/resume/cancel`；`wait()` → `{taskId, file, bytes}` |
| 读当前队列 | `ctx.playlist.getQueueSongs()` | 直接给 `Song[]`，批量导入用这个最省事 |

**版本门槛**：下载/目录授权/`getPrivateDirectory` 都是 `2.3.2-beta.10` 才进主线的。
2.3.1 的 `ctx.fs.writeFile` 只能写插件目录、**没有 append**、也没有任何下载传输接口——
所以旧版根本做不了大文件落盘（8 MiB 上限 + 无法续写），别在那上面浪费时间。
manifest 里 `requires.echoMusicVersion` 写 `>=2.2.6` 即可：能力缺失时插件自己降级（保留音源兜底 + 复制直链）。

**并发**：宿主全局最多 3 个传输、单插件 2 个，队列预算单插件 50。插件的下载队列就按 2 并发设计。

## 16. 代理到底能不能由插件控制

- EchoMusic 的代理是**应用级**的（`设置 → 网络`：system / direct / pac_script / fixed_servers，
  含用户名密码、bypass 规则），主进程 `axios.defaults.adapter = createElectronAxiosAdapter(...)`，
  所以**插件里 `ctx.net.request`、`ctx.net.download`、媒体播放全都自动跟随宿主代理**，没有 per-request 代理参数。
- 想在插件里改它：走 preload 的 `window.electron.network.get()` / `.update({settings})`，
  与设置页同一个通道；改完再 `ctx.stores.settings.applyNetworkSettings(result.settings)` 同步 store。
  注意这会**全局生效**（连酷狗播放一起），UI 上必须写清楚。
- 出口自检的省事办法：请求 `https://music.gdstudio.org/cdn-cgi/trace`，会回
  `ip/loc/colo`，一眼看出代理是否真的生效（本项目实测直连出口是 `120.229.69.46 / CN`）。

## 17. 下载页设计取舍

- 文件名 `歌手/歌名.ext`，扩展名从 URL 猜（flac/mp3/m4a/ogg），猜不到按码率兜底。
- 队列在内存里，刷新页面不丢（引擎挂在插件上下文），重启客户端会丢；宿主自己保留了任务记录
  （`ctx.net.downloads.list/attach`），后续要「重启续传」再补。
- 批量导入只认「歌名 - 歌手」一种文本格式，解析不了的行按整行当关键词搜。
- 下载不做元数据内嵌/歌词旁挂：仍由 `flac_metadata_embedder.py` 统一处理，避免两边逻辑打架。




---

# 补充（2026-10-17 下午·二）：把下载入口塞进原生 UI（v1.2.0）

> 用户要的是「播放栏一个下载按钮、批量操作面板一个批量下载」，不是侧栏页面。
> 结论：**播放栏有官方 API，批量面板没有——只能 DOM 注入**。

## 18. 三个入口的可行性与实现

| 位置 | 官方 API | 做法 |
|---|---|---|
| 播放栏右侧 | ✅ `ctx.ui.playerbar.register({ id, title, icon, defaultPlacement:'right', order, badge, onClick })` | 直接用；`badge: () => String(n)` 配一个 Vue `ref` 就能让角标随下载队列更新 |
| 歌曲右键菜单 | ✅ `ctx.ui.addSongContextMenuItem({ id, label, order, danger, visible, enabled, onSelect(song) })` | 直接用 |
| 批量操作面板 | ❌ 全仓库搜不到 `batchActions` 扩展点 | `ctx.dom.observe('.batch-footer .batch-actions', el => {...})` 注入按钮 |

**批量面板注入的三个要点**：

1. **样式**：SFC 的 scoped CSS 选择器带 `[data-v-xxxx]`，注入的 `<button>` 不匹配。
   把原生按钮的 `data-v-*` 属性**全部复制**到新按钮上，就能直接复用 `.batch-action` 的样式，不需要自己写一套。
2. **选中状态**：`BatchActionDrawer.vue` 里 `selectedSongs` 是组件内 computed，且列表用
   `useVirtualList` **只渲染可见行**——读 DOM 只能拿到屏幕上那几首，全选 60 首时严重漏项。
   正确做法是从 Vue 组件树里取实例：`ctx.app._instance` 起 BFS 遍历 `subTree`/`vnode.component`，
   按 `type.__name === 'BatchActionDrawer'` 命中后读 `instance.setupState.selectedSongs`
   （`setupState` 是 proxyRefs，computed 会自动解包）。
   注意 `el.__vueParentComponent` 在生产构建里通常**不存在**（受 `__DEV__ || __FEATURE_PROD_DEVTOOLS__` 保护），
   所以要走 `ctx.app` 而不是从 DOM 元素往上摸。
3. **数量联动**：面板顶部的 `.batch-count` 文本形如 `3/60`，用 MutationObserver 盯着它改按钮文案/禁用态即可，
   不必自己去读选中集合。

**降级**：组件树取不到实例时退回解析 `.batch-row.is-selected` 里的 `.song-title` / `.song-artist-list`，
只覆盖可见行，但至少不会完全失效。

## 19. 顺带确认的两件事

- 站点签名**时间戳不是冻结的**：同一入参的签名每秒都在变（`6B15EF1A → D695E47A → 135EBDF7`），
  连续 12 次请求全部 200，所以之前偶发的 `401 Invalid request` 是**测试桩丢了 User-Agent** 导致的，
  不是签名过期。真机里 `ctx.net.request` 会带浏览器 UA，不受影响。
- 批量下载失败不要逐条弹 toast：`enqueue(items, { quiet: items.length > 1 })` 给任务打标，
  失败回调只对单曲入口提示，批量看「GD 下载」页的队列详情。
