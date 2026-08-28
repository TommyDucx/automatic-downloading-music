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
