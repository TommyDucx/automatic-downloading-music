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

**歌词文件必须保存在歌曲所在文件夹内，与音频文件同目录**（命名 `歌手-歌名.lrc`），不得放在独立的总 lyrics 目录。

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

## 步骤 2：批量下载

使用 `gd-flac-downloader.js`（Node，无第三方依赖），用法：

```bash
node gd-flac-downloader.js --list <playlist.json> --out <歌曲文件夹> \
  --sources netease,joox --delay 4 --fallback
```

参数：
- `--sources`：netease,joox,tencent,kuwo,migu,qobuz,spotify,apple,ytmusic（逗号分隔）
- `--delay`：请求间隔秒数；默认 3，批量下载务必 ≥4
- `--fallback`：允许降级 MP3
- `--force`：已存在也重新下载；不传则已存在文件直接跳过（不耗 API 配额）

驱动脚本 `run_all.sh` 顺序遍历 `downloads/0*/playlist.json` 逐个文件夹下载，日志写 `/tmp/gdmusic_batch.log`。

### 防限流关键（务必遵守）
站点对连续大量请求会临时限流，症状：
- 搜索返回 `401 {"detail":"Invalid request."}`
- 下载卡死（401 递归死循环）

对策（已内置到下载器）：
1. `apiCall(params, depth)` 对 401 做深度上限 4 的冷却重试，超过即抛错跳过，绝不无限递归
2. `politeDelay()`：`delay * (0.7 + Math.random()*0.6)` 随机抖动
3. `downloadOne` 开头先检查同名音频文件已存在则跳过，不发 API 请求
4. 触发限流后：kill 进程 → 等冷却 → 以更大 delay 续跑（已存在文件自动跳过 = 断点续传）

### 网络拓扑
- **主站**: `https://music.gdstudio.org` ✅ 完全支持
- **国际版**: `https://music.gdstudio.xyz` ❌ 暂不支持（API 结构不同，需逆向工程）

主站签名：`/time` 拿时间戳 → VM 跑 `crc32.min.js` 对 `encodeURIComponent(name)` 求 crc32 → 拼 `s=` 参数
POST `/api.php`，`Content-Type: application/x-www-form-urlencoded`，需 UA / X-Requested-With 头
API 返回 `{songname, artist, album, url, br, size, source, lrc}`；`url` 为需二次请求的真实下载地址
下载音质优先级按 `br` 排序（999=FLAC，越高越好），`--fallback` 时无无损也可降级 MP3

**注意**：国际版使用不同的 API 结构，暂不支持。如需支持国际版，需逆向工程其认证机制。

## 步骤 3：内嵌元数据

用 `flac_metadata_embedder.py`（Python + metaflac）批量处理：

```bash
python3 flac_metadata_embedder.py --downloads-dir <项目根目录>
# 单文件：
python3 flac_metadata_embedder.py --single-file "path/to/song.flac"
```

依赖：`brew install flac`（提供 metaflac）+ `pip3 install syncedlyrics requests beautifulsoup4 rapidfuzz soupsieve`。

### 内嵌的字段（Vorbis 注释）
`TITLE` `ARTIST` `ALBUM` `ALBUMARTIST` `COMPOSER` `GENRE` `DATE` `TRACKNUMBER` `TOTALTRACKS` `COMMENT` + `LYRICS`

### 元数据来源逻辑
- `TITLE/ARTIST`：从文件名 `歌手 - 歌名.flac` 解析
- `GENRE`：从文件夹名 StyleTag 映射（Synthwave-Chillwave → "Synthwave, Chillwave" 等）
- `ALBUM/DATE/COMPOSER`：按歌手查内置专辑表，未命中则 `{歌手} Collection` + 当前年份
- `TRACKNUMBER`：在 playlist.json 中的序号；未匹配默认 1
- `LYRICS`：syncedlyrics 搜索，失败换 `https://api.lrc.cx/api/v1/lyrics/single`；**先写 lrc 文件到歌曲文件夹，再读内容内嵌**
- 歌词入 Vorbis 注释前需清洗：去掉 `[00:00.00]` 时间戳行与元信息行（`作曲:` `作词:` 等），否则 `--import-tags-from` 会报 malformed vorbis comment

### 踩坑
- **不要**用 `--import-tags-from <lrc>` 直接导入歌词（时间戳行非法），要用 `--set-tag "LYRICS=<清洗后文本>"`
- 文件名非 `歌手 - 歌名` 格式（如纯中文歌名）解析不到歌手/歌名，会跳过 → 手动改名或单独补元数据

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
| `flac_metadata_embedder.py` | 元数据+歌词内嵌（Python + metaflac） |
| `playlist.json` | 每风格文件夹内歌单 |

## 版权提醒

仅限个人本地听歌自用，禁止批量爬取、分发歌词与音频。
