# GD 音乐台音源（EchoMusic 插件）

给 EchoMusic 加第二套音源。酷狗 VIP / 无版权导致「无法播放」时，自动改用
[GD 音乐台](https://music.gdstudio.org/) 的聚合音源（QQ 音乐 / 酷我 / 网易云 / Tidal /
Apple Music / YouTube Music / Bilibili）取流。

## 安装

```bash
# macOS
cp -R echomusic-plugin-gdstudio "$HOME/Library/Application Support/echo-music/plugins/"
```

Windows 放到 `%APPDATA%\echo-music\plugins\`，Linux 放到 `~/.config/echo-music/plugins/`。

然后打开 EchoMusic →「插件管理」→ 刷新插件列表 → 启用「GD 音乐台音源」。
设置页在「设置 → 插件 → GD 音乐台音源」，里面有「测试」按钮可当场验证哪些音源可用。

## 三种工作模式

| 模式 | 行为 | 适用 |
| --- | --- | --- |
| 兜底（默认） | 仅在酷狗解析失败时接管（`after-catalog`） | 日常；不影响现有播放速度 |
| 优先 | 所有歌曲先向 GD 取流（`before-catalog`），失败才回酷狗 | 酷狗版权缺得多，或想要更高音质 |
| 关闭 | 完全不接管 | 排查问题 |

## 实现要点

1. **签名**：站点 `api.php` 要求 `s=crc32(encodeURIComponent(入参))`，其中 `crc32` 是站点
   `js/crc32.min.js` 里被改造过的 MD5，无法离线复刻。插件把该脚本拉下来，放进
   `Proxy + with` 的伪全局里执行（`new Function`，不需要 `vm`）。
   **站点升级签名算法时不需要改插件**，下次拉新脚本即可（签名被拒会自动刷新重试一次）。
   `mkPlayer.version` 从 `js/player.js` 动态解析，跟着站点走。
2. **网络**：走 `ctx.net.request`（主进程 Node HTTP）。不能用浏览器 `fetch`——
   `api.php` 没有 CORS 头；curl 也不能用（插件里起不了子进程）。
3. **匹配**：曲名/歌手归一化（繁→简、去标点）+ 二元组 Dice 相似度；
   查询没写 Live/Remix 而候选带 → 重罚，避免下到现场版/翻唱。
4. **真假无损**：站点返回的 `br` 是**标称档位**（999/740/320），不是真实码率——
   实测《晴天》999 档 `br=999`，实际 55MB/269s ≈ 1647kbps。所以用 `size*8/时长`
   反推真实码率，再按档位合理区间校验，虚标就降档重试。
5. **限流**：站点口径约 50 次/5 分钟。插件串行化请求（间隔 300ms）+ 搜索结果缓存 30 分钟
   + 播放地址缓存 20 分钟。

## 参数

- **站点**：`music.gdstudio.org`（国内版，实测直连可用）/ `music.gdstudio.xyz`（国际版）
- **音源优先级**：可勾选并上下排序，默认 `QQ → 酷我 → 网易云`
- **最高音质**：`999`（24bit 无损）/ `740`（16bit 无损）/ `320` / `128`，拿不到自动降档

## 已知边界

- `migu / kugou / spotify / deezer / ximalaya` 在 org 站点返回 `source not supported`；
  `joox` 能搜到但取流为空。默认不启用。
- Apple / YouTube Music / Bilibili 的地址要经 `music-proxy.gdstudio.org` 中转，
  首次播放会比 QQ/酷我慢 1~2 秒。
- 人声/伴奏分离等「特效音轨」GD 没有对应资源，插件直接放行给宿主链路。
- GD 音乐台是第三方聚合站，可用性随时可能变化；签名或接口变动时插件会打日志
  （`[gdstudio]`），设置页「测试」可快速定位是哪个音源挂了。

## 免责

仅供个人本地播放自用。音源来自 GD 音乐台公开接口，版权归各音乐平台所有，请勿用于分发或商业用途。
