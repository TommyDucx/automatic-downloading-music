# automatic-downloading-music

批量下载高品质 FLAC 音乐并自动内嵌完整元数据与歌词的端到端工作流。

基于 GD音乐台（music.gdstudio.org）多音源逆向 API，支持批量下载、自动按音乐风格分文件夹管理、为每首歌内嵌完整元数据（歌名、歌手、专辑、风格、年份、歌词）。

## 功能特性

- 🎵 **批量下载**：支持 100+ 歌曲批量下载，自动分文件夹管理
- 🔍 **多音源**：netease、joox、tencent、kuwo、qobuz、migu 等
- 🎼 **智能匹配**：模糊匹配歌手/歌名，避免翻唱、Live、Remix 等干扰项
- 📝 **歌词同步**：自动下载同步 LRC 歌词并内嵌，歌词与歌曲同文件夹
- 🖼️ **封面内嵌**：从 GD音乐台自动解析封面（pic_id + 尺寸回退 + Referer）并写入 FLAC PICTURE 块
- 🌐 **翻译歌词**：写入 LYRICS_TRANSLATED（GD音乐台 tlyric）
- 🏷️ **元数据完整**：内嵌 TITLE、ARTIST、ARTISTS、ALBUM、GENRE、DATE、LYRICS、LYRICS_TRANSLATED、封面等
- 🚀 **防限流**：随机抖动延迟 + 401 冷却重试 + 深度上限，避免触发站点限制
- 📁 **自动分类**：按音乐风格自动分文件夹管理
- 🔄 **断点续传**：已存在文件自动跳过，不消耗 API 配额

## 文件结构

```
├── gd-flac-downloader.js            # 主站下载器（Node，零第三方依赖）
├── gd-international-downloader.js   # 国际版下载器（网易云/酷我等）
├── flac_metadata_embedder.py        # 元数据 + 歌词内嵌（Python + metaflac）
├── run_all.sh                       # 批量下载驱动（顺序遍历所有风格文件夹）
├── retry_failed.sh                  # 失败重试脚本
├── SKILL.md                         # 技能说明（完整工作流文档）
├── README.md                        # 本文件
└── test_*.js                        # API 逆向测试脚本
```

## 系统要求

- macOS / Linux
- Node.js >= 18
- Python 3.8+
- Homebrew（用于安装 FLAC 工具）

## 安装依赖

```bash
brew install flac
pip3 install requests beautifulsoup4 rapidfuzz soupsieve syncedlyrics
```

## 快速开始

### 1. 准备歌单

每个风格文件夹放一个 `playlist.json`：

```json
[
  {"title": "Resonance", "artist": "HOME"},
  {"title": "Sunset", "artist": "The Midnight"}
]
```

### 2. 批量下载

```bash
# 指定歌单 + 输出目录（多音源，自动防限流）
node gd-flac-downloader.js --list playlist.json --out "downloads/01-风格名" \
  --sources netease,joox --delay 4 --fallback

# 或使用 run_all.sh 顺序处理所有风格文件夹
./run_all.sh
```

### 3. 内嵌元数据

```bash
# 批量处理 downloads 下所有 FLAC
python3 flac_metadata_embedder.py --downloads-dir .

# 处理单个文件
python3 flac_metadata_embedder.py --single-file "path/to/song.flac"
```

### 国际版下载（网易云/酷我）

```bash
node gd-international-downloader.js "周杰伦" netease 999 5
node gd-international-downloader.js "流行音乐" kuwo 320 10
```

## 下载器参数

`gd-flac-downloader.js` 常用参数：

| 参数 | 说明 |
|------|------|
| `--list <file>` | 歌单文件（txt 或 json） |
| `--out <dir>` | 输出目录 |
| `--sources a,b,c` | 搜索音源优先级（默认 netease,tencent,kuwo,joox,qobuz） |
| `--br <n>` | 音质档位（999=24bit 无损，740=16bit 无损，320=MP3） |
| `--delay <sec>` | 请求间隔秒数（批量下载建议 ≥4） |
| `--fallback` | 无无损时降级保存 320k MP3 |
| `--force` | 已存在也重新下载 |

## 技术原理

- **主站** `music.gdstudio.org`：`/time` 取时间戳 → VM 跑 `crc32.min.js` 生成 `s=` 签名 → POST `/api.php`
- **签名**：对 `encodeURIComponent(name)` 求自定义 crc32，取后 8 位大写
- **音质优先级**：按 `br` 排序（999=FLAC），支持 `--fallback` 降级
- **国际版** `music-api.gdstudio.xyz`：同样基于 CRC32 签名，支持网易云音乐、酷我音乐
- **镜像分流**（国际版）：migu/kugou/ximalaya→`music-api-cn.gdstudio.xyz`，joox→`music-api-hk.gdstudio.xyz`，qobuz/ytmusic→`music-api-us.gdstudio.xyz`，可手动第 5 参数指定
- **刮削接口**：`types=search / url / pic / lyric`（pic 封面尺寸 1000/640/500/300 回退，lyric 含 tlyric 翻译），失败指数退避（1s,2s,4s…上限 30s）

## 歌词存放规则

**歌词文件必须保存在歌曲所在文件夹内，与音频文件同目录**（命名 `歌手-歌名.lrc`），不要放在独立的总 lyrics 目录。方便单文件夹整体拷贝/同步。

## 故障排除

| 症状 | 处理 |
|------|------|
| 搜索返回 `401 Invalid request` | 站点限流，kill 进程 → 等待冷却 → 用更大 `--delay` 续跑（断点续传） |
| 无法找到匹配曲目 | 歌单用真实歌手/曲名，去掉 `(Instrumental)` 等不存在的版本后缀 |
| 元数据内嵌失败 | `brew install flac` 提供 metaflac；文件名需为 `歌手 - 歌名.flac` |
| 封面/翻译获取失败 | 属可降级项，不影响下载与歌词；可 `--no-cover` / `--no-gdmusic` 关闭，或换 `--gd-source`（如 kuwo） |

## 版权提醒

本工具仅限个人本地听歌自用，禁止批量爬取、分发歌词与音频，请遵守相关版权法律法规。
