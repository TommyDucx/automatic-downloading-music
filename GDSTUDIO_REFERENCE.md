# GDStudio 两个参考仓库调研笔记

调研时间：2026（本会话）
调研方式：GitHub 在线浏览 + 读取原始代码

## 1. 7878gyc/gdstudio-lx-source（洛雪音乐自定义音源，37★）

仓库内容：单个 JS 文件（洛雪音乐自定义音源-基于GD音乐台-v1.0.0.js），供 lx-music-desktop/mobile 导入。

### 实现方式
- 形式：lx-music 自定义音源脚本，通过 `globalThis.lx` 注册，只实现了 `musicUrl` 动作。
- API 调用：`GET https://music-api.gdstudio.xyz/api.php?types=url&source=kuwo|netease&id=<songmid>&br=<128|192|320|740|999>`
- 音质映射：`128k→128, 192k→192, 320k→320, flac→740(16bit 无损), flac24bit→999(24bit 无损)`
- 音质降级链：flac24bit→flac→320k→192k→128k（按音源支持列表过滤后逐个尝试）
- 源标识映射：`kw→kuwo, wy→netease`
- 该脚本**未带 s 签名参数**（2025-02 版），是否仍可用存疑。

### 已知限制（README 中官方口径）
- 请求频率限制：**5 分钟内不超过 50 次请求**（个人非商用）
- 仅支持酷我 / 网易云两个源

### 参考价值：中低
- 佐证了 `api.php` 的 endpoint 形态与 br 档位含义（740=16bit FLAC、999=24bit FLAC）。
- 音质降级链思路可直接借鉴。
- 源码本身很粗糙，无签名、无搜索，参考价值主要在于 API 使用口径。

## 2. Azincc/gdstudio-embeded-service（Go 嵌入式下载微服务，3★）

仓库内容：Go 写的"下载+元数据刮削"微服务（Gin API + Worker 一体容器，SQLite 任务队列），对接 Navidrome。

### 实现方式（internal/service/gdstudio/client.go 为精华）
- API 面：`GET <base>/api.php`，types 有 `search / url / pic / lyric` 四种：
  - search: `types=search&source=..&name=..&count=..&pages=1`（Go 版未签名）
  - url: `types=url&source=..&id=..&br=..&s=..`
  - pic: `types=pic&source=..&id=pic_id&size=..&s=..`（封面，size 有 1000/640/500/300 档）
  - lyric: `types=lyric&source=..&id=lyric_id&s=..`（返回 `lyric` 与 `tlyric` 翻译）
- 签名（Go 版，2025-11 口径）：
  - `ts9 = UnixMilli 前 9 位`，`src = "music.gdstudio.xyz|20251104|" + ts9 + "|" + url.QueryEscape(id)`
  - `s = MD5(src) 后 8 位 hex 大写`
  - 注意：与我们技能主站版（`ts9|hostname|version|入参` + crc32.min.js 自定义 MD5）**字段顺序不同、哈希不同、版本硬编码**——说明签名方案不稳定、会随站点升级变化，我们的"自动拉取 crc32.min.js/player.js 实时算"更抗变化。
- 镜像分流（config.yaml）：base=https://music-api.gdstudio.xyz；cn=https://music-api-cn.gdstudio.xyz；hk=https://music-api-hk.gdstudio.xyz；us=https://music-api-us.gdstudio.xyz
  - migu/kugou/ximalaya→cn；joox→hk；qobuz/ytmusic→us
- 元数据匹配（TAG_MATCHING_LOGIC.md + pickMetadata）：
  - 搜索关键词顺序：`"曲名 歌手" → "曲名" → trackID`
  - 匹配优先级：`id 精确匹配 → 曲名等值 + 歌手部分匹配`；歌手按 `/ 、 ; ,` 切分，双向 contains 判匹配；统一引号/大小写/空白归一化
  - 年份解析：year 字段或 publishTime/publish_date/date 前 4 位
  - 重试：1s,2s,4s,8s,16s,30s 指数退避，总窗口 3 分钟；"空列表"与"网络错误"区分对待
- 封面下载：按源加 Referer（netease→music.163.com、qq→y.qq.com、kuwo→www.kuwo.cn），URL 候选集含去 query 与 param=尺寸回退（1000y1000/640y640/500y500/300y300）
- 标签写入（tagger/flac.go）：**与我们技能完全同思路的 metaflac 流程**——
  - 先 `--remove-tag=...`（TITLE/ARTIST/ARTISTS/ALBUMARTIST/ALBUM/TRACKNUMBER/DISCNUMBER/DATE/GENRE/COMPOSER/LABEL/COMMENT/LYRICS/LYRICS_TRANSLATED）
  - 再 `--set-tag=...`，支持多值 ARTISTS/ALBUMARTISTS，额外写 `LYRICS_TRANSLATED`
  - 封面：`--remove --block-type=PICTURE` 后 `--import-picture-from=<临时文件>`
- 文件组织：`path_template: "{artist}/{album}/{trackNo:02d} - {title}.{ext}"`
- 工程化：SQLite 任务队列（幂等、避免重复下载）、Prometheus 指标、下载域名白名单（`*.163.com *.kuwo.cn *.gdstudio.xyz *.qq.com *.kugou.com *.migu.cn`）、Docker + GHCR

### 参考价值：高（元数据管线部分）
- 对我们技能最有价值的 4 点：
  1. **封面内嵌**：我们当前 embedder 不写封面；参考其 `types=pic + size 回退 + 带 Referer 下载 + --import-picture-from` 补全。
  2. **翻译歌词**：`types=lyric` 返回 `tlyric`，可存 `LYRICS_TRANSLATED` 或合成双语 lrc。
  3. **镜像分流**：不同源走 cn/hk/us 不同入口，可提高可用性。
  4. **匹配/重试策略**：多关键词搜索顺序、id 优先、歌手切分匹配、指数退避——可移植到 embedder。
- 签名实现（硬编码 version + 标准 MD5）**不建议照搬**，我们自动拉站点脚本的方式更稳。

## 3. 结论
- gdstudio-lx-source：几乎无新东西，确认 API 形态与 br 口径即可。
- gdstudio-embeded-service：元数据/封面/歌词/镜像这四块值得借鉴；下载与签名部分参考价值有限（签名方案易腐化）。
- 两者都重申同一限流口径：50 次/5 分钟，与我们 --delay≥4 的防限流策略一致。

## 4. 落地状态（已实现）

已把「有价值功能」落入技能并同步到 ~/.dsh/skills/music-processing-skills/：
- flac_metadata_embedder.py：新增 GDMusicClient（search/pic/lyric + crc32 签名 + 镜像分流 + 指数退避），封面内嵌（PICTURE 块）、LYRICS_TRANSLATED、歌词兜底；新增 --gd-source / --no-cover / --no-gdmusic 参数；修复 sys 未导入问题。
- gd-international-downloader.js：新增 cn/hk/us 镜像分流（按音源自动选，可第 5 参数手动指定）。
- SKILL.md / README.md：文档同步更新。
- 说明：本次会话 bash 工具不可用（posix_spawn 失败），未能运行 python 语法检查与真实 API 联测，建议先 `python3 -m py_compile flac_metadata_embedder.py` 再用 `--single-file` 试跑一首验证封面/翻译。
