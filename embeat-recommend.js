#!/usr/bin/env node
/**
 * Embeat 网页版推荐客户端（零第三方依赖，Node >= 18 + 系统 curl）
 *
 * 原理（2026-09-30 实测打通，不再需要浏览器/本地数据库）：
 *   1) 站点签名 crc32() 虽是被改造过的 md5（无法离线复刻），但 crc32.min.js 本身就是前端 JS——
 *      把它丢进 Node 的 vm，配好 shims（location.hostname / mkPlayer.version / FakeXHR 返回 /time），
 *      站点函数即可直接现算签名（同 GDSTUDIO_REFERENCE.md 的技巧 A）。
 *   2) 签名有效后 curl 直连 `https://music.gdstudio.xyz/api.php` 完全可用
 *      （注意用 curl，不要用 Node 内置 fetch —— undici 的 TLS 指纹会被拦，curl 不会）。
 *   3) Embeat 两个接口：
 *      - types=embeat_agent     自然语言描述推荐（"深夜学习的轻柔爵士hiphop"）
 *      - types=embeat_by_track  种子歌推荐（歌名+歌手 / Spotify track id / ISRC）
 *      返回与 search 同构的曲目数组（embeat_by_track 的 source 字段为 "embeat"），
 *      直接可用 --out 写出下载器兼容的歌单。
 *
 * 用法：
 *   node embeat-recommend.js --desc "深夜学习的轻柔爵士hiphop" --count 15
 *   node embeat-recommend.js --like "晴天 - 周杰伦" --count 15 --out recs.json
 *   node embeat-recommend.js --track-id 5pIcwtJYNJx93l420oR2Vm
 *   node embeat-recommend.js --isrc TWK970300503
 *   node embeat-recommend.js --desc "随便来几首经典粤语歌" --site org --json
 *
 * 参数：
 *   --desc <文本>       自然语言描述推荐（embeat_agent）
 *   --like <歌名 - 歌手>  种子歌推荐（embeat_by_track），也接受 --song 别名
 *   --track-id <id>     用 Spotify track id 当种子（可与其他种子参数搭配）
 *   --isrc <isrc>       用 ISRC 当种子
 *   --count <n>         结果数量，默认 20
 *   --source <音源>      查询音源，默认 netease（结果里会混入各平台曲目）
 *   --site xyz|org      默认 xyz（国际版），org 国内版
 *   --out <file>        写出下载器兼容歌单 JSON（[{title, artist, album, ...}]）
 *   --json              直接输出原始 JSON 数组（默认输出表格）
 *   --quiet             只输出 --out 文件路径
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");

const SITES = { xyz: "music.gdstudio.xyz", org: "music.gdstudio.org" };
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const CACHE_DIR = path.join(__dirname, ".gd-flac-cache");
const log = (m) => console.error(m);

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const cfg = {
    desc: null,
    like: null,
    trackId: null,
    isrc: null,
    count: 20,
    source: "netease",
    site: "xyz",
    out: null,
    json: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--desc": cfg.desc = next(); break;
      case "--like":
      case "--song": cfg.like = next(); break;
      case "--track-id": cfg.trackId = next(); break;
      case "--isrc": cfg.isrc = next(); break;
      case "--count": cfg.count = parseInt(next(), 10); break;
      case "--source": cfg.source = next(); break;
      case "--site": cfg.site = next(); break;
      case "--out": cfg.out = path.resolve(next()); break;
      case "--json": cfg.json = true; break;
      case "--quiet": cfg.quiet = true; break;
      case "--help":
      case "-h":
        console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^\/\*\*?/, ""));
        process.exit(0);
      default:
        console.error(`未知参数: ${a}`);
        process.exit(1);
    }
  }
  if (!SITES[cfg.site]) { console.error("--site 只支持 xyz / org"); process.exit(1); }
  if (!cfg.desc && !cfg.like && !cfg.trackId && !cfg.isrc) {
    console.error('至少给一个查询：--desc "<描述>" 或 --like "<歌名> - <歌手>" 或 --track-id/--isrc');
    process.exit(1);
  }
  return cfg;
}
const CFG = parseArgs(process.argv.slice(2));
const HOST = SITES[CFG.site];

// ---------------------------------------------------------------------------
// 网络：一律走 curl（Node fetch/undici 的 TLS 指纹会被站点 WAF 拦）
// ---------------------------------------------------------------------------
function curlGet(url, timeoutSec = 60) {
  const r = spawnSync(
    "curl",
    ["-sS", "--max-time", String(timeoutSec), "-A", UA,
     "-H", "X-Requested-With: XMLHttpRequest", url],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  if (r.status !== 0) throw new Error(`curl 失败(退出 ${r.status}): ${String(r.stderr || "").slice(0, 160)}`);
  return r.stdout;
}

// ---------------------------------------------------------------------------
// 签名器：把站点 crc32.min.js 丢进 Node vm 现算（含 /time、hostname、version shims）
// ---------------------------------------------------------------------------
function fetchSignerCode(host) {
  // 缓存按 host 分开；签名被服务端拒绝时会强制刷新
  const cacheFile = path.join(CACHE_DIR, `crc32-${host}.js`);
  try {
    if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 1000) {
      return fs.readFileSync(cacheFile, "utf8");
    }
  } catch {}
  const code = curlGet(`https://${host}/js/crc32.min.js`);
  if (code && code.length > 1000) {
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(cacheFile, code); } catch {}
  }
  return code;
}

function loadSigner(host, { fresh = false } = {}) {
  const cacheFile = path.join(CACHE_DIR, `crc32-${host}.js`);
  if (fresh) { try { fs.unlinkSync(cacheFile); } catch {} }

  // mkPlayer.version 从 player.js 动态解析（形如 2026.09.25 → 20260925）
  let version = null;
  try {
    const playerJs = curlGet(`https://${host}/js/player.js`);
    version = (playerJs.match(/version:"([^"]+)"/) || [])[1] || null;
  } catch {}

  const code = fetchSignerCode(host);
  if (!code || code.length < 1000) throw new Error("crc32.min.js 拉取失败");

  const ctx = {
    console, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
    setTimeout, clearTimeout, setInterval, clearInterval, isNaN, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent, unescape, escape, atob, btoa,
    location: { hostname: host, href: `https://${host}/`, protocol: "https:" },
    // FakeXHR：/time 是 10 位秒级时间戳，取当前时间即可（签名只取前 9 位，10 秒粒度）
    XMLHttpRequest: class {
      constructor() { this.readyState = 0; }
      open(method, url) { this._url = url; }
      setRequestHeader() {}
      send() {
        const self = this;
        setTimeout(() => {
          self.readyState = 4;
          self.status = 200;
          self.responseText = String(Math.floor(Date.now() / 1000));
          try { self.onreadystatechange && self.onreadystatechange(); } catch {}
          try { self.onload && self.onload(); } catch {}
        }, 0);
      }
    },
  };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  if (version) ctx.mkPlayer = { version };
  if (typeof ctx.crc32 !== "function") throw new Error("crc32.min.js 未暴露 crc32()");

  return {
    version: version || "(unknown)",
    sign: async (input) => {
      // 极端情况：/time 尚未回填时 crc32 可能抛错，宁可直接抛出去让上层刷新重试
      return ctx.crc32(input);
    },
  };
}

// ---------------------------------------------------------------------------
// API：s = crc32(urlEncode(主参数))，与站点前端完全一致
// ---------------------------------------------------------------------------
async function apiCall(signer, params, signInput) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  const s = await signer.sign(encodeURIComponent(String(signInput)));
  const url = `https://${HOST}/api.php?${qs}&s=${s}`;
  const body = curlGet(url);
  let json = null;
  try { json = JSON.parse(body); } catch {}
  if (json === null) throw new Error(`响应非 JSON: ${body.slice(0, 160)}`);
  if (json && json.detail && /invalid request/i.test(String(json.detail))) {
    const err = new Error("签名被拒");
    err.invalidSig = true;
    throw err;
  }
  return json;
}

/** 站点 WAF：查询串含 ' * ( ) 会 401（见 SKILL.md「假限流」），发送前清洗 */
const sanitize = (s) => String(s).replace(/['*()\[\]（）]/g, " ");

// ---------------------------------------------------------------------------
// 业务
// ---------------------------------------------------------------------------
async function recommend() {
  let signer = loadSigner(HOST);

  const build = () => {
    const params = { count: CFG.count, source: CFG.source, pages: 1 };
    let signInput, kind;
    if (CFG.desc) {
      kind = "embeat_agent（自然语言）";
      params.types = "embeat_agent";
      params.name = sanitize(CFG.desc);
      signInput = sanitize(CFG.desc);
    } else {
      kind = "embeat_by_track（种子推荐）";
      params.types = "embeat_by_track";
      let name = "", artist = "";
      if (CFG.like) {
        const parts = CFG.like.split(/\s+-\s+/);
        name = sanitize(parts[0] || "");
        artist = sanitize(parts.slice(1).join(" - ")).split(",")[0].trim();
      }
      const seed = JSON.stringify({
        name, artist,
        id: CFG.trackId || "",
        isrc: CFG.isrc || "",
      });
      params.name = seed;
      signInput = seed;
    }
    return { params, signInput, kind };
  };

  const { params, signInput, kind } = build();
  log(`[i] Embeat 网页版（${kind}） @ ${HOST}，请求 ${CFG.count} 首…`);

  let raw;
  try {
    raw = await apiCall(signer, params, signInput);
  } catch (e) {
    if (!e.invalidSig) throw e;
    log("[!] 签名被拒，刷新 crc32.min.js 后重试…");
    signer = loadSigner(HOST, { fresh: true });
    raw = await apiCall(signer, params, signInput);
  }

  if (!Array.isArray(raw)) {
    throw new Error("接口返回异常: " + JSON.stringify(raw).slice(0, 200));
  }
  if (raw.length === 0) {
    log("[!] 没有找到相关推荐（换个描述/种子，或 10 秒后重试——同一时刻站点可能限流）");
  }
  // embeat_agent 实测不认 count（一次回全部候选），客户端兜底截断
  if (raw.length > CFG.count) raw = raw.slice(0, CFG.count);

  const tracks = raw.map((t) => ({
    title: t.name || "",
    artist: Array.isArray(t.artist) ? t.artist.join(", ") : (t.artist || ""),
    album: t.album || "",
    source: t.source || "",
    id: t.id || "",
    duration: (t.extra_data && t.extra_data.duration) || null,
    score: (t.extra_data && t.extra_data.score) != null ? t.extra_data.score : null,
    has_hires: !!(t.extra_data && t.extra_data.has_hires),
  }));

  if (CFG.json) {
    console.log(JSON.stringify(tracks, null, 2));
  } else if (!CFG.quiet) {
    console.log(`\n===== Embeat 推荐 ${tracks.length} 首 =====`);
    tracks.forEach((t, i) => {
      const extra = [
        t.album ? `专辑: ${t.album}` : "",
        t.source ? `来源: ${t.source}` : "",
        t.score != null ? `score: ${t.score}` : "",
      ].filter(Boolean).join("  ");
      console.log(`${String(i + 1).padStart(2)}. ${t.title} - ${t.artist}    ${extra}`);
    });
  }

  if (CFG.out) {
    fs.writeFileSync(CFG.out, JSON.stringify(tracks, null, 2));
    if (CFG.quiet) console.log(CFG.out);
    else log(`[+] 已写出歌单（下载器 --list 可直接用）: ${CFG.out}`);
  }
  return tracks;
}

recommend().catch((e) => {
  console.error(`[x] ${e.message}`);
  process.exit(1);
});
