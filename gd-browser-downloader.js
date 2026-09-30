#!/usr/bin/env node
/**
 * GD音乐台 浏览器内核下载器（零第三方依赖，需 Node >= 22）
 *
 * 背景（2026-09 实测）：
 *   GD音乐台的 /time 与 /api.php 已全部置于 Cloudflare 机器人防护之后，
 *   任何 Node/curl 直接请求都会拿到 403 "Just a moment..."（国内版 music.gdstudio.org、
 *   国际版 music.gdstudio.xyz、以及 music-api.gdstudio.xyz 都一样）。
 *   唯一稳定的过法是**真实浏览器**：让它自己跑完 JS 挑战拿到 cf_clearance，
 *   然后在页面上下文里用 site 自带的签名函数发请求。
 *
 * 因此本脚本的三段式设计：
 *   1) 幂等地拉起一个带 --remote-debugging-port 的 Chrome（独立 profile，签名 cookie 可持久复用）
 *   2) 通过 CDP（Node 22 内置 WebSocket，零依赖）把页面导航到站点并等挑战通过
 *   3) 所有 api.php 调用（search / url / pic / lyric）都在页面里用 site 自己的 crc32() 签名发起；
 *      音频文件本身在 CDN 上、不受 Cloudflare 保护，仍由 Node 直连流式下载（更快、可断点）
 *
 * 站点：
 *   --site xyz   国际版 https://music.gdstudio.xyz   （满血，音源最全，国内需科学上网）
 *   --site org   国内版 https://music.gdstudio.org   （直连，音源被下架过一部分）
 *
 * 用法：
 *   node gd-browser-downloader.js "歌名 - 歌手" ["歌名2 - 歌手2" ...]
 *   node gd-browser-downloader.js --list songs.json
 *   node gd-browser-downloader.js --playlist "https://music.163.com/playlist?id=xxx" --max 10
 *   node gd-browser-downloader.js --list songs.json --site xyz --out "downloads/01-xxx" --br 999
 *
 * 可选参数：
 *   --site xyz|org          默认 xyz（国际版）
 *   --sources a,b,c         搜索音源列表，默认按站点给一套（全源扫描模式下会逐源都探一遍）
 *   --select quality|first  默认 quality = **全源扫描后按实际品质择优**；
 *                           first = 命中第一个无损就停（省配额，会漏掉更高品质的源）
 *   --br 999|740|320        目标音质，默认 999（24bit/无损档）
 *   --br-min 128            降级链下限，默认 128
 *   --strict-br             不降级，目标档拿不到就换下一音源
 *   --lossless-only         只要无损，拿不到就报失败
 *   --out <目录>            默认 ./downloads
 *   --delay <秒>            请求间隔，默认 4（站点限流口径 50 次/5 分钟）
 *   --max <n>               最多下载前 n 首
 *   --force                 已存在也重新下载
 *   --chrome-port <端口>    调试端口，默认 9333
 *   --chrome-profile <目录> Chrome 数据目录，默认 ~/.gd-chrome-profile
 *   --chrome <可执行文件>   自定义 Chrome/Chromium 路径
 *   --proxy <url>           让 Chrome 走指定代理（如 http://127.0.0.1:7897）
 *   --show-window           显示浏览器窗口（默认把窗口移到屏幕外，看不见）
 *   --keep-chrome           跑完不关闭 Chrome（默认跑完关掉自己拉起的那个）
 *   --attach                只复用已经开着调试端口的 Chrome，不新拉起
 *   --enrich                对已下载但缺站点详情的旧索引条目，补抓歌曲详情
 *                           （歌名/歌手/专辑/时长/来源/封面URL/歌词）写入 .downloaded.json，
 *                           不重新下载音频；供 flac_metadata_embedder.py 内嵌时直接复用
 *   --direct                直连模式：不用浏览器，Node 现算站点签名（gd-signer.js）+ curl 调 api.php
 *                           （2026-09-30 全链路实测通过；更快、不受 Cloudflare 时段影响。
 *                           签名被拒会自动刷新 crc32.min.js 重试；音频仍由 Node/curl 直接下载）
 *
 * 为什么必须用浏览器（2026-09-19 逆向与实测结论，别再走弯路）：
 *   1) 签名已完全逆向：crc32(x) 内部就是把
 *        raw = ts9 + "|" + location.hostname + "|" + version每段补零2位 + "|" + x
 *      丢给一个改过的 md5()（拦截 md5 调用实测入参 = "178978936|music.gdstudio.xyz|20260916|Resonance"）。
 *      但那个 md5 内核被改造过（md5("abc")=9ef90af686e68195b6f6d89b69d3c584 ≠ 标准 MD5），
 *      解出来的 285 条混淆字符串里也没有可直接当 HMAC 密钥用的东西 —— 离线复刻不可行。
 *      不过**也不需要复刻**：签名是纯前端 JS，可以在 Node 的 vm 里直接加载站点 crc32.min.js 现算。
 *   2) 真正的门槛是 Cloudflare：实测把浏览器的 cf_clearance 抠出来给 curl/Node 用**仍然 403**
 *      （cf_clearance 绑定 IP + TLS 指纹，curl/undici 的指纹与 Chrome 差太远）。
 *   3) 真无头 `--headless=new` 会被识破，永远卡在 "Just a moment..."；
 *      **有头浏览器 + `--window-position=-4000,-4000`（移出屏幕）能正常过校验**，所以默认就这么干。
 *   → 结论：api.php 必须由真实浏览器内核发，音频文件仍由 Node 直连（CDN 无防护）。
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, spawnSync, execFileSync } = require("child_process");

// ---------------------------------------------------------------------------
// 站点配置
// ---------------------------------------------------------------------------
const SITES = {
  xyz: {
    host: "music.gdstudio.xyz",
    label: "国际版",
    // 实测支持：netease kuwo joox qobuz tidal apple ytmusic tencent
    sources: ["netease", "qobuz", "joox", "kuwo", "tidal", "apple", "ytmusic", "tencent"],
  },
  org: {
    host: "music.gdstudio.org",
    label: "国内版",
    sources: ["netease", "joox", "kuwo", "apple", "ytmusic", "qobuz", "tidal"],
  },
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const cfg = {
    site: "xyz",
    sources: null,
    select: "quality",
    br: 999,
    brMin: 128,
    strictBr: false,
    losslessOnly: false,
    out: path.join(process.cwd(), "downloads"),
    delay: 4,
    max: 0,
    force: false,
    list: null,
    playlist: null,
    queries: [],
    chromePort: 9333,
    chromeProfile: path.join(os.homedir(), ".gd-chrome-profile"),
    chromeBin: null,
    proxy: null,
    keepChrome: false,
    attach: false,
    showWindow: false,
    enrich: false,
    direct: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--site": cfg.site = next(); break;
      case "--sources": cfg.sources = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--select": cfg.select = next(); break;
      case "--br": cfg.br = parseInt(next(), 10); break;
      case "--br-min": cfg.brMin = parseInt(next(), 10); break;
      case "--strict-br": cfg.strictBr = true; break;
      case "--lossless-only":
      case "--flac-only": cfg.losslessOnly = true; break;
      case "--out": cfg.out = path.resolve(next()); break;
      case "--delay": cfg.delay = parseFloat(next()); break;
      case "--max": cfg.max = parseInt(next(), 10); break;
      case "--force": cfg.force = true; break;
      case "--list": cfg.list = path.resolve(next()); break;
      case "--playlist": cfg.playlist = next(); break;
      case "--chrome-port": cfg.chromePort = parseInt(next(), 10); break;
      case "--chrome-profile": cfg.chromeProfile = path.resolve(next()); break;
      case "--chrome": cfg.chromeBin = next(); break;
      case "--proxy": cfg.proxy = next(); break;
      case "--keep-chrome": cfg.keepChrome = true; break;
      case "--attach": cfg.attach = true; break;
      case "--show-window": cfg.showWindow = true; break;
      case "--enrich": cfg.enrich = true; break;
      case "--direct": cfg.direct = true; break;
      case "--help":
      case "-h":
        console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^\/\*\*?/, ""));
        process.exit(0);
        break;
      default:
        if (a.startsWith("-")) { console.error(`未知参数: ${a}`); process.exit(1); }
        cfg.queries.push(a);
    }
  }
  if (!SITES[cfg.site]) { console.error(`--site 只支持 xyz / org`); process.exit(1); }
  if (!["quality", "first"].includes(cfg.select)) { console.error(`--select 只支持 quality（全源扫描择优）/ first（命中无损即停）`); process.exit(1); }
  if (!cfg.sources) cfg.sources = SITES[cfg.site].sources.slice();
  return cfg;
}

const CFG = parseArgs(process.argv.slice(2));
const SITE = SITES[CFG.site];
let chromeChild = null;   // 本脚本自己拉起的 Chrome 进程（用于跑完关掉，避免看不见的后台窗口常驻）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const politeDelay = () => sleep(CFG.delay * (0.7 + Math.random() * 0.6));
const log = (m) => console.log(m);

// ---------------------------------------------------------------------------
// CDP（Chrome DevTools Protocol）最小客户端 —— 只用 Node 内置能力
// ---------------------------------------------------------------------------
class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    if (typeof WebSocket === "undefined") {
      throw new Error("需要 Node >= 22（内置 WebSocket）。当前版本 " + process.version);
    }
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      this.ws.addEventListener("open", res, { once: true });
      this.ws.addEventListener("error", (e) => rej(new Error("调试端口 WebSocket 连接失败: " + (e.message || e.type))), { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
      // 事件（Page.loadEventFired 等）本脚本按轮询处理，不订阅
    });
    this.ws.addEventListener("close", () => {
      for (const [, p] of this.pending) p.reject(new Error("调试连接已断开"));
      this.pending.clear();
    });
  }
  send(method, params, timeoutMs) {
    const id = ++this.id;
    const payload = { id, method, params: params || {} };
    if (this.sessionId) payload.sessionId = this.sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify(payload)); } catch (e) { this.pending.delete(id); reject(e); return; }
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("CDP 超时: " + method)); }
      }, timeoutMs || 120000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

function httpJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = require("http").request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET", timeout: timeoutMs || 4000 },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

function findChrome() {
  if (CFG.chromeBin) return CFG.chromeBin;
  const cands = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}

async function debugPortUp() {
  try {
    const v = await httpJson(`http://127.0.0.1:${CFG.chromePort}/json/version`, 2500);
    return v && v.webSocketDebuggerUrl ? v : null;
  } catch { return null; }
}

/** 复用已有 Chrome 时也把它的窗口强制挪到屏幕外。
 *  老版本代码在校验失败时会弹出可见窗口，那个 Chrome 会一直留在调试端口上被后续运行复用，
 *  可见窗口也就一直挂着 —— 这里在复用时把所有页面窗口统一移到 -4000,-4000，保证「永不弹窗」。 */
async function moveWindowsOffscreen(ver) {
  if (CFG.showWindow) return;
  let cdp = null;
  try {
    cdp = new CDP(ver.webSocketDebuggerUrl);
    await cdp.connect();
    const targets = await httpJson(`http://127.0.0.1:${CFG.chromePort}/json/list`, 4000).catch(() => []);
    for (const t of (targets || [])) {
      if (t.type !== "page") continue;
      try {
        const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId: t.id });
        if (windowId == null) continue;
        // 最小化/最大化状态下 bounds 修改会被忽略，先恢复 normal 再挪
        await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }).catch(() => {});
        await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: -4000, top: -4000 } });
      } catch {}
    }
    log("[i] 已将复用 Chrome 的窗口移到屏幕外（不弹窗）");
  } catch (e) {
    log(`[!] 移动窗口失败（不影响下载）：${e.message}`);
  } finally {
    try { cdp && cdp.close(); } catch {}
  }
}

async function ensureChrome() {
  const up = await debugPortUp();
  if (up) {
    log(`[i] 复用已开启调试端口的 Chrome (${up.Browser})`);
    await moveWindowsOffscreen(up);
    return up;
  }
  if (CFG.attach) throw new Error(`未检测到调试端口 ${CFG.chromePort}，且指定了 --attach`);

  const bin = findChrome();
  if (!bin) throw new Error("未找到 Chrome/Chromium，请用 --chrome <路径> 指定");

  if (!fs.existsSync(CFG.chromeProfile)) fs.mkdirSync(CFG.chromeProfile, { recursive: true });
  const base = [
    `--remote-debugging-port=${CFG.chromePort}`,
    `--user-data-dir=${CFG.chromeProfile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion",
    `--user-agent=${UA}`,
    "--window-size=1280,900",
  ];
  // 默认不弹窗：不再依赖「窗口移出屏幕」（Chrome 会把完全离屏的窗口自动拉回可见区域，
  // 导致弹窗）。改由 ensureChrome 里的可见性模式处理：真无头 → open -j 隐藏实例，均不可见。
  if (CFG.showWindow) base.push("--window-position=80,60");
  if (CFG.proxy) base.push(`--proxy-server=${CFG.proxy}`);

  // 受限/容器环境（沙箱里 Chrome 自带沙箱起不来 → GPU 进程崩溃 → 几十秒后整个浏览器退出）
  // 需要这组兼容参数。首次探测到崩溃后记住，后续启动直接用。
  const COMPAT = ["--no-sandbox", "--disable-gpu", "--disable-software-rasterizer", "--disable-dev-shm-usage"];
  const modeFile = path.join(__dirname, ".gd-flac-cache", "chrome-mode.json");
  let mode = "normal";
  try { mode = (JSON.parse(fs.readFileSync(modeFile, "utf8")).mode) || "normal"; } catch {}

  const launchHeaded = (extra, tag) => {
    log(`[i] 启动 Chrome${tag}…`);
    const child = spawn(bin, [...base, ...extra, `https://${SITE.host}/`], { detached: true, stdio: "ignore" });
    child.unref();
    chromeChild = child;
  };

  // open -n -j -g：新实例 + 隐藏启动。App 处于隐藏状态时窗口根本不上屏，
  // 不依赖「窗口移出屏幕」（Chrome 会把完全离屏的窗口自动拉回可见区域，导致弹窗）。
  const launchHidden = (extra, tag) => {
    const appDir = bin.includes(".app") ? bin.slice(0, bin.indexOf(".app") + 4) : bin;
    log(`[i] 隐藏启动 Chrome${tag}（open -j，无窗口）…`);
    const r = spawnSync("open", ["-n", "-j", "-g", "-a", appDir, "--args",
      ...base, ...extra, `https://${SITE.host}/`], { timeout: 30000, encoding: "utf8" });
    chromeChild = null;   // open 拿不到 child 句柄，closeOwnChrome 走 pgrep 兜底
    if (r.status !== 0) log(`[!] open 隐藏启动失败: ${String(r.stderr || r.stdout || "").slice(0, 100)}`);
  };

  /** 等调试端口 + 确认浏览器没有几秒后就崩掉 */
  const waitAlive = async () => {
    let ver = null;
    for (let i = 0; i < 25; i++) { await sleep(600); ver = await debugPortUp(); if (ver) break; }
    if (!ver) return null;
    await sleep(3000);
    const again = await debugPortUp();
    return again ? ver : null;      // 端口在但浏览器已退出 → 视为失败
  };

  // 可见性模式：用户要求「绝不弹窗」。只允许两种真正不可见的启动方式，
  // 逐一实测「能否过 Cloudflare」——过不了就换下一种，绝不退回可见窗口。
  const visModes = CFG.showWindow
    ? [{ id: "headed", tag: "", launch: launchHeaded, needCheck: false }]
    : [
        { id: "headless", tag: "（真无头 --headless=new）", launch: (x, t) => launchHeaded(["--headless=new", ...x], t), needCheck: true },
        { id: "hidden", tag: "（open -j 隐藏实例）", launch: launchHidden, needCheck: true },
      ];

  const compatOrder = mode === "compat" ? [COMPAT, []] : [[], COMPAT];
  for (const vm of visModes) {
    for (const extra of compatOrder) {
      closeOwnChrome();
      await sleep(1500);
      vm.launch(extra, vm.tag + (extra.length ? "（兼容模式）" : ""));
      const ver = await waitAlive();
      if (!ver) { log("[!] 浏览器启动后异常退出，换方式重试…"); continue; }
      if (vm.needCheck) {
        const ok = await quickSiteCheck(ver);
        if (!ok) { log(`[!] ${vm.id} 模式过不了 Cloudflare 挑战，换下一种启动方式…`); closeOwnChrome(); continue; }
        log(`[i] ${vm.id} 模式已通过站点校验（全程无窗口）`);
      }
      const used = extra.length ? "compat" : "normal";
      if (used !== mode) {
        try { fs.mkdirSync(path.dirname(modeFile), { recursive: true }); fs.writeFileSync(modeFile, JSON.stringify({ mode: used })); } catch {}
      }
      log(`[i] Chrome 就绪: ${ver.Browser}`);
      return ver;
    }
  }
  throw new Error("无头/隐藏模式均未能通过站点校验（按要求绝不弹出可见窗口）。可手动登录后加 --attach 复用。");
}

/** 快速站点校验：开一个标签到目标站，轮询标签标题，离开 Cloudflare 挑战页即算通过 */
async function quickSiteCheck(ver) {
  let cdp = null;
  try {
    cdp = new CDP(ver.webSocketDebuggerUrl);
    await cdp.connect();
    const { targetId } = await cdp.send("Target.createTarget", { url: `https://${SITE.host}/` });
    let ok = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1500);
      const targets = await httpJson(`http://127.0.0.1:${CFG.chromePort}/json/list`, 3000).catch(() => []);
      const t = (targets || []).find((x) => x.id === targetId);
      const title = t ? t.title : "";
      if (title && !/just a moment|attention required|正在验证/i.test(title)) { ok = true; break; }
    }
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    return ok;
  } catch { return false; }
  finally { try { cdp && cdp.close(); } catch {} }
}

/** 关掉本脚本自己拉起的 Chrome（不动用户自己的窗口） */
function closeOwnChrome() {
  if (chromeChild) {
    try { chromeChild.kill("SIGTERM"); } catch {}
    chromeChild = null;
    return;
  }
  // open -j 方式拉起的实例没有 child 句柄，按 profile 路径定位（只杀我们自己的实例）
  try {
    const pr = spawnSync("pgrep", ["-f", `user-data-dir=${CFG.chromeProfile}`], { encoding: "utf8" });
    const pids = String(pr.stdout || "").split(/\s+/).filter(Boolean).map(Number);
    for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch {} }
  } catch {}
}

// ---------------------------------------------------------------------------
// 页面会话：把 api.php 调用搬进浏览器上下文
// ---------------------------------------------------------------------------
class PageSession {
  constructor(cdp, wsUrl) { this.cdp = cdp; this.wsUrl = wsUrl; }

  static async open(ver) {
    const cdp = new CDP(ver.webSocketDebuggerUrl);
    await cdp.connect();
    // 找到 / 新建一个 GD 标签页
    let targets = [];
    try { targets = await httpJson(`http://127.0.0.1:${CFG.chromePort}/json/list`, 4000); } catch {}
    let page = (targets || []).find((t) => t.type === "page" && String(t.url).includes("gdstudio"));
    let targetId = page ? page.id : null;
    if (!targetId) {
      const r = await cdp.send("Target.createTarget", { url: `https://${SITE.host}/` });
      targetId = r.targetId;
    }
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    cdp.sessionId = sessionId;
    await cdp.send("Runtime.enable");
    const self = new PageSession(cdp, ver.webSocketDebuggerUrl);
    await self.ensureOnSite();
    return self;
  }

  async evaluate(expression, timeoutMs) {
    const r = await this.cdp.send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    }, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails);
      throw new Error("页面执行异常: " + String(d).split("\n")[0]);
    }
    return r.result.value;
  }

  /** 绕过缓存硬刷新页面：签名内含页面加载时的 ts9 时间戳与 version 串，
   *  若 crc32.min.js 被缓存了旧版（或 ts 过期），签名会被服务端判 Invalid request，
   *  且单纯 ensureOnSite（只查标题、不重载）永远拿不到新鲜签名 —— 这里用 CDP ignoreCache 重载。 */
  async hardReload() {
    try {
      await this.cdp.send("Page.enable");
      await this.cdp.send("Page.reload", { ignoreCache: true });
      await sleep(6000);
      log("   [i] 已绕缓存硬刷新页面，重新获取站点签名脚本…");
    } catch (e) {
      log(`[!] 硬刷新失败（${e.message}），退回普通校验`);
    }
  }

  /** 确保当前页在目标站点且已过 Cloudflare 挑战 */
  async ensureOnSite() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = await this.evaluate(
        `(async () => {
           if (location.host !== ${JSON.stringify(SITE.host)}) {
             location.href = ${JSON.stringify("https://" + SITE.host + "/")};
             return "navigating";
           }
           return document.title + "||" + location.host;
         })()`
      ).catch(() => "navigating");
      if (String(state).startsWith("navigating")) { await sleep(5000); continue; }

      let passed = false;
      for (let i = 0; i < 40; i++) {
        const t = await this.evaluate("document.title").catch(() => "");
        if (!/just a moment|attention required|正在验证/i.test(String(t || ""))) { passed = true; break; }
        if (i === 0) log("[.] 正在通过 Cloudflare 校验…");
        await sleep(1500);
      }
      if (!passed) continue;
      // 确认站点脚本已就绪（crc32 由 crc32.min.js 暴露）
      const ready = await this.evaluate(
        `(async () => {
           for (let i = 0; i < 40; i++) {
             if (typeof crc32 === "function") return "ok";
             await new Promise(r => setTimeout(r, 250));
           }
           return "no-crc32";
         })()`
      ).catch(() => "err");
      if (ready === "ok") { log(`[+] ${SITE.label} ${SITE.host} 就绪（Cloudflare 校验已通过）`); return; }
      log(`[!] 站点签名脚本未就绪（${ready}），再试一次…`);
      await sleep(3000);
    }
    throw new Error(`无法在 ${SITE.host} 完成 Cloudflare 校验。可手动在打开的 Chrome 窗口里过一次验证后重跑。`);
  }

  /**
   * 签名一律调用页面里的 crc32()。
   *
   * 为什么不在 Node 里复刻（2026-09 实测结论）：
   *   crc32.min.js（jsjiami.com.v7 混淆）里的 crc32(x) 实际做的是
   *       s = md5( ts9 + "|" + location.hostname + "|" + version(每段补零2位) + "|" + x ).slice(-8).toUpperCase()
   *   但其中的 md5 不是标准 MD5：
   *     - 文件里含标准的 HMAC 双垫常量 0x36363636 / 0x5c5c5c5c（HMAC-MD5 结构）
   *     - 实测站点全局 md5("abc") = 9ef90af686e68195b6f6d89b69d3c584 ≠ 标准 900150983cd24fb0d6963f7d28e17f72
   *       （对 ""、"Resonance"、"hello world" 同样不等）
   *     - 183 个常见密钥字典爆破 HMAC-MD5 / md5(key+msg) / md5(msg+key) 全部未命中
   *   结论：这是站点故意改造过的 MD5 内核 + 隐藏密钥，属于反盗链设计，无法离线复刻。
   *   好处是照抄页面函数反而更抗站点升级——站点换算法我们自动跟随。
   */
  async ensureSigner() {
    if (this.signMode) return this.signMode;
    for (let i = 0; i < 20; i++) {
      const t = await this.evaluate("typeof crc32").catch(() => "undefined");
      if (t === "function") { this.signMode = "page"; return this.signMode; }
      await sleep(500);
    }
    throw new Error("站点签名函数 crc32() 未就绪，无法继续（可--keep-chrome 后手动刷新页面再重跑）");
  }

  /** 在页面里 POST /api.php，用站点自带的 crc32() 计算签名 */
  async api(params) {
    const key = params.id !== undefined && params.id !== null ? params.id
      : (params.name !== undefined && params.name !== null ? params.name : "");
    const payload = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join("&");

    await this.ensureSigner();

    const expr = `(async () => {
      const key = ${JSON.stringify(String(key))};
      const payload = ${JSON.stringify(payload)};
      const s = crc32(encodeURIComponent(key));
      // 2026-09-25 站点改版：/api.php 由 POST 改为 GET（js/ajax.js?v=20260925），
      // 签名算法不变：s = crc32(urlEncode(主参数))，主参数 = id 或 name
      const res = await fetch('/api.php?' + payload + '&s=' + s, {
        method: 'GET',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      const txt = await res.text();
      let json = null; try { json = JSON.parse(txt); } catch {}
      return JSON.stringify({ status: res.status, json: json, raw: txt.slice(0, 300) });
    })()`;

    let out;
    for (let attempt = 1; attempt <= 3; attempt++) {
      let r;
      try { r = JSON.parse(await this.evaluate(expr, 25000)); }
      catch (e) { if (attempt === 3) throw e; await sleep(2000 * attempt); continue; }

      if (r.status === 429) {
        log("   [限流 429] 冷却 8s…");
        await sleep(8000);
        continue;
      }
      // 判定不看状态码：-32001 会话过期实测会以非 200 返回，Invalid request 是 200，
      // 只要响应体里出现这两种错误就一律硬刷新重签
      const invalidSig =
        r.status === 401 || r.status === 403 ||
        (r.raw && /Invalid request/i.test(r.raw)) ||
        // 站点后端页面会话过期：页面加载时建立的 session 有 TTL，过期后所有音源
        // 一律返回 {"code":-32001,"message":"Session with given id not found."}，
        // 只有重新加载页面拿到新会话才能恢复（2026-09-24 王力宏 14/16 失败即此因）
        (r.raw && /Session with given id not found/i.test(r.raw));
      if (invalidSig) {
        // 签名过期 / 挑战失效 / crc32.min.js 缓存陈旧 / 站点会话过期：硬刷新拿新鲜会话再试
        if (attempt < 3) {
          log("   [!] 签名/会话失效，硬刷新页面后重试…");
          this.signMode = null;
          await this.hardReload();
          await this.ensureOnSite();
          continue;
        }
        throw new Error("签名校验失败: " + (r.raw || "").slice(0, 120));
      }
      if (r.status !== 200) {
        if (attempt === 3) return r;
        await sleep(1500 * attempt);
        continue;
      }
      return r;
    }
    throw new Error("api.php 请求失败（重试耗尽）");
  }

  /** Node 直连失败时的兜底：由页面取回音频并分块传回 Node */
  async fetchInPage(url, filePath) {
    const CHUNK = 4 * 1024 * 1024;
    const total = await this.evaluate(
      `(async () => {
         const r = await fetch(${JSON.stringify(url)});
         if (!r.ok) return JSON.stringify({ error: 'HTTP ' + r.status });
         window.__gdBuf = await r.arrayBuffer();
         return JSON.stringify({ size: window.__gdBuf.byteLength });
       })()`,
      300000
    );
    const meta = JSON.parse(total);
    if (meta.error) throw new Error("页面取流失败: " + meta.error);
    const fd = fs.openSync(filePath, "w");
    try {
      let off = 0;
      while (off < meta.size) {
        const b64 = await this.evaluate(
          `(() => { const u = new Uint8Array(window.__gdBuf, ${off}, ${Math.min(CHUNK, meta.size - off)});
                    let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
                    return btoa(s); })()`,
          120000
        );
        const buf = Buffer.from(b64, "base64");
        fs.writeSync(fd, buf);
        off += buf.length;
        if (meta.size > 8 * 1024 * 1024) process.stdout.write(`\r    页面取流 ${Math.round((off / meta.size) * 100)}%   `);
      }
      if (meta.size > 8 * 1024 * 1024) process.stdout.write("\n");
    } finally { fs.closeSync(fd); }
    await this.evaluate("(() => { window.__gdBuf = null; return 1; })()").catch(() => {});
    return meta.size;
  }

  /** 最终兜底：让 Chrome 自己把音频下载到临时目录再搬过来。
   *  浏览器的「下载」不走 CORS（fetchInPage 的页面 fetch 跨域到音频 CDN 必被拦，
   *  实测报 TypeError: Failed to fetch），这是绕过 CORS 最可靠的办法。返回字节数。 */
  async downloadViaBrowser(url, filePath) {
    const tmpDir = path.join(os.tmpdir(), `gd-dl-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    // Browser.* 属浏览器级命令，页面 session 里发会被拒，单独开一条浏览器级连接
    const bcdp = new CDP(this.wsUrl);
    await bcdp.connect();
    let targetId = null;
    try {
      await bcdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: tmpDir });
      const r = await bcdp.send("Target.createTarget", { url, background: true });
      targetId = r.targetId;
      // 轮询临时目录：等 .crdownload 消失且出现实体文件
      const deadline = Date.now() + 600000;
      let got = null;
      while (Date.now() < deadline) {
        await sleep(3000);
        const files = fs.readdirSync(tmpDir).filter((f) => !f.startsWith("."));
        const partial = files.some((f) => f.endsWith(".crdownload") || f.endsWith(".download"));
        const done = files.filter((f) => !f.endsWith(".crdownload") && !f.endsWith(".download"));
        if (!partial && done.length > 0) {
          const cand = done.map((f) => ({ f, s: fs.statSync(path.join(tmpDir, f)).size })).sort((a, b) => b.s - a.s)[0];
          if (cand && cand.s > 0) { got = cand.f; break; }
        }
      }
      if (!got) throw new Error("600s 内未见下载完成（该 URL 可能被 Chrome 内联播放而非下载）");
      const size = fs.statSync(path.join(tmpDir, got)).size;
      fs.renameSync(path.join(tmpDir, got), filePath);
      return size;
    } finally {
      if (targetId) await bcdp.send("Target.closeTarget", { targetId }).catch(() => {});
      try { await bcdp.send("Browser.setDownloadBehavior", { behavior: "default" }); } catch {}
      try { bcdp.close(); } catch {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// 直连会话（--direct）：不用浏览器。Node 现算站点签名（gd-signer.js）+ curl 调 api.php
// 2026-09-30 全链路实测：search/url/pic/lyric/embeat 均通，xyz/org 双站、多音源稳定。
// ---------------------------------------------------------------------------
/** curl GET 并解析 JSON，返回 {status, json, raw}（raw 截断 300 字用于错误匹配） */
function curlJson(url, timeoutSec = 60) {
  const r = spawnSync(
    "curl",
    ["-sS", "--max-time", String(timeoutSec), "-A", UA,
     "-H", "X-Requested-With: XMLHttpRequest", "-w", "\n%{http_code}", url],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  if (r.status !== 0) throw new Error(`curl 失败(退出 ${r.status}): ${String(r.stderr || "").slice(0, 160)}`);
  const out = r.stdout;
  const idx = out.lastIndexOf("\n");
  const body = idx >= 0 ? out.slice(0, idx) : out;
  const status = idx >= 0 ? (parseInt(out.slice(idx + 1), 10) || 0) : 0;
  let json = null;
  try { json = JSON.parse(body); } catch {}
  return { status, json, raw: body.slice(0, 300) };
}

class DirectSession {
  constructor(signer) { this.signer = signer; }

  static async open() {
    const { loadSigner } = require("./gd-signer.js");
    const signer = loadSigner(SITE.host);
    log(`[i] 直连模式就绪：站点签名器已装载（crc32.min.js，version ${signer.version}），全程无浏览器`);
    return new DirectSession(signer);
  }

  /** 与 PageSession.api 同构：页面里由 crc32() 签名，这里由 gd-signer 现算 */
  async api(params) {
    const { loadSigner } = require("./gd-signer.js");
    const key = params.id !== undefined && params.id !== null ? params.id
      : (params.name !== undefined && params.name !== null ? params.name : "");
    const payload = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join("&");

    for (let attempt = 1; attempt <= 3; attempt++) {
      let r;
      try {
        const s = this.signer.sign(encodeURIComponent(String(key)));
        r = curlJson(`https://${SITE.host}/api.php?${payload}&s=${s}`, 60);
      } catch (e) {
        if (attempt === 3) throw e;
        await sleep(2000 * attempt);
        continue;
      }
      if (r.status === 429) {
        log("   [限流 429] 冷却 8s…");
        await sleep(8000);
        continue;
      }
      const invalidSig =
        r.status === 401 || r.status === 403 ||
        (r.raw && /Invalid request/i.test(r.raw)) ||
        (r.raw && /Session with given id not found/i.test(r.raw));
      if (invalidSig) {
        if (attempt < 3) {
          log("   [!] 签名被拒，刷新 crc32.min.js 后重试…");
          this.signer = loadSigner(SITE.host, { fresh: true });
          continue;
        }
        throw new Error("签名校验失败: " + String(r.raw || "").slice(0, 120));
      }
      if (r.status !== 200) {
        if (attempt === 3) return r;
        await sleep(1500 * attempt);
        continue;
      }
      return r;
    }
    throw new Error("api.php 请求失败（重试耗尽）");
  }

  async evaluate() { throw new Error("直连模式没有页面上下文"); }
  async fetchInPage() { throw new Error("直连模式不支持页面取流（音频由 Node/curl 直接下载）"); }
  async downloadViaBrowser() { throw new Error("直连模式不支持浏览器下载"); }
}

// ---------------------------------------------------------------------------
// 匹配与品质（沿用主下载器的打分逻辑）
// ---------------------------------------------------------------------------
// 繁简归一化：站点自带 /js/chinese-s2t.js（joox 等源常返回繁体「周杰倫」，
// 不做转换会把「周杰倫」判成与「周杰伦」歌手不符，导致整首歌匹配失败）
let S2T = null;
async function loadS2T(session) {
  const cacheDir = path.join(__dirname, ".gd-flac-cache");
  const file = path.join(cacheDir, "chinese-s2t.js");
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < 100) {
      const txt = CFG.direct
        ? require("./gd-signer.js").curlText(`https://${SITE.host}/js/chinese-s2t.js`)
        : await session.evaluate(`(async () => await (await fetch('/js/chinese-s2t.js')).text())()`);
      if (txt && String(txt).length > 100) {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(file, txt);
      }
    }
    const m = require(file);
    S2T = m && typeof m.t2s === "function" ? m : (typeof m === "function" ? { t2s: m } : null);
    if (S2T) log("[i] 已加载站点繁简转换表（chinese-s2t.js）");
  } catch { S2T = null; }
}

function normalize(s) {
  let str = String(s || "");
  try { if (S2T && S2T.t2s) str = S2T.t2s(str); } catch {}
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[・·.．,，、'"“”‘’()[\]（）【】《》:：;；!！?？\-—_/\\|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchScore(t, query) {
  const qName = normalize(query.title);
  const qArtist = normalize(query.artist || "");
  const tName = normalize(t.name);
  const artists = Array.isArray(t.artist) ? t.artist.map(normalize) : [normalize(t.artist || "")];
  const tArtist = artists.join(" ");
  let score = 0, nameOk = false;
  if (tName === qName) { score += 100; nameOk = true; }
  else if (tName.includes(qName) || qName.includes(tName)) { score += 60; nameOk = true; }
  else if (tName.startsWith(qName) || qName.startsWith(tName)) { score += 40; nameOk = true; }

  let artistOk = false;
  if (qArtist) {
    if (artists.some((a) => a && (a === qArtist || a.includes(qArtist) || qArtist.includes(a)))) { score += 30; artistOk = true; }
    else if (tArtist.includes(qArtist)) { score += 15; artistOk = true; }
    else score -= 100;
  } else artistOk = true;

  const bad = /(remix|cover|live|karaoke|伴奏|翻唱|现场版|纯音乐|instrumental|demo|rework|bootleg|dj|beat|montagem)/;
  if (bad.test(tName)) score -= 25;
  if (bad.test(tArtist)) score -= 20;
  if (t.extra_data && t.extra_data.is_available === false) score -= 50;
  return { score, ok: nameOk && artistOk };
}

function pickBest(tracks, query) {
  let best = null, bestScore = -1e9;
  for (const t of tracks) {
    if (!t || t.id === undefined) continue;
    const r = matchScore(t, query);
    if (r.ok && r.score > bestScore) { bestScore = r.score; best = t; }
  }
  return { track: best, score: bestScore };
}

const BR_LADDER = [999, 740, 320, 192, 128];
const LOSSLESS_EXTS = new Set(["flac", "ape", "alac", "wav", "aiff"]);

function extOf(url, br) {
  const fn = String(url).split("?")[0].split("/").pop() || "";
  const dot = fn.lastIndexOf(".");
  let ext = dot >= 0 ? fn.slice(dot + 1).toLowerCase() : "";
  if (!["mp3", "flac", "ogg", "m4a", "m4s", "mp4", "aac", "wav", "alac", "aiff", "ape"].includes(ext)) {
    ext = br > 320 ? "flac" : "mp3";
  }
  return ext;
}
const isLossless = (stream, ext) => LOSSLESS_EXTS.has(ext) || Number(stream.br) > 320;
const qualityScore = (stream, ext) => (isLossless(stream, ext) ? 1e6 : 0) + (Number(stream.br) || 0);

// ---------------------------------------------------------------------------
// 全源扫描 → 择优（核心：先搜遍所有音源，再按"实际品质"排序挑最好的）
// ---------------------------------------------------------------------------
// 为什么不能只看接口返回的 br：站点会把不同源的 br 归一化标注，实测虚标严重——
//   同曲 netease 报 636、joox 报 999，但按 size/duration 算出来的实际码率都只有 ~630kbps；
//   而 qobuz 报 999、实际 ~1411kbps（37MB，extra_data.has_hires=true，24bit 真 Hi-Res）。
// 所以真正的品质信号是 **size / duration 反推的实际码率**（所有源的搜索接口都给 duration）。
//
// 来源偏好只在「实际品质相同」时当微调（qobuz/tidal 是真母带仓库，kuwo/joox 转码风险高）
const SOURCE_TIER = { qobuz: 3, tidal: 3, apple: 2, netease: 2, tencent: 2, joox: 1, kuwo: 1, migu: 1, ytmusic: 0, kugou: 1, spotify: 1, ximalaya: 0 };

/** 用 size/duration 反推实际平均码率（kbps）；拿不到 size 时退回接口报的 br */
function estKbps(stream, durationSec) {
  const size = Number(stream && stream.size);
  if (Number.isFinite(size) && size > 0 && durationSec > 0) return Math.round((size * 8) / durationSec / 1000);
  const br = Number(stream && stream.br);
  return Number.isFinite(br) && br > 0 ? br : 0;
}

function candidateScore(c) {
  let s = 0;
  s += c.lossless ? 4e6 : 0;                       // 无损永远压过有损
  s += c.hasHires ? 1e6 : 0;                       // 源自己声明有 Hi-Res
  s += Math.min(c.estKbps || 0, 6000) * 10;        // 主信号：实际码率
  s += (SOURCE_TIER[c.src] ?? 1) * 100;            // 同等品质下的来源微调
  s += Math.min(c.matchScore || 0, 130);           // 匹配度微调
  if (!c.lossless && c.estKbps > 0 && c.estKbps < 192) s -= 2e5;   // 低码有损狠狠降权
  return s;
}

function fmtCand(c) {
  const bits = [];
  bits.push(c.ext.toUpperCase());
  if (c.stream.br) bits.push(`标称${c.stream.br}k`);
  if (c.estKbps) bits.push(`实际≈${c.estKbps}k`);
  if (c.stream.size) bits.push(`${(c.stream.size / 1048576).toFixed(1)}MB`);
  if (c.hasHires) bits.push("has_hires✓");
  if (c.stream.degraded) bits.push("已降级");
  return bits.join(" ");
}

/** 阶段一：按配置的音源顺序逐个搜索 + 取流，全部收进候选池（不提前挑） */
async function scanSources(session, query) {
  const found = [];
  const notes = [];
  for (const src of CFG.sources) {
    await politeDelay();
    const name = query.artist ? `${query.title} ${query.artist}` : query.title;
    // 2026-09-25 站点改版后新增 WAF 校验：查询串含 ' * ( ) 直接 401 Invalid request
    //（实测 Beggin' / dashstar* / Luv (sic) 全部被拒），故发请求前剔除这些字符
    const safeName = name.replace(/['*()\[\]（）]/g, " ");
    let sr;
    try { sr = await session.api({ types: "search", count: 20, source: src, pages: 1, name: safeName }); }
    catch (e) { notes.push(`${src}: 搜索失败（${e.message}）`); continue; }
    if (!Array.isArray(sr.json) || sr.json.length === 0) { notes.push(`${src}: 未找到`); continue; }

    const { track, score } = pickBest(sr.json, query);
    if (!track || score < 40) { notes.push(`${src}: 匹配度不足`); continue; }

    const duration = Number(track.extra_data && track.extra_data.duration) || 0;
    let stream = null;
    try { stream = await getStream(session, track, src); }
    catch (e) { notes.push(`${src}: 取流失败（${e.message}）`); continue; }
    if (!stream) { notes.push(`${src}: 无可用流`); continue; }
    if (stream.denied) { notes.push(`${src}: 无版权/试听受限`); continue; }

    const ext = extOf(stream.url, stream.br);
    const c = {
      src, track, stream, ext, duration, matchScore: score,
      hasHires: !!(track.extra_data && track.extra_data.has_hires),
      lossless: isLossless(stream, ext),
      estKbps: estKbps(stream, duration),
      trackInfo: `${track.name} - ${(Array.isArray(track.artist) ? track.artist.join("/") : track.artist) || "?"}`,
    };
    c.score = candidateScore(c);
    found.push(c);

    // --select first：命中无损就停（省配额，回到旧行为）
    if (CFG.select === "first" && c.lossless) break;
  }
  return { found, notes };
}

// ---------------------------------------------------------------------------
// 站点歌曲详情（对应站点「歌曲详情」弹窗的全部字段）
//   歌名/歌手/专辑/时长/来源/歌曲ID/文件大小/播放音质/歌词/封面
// 数据源 = 同一次搜索命中的 track（name/artist/album/pic_id/lyric_id/duration）
//        + types=pic（封面 URL） + types=lyric（歌词/翻译）。
// 抓取后随 .downloaded.json 落盘，flac_metadata_embedder.py 直接复用，
// 不再依赖已被 Cloudflare 全站拦死、且签名算法已失效的 music-api.* mirror。
// ---------------------------------------------------------------------------
async function fetchGdDetails(session, c) {
  const t = c.track || {};
  const src = c.src;
  const details = {
    track: {
      id: t.id ?? null,
      name: t.name ?? null,
      artist: Array.isArray(t.artist) ? t.artist.map(String) : (t.artist ? [String(t.artist)] : []),
      album: t.album ?? null,
      duration: Number(t.extra_data && t.extra_data.duration) || null,
      source: t.source || src,
      url_id: t.url_id ?? null,
      pic_id: t.pic_id ?? null,
      lyric_id: t.lyric_id ?? null,
      isrc: (t.extra_data && t.extra_data.isrc) || null,
      has_hires: !!(t.extra_data && t.extra_data.has_hires),
    },
    cover_url: null,
    cover_size: null,
    lyric: null,
  };

  if (t.pic_id) {
    for (const size of [1000, 640, 500, 300]) {
      try {
        await politeDelay();
        const r = await session.api({ types: "pic", source: src, id: t.pic_id, size });
        let url = r && r.json && r.json.url;
        if (!url || url === "err") continue;
        // 个别音源返回相对路径，补全为站点绝对 URL（同取流处理）
        if (!/^https?:\/\//i.test(url)) url = `https://${SITE.host}/` + String(url).replace(/^\/+/, "");
        details.cover_url = String(url);
        details.cover_size = size;
        break;
      } catch (e) {
        log(`   · 封面获取失败（size=${size}）: ${e.message}`);
      }
    }
    // 站点详情弹窗同样逻辑：去掉 CDN 缩略参数拿原图（netease ?param=WxH）
    if (details.cover_url) details.cover_url = details.cover_url.replace(/\?param=\d+y\d+$/i, "");
  }

  if (t.lyric_id) {
    try {
      await politeDelay();
      const r = await session.api({ types: "lyric", source: src, id: t.lyric_id });
      const j = r && r.json;
      if (j && j.lyric) details.lyric = { lyric: j.lyric, tlyric: j.tlyric || "" };
    } catch (e) {
      log(`   · 歌词获取失败: ${e.message}`);
    }
  }
  return details;
}

/** --enrich 用：只搜索匹配曲目（不取流），用于给旧索引补抓站点详情 */
async function findTrackOnly(session, query) {
  for (const src of CFG.sources) {
    await politeDelay();
    const name = query.artist ? `${query.title} ${query.artist}` : query.title;
    const safeName = name.replace(/['*()\[\]（）]/g, " ");
    let sr;
    try { sr = await session.api({ types: "search", count: 20, source: src, pages: 1, name: safeName }); }
    catch { continue; }
    if (!Array.isArray(sr.json) || sr.json.length === 0) continue;
    const { track, score } = pickBest(sr.json, query);
    if (track && score >= 40) return { src, track, score };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 取流（音质降级链）
// ---------------------------------------------------------------------------
async function getStream(session, track, src) {
  const startIdx = BR_LADDER.indexOf(CFG.br) >= 0 ? BR_LADDER.indexOf(CFG.br) : 0;
  const minIdx = CFG.strictBr ? startIdx : Math.max(BR_LADDER.indexOf(CFG.brMin), 0);
  const targets = BR_LADDER.slice(startIdx, minIdx + 1);

  let lastDenied = null, lastErr = null;
  for (const br of targets) {
    await politeDelay();
    let r;
    try { r = await session.api({ types: "url", source: src, id: track.id, br }); }
    catch (e) { lastErr = e; continue; }
    if (!r.json) { lastErr = new Error(`HTTP ${r.status}`); continue; }
    const j = r.json;
    if (j.br === -2 || j.br === -3) { lastDenied = { ...j, denied: true, br }; continue; }
    if (!j.url || j.url === "err" || j.br === -1) continue;
    // 2026-09-25 实测：个别音源（apple）会返回相对路径（如 cache/apple_xxx.m4a），
    // 补全为站点绝对 URL，否则 Node fetch/curl 都无法解析
    if (!/^https?:\/\//i.test(j.url)) j.url = `https://${SITE.host}/` + String(j.url).replace(/^\/+/, "");
    const actualBr = Number(j.br) > 0 ? Number(j.br) : br;
    return { ...j, requestedBr: br, degraded: actualBr < CFG.br };
  }
  if (lastDenied) return lastDenied;
  if (lastErr) throw lastErr;
  return null;
}

/** curl 兜底：undici(Node fetch) 对个别 CDN 会报网络层 "fetch failed"（TLS/连接复位等），
 *  curl 的网络栈更皮实，带 UA/Referer/重试直下。返回字节数。 */
function curlDownload(url, filePath) {
  const args = [
    "-L", "--fail", "--silent", "--show-error", "--location-trusted",
    "--connect-timeout", "20", "--max-time", "1800",
    "--retry", "2", "--retry-delay", "3",
    "-A", UA, "-H", `Referer: https://${SITE.host}/`,
    "-o", filePath, url,
  ];
  const r = spawnSync("curl", args, { timeout: 1800000, encoding: "utf8" });
  const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  if (r.status !== 0 || size === 0) {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
    throw new Error(`curl 失败(退出 ${r.status}): ${String(r.stderr || "").slice(0, 120)}`);
  }
  return size;
}

// ---------------------------------------------------------------------------
// 文件下载（Node 直连 → curl → Chrome 自下载 → 页面取流）
// ---------------------------------------------------------------------------
async function downloadFile(session, url, filePath) {
  const headers = { "User-Agent": UA, Referer: `https://${SITE.host}/` };
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(900000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (!r.body) throw new Error("响应无 body");
    const ws = fs.createWriteStream(filePath);
    const reader = r.body.getReader();
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      ws.write(Buffer.from(value));
      size += value.length;
    }
    await new Promise((res, rej) => ws.end((e) => (e ? rej(e) : res())));
    if (size === 0) throw new Error("下载到 0 字节");
    return size;
  } catch (e) {
    log(`   [!] Node 直连失败（${e.message}${e.cause ? " / " + e.cause : ""}），curl 重试…`);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
  }
  try {
    const size = curlDownload(url, filePath);
    log(`   [+] curl 直下成功（${(size / 1024 / 1024).toFixed(1)}MB）`);
    return size;
  } catch (e) {
    if (CFG.direct) {
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
      throw new Error(`Node 直连与 curl 均失败（直连模式无浏览器兜底）: ${e.message}`);
    }
    log(`   [!] ${e.message}，改用 Chrome 自下载兜底…`);
  }
  try {
    const size = await session.downloadViaBrowser(url, filePath);
    log(`   [+] Chrome 自下载成功（${(size / 1024 / 1024).toFixed(1)}MB）`);
    return size;
  } catch (e) {
    log(`   [!] Chrome 自下载失败（${e.message}），最后试页面取流…`);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
    return await session.fetchInPage(url, filePath);
  }
}

// ---------------------------------------------------------------------------
// 单曲主流程
// ---------------------------------------------------------------------------
/** 落地后实测音频参数（macOS 自带 afinfo，零依赖）。拿不到就返回空串，不影响流程 */
async function probeAudio(file) {
  try {
    const out = execFileSync("afinfo", [file], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] });
    const fmt = (out.match(/Data format:\s*(.+)/) || [])[1] || "";
    const br = (out.match(/bit rate:\s*(\d+)/) || [])[1] || "";
    const parts = [];
    const hz = (fmt.match(/(\d{4,6})\s*Hz/) || [])[1];
    const bits = (fmt.match(/(\d+)-bit/) || [])[1];
    const ch = (fmt.match(/(\d+)\s*ch/) || [])[1];
    if (hz) parts.push(`${(Number(hz) / 1000).toFixed(1)}kHz`);
    if (bits) parts.push(`${bits}bit`);
    if (ch) parts.push(`${ch}ch`);
    if (br) parts.push(`${Math.round(Number(br) / 1000)}kbps`);
    return parts.join(" ");
  } catch { return ""; }
}

async function downloadOne(session, query, index, total) {
  const label = query.artist ? `${query.artist} - ${query.title}` : query.title;
  log(`\n[${index}/${total}] 下载: ${label}`);

  const safeBase = label.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  fs.mkdirSync(CFG.out, { recursive: true });
  const indexFile = path.join(CFG.out, ".downloaded.json");
  let idx = {};
  try { idx = JSON.parse(fs.readFileSync(indexFile, "utf8")); } catch {}

  if (!CFG.force) {
    const known = idx[safeBase] && fs.existsSync(path.join(CFG.out, idx[safeBase].file));
    const existing = known ? idx[safeBase].file
      : (fs.readdirSync(CFG.out).find((f) => f.startsWith(safeBase + ".") && !f.endsWith(".json")) || null);
    if (existing) {
      if (CFG.enrich && !(idx[safeBase] && idx[safeBase].track)) {
        // --enrich：已下载但索引缺站点详情 → 只搜索 + 抓详情，不重新下载
        log(`[i] 已存在但缺站点详情，补抓中: ${existing}`);
        const found = await findTrackOnly(session, query);
        if (found) {
          const details = await fetchGdDetails(session, found);
          idx[safeBase] = {
            ...(idx[safeBase] || { file: existing }),
            file: existing, src: found.src, site: CFG.site, enriched: Date.now(),
            track: details.track, cover_url: details.cover_url,
            cover_size: details.cover_size, lyric: details.lyric,
          };
          fs.writeFileSync(indexFile, JSON.stringify(idx, null, 2));
          log(`[+] 站点详情已补入索引: ${existing}（专辑: ${details.track.album || "?"}，封面: ${details.cover_url ? "有" : "无"}，歌词: ${details.lyric ? "有" : "无"}）`);
        } else {
          log(`   · 补抓失败：所有音源均未匹配到「${label}」`);
        }
      } else {
        log(`[=] 已存在，跳过: ${existing}`);
      }
      return true;
    }
  }

  // ---- 阶段一：全源扫描（所有音源都探一遍，不提前挑） ----
  const { found, notes } = await scanSources(session, query);
  for (const n of notes) log(`   · ${n}`);

  // ---- 阶段二：按"实际品质"排序择优 ----
  found.sort((a, b) => b.score - a.score);

  let candidates = found;
  if (CFG.losslessOnly) {
    const only = found.filter((c) => c.lossless);
    if (only.length === 0 && found.length > 0) {
      log(`   [!] 有 ${found.length} 个候选但都不是无损，--lossless-only 下全部排除`);
    }
    candidates = only;
  }

  if (candidates.length === 0) { log(`[x] 未能为「${label}」找到可用音源`); return false; }

  if (found.length > 1) {
    log(`   [i] 全源扫描：${found.length} 个可用候选，按实际品质排序 ——`);
    found.forEach((c, i) => {
      const mark = c === candidates[0] ? "→ 采用" : (candidates.includes(c) ? "  备选" : "  （被 --lossless-only 排除）");
      log(`        ${i + 1}) ${c.src.padEnd(8)} ${fmtCand(c)}  匹配${c.matchScore} ${mark}`);
    });
    if (candidates[0] !== found[0]) log(`   [i] 采用候选已按过滤条件调整：${candidates[0].src}`);
  } else if (candidates.length === 1) {
    log(`   [i] 仅 1 个可用候选：${candidates[0].src} ${fmtCand(candidates[0])}`);
  }

  log(`   [✓] 选定音源：${candidates[0].src}（${fmtCand(candidates[0])}）`);

  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const file = path.join(CFG.out, `${safeBase}.${c.ext}`);
    try {
      log(`   下载中: ${String(c.stream.url).split("?")[0].split("/").pop()}`);
      const size = await downloadFile(session, c.stream.url, file);
      const head = fs.readFileSync(file).subarray(0, 4).toString("latin1");
      const ok = c.ext === "flac" ? head.startsWith("fLaC")
        : c.ext === "mp3" ? head.startsWith("ID3") || fs.readFileSync(file)[0] === 0xff
        : true;
      if (!ok) throw new Error(`文件校验失败（魔数 ${JSON.stringify(head)} 不是 ${c.ext}）`);
      // 站点歌曲详情（对应站点「歌曲详情」弹窗：信息/封面/歌词）随索引落盘，
      // 内嵌器优先复用本地详情，不再依赖已被 Cloudflare 拦死的 mirror API
      const details = await fetchGdDetails(session, c).catch((e) => {
        log(`   · 站点详情抓取失败（不影响下载）: ${e.message}`);
        return null;
      });
      idx[safeBase] = {
        file: path.basename(file), src: c.src, br: c.stream.br ?? null,
        estKbps: c.estKbps || null, hasHires: c.hasHires || false, size, site: CFG.site, time: Date.now(),
        url: c.stream.url,
        track: details ? details.track : null,
        cover_url: details ? details.cover_url : null,
        cover_size: details ? details.cover_size : null,
        lyric: details ? details.lyric : null,
      };
      fs.writeFileSync(indexFile, JSON.stringify(idx, null, 2));
      const actual = await probeAudio(file).catch(() => null);
      const factNote = actual ? `  实际: ${actual}` : "";
      log(`[+] 完成 (${c.src} ${c.ext.toUpperCase()}, ${CFG.site}): ${file} (${Math.round(size / 1048576)}MB)${factNote}`);
      return true;
    } catch (e) {
      lastErr = e;
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
      log(`[!] 候选 ${i + 1}/${candidates.length}（${c.src} ${c.ext.toUpperCase()}）失败：${e.message}`);
    }
  }
  log(`[x] 全部候选均失败：${lastErr ? lastErr.message : "未知错误"}`);
  return false;
}

// ---------------------------------------------------------------------------
// 输入解析
// ---------------------------------------------------------------------------
function loadQueries() {
  const qs = [];
  const push = (raw) => {
    const s = String(raw).trim();
    if (!s) return;
    const m = s.match(/^(.*?)\s*[|-]\s*(.+)$/);
    if (m) qs.push({ title: m[1].trim(), artist: m[2].trim() });
    else qs.push({ title: s, artist: "" });
  };
  if (CFG.list) {
    const raw = fs.readFileSync(CFG.list, "utf8");
    const t = raw.trim();
    if (t.startsWith("[") || t.startsWith("{")) {
      const arr = JSON.parse(t);
      if (!Array.isArray(arr)) throw new Error("JSON 列表必须是数组");
      for (const it of arr) qs.push({ title: String(it.name || it.title || "").trim(), artist: String(it.artist || "").trim() });
    } else for (const line of raw.split(/\r?\n/)) push(line);
  }
  if (CFG.playlist) {
    const { importPlaylist } = require("./playlist-importer.js");
    return importPlaylist(CFG.playlist).then((result) => {
      log(`[i] 歌单导入: ${result.provider}「${result.name}」共 ${result.tracks.length} 首`);
      let tracks = result.tracks;
      if (CFG.max > 0 && tracks.length > CFG.max) { log(`[i] --max ${CFG.max}：仅下载前 ${CFG.max} 首`); tracks = tracks.slice(0, CFG.max); }
      for (const t of tracks) qs.push({ title: String(t.title || "").trim(), artist: String(t.artist || "").trim() });
      return qs;
    });
  }
  for (const q of CFG.queries) push(q);
  if (CFG.max > 0 && qs.length > CFG.max) { log(`[i] --max ${CFG.max}：仅下载前 ${CFG.max} 首`); return qs.slice(0, CFG.max); }
  return qs;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
(async () => {
  const queries = await loadQueries();
  if (queries.length === 0) { console.error("没有待下载歌曲。用法见 --help。"); process.exit(1); }

  log(`[i] 站点: ${SITE.label} https://${SITE.host}`);
  log(`[i] 音质: br=${CFG.br}${CFG.strictBr ? "（不降级）" : `（可降至 ${CFG.brMin}）`}  音源: ${CFG.sources.join(", ")}`);
  log(`[i] 选源策略: ${CFG.select === "quality" ? "全源扫描 → 按实际码率/无损/Hi-Res 择优" : "首个无损命中即停（--select first）"}`);
  log(`[i] 输出目录: ${CFG.out}   请求间隔: ${CFG.delay}s   ${CFG.losslessOnly ? "仅无损" : "品质优先"}`);
  log(`[i] 模式: ${CFG.direct ? "直连（Node 签名 + curl，全程无浏览器）" : "浏览器内核（CDP + Cloudflare 挑战）"}`);
  if (CFG.enrich) log(`[i] --enrich：已下载但索引缺站点详情的曲目将补抓歌曲信息/封面URL/歌词（不重新下载）`);

  let session;
  if (CFG.direct) {
    session = await DirectSession.open();
  } else {
    const ver = await ensureChrome();
    try {
      session = await PageSession.open(ver);
    } catch (e) {
      // 用户要求「无头、不要弹窗」：校验失败时只重建不可见 Chrome 重试（ensureChrome
      // 内部会重新按「真无头 → 隐藏实例」轮询），绝不退回任何可见窗口。
      if (!CFG.showWindow && !CFG.attach) {
        let lastErr = e;
        for (let attempt = 1; attempt <= 2; attempt++) {
          log(`[!] 站点会话/校验失败（${lastErr.message}），重建不可见 Chrome 重试（${attempt}/2）…`);
          closeOwnChrome();
          await sleep(3000);
          try {
            const ver2 = await ensureChrome();
            session = await PageSession.open(ver2);
            break;
          } catch (e2) { lastErr = e2; }
        }
        if (!session) {
          throw new Error(`离屏校验多次失败：${lastErr.message}。可手动登录 Chrome 后加 --attach 复用（仍屏幕外），或检查网络/Cloudflare 状态。`);
        }
      } else throw e;
    }
  }
  await loadS2T(session);

  let ok = 0, fail = 0;
  for (let i = 0; i < queries.length; i++) {
    try { (await downloadOne(session, queries[i], i + 1, queries.length)) ? ok++ : fail++; }
    catch (e) { fail++; log(`[x] ${queries[i].title} 异常: ${e.message}`); }
  }
  console.log(`\n===== 完成：成功 ${ok}，失败 ${fail} =====`);

  if (CFG.direct) {
    log("[i] 直连模式：无浏览器需要关闭");
  } else if (!CFG.keepChrome) {
    session.cdp.close();
    // 关掉自己拉起的（离屏）Chrome；用户自己开的浏览器不受影响
    closeOwnChrome();
    log("[i] 已关闭临时 Chrome（--keep-chrome 可保留，下次启动更快）");
  } else {
    log(`[i] Chrome 保持运行（调试端口 ${CFG.chromePort}），下次可直接复用`);
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(`[!] 致命错误: ${e.message}`);
  process.exit(1);
});
