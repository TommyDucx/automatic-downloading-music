---
name: music-processing-skills
description: >-
  批量下载高品质FLAC音乐（GD音乐台多音源），自动按音乐风格分文件夹管理，
  并为每首歌内嵌完整元数据（歌名、歌手、专辑、风格、年份、歌词）的完整工作流。
  当用户要求「下载歌曲」「批量下载音乐」「整理音乐库」「内嵌元数据」「给歌曲加歌词/信息」时使用。
---

# 音乐批量下载与元数据内嵌

从下载歌曲到内嵌完整歌曲信息的端到端流程，可复用。

## 完整工作流（4 步）

```
1. 建立音乐风格目录 + JSON 歌单
2. 批量下载 FLAC（gd-flac-downloader.js，防限流）
3. 内嵌元数据 + 歌词（flac_metadata_embedder.py）
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
node playlist-importer.js "https://music.163.com/playlist?id=7403678821" --out downloads/01-xxx/playlist.json
node playlist-importer.js "https://y.qq.com/n/ryqq/playlist/8612270405" --out playlist.json
node playlist-importer.js "https://open.spotify.com/playlist/xxx" --out playlist.json
node playlist-importer.js "歌手 - 歌名" --out playlist.json     # 纯文本直通
```

支持平台：网易云（含 163cn.tv 短链）、QQ 音乐、Spotify、酷狗（含短链）、汽水音乐、文本。
输出 `[{title, artist}]`；也可 `--txt` 输出 "歌名 - 歌手" 每行。纯数字 ID 需加 `--platform <平台>`。

下载器也可直接吃链接（免去中间文件）：

```bash
node gd-flac-downloader.js --playlist "https://music.163.com/playlist?id=xxx" --out <文件夹> --max 10
```

## 步骤 2：批量下载

使用 `gd-flac-downloader.js`（Node，无第三方依赖），用法：

```bash
node gd-flac-downloader.js --list <playlist.json> --out <歌曲文件夹> \
  --sources netease,joox --delay 4
# 只收无损（没有 FLAC 就报失败，不降级）：加 --lossless-only
```

参数：
- `--sources`：netease,joox,tencent,kuwo,migu,qobuz,spotify,apple,ytmusic（逗号分隔）
- `--delay`：请求间隔秒数；默认 3，批量下载务必 ≥4
- `--br 999|740|320`：目标音质，默认 999（24bit FLAC）
- `--br-min 320`：音质降级链下限，默认 128。**降级链**：目标 br 拿不到时自动逐档向下试（999→740→320→192→128），同一音源内先降级再换源，借鉴 EchoMusic resolver 的候选降级思路
- `--strict-br`：关闭降级，目标 br 拿不到就直接换下一音源
- **格式优先级（默认行为）**：没有无损就存有损里**品质最高**的那份，扩展名按实际格式落盘
  （`.flac` / `.mp3` / `.m4a` / `.ogg`…）。评分 = 无损 +1e6 + 码率，跨音源择优，不是「最后一个说了算」
- `--lossless-only`（别名 `--flac-only` / `--no-fallback`）：**只要无损**，拿不到就报失败。
  想严格只收 FLAC 时用它；`--fallback` 保留为兼容别名，如今已是默认行为
- `--playlist <链接>`：歌单链接直导（网易云/QQ/Spotify/酷狗），免手动写 JSON
- `--max <n>`：最多下载前 n 首（歌单很大时限制数量）
- `--force`：已存在也重新下载；不传则已存在文件直接跳过（不耗 API 配额）

已下载记录写入 `<out>/.downloaded.json`（本地缓存兜底）：同一首歌名重复运行直接跳过，不消耗搜索/取流配额。

驱动脚本 `run_all.sh` 顺序遍历 `downloads/0*/playlist.json` 逐个文件夹下载，日志写 `/tmp/gdmusic_batch.log`。

### 国际版批量下载（gd-international-downloader.js）
按关键词搜索下载（网易云 / 酷我），自动跳过已存在文件；**同样内置音质降级链**（按音源支持档位从目标档向下）：

```bash
node gd-international-downloader.js "Taylor Swift" netease 999 5    # 网易云 FLAC（999 拿不到自动降 320）
node gd-international-downloader.js "流行音乐" kuwo 320 10        # 酷我 320k
node gd-international-downloader.js "周杰伦" netease 999 5 cn     # 手动指定镜像
```

参数：`<关键词> [音源 netease|kuwo] [音质 128|192|320|999] [数量] [镜像 cn|hk|us|default]`
镜像缺省按音源自动分流：migu/kugou/ximalaya→cn，joox→hk，qobuz/ytmusic→us，其余→默认。

### 防限流关键（务必遵守）
站点对连续大量请求会临时限流，症状：
- 搜索返回 `401 {"detail":"Invalid request."}`
- 下载卡死（401 递归死循环）

对策（已内置到下载器，JS 与 Python 两端一致）：
1. `apiCall(params, depth)` 对 401 做深度上限 4 的冷却重试，超过即抛错跳过，绝不无限递归
2. 401 细分处理：`ssa-code`/verify/captcha 等验证挑战头 → 等待 12s 单次重试；普通 401（签名过期/隐性限流）→ 指数退避；429 显式限流 → 尊重 `Retry-After` 头冷却
3. `politeDelay()`：`delay * (0.7 + Math.random()*0.6)` 随机抖动
4. `downloadOne` 开头先查 `.downloaded.json` 索引与同名音频文件，已存在则跳过，不发 API 请求
5. 触发限流后：kill 进程 → 等冷却 → 以更大 delay 续跑（已存在文件自动跳过 = 断点续传）

### 网络拓扑
- **主站**: `https://music.gdstudio.org` ✅ 完全支持（`gd-flac-downloader.js`）
- **国际版**: `https://music-api.gdstudio.xyz` ✅ 完全支持（`gd-international-downloader.js`，含 cn/hk/us 镜像）

主站签名：`/time` 拿时间戳 → VM 跑 `crc32.min.js` 对 `encodeURIComponent(name)` 求 crc32 → 拼 `s=` 参数
POST `/api.php`，`Content-Type: application/x-www-form-urlencoded`，需 UA / X-Requested-With 头
API 返回 `{songname, artist, album, url, br, size, source, lrc}`；`url` 为需二次请求的真实下载地址
下载音质优先级按 `br` 排序（999=FLAC，越高越好）；**默认**无无损时也会接受有损里最高品质那份
（要严格只收无损请加 `--lossless-only`）

国际版签名：`s = crc32Hex(encodeURIComponent(name 或 id))`，POST form 到 `<mirror>/api.php`；
限流口径约 50 次/5 分钟，遇 401 自动指数退避重试。

### ⚠️ 假限流：查询串含 `(` `)` `'` 时搜索必失败（实测 2026-08-29）

现象：标题里带半角括号或撇号时，所有音源都返回
`搜索失败（签名校验失败（可能触发站点限流，请稍后再试））`，**看起来像被限流，其实不是**——
同一时刻换成纯 ASCII 标题立刻正常返回（命中或 `未找到匹配曲目`）。

原因：`encodeURIComponent` **不会**转义 `!'()*-._~`，这些字符原样进入 form body 后服务端算出的
签名与本地不一致。凡是 `(` `)` `'` 参与的查询都会挂。

| 想下的曲名 | 报错 | 改用 | 结果 |
|---|---|---|---|
| `Luv(sic) Part 2` | 签名校验失败 | `Luv sic Part 2` | netease 命中（可能匹配到 A Cappella 版，音质低） |
| `Luv(sic) Part 3` | 签名校验失败 | `Luv sic Part 3` | 同上 |
| `World's End Rhapsody` | 签名校验失败 | `Worlds End Rhapsody` | 各源均 `未找到匹配曲目`（是真的没有，不是限流） |

排查口诀：**先用一个纯 ASCII 标题探一次**，能通就不是限流，而是标题里的标点问题；
按上表去掉 `(` `)` `'` 后重试。注意模糊匹配会把不同 Part 折叠到同一条结果（实测 joox 把
`Part 2` / `Part 3` 都指向同一首 `Luv(Sic)`，下到两个 30MB 的**完全相同**文件），
下完务必 `shasum` 查重再入库。

## 步骤 3：内嵌元数据

用 `flac_metadata_embedder.py`（Python + metaflac）批量处理：

```bash
python3 flac_metadata_embedder.py --downloads-dir <项目根目录>
# 单文件：
python3 flac_metadata_embedder.py --single-file "path/to/song.flac"
# 可选参数：
#   --gd-source netease|kuwo|qobuz|joox|migu|ytmusic   刮削音源（默认 netease）
#   --no-cover                                        不内嵌封面
#   --no-gdmusic                                      完全不用 GD音乐台 API（跳过封面/翻译/歌词兜底）
```

依赖：`brew install flac`（提供 metaflac）+ `pip3 install syncedlyrics requests beautifulsoup4 rapidfuzz soupsieve`。

### 内嵌的字段（Vorbis 注释）
`TITLE` `ARTIST` `ARTISTS` `ALBUM` `ALBUMARTIST` `COMPOSER` `GENRE` `DATE` `TRACKNUMBER` `TOTALTRACKS` `COMMENT` + `LYRICS` + `LYRICS_TRANSLATED` + **封面（PICTURE 块）**

### 元数据来源逻辑
- `TITLE/ARTIST`：从文件名 `歌手 - 歌名.flac` 解析
- `GENRE`：优先查内置映射表（Synthwave-Chillwave → "Synthwave, Chillwave" 等）；
  未命中则**从目录名的 StyleTag 推导**（`Jazzhop-Lo-fi-Hip-Hop` → `Jazzhop, Lo-fi, Hip-Hop`，
  内置复合词表保证 `Lo-fi` / `Hip-Hop` 不会被切成两个词）；
  再推导不出才回落 `Electronic` 并**打印告警**（不再静默写错值）
- `ALBUM`：**优先取 GD音乐台刮削到的真实专辑名**（`modal soul` → `Modal Soul`）；
  刮不到才回落到「歌手 → 内置专辑表」，再兜底 `{歌手} Collection`
- `DATE/COMPOSER`：仍按歌手查内置表 —— ⚠️ 搜索接口不返回年份，所以 DATE 是**歌手级近似值**，
  一首歌跨专辑时可能不准（已知局限，暂无数据源可修）
- `TRACKNUMBER`：在 playlist.json 中的序号；未匹配默认 1
- `LYRICS`：syncedlyrics 搜索（**固定 providers = Lrclib,NetEase**），失败换 `https://api.lrc.cx/api/v1/lyrics/single`；再失败走 GD音乐台 `types=lyric` 兜底；**先写 lrc 文件到歌曲文件夹，再读内容内嵌**
- `LYRICS_TRANSLATED`：GD音乐台 `types=lyric` 返回的 `tlyric` 翻译歌词
- **封面（PICTURE）**：GD音乐台搜索 -> 取 `pic_id` -> `types=pic`（尺寸 1000/640/500/300 回退）-> 带 Referer 下载 -> `metaflac --import-picture-from` 内嵌
- 歌词入 Vorbis 注释前需清洗：去掉 `[00:00.00]` 时间戳行与元信息行（`作曲:` `作词:` 等），否则 `--import-tags-from` 会报 malformed vorbis comment
- **一次搜索三处复用**：`resolve_gd_track()` 按 (曲名, 歌手) 缓存搜索命中，
  专辑名 / 封面 / 歌词共用同一次搜索，避免每首歌重复打 2~3 次 API（省配额、降限流概率）

### GD音乐台刮削（封面/翻译歌词）参考实现
- 接口形态与签名参考 [gdstudio-embeded-service](https://github.com/Azincc/gdstudio-embeded-service)（types=search/pic/lyric、封面尺寸回退、tlyric 翻译、镜像分流）
- 签名沿用本站实测有效的 crc32 方案：`s = crc32Hex(encodeURIComponent(name 或 id))`，POST 到 `<mirror>/api.php`
- **镜像分流**（缺省按音源自动选）：migu/kugou/ximalaya → `music-api-cn.gdstudio.xyz`，joox → `music-api-hk.gdstudio.xyz`，qobuz/ytmusic → `music-api-us.gdstudio.xyz`，其余 → `music-api.gdstudio.xyz`
- 请求失败按 1s,2s,4s,8s... 指数退避重试（上限 30s），符合站点限流口径（约 50 次/5 分钟）

### 踩坑
- **不要**用 `--import-tags-from <lrc>` 直接导入歌词（时间戳行非法），要用 `--set-tag "LYRICS=<清洗后文本>"`
- 文件名非 `歌手 - 歌名` 格式（如纯中文歌名）解析不到歌手/歌名，会跳过 → 手动改名或单独补元数据
- 封面内嵌前必须 `metaflac --remove --block-type=PICTURE` 清掉旧封面，否则重复堆积

### 非 FLAC 音频：用 `download_lyrics.py` 单独补歌词

`flac_metadata_embedder.py` 依赖 metaflac，**只能处理 FLAC**。
要给 mp3 / m4a / aac / ogg / wav / wma 补歌词，用 `download_lyrics.py`
（只写 `.lrc` 文件，不改动音频本身）：

```bash
# 批量：递归扫目录，在每个音频旁生成同名 .lrc（已存在则跳过）
python3 download_lyrics.py "<目录>" --delay 0.4

# 单曲
python3 download_lyrics.py --title "Blinding Lights" --artist "The Weeknd" --out "<目录>"
python3 download_lyrics.py --song "Taylor Swift - Fortnight" --out ./
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

## 🚀 使用方法

### 原版网站（推荐）
```bash
# 使用现有的原版下载器
cd "/Users/tommydu/Documents/automatic downloading music"
node gd-flac-downloader.js playlist.json

# 注意：会自动检查已下载文件，避免重复下载
```

### 国际版网站（新功能）
```bash
# 下载网易云音乐歌曲（自动检查重复）
cd "/Users/tommydu/Documents/automatic downloading music"
node gd-international-downloader.js "周杰伦" netease 999 5

# 下载酷我音乐歌曲（自动检查重复）
node gd-international-downloader.js "流行音乐" kuwo 320 10

# 批量下载歌单（自动跳过已存在文件）
node gd-international-downloader.js "治愈系合成器" netease 999 20

# 手动指定镜像（cn/hk/us/default；缺省按音源自动分流）
#   migu/kugou/ximalaya→cn，joox→hk，qobuz/ytmusic→us
node gd-international-downloader.js "周杰伦" netease 999 5 cn
```

### 元数据内嵌
```bash
# 为下载的音乐添加元数据和歌词
cd "/Users/tommydu/Documents/automatic downloading music"
python flac_metadata_embedder.py
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
| music.gdstudio.org | ✅ 完全支持 | `/api.php` | 使用 CRC32 签名，已验证稳定 |
| music-api.gdstudio.xyz | ✅ 完全支持 | `/api.php` | 基于洛雪音乐源项目逆向成功 |

**最新进展**：国际版 API 已成功逆向工程，支持网易云音乐、酷我音乐等多个平台。

## 技术实现

### 国际版 API 特点
- **端点**：`https://music-api.gdstudio.xyz/api.php`
- **认证**：CRC32 签名计算
- **支持平台**：网易云音乐、酷我音乐
- **音质支持**：128k、192k、320k、FLAC

### 签名计算方法
```javascript
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

// 使用方法
const signInput = encodeURIComponent(query);
const signature = crc32(signInput).toString(16).toUpperCase().padStart(8, '0');
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
/Users/tommydu/Documents/automatic downloading music/
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
- **主目录**：`/Users/tommydu/Documents/automatic downloading music/downloads`
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

## 🚀 使用方法

### 原版网站（推荐）
```bash
# 使用现有的原版下载器
cd "/Users/tommydu/Documents/automatic downloading music"
node gd-flac-downloader.js playlist.json
```

### 国际版网站（新功能）
```bash
# 下载网易云音乐歌曲
cd "/Users/tommydu/Documents/automatic downloading music"
node gd-international-downloader.js "周杰伦" netease 999 5

# 下载酷我音乐歌曲
node gd-international-downloader.js "流行音乐" kuwo 320 10
```

### 元数据内嵌
```bash
# 为下载的音乐添加元数据和歌词
python flac_metadata_embedder.py
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
| `gd-flac-downloader.js` | 批量下载器（Node，零依赖，内置签名+防限流+断点续传） |
| `gd-international-downloader.js` | 国际版下载器（支持网易云音乐、酷我音乐） |
| `run_all.sh` | 顺序跑所有风格文件夹的下载驱动 |
| `flac_metadata_embedder.py` | 元数据+歌词+封面内嵌（Python + metaflac，**仅 FLAC**） |
| `download_lyrics.py` | 给**非 FLAC**（mp3/m4a/aac/ogg/wav/wma）单独补 `.lrc`，只写文件不改音频 |
| `playlist.json` | 每风格文件夹内歌单 |

## 版权提醒

仅限个人本地听歌自用，禁止批量爬取、分发歌词与音频。
