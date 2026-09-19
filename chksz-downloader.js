#!/usr/bin/env node
/**
 * ChKSz API 下载器（零第三方依赖，Node >= 18）
 *
 * 为什么加这个：GD音乐台的 /api.php 全部被 Cloudflare 机器人防护拦住，只能靠浏览器内核绕；
 * 而 ChKSz API（https://api.chksz.com）是**普通 HTTPS 接口**，没有 WAF、不需要浏览器，
 * 只要一个免费的 apikey 就能直连，音质档位更高：
 *
 *   网易云  standard / exhigh / lossless / hires / jyeffect / sky / jymaster(超清母带)
 *   QQ音乐  128k / 320k / flac / hires / master
 *   酷狗    128k / 320k / flac / hires / master
 *
 * 拿 apikey：打开 https://api.chksz.com → 登录 → 查看密钥（免费）
 *
 * 用法：
 *   export CHKSZ_KEY=你的key            # 或每次传 --key
 *   node chksz-downloader.js "歌名 - 歌手"
 *   node chksz-downloader.js --list songs.json --out "downloads/01-xxx" --level jymaster
 *   node chksz-downloader.js --playlist "https://music.163.com/playlist?id=xxx" --max 10
 *
 * 可选参数：
 *   --key <apikey>      也可用环境变量 CHKSZ_KEY
 *   --api-base <url>    默认 https://api.chksz.com（可指向自建/镜像）
 *   --level <档位>      目标音质，默认 jymaster（超清母带）
 *   --lossless-only     只要无损（jymaster/hires/lossless 三档之一），拿到有损就报失败
 *   --strict-level      不降级，目标档拿不到就换下一首
 *   --lyrics            顺便把 .lrc 写到歌曲同目录
 *   --out <目录>        默认 ./downloads
 *   --delay <秒>        请求间隔，默认 3
 *   --max <n>           最多下载前 n 首
 *   --force             已存在也重新下载
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const LEVELS = ["jymaster", "hires", "lossless", "exhigh", "sky", "jyeffect", "standard"];
const LOSSLESS_LEVELS = new Set(["jymaster", "hires", "lossless"]);
const LEVEL_LABEL = {
  jymaster: "超清母带",
  hires: "Hi-Res",
  lossless: "无损",
  exhigh: "极高",
  sky: "沉浸声",
  jyeffect: "臻品音效",
  standard: "标准",
};

function parseArgs(argv) {
  const cfg = {
    key: process.env.CHKSZ_KEY || process.env.CHKSZ_APIKEY || null,
    apiBase: process.env.CHKSZ_API_BASE || "https://api.chksz.com",
    level: "jymaster",
    strictLevel: false,
    losslessOnly: false,
    lyrics: false,
    out: path.join(process.cwd(), "downloads"),
    delay: 3,
    max: 0,
    force: false,
    list: null,
    playlist: null,
    queries: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--key": cfg.key = next(); break;
      case "--api-base": cfg.apiBase = next().replace(/\/+$/, ""); break;
      case "--level": cfg.level = next(); break;
      case "--strict-level": cfg.strictLevel = true; break;
      case "--lossless-only":
      case "--flac-only": cfg.losslessOnly = true; break;
      case "--lyrics": cfg.lyrics = true; break;
      case "--out": cfg.out = path.resolve(next()); break;
      case "--delay": cfg.delay = parseFloat(next()); break;
      case "--max": cfg.max = parseInt(next(), 10); break;
      case "--force": cfg.force = true; break;
      case "--list": cfg.list = path.resolve(next()); break;
      case "--playlist": cfg.playlist = next(); break;
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
  if (!LEVELS.includes(cfg.level)) {
    console.error(`--level 只支持 ${LEVELS.join(" / ")}`);
    process.exit(1);
  }
  return cfg;
}

const CFG = parseArgs(process.argv.slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const politeDelay = () => sleep(CFG.delay * (0.7 + Math.random() * 0.6));
const log = (m) => console.log(m);
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function api(pathname, params, depth) {
  depth = depth || 0;
  if (!CFG.key) throw new Error("缺少 apikey：到 https://api.chksz.com 登录后查看密钥，然后用 --key 或 export CHKSZ_KEY=... 传入");
  const qs = new URLSearchParams(Object.assign({}, params, { apikey: CFG.key }));
  const url = `${CFG.apiBase}/api/${pathname}?${qs}`;
  let r;
  try {
    r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json,*/*" }, signal: AbortSignal.timeout(45000) });
  } catch (e) {
    if (depth < 3) { await sleep(2000 * (depth + 1)); return api(pathname, params, depth + 1); }
    throw new Error(`请求失败: ${e.message}`);
  }
  const txt = await r.text();
  if (r.status === 429 && depth < 4) {
    const ra = parseFloat(r.headers.get("retry-after"));
    const cool = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 8000 * Math.pow(2, Math.min(depth, 2));
    log(`   [限流 429] 冷却 ${Math.round(cool / 1000)}s…`);
    await sleep(cool);
    return api(pathname, params, depth + 1);
  }
  let json = null;
  try { json = JSON.parse(txt); } catch {}
  if (r.status === 401 || (json && (json.code === 401 || /apikey/i.test(String(json.msg || ""))))) {
    throw new Error(`apikey 无效或已失效：${(json && json.msg) || txt.slice(0, 120)}`);
  }
  if (r.status !== 200) {
    if (depth < 3) { await sleep(2000 * (depth + 1)); return api(pathname, params, depth + 1); }
    throw new Error(`HTTP ${r.status}: ${txt.slice(0, 160)}`);
  }
  if (json === null) throw new Error(`返回不是 JSON: ${txt.slice(0, 160)}`);
  return json;
}

// ---------------------------------------------------------------------------
// 容错解析（接口字段名可能随版本变化，这里做多形态适配）
// ---------------------------------------------------------------------------
function asArray(j) {
  if (Array.isArray(j)) return j;
  if (!j || typeof j !== "object") return [];
  for (const k of ["data", "songs", "list", "result", "results", "items", "tracks"]) {
    const v = j[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") {
      const inner = asArray(v);
      if (inner.length) return inner;
    }
  }
  return [];
}

function pickArtist(t) {
  const raw = t.artist || t.artists || t.singer || t.ar || t.singers || t.artistName;
  if (Array.isArray(raw)) return raw.map((x) => (typeof x === "string" ? x : x && (x.name || x.nickname)) ).filter(Boolean);
  if (raw && typeof raw === "object") return [raw.name || raw.nickname].filter(Boolean);
  if (typeof raw === "string") return raw.split(/[\/、,;&]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

function pickName(t) {
  return String(t.name || t.title || t.songname || t.songName || t.song_name || "").trim();
}

function pickId(t) {
  const v = t.id !== undefined ? t.id : (t.songid !== undefined ? t.songid : (t.song_id !== undefined ? t.song_id : (t.mid !== undefined ? t.mid : undefined)));
  return v === undefined || v === null ? null : String(v);
}

function pickUrl(j) {
  if (!j || typeof j !== "object") return null;
  for (const k of ["url", "play_url", "playUrl", "src", "audio", "link", "music_url"]) {
    const v = j[k];
    if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
  }
  for (const k of ["data", "song", "detail", "result"]) {
    const v = j[k];
    if (v && typeof v === "object") { const u = pickUrl(v); if (u) return u; }
  }
  return null;
}

function pickCover(j) {
  if (!j || typeof j !== "object") return null;
  for (const k of ["pic", "cover", "picUrl", "cover_url", "album_pic", "image"]) {
    const v = j[k];
    if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
  }
  const alb = j.album || j.al;
  if (alb && typeof alb === "object") {
    for (const k of ["pic", "picUrl", "cover"]) if (typeof alb[k] === "string" && /^https?:\/\//i.test(alb[k])) return alb[k];
  }
  for (const k of ["data", "song", "detail", "result"]) {
    const v = j[k];
    if (v && typeof v === "object") { const c = pickCover(v); if (c) return c; }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 匹配（与主下载器一致的打分口径）
// ---------------------------------------------------------------------------
function normalize(s) {
  return String(s || "")
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
  const tName = normalize(pickName(t));
  const artists = pickArtist(t).map(normalize);
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
  return { score, ok: nameOk && artistOk };
}

function pickBest(tracks, query) {
  let best = null, bestScore = -1e9;
  for (const t of tracks) {
    if (pickId(t) === null) continue;
    const r = matchScore(t, query);
    if (r.ok && r.score > bestScore) { bestScore = r.score; best = t; }
  }
  return { track: best, score: bestScore };
}

function extOf(url) {
  const fn = String(url).split("?")[0].split("/").pop() || "";
  const dot = fn.lastIndexOf(".");
  const ext = dot >= 0 ? fn.slice(dot + 1).toLowerCase() : "";
  return ["mp3", "flac", "ogg", "m4a", "m4s", "mp4", "aac", "wav", "alac", "aiff", "ape"].includes(ext) ? ext : "flac";
}

// ---------------------------------------------------------------------------
// 下载
// ---------------------------------------------------------------------------
async function downloadFile(url, filePath) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Referer: "https://api.chksz.com/" },
    signal: AbortSignal.timeout(900000),
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
  if (size === 0) throw new Error("下载到 0 字节");
  return size;
}

async function downloadOne(query, index, total) {
  const label = query.artist ? `${query.artist} - ${query.title}` : query.title;
  log(`\n[${index}/${total}] 下载: ${label}`);

  const safeBase = label.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  fs.mkdirSync(CFG.out, { recursive: true });
  const indexFile = path.join(CFG.out, ".downloaded.json");
  let idx = {};
  try { idx = JSON.parse(fs.readFileSync(indexFile, "utf8")); } catch {}

  if (!CFG.force) {
    if (idx[safeBase] && fs.existsSync(path.join(CFG.out, idx[safeBase].file))) {
      log(`[=] 已存在（索引），跳过: ${idx[safeBase].file}`);
      return true;
    }
    const existing = fs.readdirSync(CFG.out).filter((f) => f.startsWith(safeBase + ".") && !f.endsWith(".json") && !f.endsWith(".lrc"));
    if (existing.length > 0) { log(`[=] 已存在，跳过: ${existing[0]}`); return true; }
  }

  await politeDelay();
  const name = query.artist ? `${query.title} ${query.artist}` : query.title;
  const sr = await api("163_search", { keyword: name, limit: 20, offset: 0 });
  const list = asArray(sr);
  if (!list.length) { log(`[x] 搜索无结果（原始返回：${JSON.stringify(sr).slice(0, 160)}）`); return false; }

  const { track, score } = pickBest(list, query);
  if (!track) { log(`[x] 没有匹配度足够的候选（前 3 个：${list.slice(0, 3).map((t) => pickName(t) + " / " + pickArtist(t).join(",")).join(" | ")}）`); return false; }
  const id = pickId(track);
  log(`   命中 ${pickName(track)} - ${pickArtist(track).join("/")} (${id})  匹配分 ${score}`);

  // 音质降级链
  const startIdx = LEVELS.indexOf(CFG.level);
  const targets = CFG.strictLevel ? [CFG.level] : LEVELS.slice(startIdx);
  let streamUrl = null, usedLevel = null, meta = null;
  for (const lv of targets) {
    await politeDelay();
    let j;
    try { j = await api("163_music", { id, level: lv, type: "json" }); }
    catch (e) { log(`   ${lv}: 失败（${e.message}）`); continue; }
    const u = pickUrl(j);
    if (!u) { log(`   ${lv}(${LEVEL_LABEL[lv] || lv}): 无可用地址，降级…`); continue; }
    streamUrl = u; usedLevel = lv; meta = j;
    log(`   ${lv}(${LEVEL_LABEL[lv] || lv}): ${String(u).split("?")[0].split("/").pop()}`);
    break;
  }
  if (!streamUrl) { log("[x] 所有音质档位均取不到地址"); return false; }
  if (CFG.losslessOnly && !LOSSLESS_LEVELS.has(usedLevel)) {
    log(`[x] 只拿到 ${LEVEL_LABEL[usedLevel] || usedLevel}（非无损），--lossless-only 下判为失败`);
    return false;
  }

  const ext = extOf(streamUrl);
  const file = path.join(CFG.out, `${safeBase}.${ext}`);
  let size;
  try {
    size = await downloadFile(streamUrl, file);
  } catch (e) {
    log(`[x] 下载失败: ${e.message}`);
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
    return false;
  }
  const head = fs.readFileSync(file).subarray(0, 4).toString("latin1");
  if (ext === "flac" && !head.startsWith("fLaC")) {
    log(`[!] 校验异常：扩展名为 flac 但魔数是 ${JSON.stringify(head)}（可能实际是加密/有损流，保留文件供检查）`);
  }
  idx[safeBase] = { file: path.basename(file), level: usedLevel, size, cover: pickCover(meta) || null, time: Date.now() };
  fs.writeFileSync(indexFile, JSON.stringify(idx, null, 2));
  log(`[+] 完成 (${LEVEL_LABEL[usedLevel] || usedLevel} ${ext.toUpperCase()}): ${file} (${Math.round(size / 1048576)}MB)`);

  if (CFG.lyrics) {
    await politeDelay();
    try {
      const lj = await api("163_lyric", { id });
      const raw = lj.lyric || (lj.data && lj.data.lyric) || (lj.lrc && lj.lrc.lyric) || "";
      const tr = lj.tlyric || (lj.data && lj.data.tlyric) || (lj.lrc && lj.lrc.tlyric) || "";
      if (raw) {
        const lrcPath = path.join(CFG.out, `${safeBase}.lrc`);
        fs.writeFileSync(lrcPath, tr ? raw.trimEnd() + "\n\n" + tr : raw);
        log(`    歌词: ${lrcPath}`);
      } else {
        log("    (接口未返回歌词)");
      }
    } catch (e) { log(`    歌词获取失败: ${e.message}`); }
  }
  return true;
}

// ---------------------------------------------------------------------------
// 输入
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
      if (CFG.max > 0 && tracks.length > CFG.max) tracks = tracks.slice(0, CFG.max);
      for (const t of tracks) qs.push({ title: String(t.title || "").trim(), artist: String(t.artist || "").trim() });
      return qs;
    });
  }
  for (const q of CFG.queries) push(q);
  if (CFG.max > 0) return qs.slice(0, CFG.max);
  return qs;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
(async () => {
  const queries = await loadQueries();
  if (queries.length === 0) { console.error("没有待下载歌曲。用法见 --help。"); process.exit(1); }
  if (!CFG.key) {
    console.error("缺少 apikey。先到 https://api.chksz.com 登录 → 查看密钥（免费），然后：");
    console.error("  export CHKSZ_KEY=xxxxx   或   node chksz-downloader.js \"歌名 - 歌手\" --key xxxxx");
    process.exit(1);
  }

  log(`[i] 接口: ${CFG.apiBase}/api  目标音质: ${CFG.level}(${LEVEL_LABEL[CFG.level] || CFG.level})${CFG.strictLevel ? "（不降级）" : "（可逐档降级）"}`);
  log(`[i] 输出目录: ${CFG.out}   请求间隔: ${CFG.delay}s   ${CFG.losslessOnly ? "仅无损" : "品质优先"}`);

  let ok = 0, fail = 0;
  for (let i = 0; i < queries.length; i++) {
    try { (await downloadOne(queries[i], i + 1, queries.length)) ? ok++ : fail++; }
    catch (e) { fail++; log(`[x] ${queries[i].title} 异常: ${e.message}`); }
  }
  console.log(`\n===== 完成：成功 ${ok}，失败 ${fail} =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(`[!] 致命错误: ${e.message}`); process.exit(1); });
