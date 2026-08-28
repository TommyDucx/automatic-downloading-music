#!/usr/bin/env node
/**
 * GD音乐台 FLAC 批量下载器（零第三方依赖，仅需 Node.js >= 18）
 *
 * 原理（逆向自 https://music.gdstudio.xyz 前端，2026-08-27 实测有效）：
 *   1. 站点每次请求都携带时间签名 s，由前端 crc32.min.js 中的自定义 MD5 生成：
 *        raw  = ts9 + "|" + location.hostname + "|" + version(去点补零) + "|" + urlEncode(入参)
 *        s    = customMD5(raw).slice(-8).toUpperCase()
 *     其中 ts9 来自 GET /time 返回的秒级时间戳的前 9 位，version 来自 player.js 的 mkPlayer.version。
 *   2. 签名函数整体在混淆后的 crc32.min.js 中，直接复用它计算签名（自动下载并缓存，站点升级也无需改代码）。
 *   3. 请求体必须是「预编码一次」的原始字符串（用 URLSearchParams 会二次编码 %20 -> %2520 导致 401）。
 *
 * 音质档位 br：128 / 192 / 320 / 740(16bit无损) / 999(24bit无损)
 *   netease: br>320 即 FLAC；qobuz/joox/migu 等 999 为无损。
 *
 * 用法：
 *   node gd-flac-downloader.js "歌名 - 歌手" ["歌名2 - 歌手2" ...]
 *   node gd-flac-downloader.js --list songs.txt        # 每行 "歌名 - 歌手"
 *   node gd-flac-downloader.js --list songs.json       # [{"name":"...","artist":"..."}]
 *   node gd-flac-downloader.js --sources netease,joox,qobuz --br 999
 *
 * 可选参数：
 *   --host <music.gdstudio.org|music.gdstudio.xyz>  默认 music.gdstudio.org（国内直连）
 *   --proxy <http://127.0.0.1:7897>                 使用代理时走 curl 传输
 *   --br 999|740|320                                默认 999（尽量无损）
 *   --sources netease,joox,tencent,qobuz,migu,kuwo  搜索音源优先级
 *   --out <目录>                                    默认 ./downloads
 *   --delay <秒>                                    请求间隔，默认 3（站点限流严格，请勿调太小）
 *   --fallback                                      无 FLAC 时降级保存 320k MP3
 *   --force                                         已存在也重新下载
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileP = promisify(execFile);

const CACHE_DIR = path.join(__dirname, ".gd-flac-cache");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const API_HEADERS = {
  "User-Agent": UA,
  Accept: "application/json, text/javascript, */*; q=0.01",
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  "X-Requested-With": "XMLHttpRequest",
};

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const cfg = {
    host: "music.gdstudio.org",
    proxy: process.env.GD_PROXY || null,
    br: 999,
    sources: ["netease", "tencent", "kuwo", "joox", "qobuz"],
    out: path.join(process.cwd(), "downloads"),
    delay: 4,
    fallback: false,
    force: false,
    list: null,
    queries: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--host":
        cfg.host = next();
        break;
      case "--proxy":
        cfg.proxy = next();
        break;
      case "--br":
        cfg.br = parseInt(next(), 10);
        break;
      case "--sources":
        cfg.sources = next().split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--out":
        cfg.out = path.resolve(next());
        break;
      case "--delay":
        cfg.delay = parseFloat(next());
        break;
      case "--list":
        cfg.list = path.resolve(next());
        break;
      case "--fallback":
        cfg.fallback = true;
        break;
      case "--force":
        cfg.force = true;
        break;
      case "--help":
      case "-h":
        console.log(
          "用法: node gd-flac-downloader.js \"歌名 - 歌手\" ...  | --list songs.txt | --help"
        );
        process.exit(0);
        break;
      default:
        if (a.startsWith("-")) {
          console.error(`未知参数: ${a}`);
          process.exit(1);
        }
        cfg.queries.push(a);
    }
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// HTTP 传输层：无代理用全局 fetch；有代理用 curl（curl 支持 -x 与流式写文件）
// ---------------------------------------------------------------------------
async function httpFetch(url, opts) {
  if (!CFG.proxy) {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(60000) });
    return { status: r.status, headers: r.headers, text: () => r.text(), arrayBuffer: () => r.arrayBuffer() };
  }
  // curl 方式
  const args = ["-sS", "-L", "--max-time", "60", "-x", CFG.proxy];
  if (opts.headers) for (const [k, v] of Object.entries(opts.headers)) args.push("-H", `${k}: ${v}`);
  if (opts.method === "POST") args.push("-d", opts.body);
  args.push(url);
  const { stdout, stderr } = await execFileP("curl", args, { maxBuffer: 10 * 1024 * 1024 });
  if (!opts.method || opts.method === "GET") {
    return { status: stderr ? 0 : 200, headers: new Headers(), text: () => stdout, arrayBuffer: () => Buffer.from(stdout).buffer };
  }
  return { status: 200, headers: new Headers(), text: () => stdout, arrayBuffer: () => Buffer.from(stdout).buffer };
}

// 流式下载到文件（fetch 用 ReadableStream，curl 直接 -o）
async function downloadFile(url, filePath, extraHeaders) {
  if (CFG.proxy) {
    const args = ["-sS", "-L", "--max-time", "300", "-x", CFG.proxy, "-o", filePath, "-A", UA];
    if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) args.push("-H", `${k}: ${v}`);
    args.push(url);
    await execFileP("curl", args, { maxBuffer: 1 });
    if (!fs.existsSync(filePath)) throw new Error("curl 下载失败（无输出文件）");
    return fs.statSync(filePath).size;
  }
  const r = await fetch(url, {
    headers: { "User-Agent": UA, ...(extraHeaders || {}) },
    signal: AbortSignal.timeout(600000),
  });
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
  return size;
}

// ---------------------------------------------------------------------------
// 签名运行时：下载并缓存 crc32.min.js / player.js，用站点原版函数算 s
// ---------------------------------------------------------------------------
async function ensureRuntime() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const crcFile = path.join(CACHE_DIR, "crc32.min.js");
  const playerFile = path.join(CACHE_DIR, "player.js");
  const s2tFile = path.join(CACHE_DIR, "chinese-s2t.js");
  async function fetchTo(url, file) {
    const r = await httpFetch(url, { method: "GET" });
    if (r.status === 200) {
      fs.writeFileSync(file, await r.text());
      return true;
    }
    return false;
  }
  if (!fs.existsSync(crcFile) || !fs.existsSync(playerFile) || !fs.existsSync(s2tFile)) {
    console.log("[i] 首次运行，正在获取站点前端脚本（用于签名/简繁转换）…");
    const base = `https://${CFG.host}`;
    const ok1 = await fetchTo(`${base}/js/crc32.min.js`, crcFile);
    const ok2 = await fetchTo(`${base}/js/player.js`, playerFile);
    const ok3 = await fetchTo(`${base}/js/chinese-s2t.js`, s2tFile);
    if (!ok1 || !ok2 || !ok3) throw new Error(`无法获取前端脚本，请检查 ${base} 是否可访问`);
  }
  const playerSrc = fs.readFileSync(playerFile, "utf8");
  const m = playerSrc.match(/version\s*:\s*"([\d.]+)"/);
  if (!m) throw new Error("无法从 player.js 解析 mkPlayer.version");
  let s2t = null;
  try {
    s2t = require(s2tFile);
  } catch {}
  return { crc32Src: fs.readFileSync(crcFile, "utf8"), version: m[1], s2t };
}

function makeVm(crc32Src, host, ts) {
  const window = { location: { hostname: host } };
  class FakeXHR {
    constructor() {
      this.readyState = 0;
      this.status = 200;
    }
    open() { this.readyState = 1; }
    setRequestHeader() {}
    send() { this.readyState = 4; this.responseText = String(ts); }
  }
  const ctx = {
    window,
    String,
    Math,
    console,
    Date,
    parseInt,
    parseFloat,
    setTimeout,
    clearTimeout,
    XMLHttpRequest: FakeXHR,
    mkPlayer: { version: RUNTIME.version },
  };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(crc32Src, ctx, { timeout: 5000 });
  if (typeof ctx.crc32 !== "function") throw new Error("crc32.min.js 加载后未暴露 crc32()");
  return ctx;
}

async function fetchTime() {
  const r = await httpFetch(`https://${CFG.host}/time`, { method: "GET" });
  const txt = (await r.text()).trim();
  const t = parseInt(txt, 10);
  if (!Number.isFinite(t)) throw new Error(`/time 返回异常: ${txt}`);
  return t;
}

async function apiCall(params, depth) {
  // params: { types, source?, name?|id?, br?, pages?, count? }
  depth = depth || 0;
  const ts = await fetchTime();
  const ctx = makeVm(RUNTIME.crc32Src, CFG.host, ts);
  const signInput = encodeURIComponent(String(params.id !== undefined ? params.id : params.name || ""));
  const s = ctx.crc32(String(signInput));
  // 关键：组装成「预编码一次」的原始表单字符串，避免二次编码
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${encodeURIComponent(String(v))}`);
  }
  parts.push(`s=${s}`);
  const body = parts.join("&");
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await httpFetch(`https://${CFG.host}/api.php`, {
        method: "POST",
        headers: API_HEADERS,
        body,
      });
      const txt = await r.text();
      if (r.status === 401 && txt.includes("Invalid request")) {
        // 签名过期/被拒：大概率是限流或时间窗口问题，冷却后重试，但限制总次数避免死循环
        if (depth < 4) {
          await sleep(5000);
          return apiCall(params, depth + 1);
        }
        throw new Error("签名校验失败（可能触发站点限流，请稍后再试）");
      }
      let json = null;
      try { json = JSON.parse(txt); } catch {}
      return { status: r.status, json };
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(3000 * attempt);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const politeDelay = () => sleep(CFG.delay * (0.7 + Math.random() * 0.6));

// ---------------------------------------------------------------------------
// 搜索与匹配
// ---------------------------------------------------------------------------
function normalize(s) {
  let str = String(s || "");
  try {
    if (RUNTIME && RUNTIME.s2t && RUNTIME.s2t.t2s) str = RUNTIME.s2t.t2s(str);
  } catch {}
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[・·.．,，、'"“”‘’()[\]（）【】《》:：;；!！?？\-—_/\\|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trackString(t) {
  const artists = Array.isArray(t.artist) ? t.artist.join(" ") : String(t.artist || "");
  return `${normalize(t.name)} ${normalize(artists)}`.trim();
}

function matchScore(t, query) {
  const qName = normalize(query.title);
  const qArtist = normalize(query.artist || "");
  const tName = normalize(t.name);
  const artists = Array.isArray(t.artist) ? t.artist.map(normalize) : [normalize(t.artist || "")];
  const tArtist = artists.join(" ");
  let score = 0;
  let nameOk = false;
  if (tName === qName) { score += 100; nameOk = true; }
  else if (tName.includes(qName) || qName.includes(tName)) { score += 60; nameOk = true; }
  else if (tName.startsWith(qName) || qName.startsWith(tName)) { score += 40; nameOk = true; }

  let artistOk = false;
  if (qArtist) {
    const artistHit = artists.some((a) => a && (a === qArtist || a.includes(qArtist) || qArtist.includes(a)));
    if (artistHit) { score += 30; artistOk = true; }
    else if (tArtist.includes(qArtist)) { score += 15; artistOk = true; }
    else score -= 100; // 歌手明确不符：直接否决（避免翻唱版）
  } else {
    artistOk = true;
  }

  // 讨厌的翻唱/现场/乐器版降权
  const bad = /(remix|cover|live|karaoke|伴奏|翻唱|现场版|纯音乐|instrumental|demo|rework|bootleg|dj|beat|montagem)/;
  if (bad.test(tName)) score -= 25;
  if (bad.test(tArtist)) score -= 20;

  return { score, ok: nameOk && artistOk };
}

function pickBest(tracks, query) {
  let best = null;
  let bestScore = -1e9;
  for (const t of tracks) {
    if (!t || !t.id) continue;
    const r = matchScore(t, query);
    if (r.ok && r.score > bestScore) {
      bestScore = r.score;
      best = t;
    }
  }
  return { track: best, score: bestScore };
}

// ---------------------------------------------------------------------------
// 单曲下载主流程
// ---------------------------------------------------------------------------
async function searchSource(src, query) {
  await politeDelay();
  const name = query.artist ? `${query.title} ${query.artist}` : query.title;
  const r = await apiCall({ types: "search", count: 20, source: src, pages: 1, name });
  if (r.status !== 200 || !Array.isArray(r.json) || r.json.length === 0) return null;
  const { track, score } = pickBest(r.json, query);
  if (!track) return null;
  if (score < 40) {
    console.log(`   ${src}: 首个候选「${track.name} - ${(Array.isArray(track.artist) ? track.artist.join("/") : track.artist) || "?"}」匹配度不足(${score})，跳过`);
    return null;
  }
  return track;
}

async function getStream(track, src) {
  await politeDelay();
  const r = await apiCall({ types: "url", id: track.id, source: src, br: CFG.br });
  if (r.status !== 200 || !r.json) return null;
  const j = r.json;
  if (j.br === -3 || j.br === -2) return { ...j, denied: true };
  if (!j.url || j.url === "err" || j.br === -1) return null;
  return j;
}

function extOf(url, br) {
  let fn = String(url).split("?")[0].split("/").pop() || "";
  const dot = fn.lastIndexOf(".");
  let ext = dot >= 0 ? fn.slice(dot + 1).toLowerCase() : "";
  if (!["mp3", "flac", "ogg", "m4a", "m4s", "mp4", "aac", "wav", "alac", "aiff", "ape"].includes(ext)) {
    ext = br > 320 ? "flac" : "mp3";
  }
  return ext;
}

async function downloadOne(query, index, total) {
  const label = `${query.artist ? `${query.artist} - ${query.title}` : query.title}`;
  console.log(`\n[${index}/${total}] 下载: ${label}`);

  // 断点续跑：已存在同名文件则直接跳过（不消耗 API 配额）
  const safeBase = `${label}`.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  if (!CFG.force) {
    const existing = fs.readdirSync(CFG.out).filter((f) => f.startsWith(safeBase + "."));
    if (existing.length > 0) {
      console.log(`[=] 已存在，跳过: ${path.join(CFG.out, existing[0])}`);
      return true;
    }
  }

  let chosen = null; // { track, src, stream }
  for (const src of CFG.sources) {
    await politeDelay();
    let track;
    try {
      track = await searchSource(src, query);
    } catch (e) {
      console.log(`   ${src}: 搜索失败（${e.message}）`);
      continue;
    }
    if (!track) {
      console.log(`   ${src}: 未找到匹配曲目`);
      continue;
    }
    const info = `${track.name} - ${(Array.isArray(track.artist) ? track.artist.join("/") : track.artist) || "?"} (${track.id})`;
    console.log(`   ${src}: 命中 ${info}`);

    let stream = null;
    for (let tries = 0; tries < 2; tries++) {
      try {
        stream = await getStream(track, src);
        break;
      } catch (e) {
        if (tries === 1) {
          console.log(`   ${src}: 取流失败（${e.message}）`);
          stream = null;
        }
      }
    }
    if (!stream) {
      console.log(`   ${src}: 该音源无可用音源`);
      continue;
    }
    if (stream.denied) {
      console.log(`   ${src}: 无版权/试听受限（br=${stream.br}），尝试下一音源`);
      continue;
    }
    const ext = extOf(stream.url, stream.br);
    const isLossless = ext === "flac" || ext === "ape" || ext === "alac" || stream.br > 320;
    console.log(`   ${src}: 获得 ${ext.toUpperCase()} ${stream.br || "?"}kbps ${stream.size ? Math.round(stream.size / 1048576) + "MB" : ""}`);
    if (isLossless) {
      chosen = { track, src, stream };
      break; // 拿到无损即停
    }
    if (!CFG.fallback) {
      console.log(`   ${src}: 仅 ${ext.toUpperCase()}（非无损），且未开启 --fallback，尝试下一音源`);
      continue;
    }
    chosen = { track, src, stream }; // 允许降级，但继续找更高品质的
  }

  if (!chosen) {
    console.log(`[x] 未能为「${label}」找到可用音源`);
    return false;
  }

  const { track, src, stream } = chosen;
  const ext = extOf(stream.url, stream.br);
  const file = path.join(CFG.out, `${safeBase}.${ext}`);
  fs.mkdirSync(CFG.out, { recursive: true });
  console.log(`   下载中: ${stream.url.split("?")[0].split("/").pop()}`);
  const size = await downloadFile(stream.url, file);
  const magic = fs.readFileSync(file).subarray(0, 4).toString("ascii");
  const ok = ext === "flac" ? magic.startsWith("fLaC") : ext === "mp3" ? magic.startsWith("ID3") || (fs.readFileSync(file)[0] === 0xff) : true;
  if (!ok) {
    console.log(`[!] 文件校验失败（魔数 ${JSON.stringify(magic)} 不是 ${ext}），删除重下…`);
    fs.unlinkSync(file);
    return false;
  }
  console.log(`[+] 完成 (${src} ${ext.toUpperCase()}): ${file} (${Math.round(size / 1048576)}MB)`);
  return true;
}

// ---------------------------------------------------------------------------
// 输入解析
// ---------------------------------------------------------------------------
function loadQueries(cfg) {
  const qs = [];
  const push = (raw) => {
    const s = String(raw).trim();
    if (!s) return;
    let m = s.match(/^(.*?)\s*[|-]\s*(.+)$/);
    if (m) {
      qs.push({ title: m[1].trim(), artist: m[2].trim() });
    } else {
      qs.push({ title: s, artist: "" });
    }
  };
  if (cfg.list) {
    const raw = fs.readFileSync(cfg.list, "utf8");
    const t = raw.trim();
    if (t.startsWith("[") || t.startsWith("{")) {
      const arr = JSON.parse(t);
      if (!Array.isArray(arr)) throw new Error("JSON 列表必须是数组");
      for (const it of arr) qs.push({ title: String(it.name || it.title || "").trim(), artist: String(it.artist || "").trim() });
    } else {
      for (const line of raw.split(/\r?\n/)) push(line);
    }
  }
  for (const q of cfg.queries) push(q);
  return qs;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const CFG = parseArgs(process.argv.slice(2));
let RUNTIME = null;

(async () => {
  const queries = loadQueries(CFG);
  if (queries.length === 0) {
    console.error("没有待下载歌曲。用法见 --help。");
    process.exit(1);
  }
  RUNTIME = await ensureRuntime();
  console.log(`[i] 站点: https://${CFG.host}  音质: br=${CFG.br}  音源顺序: ${CFG.sources.join(", ")}`);
  console.log(`[i] 输出目录: ${CFG.out}   请求间隔: ${CFG.delay}s${CFG.fallback ? "   允许降级MP3" : ""}`);

  let ok = 0;
  let fail = 0;
  for (let i = 0; i < queries.length; i++) {
    try {
      if (await downloadOne(queries[i], i + 1, queries.length)) ok++;
      else fail++;
    } catch (e) {
      fail++;
      console.log(`[x] ${queries[i].title} 异常: ${e.message}`);
    }
  }
  console.log(`\n===== 完成：成功 ${ok}，失败 ${fail} =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(`[!] 致命错误: ${e.stack || e.message}`);
  process.exit(1);
});
