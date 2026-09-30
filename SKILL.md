---
name: music-processing-skills
agent_created: true
description: >-
  批量下载高品质FLAC音乐（GD音乐台多音源），自动按音乐风格分文件夹管理，
  下载时顺带抓取站点「歌曲详情」（专辑/封面/歌词+翻译）存入本地索引，内嵌时零 API 直接复用，
  为每首歌内嵌完整元数据（歌名、歌手、专辑、风格、年份、歌词、封面）的完整工作流。
  内置 Embeat 推荐客户端（网页版直连：按自然语言描述或种子歌推荐相似曲目，可一键转下载；
  embeat-recommend.js 纯 Node 现算站点签名，无需浏览器、无需本地数据库）。
  当用户要求「下载歌曲」「批量下载音乐」「整理音乐库」「内嵌元数据」「给歌曲加歌词/信息」
  「推荐歌曲」「类似XX的歌」「帮我想点听的音乐」时使用。

## 路径约定

下文命令中使用两个变量，执行前先设置（或替换成你的实际路径）：

```bash
# 本技能目录（脚本都在 scripts/ 子目录）。按实际安装位置取其一：
#   WorkBuddy:  $HOME/.workbuddy/skills/music-processing-skills
#   opencode:   $HOME/.config/opencode/skills/music-processing-skills
SKILL_DIR="$HOME/.workbuddy/skills/music-processing-skills"
MUSIC_DIR="$HOME/Documents/automatic downloading music"              # 音乐库根目录（下载存放处）
```

脚本是**路径无关**的：下载器用 `--out` 指定输出目录，元数据脚本用 `--downloads-dir` 指定要处理的目录。
所以任何目录都能作为 `$MUSIC_DIR`，不必是上面这个默认值。

## 环境前置检查（首次使用）

```bash
which node      && node -v        # 下载器需要 Node（零第三方依赖）
which metaflac  || brew install flac
python3 -c "import requests, bs4, rapidfuzz, syncedlyrics" \
  || python3 -m pip install requests beautifulsoup4 rapidfuzz soupsieve syncedlyrics
```

> 注意：`flac_metadata_embedder.py` 在缺依赖时会**自动**执行 `pip install` / `brew install`。
> 不想让它自动装系统包的话，先手动装好，脚本检测到存在就会跳过。

---

# 音乐批量下载与元数据内嵌

从下载歌曲到内嵌完整歌曲信息的端到端流程，可复用。

## 完整工作流（4 步）

```
1. 建立音乐风格目录 + JSON 歌单
2. 批量下载 FLAC（gd-browser-downloader.js）——下载同时抓站点歌曲详情写入 .downloaded.json
3. 内嵌元数据 + 歌词 + 封面（flac_metadata_embedder.py，优先消费本地详情）
4. 验证元数据
```

## 工作目录

技能脚本与歌单统一放在项目的 `downloads/` 下，按风格分子文件夹：

```
downloads/
├── 01-梦幻复古合成器与波形律动-Synthwave-Chillwave/
│   ├── playlist.json
│   ├── HOME - Resonance.flac
│   └── HOME-Resonance.lrc          ← 歌词与歌曲同文件夹
└── 02-空灵未来贝斯与电音切片-Melodic-Future-Bass-Glitch/
```

## 规则：歌词与歌曲同文件夹

**歌词文件必须保存在歌曲所在文件夹内，与音频文件同目录，且与音频同名**
（`Nujabes - Battlecry.flac` → `Nujabes - Battlecry.lrc`），不得放在独立的总 lyrics 目录。

> ⚠️ 命名已从 `歌手-歌名.lrc` 改为**与音频同名**。同名才是播放器自动匹配的前提；
> 两条歌词路径（`flac_metadata_embedder.py` 与 `download_lyrics.py`）现在都用这一套命名，
> 否则同一首歌会被写出两份命名不同的 .lrc。

原因：方便单文件夹整体拷贝/同步，播放器按目录读取歌词时无需额外配置。

实现要点（`flac_metadata_embedder.py`）：
- `download_lyrics(title, artist, save_dir=歌曲所在文件夹)`
- 批量模式传 `save_dir=folder`（当前遍历的风格文件夹）
- 单文件模式传 `save_dir=flac_path.parent`
- 若歌词按旧逻辑被存到 `lyrics/` 总目录，需用「按 歌手-歌名 归一化匹配」脚本移到歌曲文件夹，并删除空 lyrics 目录。

### 歌词移动脚本（旧数据归位用）
```python
import os, re, shutil
def norm(s): return re.sub(r'[\s\-_]+', '', s).lower()
# 建立 audio 索引后，把 lrc 按 norm(歌手-歌名) 匹配移动即可
```

## 步骤 1：建目录与歌单

每首歌单 `playlist.json` 为数组，元素 `{"title": "...", "artist": "..."}`，**必须用真实歌手/曲名**，不要带 "(Instrumental)" "(Ambient Reprise)" 等不存在版本后缀，否则搜不到。

目录名建议：`NN-中文描述-StyleTag`（StyleTag 用于映射 GENRE）。

**歌单链接直导（新）**：不想手写 JSON 时，可用 `playlist-importer.js` 把分享链接解析成曲目列表（借鉴 EchoMusic 的多平台歌单导入思路）：

```bash
# 解析歌单链接 → 标准 playlist.json（供下载器 --list 使用）
node "$SKILL_DIR/scripts/playlist-importer.js" "https://music.163.com/playlist?id=7403678821" --out downloads/01-xxx/playlist.json
node "$SKILL_DIR/scripts/playlist-importer.js" "https://y.qq.com/n/ryqq/playlist/8612270405" --out playlist.json
node "$SKILL_DIR/scripts/playlist-importer.js" "https://open.spotify.com/playlist/xxx" --out playlist.json
node "$SKILL_DIR/scripts/playlist-importer.js" "歌手 - 歌名" --out playlist.json     # 纯文本直通
```

支持平台：网易云（含 163cn.tv 短链）、QQ 音乐、Spotify、酷狗（含短链）、汽水音乐、文本。
输出 `[{title, artist}]`；也可 `--txt` 输出 "歌名 - 歌手" 每行。纯数字 ID 需加 `--platform <平台>`。

下载器也可直接吃链接（免去中间文件）：

```bash
node "$SKILL_DIR/scripts/gd-flac-downloader.js" --playlist "https://music.163.com/playlist?id=xxx" --out <文件夹> --max 10
```

### ⚠️ 歌单制作经验：曲名/艺人名决定了匹配成败（2026-09-24 大规模实测）

CN 音源（netease/tencent/joox/kuwo）的搜索匹配**强依赖曲名与艺人名**，两类坑实测踩过：

1. **必须用中文曲名**：用 MusicBrainz 抓的英文/罗马音曲名（`Siwei`、`I Want You (Rudejack remix)`…）
   在 org 上全部 `匹配度不足`（0/12）。换成**中文热门曲名**后立刻能下（崂山道士 15MB / 黑马王子 42MB，
   24bit/48kHz）。满舒克/艾福杰尼的英文曲名部分能中（10/8），但中文曲名命中率远高。
2. **artist 必须用平台收录名**：`更高兄弟` 平台收录为 **Higher Brothers**、`功夫胖` 收录为
   **功夫胖KUNGFU-PEN**——写中文名 12 首全「匹配度不足」，写收录名立刻命中。

**拿正确曲目的方法**：搜不到歌单链接时，用 WebSearch 查「<歌手> 热门歌曲 代表作 / 演唱会歌单」，
票务网站（黄河票务）和百科（QQ 音乐百科/百度百科）会给出官方歌单级曲目列表，照抄即可。

**按可用性排产**：搜索失败的形态先分类再行动——
`匹配度不足/未找到` = 曲名或收录名问题 → 改列表重跑；`-32001/Invalid request` = 会话/签名故障 →
走自愈（见下节）；`找到但下载失败` = 取流问题 → 走取流级联（见下节）。
反复重试前先看失败形态，别盲试。

## 步骤 2：批量下载

### ✅ 首选：`gd-browser-downloader.js`（国际版/国内版双站通用，2026-09 起）

**为什么必须换**：2026-09 实测，GD 音乐台的 `/time` 与 `/api.php` 已全部置于 Cloudflare 机器人防护之后，
Node / curl 直连**一律 403 `Just a moment...`**——`music.gdstudio.org`、`music.gdstudio.xyz`、
`music-api.gdstudio.xyz` 三个域名都一样；但静态 `/js/player.js` 仍返回 200，**很容易误判成「站点还能用」**。
唯一稳定过法是**真实浏览器**跑完 JS 挑战拿到 `cf_clearance`。
> 2026-09-30 补充：主站对 curl 的浏览器指纹已放行（带有效签名直连 200，401=仅签名问题）。
> 纯 Node 签名器已抽成共用模块 `gd-signer.js`，下载器新增 **`--direct` 直连模式**
> （`embeat-recommend.js` 共用同一签名器）——日常优先直连，浏览器模式继续作为兜底。

#### 两种运行模式（2026-09-30 起）

| 模式 | 命令 | 特点 |
|---|---|---|
| **直连（推荐日常）** | 加 `--direct` | 纯 Node：`gd-signer.js` 把站点 `crc32.min.js` 装进 vm 现算签名 + curl 调 `api.php`；无浏览器、不受 Cloudflare 时段挑战影响；签名被拒自动刷新重试；实测 3~10 秒/首 |
| 浏览器内核（默认） | 不加参数 | 页面上下文里跑站点自己的 `crc32()`，对站点改动最免疫；受 CF 间歇性挑战影响、启动慢 |

直连实测（2026-09-30）：xyz/org 双站全链路通过（search → url → 下载 → 站点详情抓取），
连续多轮无失败；多音源扫描正常（qobuz 24bit/48kHz 1411kbps 下载验证通过）；
`--enrich` 亦可用。直连失效（站点大改签名 shim）时回退浏览器模式，**两条路都在脚本里**。

浏览器模式的三段式设计：
1. 幂等拉起一个带 `--remote-debugging-port` 的 Chrome（独立 profile `~/.gd-chrome-profile`，校验 cookie 可跨次复用）
2. 通过 CDP（Node 22 内置 WebSocket，**零第三方依赖**）导航到站点并等挑战通过
3. **所有 `/api.php` 调用都在页面上下文里用站点自带的 `crc32()` 签名**；
   音频文件在 CDN 上、不受 Cloudflare 保护，仍由 Node 直连流式下载（更快、可校验魔数）

```bash
# 直连模式（推荐：无浏览器）
node "$SKILL_DIR/scripts/gd-browser-downloader.js" "Resonance - HOME" --site xyz --direct
node "$SKILL_DIR/scripts/gd-browser-downloader.js" --site org --list songs.json --out "<文件夹>" --direct
# 国际版（满血：netease kuwo joox qobuz tidal apple ytmusic tencent）
node "$SKILL_DIR/scripts/gd-browser-downloader.js" --site xyz --list songs.json --out "<文件夹>" --br 999 --delay 4
# 国内版（直连，音源被下架过一部分）
node "$SKILL_DIR/scripts/gd-browser-downloader.js" --site org --list songs.json --out "<文件夹>"
# 歌单链接直导 / 限数量 / 只要无损
node "$SKILL_DIR/scripts/gd-browser-downloader.js" --playlist "https://music.163.com/playlist?id=xxx" --max 10 --lossless-only
```

CLI 与旧脚本保持一致（`--list` `--playlist` `--sources` `--br` `--br-min` `--strict-br` `--lossless-only`
`--out` `--delay` `--max` `--force`），输出仍是 `歌手 - 歌名.扩展名` + `<out>/.downloaded.json` 索引，
可直接接 `flac_metadata_embedder.py`。新增：`--site xyz|org`、`--select quality|first`、`--chrome-port`、
`--chrome-profile`、`--chrome <路径>`、`--proxy <url>`、`--show-window`（默认窗口在屏幕外）、
`--keep-chrome`（跑完保留浏览器，下次启动更快；默认跑完自动关掉自己拉起的那个）、
`--attach`（只复用已开的调试端口，不新拉起）、`--enrich`（给旧索引补抓站点详情，见下）、
`--direct`（直连模式：不用浏览器，Node 现算签名 + curl，见上「两种运行模式」）。

#### ✅ 下载时顺带抓取站点「歌曲详情」（2026-09-30 新增，替代已死的 mirror 刮削）

站点每首歌都有自己的「歌曲详情」弹窗（歌名/歌手/专辑/时长/来源/歌曲ID/文件大小/播放音质/
歌词/封面），数据全部来自同一次 search 命中 + `types=pic` + `types=lyric`。
下载器现在**在下完每首歌后、还在浏览器会话里**时顺手抓齐这些字段，写进 `<out>/.downloaded.json`：

```json
{
  "汪苏泷 - 巴赫旧约": {
    "file": "汪苏泷 - 巴赫旧约.flac", "src": "netease", "br": 999, "size": 26255000, "site": "org",
    "track": { "id": "165405", "name": "巴赫旧约", "artist": ["汪苏泷"], "album": "巴赫旧约",
               "duration": 227, "source": "netease", "pic_id": "...", "lyric_id": "...", "has_hires": false },
    "cover_url": "https://p2.music.126.net/...jpg",
    "lyric": { "lyric": "[00:01.00]...", "tlyric": "" }
  }
}
```

- 封面 `types=pic` 依次试 1000/640/500/300，成功后按站点同样逻辑去掉 `?param=WxH` 拿原图；
- 歌词 `types=lyric` 同时拿 `lyric` 与 `tlyric`（翻译）；
- 抓详情失败**不影响下载**（字段留空，内嵌器回落）；
- 旧下载的索引条目没有 `track` 字段 → 加 `--enrich` 重跑同一条命令即可补抓（只搜索+抓详情，
  **不重新下载音频**）：

```bash
node "$SKILL_DIR/scripts/gd-browser-downloader.js" --list songs.json --out "<文件夹>" --enrich
```

内嵌器（下一步）会优先消费这份本地详情，专辑/封面/歌词都不再依赖已被 Cloudflare 全站拦截的
`music-api.*` mirror。**新下载全自动，无需额外操作。**

要求：**Node ≥ 22**（提供内置 WebSocket）+ 本机有 Chrome/Chromium。首次运行会弹出一个独立 Chrome 窗口，属正常。

#### ⚠️ 站点改版追踪（站点会随时升级，下载器须跟着改）

改版判断技巧：看静态资源版本号——`curl` 首页 grep `js/*.js?v=日期`，版本号变了就 diff 一下对应 js。
GD 音乐台的 js 是**非混淆明文**（只有 `crc32.min.js` 混淆），能直接读出请求方案。

| 日期 | 改动 | 对下载器的影响 |
|---|---|---|
| 2026-09-25 | `/api.php` 由 **POST 改为 GET**（`js/ajax.js?v=20260925`），参数名不变（`types/search/url`、`pages=`），签名算法不变 | 老脚本全源 401 `{"detail":"Invalid request."}`——**签名没坏、方式变了**。已在 `api()` 里改成 `fetch('/api.php?'+payload+'&s='+s, {method:'GET'})` |
| 2026-09-25 | 个别音源取流返回**相对路径**（如 `cache/apple_xxx.m4a`） | Node fetch/curl 都无法解析（`Invalid URL` / 502）。取流前补全 `https://<站点host>/` 前缀（已修） |
| 2026-09-25 | Cloudflare 无头挑战**间歇性死循环**（"Just a moment..." 刷不过，过几分钟到几小时自愈） | 不是永久封锁，先怀疑限流软禁；换时间重试。另：**下载器运行时绝不要再手动 attach 同一页面的 CDP**——第二个 WebSocket 会挤掉/干扰调试会话，让 evaluate 全部挂起（表现为无任何音源输出地卡住） |

稳健性参数（2026-09-25 调优）：`api()` evaluate 超时 60s→25s（坏会话快速失败换源，避免整夜每首卡 35 分钟）；批量 `--delay` 用 6（站点限流口径 50 次/5 分钟 ≈ 6s/次）。

#### 📏 经验回写规则（standing rule）

每次排障获得新结论（站点改版、新故障模式、新参数），**必须当次回写更新本 skill**，不要只写进对话或记忆——skill 是下次开工时唯一自动加载的经验库。

#### 📏 仓库同步规则（standing rule）

本 skill 有源仓库 GitHub `TommyDucx/automatic-downloading-music`（仓库根目录即 skill 源文件）。
**每次更新 skill 后必须**：
1. 同步安装副本，保持与仓库一致：`~/.config/opencode/skills/music-processing-skills/`（SKILL.md + scripts/）与
   `~/.workbuddy/skills/music-processing-skills/`（脚本在 scripts/ 子目录）；
2. 把变更 commit 并 push 到 GitHub（`git push origin`），不要留在本地未提交。

#### 选源机制：全源扫描 → 择优（默认 `--select quality`）

**不要相信接口返回的 `br`**。站点会把各源归一化标注，实测虚标严重——同一首《Resonance》：
netease 报 `636`、joox 报 `999`，但按 `size/duration` 反推的**实际码率都只有 ~630kbps**；
qobuz 报 `999`、实际 `1411kbps`（24bit/48kHz 真 Hi-Res）。所以真正的品质信号是**实际码率**。

流程（`scanSources()` → `candidateScore()`）：
1. **扫描**：按 `--sources` 把每个源都搜一遍 + 取流一遍，合格的全进候选池（**不提前挑**）
2. **打分**：`无损 +4e6`、`源声明 has_hires +1e6`、`实际码率×10`（主信号）、
   `来源微调 ×100`（qobuz/tidal > apple/netease/tencent > joox/kuwo）、`匹配分微调`；
   有损且 <192kbps 额外扣 2e5
3. **择优 + 兜底**：打印排序表 → 选第一名下载，失败自动回落次优

```
[i] 全源扫描：4 个可用候选，按实际品质排序 ——
     1) qobuz    FLAC 标称999k 实际≈1411k 35.6MB has_hires✓  匹配130 → 采用
     2) netease  FLAC 标称636k 实际≈639k 16.1MB 已降级  匹配130   备选
     3) joox     FLAC 标称999k 实际≈630k 15.9MB  匹配130   备选
     4) apple    M4A 标称256k 实际≈283k 7.1MB 已降级  匹配130   备选
[✓] 选定音源：qobuz（FLAC 标称999k 实际≈1411k 35.6MB has_hires✓）
[+] 完成 (qobuz FLAC, xyz): /tmp/gdscan/HOME - Resonance.flac (36MB)  实际: 48.0kHz 24bit 2ch 1404kbps
```

同曲 A/B 实测（`--select quality` vs `--select first`）：

| 策略 | 选定源 | 体积 | 实测参数 |
|---|---|---|---|
| `quality`（默认） | qobuz | 36MB | 48.0kHz **24bit** 1404kbps |
| `first`（旧行为） | netease | 16MB | 44.1kHz 16bit 636kbps |

下载完成后会用 macOS 自带 `afinfo` 实测 `采样率/位深/声道/码率` 打在日志里（零依赖），
避免「文件下下来了但不知道是不是真无损」。想省配额就 `--select first`（命中首个无损即停，会漏掉更高品质的源）。

### 🥇 备选（更省事、音质更高）：`chksz-downloader.js`

GD音乐台被 Cloudflare 拦着，只能靠浏览器绕；**ChKSz API** 是普通 HTTPS 接口、**没有 WAF**，
只要一个免费 apikey 就能直连，档位还更高（网易云 `jymaster` 超清母带 / QQ·酷狗 `master`）。

> ⚠️ **2026-09-19 实测：ChKSz 已暂停邮箱注册**（页面全局 `emailRegistrationEnabled=false`，
> 点注册直接提示「当前已暂停邮箱注册」），**只剩 LinuxDo OAuth 一条路**：先注册 linux.do 论坛账号 →
> 用 OAuth 登录 api.chksz.com → 账户页「查看密钥」。key 是服务端签发+服务端校验的，
> 客户端逆向拿不到（前端只有输入框，CPlayer / 官方 lx 脚本也都是让你自己填 key），不要在这上面浪费时间。
> 没有 key 时继续用上面的 GD音乐台方案即可（同样免费且能到 24bit 真无损）。

```bash
export CHKSZ_KEY=你的密钥
node "$SKILL_DIR/scripts/chksz-downloader.js" --list songs.json --out "<文件夹>" --level jymaster --lyrics
node "$SKILL_DIR/scripts/chksz-downloader.js" "晴天 - 周杰伦" --level hires --out "<文件夹>"
```

参数：`--key`（或环境变量 `CHKSZ_KEY`）、`--level jymaster|hires|lossless|exhigh|standard`（默认 jymaster，
拿不到逐档降）、`--strict-level`、`--lossless-only`、`--lyrics`、`--api-base`（可指自建/镜像）、
以及通用的 `--list/--playlist/--out/--delay/--max/--force`。输出约定与上面完全一致，可接同一个
元数据内嵌流程。GitHub 音源调研结论见音乐库根目录的 `音源调研-2026-09.md`。

### （旧）`gd-flac-downloader.js` —— 直连模式，现已被 Cloudflare 拦截

保留作参考与备用（若将来站点撤掉防护仍可直接用）。用法：

```bash
node "$SKILL_DIR/scripts/gd-flac-downloader.js" --list <playlist.json> --out <歌曲文件夹> \
  --sources netease,joox --delay 4
# 只收无损（没有 FLAC 就报失败，不降级）：加 --lossless-only
```

参数：
- `--sources`：netease,joox,tencent,kuwo,migu,qobuz,spotify,apple,ytmusic（逗号分隔）
- `--delay`：请求间隔秒数；默认 3，批量下载务必 ≥4
- **格式优先级（默认行为）**：没有无损就存有损里**品质最高**的那份，扩展名按实际格式落盘
  （`.flac` / `.mp3` / `.m4a` / `.ogg`…）。评分 = 无损 +1e6 + 码率，跨音源择优，不是「最后一个说了算」
- `--lossless-only`（别名 `--flac-only` / `--no-fallback`）：**只要无损**，拿不到就报失败。
  想严格只收 FLAC 时用它；`--fallback` 保留为兼容别名，如今已是默认行为
- `--br 999|740|320`：目标音质，默认 999（24bit FLAC）
- `--br-min 320`：音质降级链下限，默认 128。**降级链**：目标 br 拿不到时自动逐档向下试（999→740→320→192→128），同一音源内先降级再换源，借鉴 EchoMusic resolver 的候选降级思路
- `--strict-br`：关闭降级，目标 br 拿不到就直接换下一音源
- `--playlist <链接>`：歌单链接直导（网易云/QQ/Spotify/酷狗），免手动写 JSON
- `--max <n>`：最多下载前 n 首（歌单很大时限制数量）
- `--force`：已存在也重新下载；不传则已存在文件直接跳过（不耗 API 配额）

已下载记录写入 `<out>/.downloaded.json`（本地缓存兜底）：同一首歌名重复运行直接跳过，不消耗搜索/取流配额。

驱动脚本 `run_all.sh` 顺序遍历 `downloads/0*/playlist.json` 逐个文件夹下载，日志写 `/tmp/gdmusic_batch.log`。

### （旧）国际版批量下载（gd-international-downloader.js）—— 同样已被 Cloudflare 拦截
按关键词搜索下载（网易云 / 酷我），自动跳过已存在文件；**同样内置音质降级链**（按音源支持档位从目标档向下）：

```bash
node "$SKILL_DIR/scripts/gd-international-downloader.js" "Taylor Swift" netease 999 5    # 网易云 FLAC（999 拿不到自动降 320）
node "$SKILL_DIR/scripts/gd-international-downloader.js" "流行音乐" kuwo 320 10        # 酷我 320k
node "$SKILL_DIR/scripts/gd-international-downloader.js" "周杰伦" netease 999 5 cn     # 手动指定镜像
```

参数：`<关键词> [音源 netease|kuwo] [音质 128|192|320|999] [数量] [镜像 cn|hk|us|default]`
镜像缺省按音源自动分流：migu/kugou/ximalaya→cn，joox→hk，qobuz/ytmusic→us，其余→默认。

### 防限流关键（务必遵守）
站点对连续大量请求会临时限流/失效，症状（按出现频率排）：
- 全源搜索返回 `{"code":-32001,"message":"Session with given id not found."}`（**页面会话过期，非 200**，见下节自愈表）
- 搜索返回 `401 {"detail":"Invalid request."}`（签名被拒，多为 profile 陈旧，见下节）
- 下载卡死（401 递归死循环）

对策（已内置到下载器，JS 与 Python 两端一致）：
1. `apiCall(params, depth)` 对 401 做深度上限 4 的冷却重试，超过即抛错跳过，绝不无限递归
2. 401 细分处理：`ssa-code`/verify/captcha 等验证挑战头 → 等待 12s 单次重试；普通 401（签名过期/隐性限流）→ 指数退避；429 显式限流 → 尊重 `Retry-After` 头冷却
3. `politeDelay()`：`delay * (0.7 + Math.random()*0.6)` 随机抖动
4. `downloadOne` 开头先查 `.downloaded.json` 索引与同名音频文件，已存在则跳过，不发 API 请求
5. 触发限流后：kill 进程 → 等冷却 → 以更大 delay 续跑（已存在文件自动跳过 = 断点续传）

### 网络拓扑与渠道/音源清单（2026-09-30 全量核查）

**渠道（前端 `apis` 对象）**：

| 渠道 | 地址 | 状态（2026-09-30 实测） |
|---|---|---|
| 站点自身（lo） | `https://music.gdstudio.xyz/api.php` / `music.gdstudio.org/api.php` | ✅ **全音源**转发（前端所有请求都走这里）；需签名；**curl 直连已可行**（不再被 CF 拦，401=签名不对）；下载仍首选 `gd-browser-downloader.js`（无头浏览器 + 自动签名，最稳） |
| 官方 API 镜像 | `https://music-api.gdstudio.xyz/api.php` | ✅ **免签名直连**；但只支持 **netease / joox**（bilibili 返回空数组；tencent/kuwo/kugou/migu/qobuz/tidal/spotify/apple/ytmusic/deezer/ximalaya 报 `Value of source is not supported.`）；`search / url / pic / lyric` 全部可用 |
| 旧官方镜像 | `music-api-cn/-hk/-us.gdstudio.xyz` | ❌ 已下线（DNS 不解析） |
| 播放代理 | `https://music-proxy.gdstudio.org` | 站点播放 bilibili/tidal 时用的前端 `proxyUrl`，一般用不到 |

**音源清单（站点全量 15 个，来自前端 `copyrightBox` 映射 + `album_sources`）**：
`netease` `tencent` `kuwo` `kugou` `migu` `joox` `qobuz` `tidal` `spotify` `apple` `ytmusic` `deezer` `ximalaya` `bilibili` `embeat`(推荐源)
- 前端默认屏蔽 `bansources:["tencent","kuwo","joox"]`（设置里可开）
- `cache_sources`（需服务端中转解密、播放较慢）：`ytmusic / deezer / spotify / apple`
- 前端 API `types` 全集：`search / search_album / search_playlist / url / pic / lyric / autosource / embeat_agent / embeat_by_track / playlist / userlist`

- **音频 CDN 不受 Cloudflare 保护**：`types=url` 拿到的 `url`（`m701.music.126.net` / `akamaized.net` / `tidal` 等）
  用 Node 直连即可，实测带 `Referer: https://<host>/` + 浏览器 UA 就返回 200 + 正确魔数（`fLaC`）。
- ⚠️ **繁简必须归一**：joox 返回的是繁体「周杰倫」，不做 `t2s` 转换会被判成「歌手不符」而整首跳过。
  `gd-browser-downloader.js` 会从站点拉 `/js/chinese-s2t.js` 缓存到 `.gd-flac-cache/` 并用于匹配。

### 签名算法（2026-09 逆向，重要）
```
s = md5( ts9 + "|" + location.hostname + "|" + version每段补零2位 + "|" + encodeURIComponent(入参) ).slice(-8).toUpperCase()
```
- `ts9` = `GET /time` 返回的 10 位秒级时间戳取**前 9 位**（10 秒粒度）；`version` 取自 `js/player.js` 的
  `mkPlayer.version`（当前 `2026.09.16` → 补零后 `20260916`）
- 调用点形如 `s=" + crc32(urlEncode(String(id)))`（见 `js/ajax.js`），入参是 **urlEncode 之后**的串
- ⚠️ **函数名叫 crc32，实际是 MD5，而且是被改过的 MD5**：文件里是 HMAC-MD5 结构（双垫常量
  `0x36363636` / `0x5c5c5c5c`），实测站点全局 `md5("abc") = 9ef90af686e68195b6f6d89b69d3c584`
  ≠ 标准 `900150983cd24fb0d6963f7d28e17f72`；用 183 个常见密钥爆破 HMAC-MD5 / `md5(key+msg)` /
  `md5(msg+key)` 全部未命中（密钥藏在 jsjiami v7 混淆字符串表里）
- **结论：不要在 Node 里复刻签名**，直接调页面里的 `crc32()`——顺带免疫站点后续改算法。
  `gd-browser-downloader.js` 的 `ensureSigner()` 会轮询等它就绪

### 浏览器窗口怎么处理（⚠️ 2026-09-24 大翻案：离屏方案作废，真无头翻案成功）

| 方案 | 结果（2026-09-24 实测，Chrome 153） |
|---|---|
| **真无头 `--headless=new`（+ compat 参数）** | ✅ **能过 Cloudflare**（`--no-sandbox --disable-gpu --disable-software-rasterizer --disable-dev-shm-usage`，全新 profile 也过）。**首选：零窗口、且比有头快得多**（实测单首 38 秒 vs 有头数分钟）。旧「被识破」结论作废 |
| **`open -n -j -g -a "Google Chrome.app" --args …` 隐藏实例** | ✅ 备选：App 处于隐藏状态时窗口根本不上屏，无需任何系统权限；无头被拦时用 |
| 有头 Chrome + `--window-position=-4000,-4000`（移出屏幕） | ❌ **作废**。Chrome 有窗口位置校验，会**把完全离屏的窗口自动拉回可见区域** → 每次启动都弹窗。这就是「总是弹窗」的真因，别再走这条路 |
| 抠出浏览器 `cf_clearance` 给 Node/curl 用 | ❌ 仍然 403（cf_clearance 绑 IP + TLS 指纹） |

`ensureChrome()` 的现行策略（**绝不弹窗，宁可失败**）：
1. 只允许两种**真正不可见**的启动模式：`headless` → `hidden`，逐一实测站点校验
   （`quickSiteCheck`：CDP 开标签到目标站，轮询 `/json/list` 的标题，离开挑战页即通过）
2. 哪种都过不了就直接报错退出（提示 `--attach` 手动复用），**绝不退回任何可见窗口**
3. 启动后仍做存活校验（崩了切 compat 参数，记 `.gd-flac-cache/chrome-mode.json`）
4. 跑完自动关闭自己拉起的 Chrome；`open -j` 拉起的实例没有 child 句柄，
   `closeOwnChrome()` 用 `pgrep -f "user-data-dir=<profile>"` 兜底定位（只杀自己的实例）

### 会话/签名三类故障与自愈（2026-09-24 实战，全部已内置修复）

| 症状 | 根因 | 自愈 |
|---|---|---|
| 全源搜索返回 `{"code":-32001,"message":"Session with given id not found."}` | 站点**页面级 session 有 TTL**，过期后所有音源全挂（实测王力宏 14/16 一次全灭）。⚠️ 该错误**以非 200 状态码返回**，只判 200 会漏 | `api()` 里**不看状态码**、响应体命中即触发 CDP `Page.reload {ignoreCache:true}` 硬刷新拿新会话再重试（原逻辑只 `ensureOnSite` 查标题不刷新页面，永远救不回来） |
| xyz 全源 `{"detail":"Invalid request."}`（签名被拒） | **共享 profile 里缓存了陈旧的 `crc32.min.js`/会话**（签名内含 version 串与 ts9） | ① 签名失效时同上硬刷新；② **xyz 一律用隔离 profile + 独立端口**（如 `/tmp/gd-xyz-profile` + 9444），别用共享的 `~/.gd-chrome-profile` |
| 走代理的 xyz 反复「会话失效→刷新→又失效」死循环 | **Clash 负载均衡轮换出口 IP**（实测采样两次 IP 不同），站点会话绑 IP，页面刷新救不了 | **xyz 直连完全可用**（无头直接过 Cloudflare，15 秒下到 FLAC），补缺一律不走代理。旧「国内访问 xyz 需科学上网」假设作废 |

**取流级联**（`downloadFile`，解决「搜索命中但下载失败」）：
`Node fetch` →（网络层 `fetch failed`，undici 对个别 CDN 不行）→ **curl 兜底**（UA/Referer/重试，
网络栈更皮实）→ **Chrome 自下载兜底**（`Browser.setDownloadBehavior` + 临时目录 + `Target.createTarget`
直开音频 URL——浏览器的「下载」不走 CORS）→ 页面取流 `fetchInPage`（**跨域必被 CORS 拦**，
`TypeError: Failed to fetch`，只当最后手段）。

**并行跑批的防串台**：同时开多个下载任务时，每个任务必须用**独立的 `--chrome-port` + `--chrome-profile`**
（实测组合：9333=主 org / 9444=xyz 补缺 / 9555=第二路 org）。共享端口会复用对方的标签页并把
`location.href` 导航到自己的站点，把对方任务打崩。
⚠️ 杀后台链的教训：链式 bash 脚本的**命令行全文**可被 `pkill -f` 匹配到，会连链一起误杀；
要么用更精确的特征（profile 路径/端口），要么把匹配串分段写（`pkill -f "xxx_""yyy"`）。


### ⚠️ 假限流：查询串含 `(` `)` `'` 时搜索必失败（实测 2026-08-29）

现象：标题里带半角括号或撇号时，所有音源都返回
`搜索失败（签名校验失败（可能触发站点限流，请稍后再试））`，**看起来像被限流，其实不是**——
同一时刻换成纯 ASCII 标题立刻正常返回（命中或 `未找到匹配曲目`）。

原因：`encodeURIComponent` **不会**转义 `!'()*-._~`，这些字符原样进入请求后服务端算出的
签名与本地不一致。凡是 `(` `)` `'` 参与的查询都会挂。
（2026-09-25 复测：改 GET 后行为一致——`Luv (sic) Grand Finale` 401，`Dancing With Your Ghost`
200，`&` `+` `#` `/` `%` `?` 都没事。**黑名单就是 `'` `*` `(` `)`**。）

**2026-09-25 起下载器已自动清洗**：`scanSources()` 里 `name.replace(/['*()\[\]（）]/g," ")` 后再发，
不会再踩这个坑；本节保留供手工调试/复刻时参考。

有效曲名对照：

| 想下的曲名 | 报错 | 改用 | 结果 |
|---|---|---|---|
| `Luv(sic) Part 2` | 签名校验失败 | `Luv sic Part 2` | netease 命中（但可能匹配到 A Cappella 版，音质低） |
| `Luv(sic) Part 3` | 签名校验失败 | `Luv sic Part 3` | 同上 |
| `World's End Rhapsody` | 签名校验失败 | `Worlds End Rhapsody` | 各源均 `未找到匹配曲目`（是真的没有，不是限流） |

排查口诀：**先用一个纯 ASCII 标题探一次**，能通就不是限流，而是标题里的标点问题；
按上表去掉 `(` `)` `'` 后重试。注意模糊匹配会把不同 Part 折叠到同一条结果（实测 joox 把
`Part 2` / `Part 3` 都指向同一首 `Luv(Sic)`，下到两个 30MB 的**完全相同**文件），
下完务必 `shasum` 查重再入库。

## 扩展：Embeat 歌曲推荐（网页版直连，2026-09-30 打通；无需浏览器、无需本地数据库）

**Embeat 是 GD音乐台自家的推荐系统**（开源：https://github.com/gdstudio-org/Embeat）：
EmbeatMLP 声学向量（"听起来像"）+ Track2Vec 歌单协同过滤（"大众口味"）+ 6291 个微流派标签，
多路召回融合，覆盖 200 万+ 歌手，冷门歌表现极稳。**线上接口免部署直接可用**，
返回标准曲目列表（结构与 search 相同），可直接接 `--list` 下载。

### 推荐决策树（拿到用户需求后怎么用）

| 用户诉求 | 用法 |
|---|---|
| 「推荐一些**类似 XX** 的歌」 / 「和 XX 听感像的」 | `--like "歌名 - 歌手"`（embeat_by_track，种子歌 = XX） |
| 纯描述/心情/场景（「深夜学习的轻柔 jazz hiphop」「健身蹦迪」） | `--desc "<描述>"`（embeat_agent，直接吃自然语言） |
| 「推荐 XX 歌手风格的新歌」 | 先 search 歌手热门曲 → 用它当种子；或直接 `--desc "XX 风格"` |
| 描述里点出了具体歌名 | 优先 `--like`（种子比描述精准） |

### ✅ 怎么调：`embeat-recommend.js`（首选，纯 Node + 系统 curl，零第三方依赖）

```bash
# 按描述推荐（agent）
node "$SKILL_DIR/scripts/embeat-recommend.js" --desc "深夜学习的轻柔爵士hiphop" --count 15
# 按种子歌推荐（by_track），并写出下载器能直接吃的歌单
node "$SKILL_DIR/scripts/embeat-recommend.js" --like "晴天 - 周杰伦" --count 15 --out recs.json
# 也支持 Spotify track id / ISRC 当种子、--site org、--json
node "$SKILL_DIR/scripts/embeat-recommend.js" --track-id 5pIcwtJYNJx93l420oR2Vm --count 10
```

拿到 `--out recs.json` 后直接下载（一气呵成）：

```bash
node "$SKILL_DIR/scripts/gd-browser-downloader.js" --list recs.json --out "<文件夹>"
```

**原理（为什么不用浏览器、不用本地库）**：
1) 签名复用站点自己的 `js/crc32.min.js`——丢进 Node `vm`，配 shims
   （`location.hostname`、`mkPlayer.version`（从 `js/player.js` 动态解析）、FakeXHR 返回 `/time`）
   即可现算签名（与 GDSTUDIO_REFERENCE.md 技巧 A 相同）；
2) 拿签名后**用 curl 直连主站 `api.php`**（Node 内置 fetch/undici 的 TLS 指纹会被拦，curl 不会）；
3) 签名被服务端拒绝（站点升级算法）时脚本自动拉新 `crc32.min.js` 重试。

### 接口契约（从 `js/ajax.js` 逆向，权威；站点改版后需复核）

两个都是**同源 GET**、签名规则与搜索完全一致（`s=crc32(String(urlEncode(主参数)))`）：

```js
// ① embeat_agent：自然语言描述推荐（走 ajaxSearch 通用路径）
//    name = urlEncode(描述原文)；实测 count 不生效（一次回全部候选），客户端自行截断
GET /api.php?types=embeat_agent&count=20&source=<source>&pages=1&name=<urlEncode(描述)>&s=<crc32(String(urlEncode(描述)))>

// ② embeat_by_track：种子歌推荐（函数 ajaxEmbeat）
//    name = urlEncode(JSON.stringify({name, artist, id, isrc}))；count 生效
//    - artist 取逗号分隔的第一位；id=Spotify track id（可空）；isrc（可空）；name+artist 必填其一组合
//    - source 不支持 bilibili；返回同 search 的曲目数组（source 字段为 "embeat"）
GET /api.php?types=embeat_by_track&count=20&source=<source>&pages=1&name=<urlEncode(JSON)>&s=<crc32(String(urlEncode(JSON)))>
```

⚠️ 查询串 WAF 黑名单同样适用（`'` `*` `(` `)` 会 401，见《假限流》节）——描述里带括号/撇号先清洗。

### 回退：浏览器内核方式（签名直连失效时）

```bash
node "$SKILL_DIR/scripts/embeat_page_test.js"   # 无头 Chrome → 过盾 → 页面里用站点 crc32() 发签名请求
```

### 本地自部署 Embeat（可选，仅离线/大批量才值得——2026-09-30 实测部署过，已按需删除）

网页版接口够用后**不建议本地部署**：mini 版 3.7GB 压缩 / 9.3GB 解压 / ~2.5GB 内存（1200 万+ 曲目），
full 版 17.5GB 压缩 / 40GB 解压 / ~20.5GB 内存；且**没有数据库等于零**（模型权重必须配合数据库使用）。
实测步骤（macOS Intel，无 Docker 也行）：

```bash
git clone https://github.com/gdstudio-org/Embeat && cd Embeat
conda create -n embeat python=3.10 -y
~/miniconda3/envs/embeat/bin/pip install "qdrant-client>=1.18.0,<1.19.0" "numpy<=1.26.4" gensim python-dotenv zhconv \
    beautifulsoup4 requests cloudscraper gdown      # 推理不需要 torch
# Track2Vec 权重（HF: GD-Studio/embeat-track2vec）→ checkpoints/Track2Vec/track2vec.wv(+vectors.npy)
# Qdrant 必须 1.18.x（README 强调）：github release 的 qdrant-x86_64-apple-darwin.tar.gz 解压即用
# 数据库：Google Drive 文件夹 1dFdueTmcWgGZXhJXs7c7YOjeniZsSW9x（v2_20260901/，mini/base/full 三档）
QDRANT__STORAGE__STORAGE_PATH=<解压出的 embeat_qdrant_db 目录> ./qdrant
cp .env.example infer/.env      # 注意 .env 要放 infer/ 下（代码读 file_dir/.env）
cd infer && python Embeat.py -s "晴天 - Jay Chou"   # 也支持 -t <track id/ISRC> / -a <歌手>
```

## 步骤 3：内嵌元数据


用 `flac_metadata_embedder.py`（Python + metaflac）批量处理：

```bash
python3 "$SKILL_DIR/scripts/flac_metadata_embedder.py" --downloads-dir <项目根目录>
# 单文件：
python3 "$SKILL_DIR/scripts/flac_metadata_embedder.py" --single-file "path/to/song.flac"
# 可选参数：
#   --gd-source netease|kuwo|qobuz|joox|migu|ytmusic   在线刮削音源（本地详情缺失时才用，默认 netease）
#   --no-cover                                        不内嵌封面
#   --no-gdmusic                                      完全不用 GD音乐台数据（本地 .downloaded.json 详情 + 在线刮削都跳过）
```

依赖：`brew install flac`（提供 metaflac）+ `pip3 install syncedlyrics requests beautifulsoup4 rapidfuzz soupsieve`。

> ✅ **信息/封面/歌词优先来自下载时抓取的站点详情**（`<文件夹>/.downloaded.json` 里的
> `track` / `cover_url` / `lyric` 字段，由 `gd-browser-downloader.js` 写入）。
> 零 API 请求、不依赖已被 Cloudflare 拦死的 `music-api.*` mirror。
> 旧下载缺详情时：`gd-browser-downloader.js ... --enrich` 补抓一次即可。

### 内嵌的字段（Vorbis 注释）
`TITLE` `ARTIST` `ARTISTS` `ALBUM` `ALBUMARTIST` `COMPOSER` `GENRE` `DATE` `TRACKNUMBER` `TOTALTRACKS` `COMMENT` + `LYRICS` + `LYRICS_TRANSLATED` + **封面（PICTURE 块）**

### 元数据来源逻辑
- `TITLE/ARTIST`：从文件名 `歌手 - 歌名.flac` 解析
- `GENRE`：优先查内置映射表（Synthwave-Chillwave → "Synthwave, Chillwave" 等）；
  未命中则**从目录名的 StyleTag 推导**（`Jazzhop-Lo-fi-Hip-Hop` → `Jazzhop, Lo-fi, Hip-Hop`，
  内置复合词表保证 `Lo-fi` / `Hip-Hop` 不被切成两个词）；再推导不出才回落 `Electronic` 并**告警**
- `ALBUM`：**优先取本地站点详情里的真实专辑名**（`track.album`，`modal soul` → `Modal Soul`）；
  本地没有才在线刮削；再取不到才回落「歌手 → 内置专辑表」，最后兜底 `{歌手} Collection`
- `DATE/COMPOSER`：仍按歌手查内置表 —— ⚠️ 搜索接口不返回年份，DATE 是**歌手级近似值**，
  一首歌跨专辑时可能不准（已知局限，暂无数据源可修）
- `TRACKNUMBER`：在 playlist.json 中的序号；未匹配默认 1
- `LYRICS`：syncedlyrics 搜索（**固定 providers = Lrclib,NetEase**），失败换 `https://api.lrc.cx/api/v1/lyrics/single`；再失败用下载时抓取的站点歌词（`.downloaded.json` 的 `lyric.lyric`），最后才在线 `types=lyric`；**先写 lrc 文件到歌曲文件夹，再读内容内嵌**
- `LYRICS_TRANSLATED`：站点详情的 `lyric.tlyric`（在线兜底则是 `types=lyric` 的 `tlyric`）
- **封面（PICTURE）**：下载时抓到的 `cover_url` 直链（CDN 直连）下载 -> `metaflac --import-picture-from` 内嵌；
  本地没有才回落「搜索 -> `pic_id` -> `types=pic`（尺寸 1000/640/500/300 回退）」
- 歌词入 Vorbis 注释前需清洗：去掉 `[00:00.00]` 时间戳行与元信息行（`作曲:` `作词:` 等），否则 `--import-tags-from` 会报 malformed vorbis comment
- **一次搜索三处复用**：本地无详情时 `resolve_gd_track()` 按 (曲名, 歌手) 缓存搜索命中，
  专辑名 / 封面 / 歌词共用同一次搜索，避免每首歌重复打 2~3 次 API（省配额、降限流概率）

### 本地站点详情（`resolve_local_meta`，2026-09-30 新增，首选）
- 读取歌曲文件夹的 `.downloaded.json`，按 `file` 字段（落盘文件名）精确匹配曲目；
  命中则专辑/封面/歌词/翻译全部直接用，不再打任何镜像 API
- 找不到详情时静默回落在线刮削；`--no-gdmusic` 则两者都跳过
- 数据来源与站点「歌曲详情」弹窗完全一致（见「步骤 2」的说明）

### GD音乐台在线刮削（仅本地详情缺失时报底）参考实现
- 接口形态与签名参考 [gdstudio-embeded-service](https://github.com/Azincc/gdstudio-embeded-service)（types=search/pic/lyric、封面尺寸回退、tlyric 翻译、镜像分流）
- ⚠️ **`music-api.*` mirror 已被 Cloudflare 全站拦截**（2026-09 实测），此路径只在本地详情缺失时尝试，大概率失败——正确姿势是 `--enrich` 补本地详情
- 签名沿用旧 crc32 方案：`s = crc32Hex(encodeURIComponent(name 或 id))`，POST 到 `<mirror>/api.php`
- **镜像分流**（缺省按音源自动选）：migu/kugou/ximalaya → `music-api-cn.gdstudio.xyz`，joox → `music-api-hk.gdstudio.xyz`，qobuz/ytmusic → `music-api-us.gdstudio.xyz`，其余 → `music-api.gdstudio.xyz`
- 请求失败按 1s,2s,4s,8s... 指数退避重试（上限 30s），符合站点限流口径（约 50 次/5 分钟）

### 踩坑
- **不要**用 `--import-tags-from <lrc>` 直接导入歌词（时间戳行非法），要用 `--set-tag "LYRICS=<清洗后文本>"`
- 文件名非 `歌手 - 歌名` 格式（如纯中文歌名）解析不到歌手/歌名，会跳过 → 手动改名或单独补元数据
- 封面内嵌前必须 `metaflac --remove --block-type=PICTURE` 清掉旧封面，否则重复堆积
- **（2026-09-25 实测）软链文件夹名必须以 `0X-` 开头**：embedder 的文件发现只 glob
  `<downloads_dir>/downloads/0*`，把 SD 卡目录软链成 `/tmp/embed_x/downloads/MSW-马思维-…`
  会扫到 **0 个文件**（总文件数 0，静默"成功"）。改成 `01-马思维-JazzHop-Hip-Hop` 后 38/38 正常内嵌。
- **（2026-09-25 实测）后台 bash 链里的 node 下载进程跑约 5 分钟会被 SIGTERM**
  （org/xyz 两次独立复现，exit 143）。对策：歌单大时不要指望一条链跑完，
  用「skip-existing + 分轮补跑」——重跑同一条命令会跳过已下曲目、只补缺口，第二轮即可跑完。

### 非 FLAC 音频：用 `download_lyrics.py` 单独补歌词

`flac_metadata_embedder.py` 依赖 metaflac，**只能处理 FLAC**。
要给 mp3 / m4a / aac / ogg / wav / wma 补歌词，用 `download_lyrics.py`
（只写 `.lrc` 文件，不改动音频本身）：

```bash
# 批量：递归扫目录，在每个音频旁生成同名 .lrc（已存在则跳过）
python3 "$SKILL_DIR/scripts/download_lyrics.py" "<目录>" --delay 0.4

# 单曲
python3 "$SKILL_DIR/scripts/download_lyrics.py" --title "Blinding Lights" --artist "The Weeknd" --out "<目录>"
python3 "$SKILL_DIR/scripts/download_lyrics.py" --song "Taylor Swift - Fortnight" --out ./
```

参数：
- `--force`：已有 .lrc 也重新下载
- `--plain-ok`：同步歌词找不到时接受纯文本（默认只要带 `[mm:ss.xx]` 的同步歌词）
- `--providers`：默认 `Lrclib,NetEase`（中英文覆盖好）
- `--lang zh`：中文歌词优先
- `--delay N`：批量模式每首之间的间隔秒数（默认 0.4）

行为约定（脚本内已固化，不要改）：
- 文件名解析不出「歌手 - 歌名」时回落到内嵌标签（需 `pip install mutagen`，可选）
- **找不到就如实报告，绝不编造歌词，也不写空文件污染目录**
- 结束后打印每个 `.lrc` 的完整绝对路径

> ⚠️ **歌词源必须限定 providers**。不指定时 `syncedlyrics` 会遍历全部源，
> 其中 Musixmatch / Genius / Megalobiz 在受限网络下会逐个超时，拖到整个调用返回 `None`。
> `flac_metadata_embedder.py` 里已固定为 `LYRIC_PROVIDERS = ["Lrclib", "NetEase"]`。
> 纯音乐（如 Nujabes 大部分曲目）本来就没有歌词，找不到是正常的，会走 GD `types=lyric` 兜底
> （返回的常是「纯音乐，请欣赏」这类占位文本，属预期）。

## 步骤 4：验证

```bash
metaflac --list --block-type=VORBIS_COMMENT "歌曲.flac"
metaflac --show-tag=TITLE --show-tag=ARTIST --show-tag=ALBUM --show-tag=GENRE "歌曲.flac"
```

## 🚀 使用方法（⚠️ 以下为 2026-08 的历史内容，已过时——请看上方《网络拓扑》《签名算法》）

### 原版网站（已过时：直连已被 Cloudflare 拦截）
```bash
# 使用现有的原版下载器
cd "$MUSIC_DIR"
node "$SKILL_DIR/scripts/gd-flac-downloader.js" playlist.json

# 注意：会自动检查已下载文件，避免重复下载
```

### 国际版网站（新功能）
```bash
# 下载网易云音乐歌曲（自动检查重复）
cd "$MUSIC_DIR"
node "$SKILL_DIR/scripts/gd-international-downloader.js" "周杰伦" netease 999 5

# 下载酷我音乐歌曲（自动检查重复）
node "$SKILL_DIR/scripts/gd-international-downloader.js" "流行音乐" kuwo 320 10

# 批量下载歌单（自动跳过已存在文件）
node "$SKILL_DIR/scripts/gd-international-downloader.js" "治愈系合成器" netease 999 20

# 手动指定镜像（cn/hk/us/default；缺省按音源自动分流）
#   migu/kugou/ximalaya→cn，joox→hk，qobuz/ytmusic→us
node "$SKILL_DIR/scripts/gd-international-downloader.js" "周杰伦" netease 999 5 cn
```

### 元数据内嵌
```bash
# 为下载的音乐添加元数据和歌词
cd "$MUSIC_DIR"
python3 "$SKILL_DIR/scripts/flac_metadata_embedder.py"
```

## 📋 重要提醒

### 1. 防重复下载
- ✅ **自动检测**：每次下载前检查文件是否已存在
- ✅ **智能跳过**：已存在的文件会被自动跳过
- ✅ **节省时间**：避免重复下载，提高效率
- ✅ **节省带宽**：减少不必要的网络流量

### 2. 文件存储
- ✅ **自动分类**：音乐按类型自动分类存储
- ✅ **标准命名**：统一的文件命名格式
- ✅ **路径管理**：所有文件存储在指定目录

### 3. 使用建议
- 🎯 **首次使用**：建议小批量测试，确认功能正常
- 🎯 **批量下载**：可以一次性下载大量歌曲
- 🎯 **断点续传**：网络中断后可以继续下载
- 🎯 **错误处理**：遇到错误会自动重试

| 域名 | 状态 | API 端点 | 备注 |
|------|------|----------|------|
| music.gdstudio.org | ✅ 可用（直连） | `/api.php` | 需 `gd-browser-downloader.js --site org --proxy "direct://"`（绕开系统代理）；2026-09-25 起 POST→GET、查询串禁 `' * ( )` |
| music.gdstudio.xyz | ⚠️ 时通时不通；**带有效签名时 curl 可用（2026-09-30 实测 search/embeat 均通）** | `/api.php` | 下载仍首选 `--site xyz`（浏览器内核）；Node 端签名器见 `embeat-recommend.js` |
| music-api.gdstudio.xyz | ⚠️ 免签名直连可用，但**仅 netease/joox** | `/api.php` | search/url/pic/lyric 都通；tencent/kuwo 等报 `Value of source is not supported.`；cn/hk/us 旧镜像已下线（DNS 不解析） |

**最新进展（2026-09-19）**：GD音乐台已全面置于 Cloudflare 之后，直连路线作废；改用浏览器内核（CDP）下载器，
并默认「全源扫描 → 按实际码率择优」；音频 CDN 仍由 Node 直连。
**2026-09-25 补缺实战**：org 缺的 29 首用 xyz 补，全源（netease/joox/kuwo/apple/qobuz/tidal/ytmusic/tencent）
搜索均正常返回但匹配度全不足 → 这些歌是曲库真没有（日韩地区下架曲/Phonk 冷门），换站点也救不了，别反复重试。

## 技术实现

### 国际版 API 特点
- **端点**：`https://music-api.gdstudio.xyz/api.php`
- **认证**：CRC32 签名计算
- **支持平台**：网易云音乐、酷我音乐
- **音质支持**：128k、192k、320k、FLAC

### 签名计算方法（⚠️ 以下为 2025 旧版推测，**已被推翻**）

> 实测（2026-09-19）：站点 `crc32()` **不是**纯 CRC32，而是「改造过的 MD5 + 隐藏密钥」，
> 完整算法与证据见上方《签名算法》。**不要按下面的代码去复刻。**

```javascript
// 【已作废】旧版以为是标准 CRC32，实际不成立
function crc32(input) {
    const polynomial = 0xEDB88320;
    let crc = 0xFFFFFFFF;
    let bytes = Buffer.from(input, 'utf8');
    for (let i = 0; i < bytes.length; i++) {
        crc ^= bytes[i];
        for (let j = 0; j < 8; j++) {
            if (crc & 1) crc = (crc >>> 1) ^ polynomial;
            else crc = crc >>> 1;
        }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}
```

### API 调用示例
```bash
# 搜索音乐
curl -X POST "https://music-api.gdstudio.xyz/api.php" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "types=search&count=20&source=netease&pages=1&name=HOME&s=4743E164"

# 获取音乐URL
curl -X POST "https://music-api.gdstudio.xyz/api.php" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "types=url&source=netease&id=442605343&br=320"
```

## 🎉 最新进展

### ✅ 成功完成的功能
1. **原版音乐.gdstudio.org**：完整的下载和元数据内嵌工作流
2. **国际版 music-api.gdstudio.xyz**：成功逆向工程，支持网易云音乐下载
3. **自动化脚本**：`gd-international-downloader.js` 完全可用
4. **防限流机制**：自动随机延迟，避免被封禁

### 📊 测试结果
- ✅ **网易云音乐**：FLAC格式下载成功（测试周杰伦歌曲）
- ✅ **搜索功能**：准确找到目标歌曲
- ✅ **URL获取**：成功获取高质量音乐链接
- ✅ **批量下载**：支持多首歌曲连续下载
- ❌ **酷我音乐**：部分歌曲可能因版权限制不可用

## 📁 目录结构

```
$MUSIC_DIR/
├── downloads/                          # 音乐下载主目录
│   ├── 01-梦幻复古合成器与波形律动-Synthwave-Chillwave/
│   ├── 02-空灵未来贝斯与电音切片-Melodic-Future-Bass-Glitch/
│   ├── 03-治愈系电子爵士与氛围节拍-Chillhop-Lofi-Synth-Electronica/
│   ├── 04-现代唯美电子与原声融合-Folktronica-Ambient-Pop/
│   ├── 05-极简太空漫游与深层沉浸-Space-Ambient-Modular-Synth/
│   ├── 06-细腻情绪与独立氛围电音-Emotional-Synth-Melancholy/
│   └── documentation/                  # 技术文档
│       ├── CRC32_IMPLEMENTATION_SUMMARY.md
│       ├── crc32_final.js
│       ├── crc32_comprehensive.js
│       ├── test_api_discovery.py
│       └── test_api_signature.py
├── flac_metadata_embedder.py           # 元数据内嵌脚本
├── gd-flac-downloader.js              # 原版下载器
├── gd-international-downloader.js     # 国际版下载器
└── playlist.json                      # 歌单文件
```

## 🎯 核心规则

### 1. 目录配置
- **主目录**：`$MUSIC_DIR/downloads`
- **分类文件夹**：按音乐类型自动分类
- **防重复下载**：每次下载前检查文件是否已存在

### 2. 下载规则
- ✅ **文件存在检查**：下载前检查目标文件是否已存在
- ✅ **自动跳过**：如果文件已存在，自动跳过下载
- ✅ **智能命名**：使用标准化文件名格式
- ✅ **错误处理**：完善的错误提示和重试机制

### 3. 文件命名规范
```
艺术家 - 歌曲名 [音源-音质].格式
例如：The Midnight - Sunset [netease-FLAC].flac
```

## 🚀 使用方法（⚠️ 以下为 2026-08 的历史内容，已过时——请看上方《网络拓扑》《签名算法》）

### 原版网站（已过时：直连已被 Cloudflare 拦截）
```bash
# 使用现有的原版下载器
cd "$MUSIC_DIR"
node "$SKILL_DIR/scripts/gd-flac-downloader.js" playlist.json
```

### 国际版网站（新功能）
```bash
# 下载网易云音乐歌曲
cd "$MUSIC_DIR"
node "$SKILL_DIR/scripts/gd-international-downloader.js" "周杰伦" netease 999 5

# 下载酷我音乐歌曲
node "$SKILL_DIR/scripts/gd-international-downloader.js" "流行音乐" kuwo 320 10
```

### 元数据内嵌
```bash
# 为下载的音乐添加元数据和歌词
python3 "$SKILL_DIR/scripts/flac_metadata_embedder.py"
```

## 🔧 技术特性

### 国际版下载器特性
- ✅ 多音源支持：网易云音乐、酷我音乐
- ✅ 多音质支持：128k、192k、320k、FLAC
- ✅ 防限流：随机延迟，避免被封禁
- ✅ 断点续传：失败自动重试
- ✅ 错误处理：完善的错误提示
- ✅ 文件命名：自动格式化文件名
- ✅ **防重复下载**：检查文件是否已存在，自动跳过
- ✅ **智能分类**：按音乐类型自动分类存储

### 原版下载器特性
- ✅ 歌单下载：支持JSON格式歌单
- ✅ 元数据内嵌：歌词、艺术家、专辑信息
- ✅ 文件分类：按音乐类型自动分类
- ✅ 完整报告：生成详细的处理报告
- ✅ **防重复下载**：检查文件是否已存在，自动跳过

## 📋 下载流程

### 1. 文件检查流程
```
开始下载 → 检查目标目录 → 查看已下载文件列表 → 
跳过已存在文件 → 下载新文件 → 保存到对应分类文件夹
```

### 2. 防重复机制
- ✅ **文件名匹配**：基于艺术家-歌曲名精确匹配
- ✅ **格式统一**：标准化文件命名格式
- ✅ **目录扫描**：自动扫描所有分类文件夹
- ✅ **实时更新**：每次下载前更新已下载文件列表

### 3. 错误处理
- ✅ **网络错误**：自动重试机制
- ✅ **API错误**：签名校验失败自动重新计算
- ✅ **文件错误**：文件已存在自动跳过
- ✅ **限流保护**：随机延迟避免被封禁

## 工具清单

| 文件 | 作用 |
|------|------|
| `gd-browser-downloader.js` | **首选下载器**：双站通用，两种模式——浏览器内核（CDP 过 Cloudflare，默认）与 `--direct` 直连（Node 签名 + curl，无浏览器）；下载时顺抓站点详情（`--enrich` 可补旧索引） |
| `gd-signer.js` | **离线签名器**（共用模块）：把站点 `crc32.min.js` 装进 Node vm 现算签名；供 `--direct` 与 `embeat-recommend.js` 使用 |
| `embeat-recommend.js` | **Embeat 推荐客户端（网页版直连）**：Node vm 现算站点签名 + curl 调用，无需浏览器/本地库；支持 `--desc` / `--like` / `--track-id` / `--isrc`，`--out` 写下载器歌单 |
| `chksz-downloader.js` | **备选下载器**：ChKSz API 直连（无 WAF），免费 apikey 可到超清母带 |
| `gd-flac-downloader.js` | （旧）直连批量下载器，现被 Cloudflare 拦截，保留作参考 |
| `gd-international-downloader.js` | （旧）国际版直连下载器，同上 |
| `run_all.sh` | 顺序跑所有风格文件夹的下载驱动 |
| `flac_metadata_embedder.py` | 元数据+歌词+封面内嵌（Python + metaflac，**仅 FLAC**） |
| `download_lyrics.py` | 给**非 FLAC**（mp3/m4a/aac/ogg/wav/wma）单独补 `.lrc`，只写文件不改音频 |
| `playlist.json` | 每风格文件夹内歌单 |

## 版权提醒

仅限个人本地听歌自用，禁止批量爬取、分发歌词与音频。
