# GD 音乐台音源 + 下载（EchoMusic 插件）

给 EchoMusic 加第二套音源，并把「下载」补上：

- **播放兜底**：酷狗 VIP / 无版权导致「无法播放」时，自动改用
  [GD 音乐台](https://music.gdstudio.org/) 的聚合音源（QQ 音乐 / 酷我 / 网易云 / Tidal /
  Apple Music / YouTube Music / Bilibili）取流。
- **下载**：侧边栏「GD 下载」页支持单曲下载、批量下载（粘贴歌单文本 / 导入当前播放队列），
  带进度、速率、取消、重试，文件按 `歌手/歌名.flac` 落盘。
- **代理**：页内可读写客户端全局代理（跟随系统 / 强制直连 / 自定义），并能一键检测出口 IP。

## 安装

```bash
cp -R echomusic-plugin-gdstudio "$HOME/Library/Application Support/echo-music/plugins/"
```

Windows 放 `%APPDATA%\echo-music\plugins\`，Linux 放 `~/.config/echo-music/plugins/`。
然后 EchoMusic →「插件管理」→ 刷新列表 → 启用「GD 音乐台音源」。

> **下载功能需要 EchoMusic ≥ 2.3.2-beta.10**（宿主才提供下载传输接口）。
> 低于该版本时插件照常提供音源兜底与「复制直链」，下载区会给出提示。

## 三种工作模式

| 模式 | 行为 | 适用 |
| --- | --- | --- |
| 兜底（默认） | 仅在酷狗解析失败时接管（`after-catalog`） | 日常；不影响现有播放速度 |
| 优先 | 所有歌曲先向 GD 取流（`before-catalog`），失败才回酷狗 | 酷狗版权缺得多，或想要更高音质 |
| 关闭 | 完全不接管 | 排查问题 |

## 下载页怎么用

1. 第一次进页面点「选择目录」，选一个音乐库文件夹（授权会持久保存，可在
   「插件管理 → 已授权文件与目录」里撤销）。
2. 加歌的三种方式：
   - **批量**：文本框每行一首，`歌名 - 歌手`（支持 `晴天 - 周杰伦`、`01. 晴天 - 周杰伦`）；
   - **导入播放队列** / **下载当前播放**：直接拿现在正在听的歌；
   - **搜索**：搜到结果后点「下载」，或点「复制直链」自己用外部工具下。
3. 队列最多 2 个并发（宿主对单插件的上限），可以取消 / 重试 / 移除。

下载只负责音频文件本身；内嵌封面/歌词仍然用仓库里的 `flac_metadata_embedder.py`。

## 实现要点

1. **签名**：站点 `api.php` 要求 `s=crc32(encodeURIComponent(入参))`，`crc32` 是站点
   `js/crc32.min.js` 里被改造过的 MD5，无法离线复刻。插件把脚本拉下来放进
   `Proxy + with` 的伪全局里执行（`new Function`，不需要 `vm`），签名被拒会自动刷新重试一次；
   `mkPlayer.version` 从 `js/player.js` 动态解析。
2. **网络**：`ctx.net.request`（主进程 Axios，走 Chromium session）。不能用浏览器 `fetch`——
   `api.php` 没有 CORS 头。
3. **代理**：EchoMusic 的代理是应用级的，插件请求与 `ctx.net.download` 都沿用宿主代理；
   页内「网络代理」直接调 `window.electron.network.update`，和「设置 → 网络」同一通道。
   那会影响全局（含酷狗播放），所以改完建议点「检测出口」确认。
4. **下载**：`ctx.net.download({url, target:{directoryId, relativePath}, conflict:'rename'})`，
   由主进程流式写盘 + 续传，不在 renderer 里搬字节。
5. **匹配**：曲名/歌手归一化（繁→简、去标点）+ 二元组 Dice；查询没写 Live/Remix 而候选带 → 重罚。
6. **真假无损**：站点返回的 `br` 是**标称档位**（999/740/320），不是真实码率——
   实测《晴天》999 档 `br=999`，实际 55MB/269s ≈ 1647kbps。插件用 `size*8/时长`
   反推真实码率并按档位区间校验，虚标就降档重试。
7. **限流**：站点口径约 50 次/5 分钟。请求串行 300ms 间隔 + 搜索缓存 30 分钟 + 地址缓存 20 分钟。

## 参数

- **站点**：`music.gdstudio.org`（国内版）/ `music.gdstudio.xyz`（国际版，视网络可达性）
- **音源优先级**：勾选并上下排序，默认 `QQ → 酷我 → 网易云`
- **最高音质**：`999`（24bit 无损）/ `740`（16bit 无损）/ `320` / `128`，拿不到自动降档

## 已知边界

- `migu / kugou / spotify / deezer / ximalaya` 在 org 站点返回 `source not supported`；
  `joox` 能搜到但取流为空。默认不启用。
- Apple / YouTube Music / Bilibili 的地址经 `music-proxy.gdstudio.org` 中转，首次可能慢几秒。
- 人声/伴奏分离等「特效音轨」GD 没有对应资源，插件直接放行给宿主链路。
- 下载队列保存在内存里，重启客户端后不会自动续上（宿主侧任务记录仍可用 `ctx.net.downloads` 恢复）。
- GD 音乐台是第三方聚合站，可用性随时可能变化；签名或接口变动时插件会打 `[gdstudio]` 日志，
  设置页「测试」可快速定位是哪个音源挂了。

## 免责

仅供个人本地播放自用。音源来自 GD 音乐台公开接口，版权归各音乐平台所有，请勿用于分发或商业用途。
