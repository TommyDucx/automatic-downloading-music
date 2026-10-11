#!/usr/bin/env node
/**
 * kugou-downloader.js —— 酷狗音乐免签名直连下载器（零第三方依赖，Node >= 18）
 *
 * 逆向来源：hoowhoami/EchoMusic（酷狗概念版客户端）→ 其取流服务端为
 * MakcRe/KuGouMusicApi。本脚本按实测复刻了其中**不需要登录**的那条链路：
 *
 *   1) 搜索   complexsearch.kugou.com/v2/search/song  （网页版 WebFilter 参数 + 网页盐签名）
 *   2) 取流   m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=…&from=mkugou
 *             —— 免签名、免 SSA 风控、免登录，直接给 sharefs.kugou.com 的 CDN 直链
 *   3) 歌词   krcs.kugou.com/search?keyword=… → /download?fmt=krc → XOR+zlib 解出 KRC
 *             再转成标准 [mm:ss.xx] LRC
 *   4) 封面  搜索结果 Image 字段（imge.kugou.com，{size} 占位符替换为 480）
 *
 * ⚠️ 能力边界（2026-10-11 实测）：
 *   · 只有**免费曲目**（搜索结果 Privilege / HQPrivilege / SQPrivilege 为 0）能取到流；
 *     VIP 曲目 m.kugou 返回 status:0，web 侧 wwwapi 返回 err_code 30020（SSA 风控），
 *     概念版「免费听」需要登录态，本脚本不做登录 —— 这类曲目请回落到 GD 音乐台。
 *   · 免费曲目可以拿到真无损：实测周杰伦《千山万水》32MB FLAC / 1060kbps。
 *   · 酷狗的 Android（gateway.kugou.com + AndroidFilter）签名盐已失效，实测恒返回
 *     error_code 152 Parameter Error —— **别走那条路**，网页盐才是现在可用的。
 *
 * 用法：
 *   node kugou-downloader.js "晴天 - 周杰伦" --out downloads/01-xxx
 *   node kugou-downloader.js --list songs.json --out downloads/01-xxx
 *   node kugou-downloader.js --list songs.json --out downloads/01-xxx --lossless-only --delay 3
 *
 * 参数：
 *   --list <json>        歌单文件（[{title,artist}] 或 ["歌手 - 歌名"]）
 *   --out <dir>          输出目录（默认 ./downloads）
 *   --quality <flac|320|128>  目标音质，默认 flac（逐档降级）
 *   --lossless-only      只要无损，拿不到就报失败（不降级）
 *   --delay <秒>         每首之间间隔，默认 2
 *   --max <n>            最多下载前 n 首
 *   --force              已存在也重下
 *   --no-lyric           不抓歌词
 *   --only-free          跳过非免费曲目（默认行为，显式声明用）
 *   --probe              只搜索+打印候选与可用档位，不下载
 *   --help / -h          显示本说明
 *
 * 输出（与 gd-browser-downloader.js 完全一致，可直接接 flac_metadata_embedder.py）：
 *   <out>/歌手 - 歌名.flac|mp3
 *   <out>/歌手 - 歌名.lrc                  ← 与音频同名同目录（山灵播放器要求）
 *   <out>/.downloaded.json                 ← 索引（含 track / cover_url / lyric 详情）
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// 常量（全部来自逆向结论，改动前先读上面的溯源说明）
// ---------------------------------------------------------------------------
const SALT_WEB = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt"; // 网页版签名盐（双三明治）
const UA_WEB =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const UA_MOBILE = "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15";
const REFERER = "https://www.kugou.com/";
// KRC 歌词 XOR 密钥（16 字节循环；来自 KuGouMusicApi util/util.js decodeLyrics）
const KRC_KEY = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];
// 设备指纹缓存（酷狗对 mid 有粘性，固定下来更稳）
const DEVICE_FILE = path.join(os.homedir(), ".kugou-downloader-device.json");

const md5 = (s) => crypto.createHash("md5").update(String(s), "utf8").digest("hex");
const uuidv4 = () =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 签名：网页版 signatureAndroidParams 的 Web 变体
//   md5(盐 + 参数按 key 排序拼 "k=v" + 盐)，取大写
// ---------------------------------------------------------------------------
function signWeb(params) {
  const ps = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("");
  return md5(`${SALT_WEB}${ps}${SALT_WEB}`).toUpperCase();
}

// ---------------------------------------------------------------------------
// 设备身份（网页版只要 mid；mid = md5(guid)）
// ---------------------------------------------------------------------------
function loadDevice() {
  try {
    const d = JSON.parse(fs.readFileSync(DEVICE_FILE, "utf8"));
    if (d && d.mid) return d;
  } catch {}
  const d = { guid: uuidv4(), mid: md5(uuidv4()), createdAt: Date.now() };
  try {
    fs.writeFileSync(DEVICE_FILE, JSON.stringify(d, null, 2));
  } catch {}
  return d;
}
const DEVICE = loadDevice();

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function httpText(url, { headers = {}, timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(t);
  }
}
const httpJson = async (url, opt) => {
  const { status, text } = await httpText(url, opt);
  try {
    return { status, json: JSON.parse(text) };
  } catch {
    return { status, json: null, raw: text };
  }
};

// ---------------------------------------------------------------------------
// 1) 搜索（网页版 WebFilter）
// ---------------------------------------------------------------------------
async function searchSongs(keyword, pagesize = 20) {
  const params = {
    bitrate: 0,
    clienttime: Date.now(),
    clientver: 2000,
    dfid: "-",
    inputtype: 0,
    iscorrection: 1,
    keyword,
    mid: DEVICE.mid,
    page: 1,
    pagesize,
    platform: "WebFilter",
    privilege_filter: 0,
    srcappid: 2919,
    token: "",
    userid: 0,
    uuid: String(Date.now()),
    appid: 1014,
  };
  const q = { ...params, signature: signWeb(params) };
  const qs = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]));
  const { json, raw } = await httpJson(`https://complexsearch.kugou.com/v2/search/song?${qs}`, {
    headers: { "User-Agent": UA_WEB, Referer: REFERER },
  });
  if (!json) throw new Error(`搜索响应非 JSON: ${String(raw).slice(0, 120)}`);
  if (json.error_code && json.error_code !== 0) {
    throw new Error(`搜索失败 error_code=${json.error_code} ${json.error_msg || ""}`);
  }
  return json.data?.lists || [];
}

// ---------------------------------------------------------------------------
// 2) 取流（m.kugou 免签名）
// ---------------------------------------------------------------------------
async function resolveUrl(hash) {
  const url = `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${String(hash).toUpperCase()}&from=mkugou`;
  const { json } = await httpJson(url, { headers: { "User-Agent": UA_MOBILE, Referer: "https://m.kugou.com/" } });
  if (!json) return null;
  if (json.status !== 1 || !json.url) return { unavailable: true, raw: json };
  return {
    url: json.url,
    ext: (json.extName || "").toLowerCase(),
    bitRate: json.bitRate || 0,
    fileSize: json.fileSize || 0,
    duration: json.timeLength || 0,
    songName: json.songName || "",
    singerName: json.author_name || "",
    albumName: json.albumName || "",
    albumId: json.req_albumid || json.album_id || "",
  };
}

// ---------------------------------------------------------------------------
// 3) 歌词（krcs.kugou.com）
// ---------------------------------------------------------------------------
function krcDecode(b64) {
  const buf = Buffer.from(b64, "base64");
  if (buf.length <= 4) return "";
  const body = Buffer.from(buf.subarray(4)); // 跳过 4 字节文件头
  for (let i = 0; i < body.length; i++) body[i] ^= KRC_KEY[i % KRC_KEY.length];
  try {
    return zlib.inflateSync(body).toString("utf8");
  } catch {
    return "";
  }
}

/** KRC → 标准 LRC（行级时间轴，去掉逐字 <offset,dur,0> 标记） */
function krcToLrc(krcText) {
  const out = [];
  for (const line of krcText.split(/\r?\n/)) {
    const m = line.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!m) continue;
    const ms = Number(m[1]);
    const text = m[3].replace(/<[^>]*>/g, "").trim();
    const mm = String(Math.floor(ms / 60000)).padStart(2, "0");
    const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
    const xx = String(ms % 1000).padStart(3, "0").slice(0, 2);
    out.push(`[${mm}:${ss}.${xx}]${text}`);
  }
  return out.join("\n");
}

async function downloadLyric(songName, durationSec, artist) {
  const durMs = Math.round((durationSec || 0) * 1000);
  // ⚠️ keyword 只放**歌名**：带歌手名会 404（实测「晴天 周杰伦」→404，「晴天」→200）
  const cleanName = String(songName || "").replace(/[()（）\[\]]/g, " ").trim();
  const tries = [cleanName];
  if (artist) tries.push(`${cleanName} ${artist}`.trim());

  let cands = [];
  for (const kw of tries) {
    const sUrl = `https://krcs.kugou.com/search?ver=1&man=no&client=mobi&keyword=${encodeURIComponent(kw)}&hash=&album_audio_id=0&duration=${durMs}`;
    const { json: s } = await httpJson(sUrl, { headers: { "User-Agent": UA_WEB, Referer: REFERER } }).catch(() => ({}));
    cands = [...(s?.candidates || []), ...(s?.ugccandidates || [])];
    if (cands.length) break;
  }
  if (!cands.length) return null;

  // 闸门一：候选歌名必须与请求歌名有重合（krcs 只按名字检索，会混入同名异曲）
  const named = cands.filter((c) => overlapScore(cleanName, c.song) >= 60);
  if (!named.length) return { mismatch: true, cand: `${cands[0].song}/${cands[0].singer}`, drift: -1, reason: "歌名不符" };

  // 闸门二：时长差 > 6 秒一律丢弃，宁可没有歌词也不要配错版本（山灵上会整首错位）
  named.sort((a, b) => Math.abs((a.duration || 0) - durMs) - Math.abs((b.duration || 0) - durMs));
  const c = named[0];
  const drift = Math.abs((c.duration || 0) - durMs);
  if (durMs > 0 && drift > 6000) return { mismatch: true, cand: `${c.song}/${c.singer}`, drift, reason: "时长不符" };

  const dUrl = `https://krcs.kugou.com/download?ver=1&client=mobi&id=${c.id}&accesskey=${c.accesskey}&fmt=krc&charset=utf8`;
  const { json: d } = await httpJson(dUrl, { headers: { "User-Agent": UA_WEB, Referer: REFERER } });
  if (!d?.content) return null;
  const isKrc = Number(d.contenttype) === 0;
  const text = isKrc
    ? krcToLrc(krcDecode(d.content))
    : Buffer.from(d.content, "base64").toString("utf8");
  if (!text || !/\[\d{2}:\d{2}/.test(text)) return null;
  return { lrc: text, song: c.song, singer: c.singer, isKrc, drift };
}

// ---------------------------------------------------------------------------
// 匹配打分（简繁 + 标点归一 + 包含关系）
// ---------------------------------------------------------------------------
const T2S = {
  傑: "杰",倫: "伦",華: "华",語: "语",飛: "飞",陽: "阳",張: "张",學: "学",友: "友",
  這: "这",愛: "爱",時: "时",間: "间",過: "过",來: "来",會: "会",說: "说",對: "对",
  為: "为",無: "无",與: "与",從: "从",點: "点",還: "还",後: "后",種: "种",樣: "样",
  開: "开",關: "关",麼: "么",們: "们",現: "现",實: "实",樂: "乐",聲: "声",舊: "旧",
};
const norm = (s) =>
  String(s || "")
    .split("")
    .map((c) => T2S[c] || c)
    .join("")
    .toLowerCase()
    .replace(/[\s\-_·・~!@#$%^&*()+=\[\]{}|\\;:'",.<>/?，。！？、；：""''（）【】《》]/g, "");

function overlapScore(want, got) {
  const a = norm(want), b = norm(got);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (b.includes(a) || a.includes(b)) return 80;
  const setB = new Set(b);
  let hit = 0;
  for (const ch of new Set(a)) if (setB.has(ch)) hit++;
  return Math.round((hit / new Set(a).size) * 60);
}

function matchScore(song, q) {
  let s = overlapScore(q.title, song.SongName);
  if (q.artist) s += overlapScore(q.artist, song.SingerName) * 0.5;
  // 版本标记惩罚：查询没写 live/remix，候选却带，重罚（沿用 gd 下载器的 -80 约定）
  const verRe = /(live|remix|现场|演唱会|伴奏|翻唱|dj|纯音乐|instrumental)/i;
  const qVer = verRe.test(q.title || "") || verRe.test(q.artist || "");
  const sVer = verRe.test(song.SongName || "") || verRe.test(song.SingerName || "");
  if (sVer && !qVer) s -= 80;
  return s;
}

// ---------------------------------------------------------------------------
// 音质档位
// ---------------------------------------------------------------------------
function qualityLadder(song) {
  // 每档：{q, hash, size, br, priv}
  const list = [];
  if (song.ResFileHash) list.push({ q: "hires", hash: song.ResFileHash, size: song.ResFileSize, br: song.ResBitrate, priv: song.ResPrivilege ?? song.ASQPrivilege });
  if (song.SQFileHash) list.push({ q: "flac", hash: song.SQFileHash, size: song.SQFileSize, br: song.SQBitrate, priv: song.SQPrivilege });
  if (song.HQFileHash) list.push({ q: "320", hash: song.HQFileHash, size: song.HQFileSize, br: song.HQBitrate, priv: song.HQPrivilege });
  if (song.FileHash) list.push({ q: "128", hash: song.FileHash, size: song.FileSize, br: song.Bitrate, priv: song.Privilege });
  for (const it of list) it.free = it.priv === 0;
  return list;
}

function pickCandidate(song, target, losslessOnly) {
  const ladder = qualityLadder(song);
  const order = { flac: ["hires", "flac"], "320": ["flac", "hires", "320"], "128": ["320", "flac", "hires", "128"] }[target] || ["hires", "flac", "320", "128"];
  for (const q of order) {
    const hit = ladder.find((x) => x.q === q && x.free);
    if (hit) return hit;
  }
  if (losslessOnly) return null;
  // 降级：任何免费档位里挑最好的
  const free = ladder.filter((x) => x.free);
  return free.length ? free[free.length - 1] : null;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const IMG_SIZE = 480;

async function downloadOne(q, idx, total, cfg) {
  const label = q.artist ? `${q.artist} - ${q.title}` : q.title;
  console.log(`\n[${idx}/${total}] ${label}`);

  const safeBase = label.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  fs.mkdirSync(cfg.out, { recursive: true });
  const indexFile = path.join(cfg.out, ".downloaded.json");
  let index = {};
  try { index = JSON.parse(fs.readFileSync(indexFile, "utf8")); } catch {}

  const existing = fs.readdirSync(cfg.out).find((f) => f.startsWith(safeBase + ".") && !f.endsWith(".json"));
  if (existing && !cfg.force) {
    console.log(`   · 已存在，跳过: ${existing}`);
    return "skip";
  }

  // ---- 搜索 ----
  let songs;
  try {
    songs = await searchSongs(`${q.title} ${q.artist || ""}`.trim());
  } catch (e) {
    console.log(`   ✗ 搜索失败: ${e.message}`);
    return "fail";
  }
  if (!songs.length) { console.log(`   ✗ 未搜到「${q.title}」`); return "fail"; }

  songs.sort((a, b) => matchScore(b, q) - matchScore(a, q));
  const best = songs[0];
  const bestScore = matchScore(best, q);
  if (cfg.probe) {
    console.log(`   匹配分 ${bestScore} → ${best.SongName} / ${best.SingerName}（时长 ${best.Duration}s）`);
    for (const it of songs.slice(0, 5)) {
      const ladder = qualityLadder(it);
      console.log(
        `     ${String(matchScore(it, q)).padStart(4)}  ${it.SongName} / ${it.SingerName}  ` +
          ladder.map((x) => `${x.q}${x.free ? "✓" : "🔒"}${x.br ? `(${x.br}k)` : ""}`).join(" ")
      );
    }
    return "probe";
  }
  if (bestScore < 40) {
    console.log(`   ✗ 匹配度不足（${bestScore}）: ${best.SongName} / ${best.SingerName}`);
    return "fail";
  }
  console.log(`   · 命中: ${best.SongName} / ${best.SingerName}（匹配 ${bestScore}，时长 ${best.Duration}s）`);

  const ladder = qualityLadder(best);
  console.log(`   · 档位: ${ladder.map((x) => `${x.q}${x.free ? "✓" : "🔒"}`).join(" ")}`);

  const pick = pickCandidate(best, cfg.quality, cfg.losslessOnly);
  if (!pick) {
    console.log(`   ✗ ${cfg.losslessOnly ? "无免费无损档" : "无任何免费档"}（VIP 曲目请改用 GD 音乐台渠道）`);
    return "fail";
  }

  // ---- 取流 ----
  const info = await resolveUrl(pick.hash);
  if (!info || info.unavailable) {
    console.log(`   ✗ 取流被拒（VIP/风控）: ${pick.q}`);
    return "fail";
  }
  const ext = info.ext || "mp3";
  const fileName = `${safeBase}.${ext}`;
  const filePath = path.join(cfg.out, fileName);
  console.log(`   · 取流成功: ${pick.q} ${info.bitRate}kbps ${(info.fileSize / 1048576).toFixed(1)}MB → ${fileName}`);

  // ---- 下载 ----
  const res = await fetch(info.url, { headers: { "User-Agent": UA_WEB, Referer: REFERER } });
  if (!res.ok) { console.log(`   ✗ 下载 HTTP ${res.status}`); return "fail"; }
  const buf = Buffer.from(await res.arrayBuffer());
  const magic = buf.subarray(0, 4).toString("ascii");
  if (magic !== "fLaC" && !magic.startsWith("ID3") && !(buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) {
    console.log(`   ✗ 响应不是音频（魔数 ${buf.subarray(0, 4).toString("hex")}），可能链接已过期`);
    return "fail";
  }
  fs.writeFileSync(filePath, buf);
  const realLossless = magic === "fLaC";
  console.log(`   ✓ 已保存 ${(buf.length / 1048576).toFixed(1)}MB${realLossless ? "（FLAC 真无损）" : "（有损）"}`);

  // ---- 歌词 ----
  let lyric = null;
  if (!cfg.noLyric) {
    try {
      const lc = await downloadLyric(best.SongName, best.Duration, String(best.SingerName || "").split(/[、,&\/]/)[0]);
      if (lc && lc.lrc) {
        fs.writeFileSync(path.join(cfg.out, `${safeBase}.lrc`), lc.lrc, "utf8");
        lyric = { lyric: lc.lrc, tlyric: "" };
        console.log(`   ✓ 歌词已写入 ${safeBase}.lrc（${lc.isKrc ? "KRC 逐字→LRC" : "LRC"}，${lc.lrc.split("\n").length} 行，时长差 ${(lc.drift / 1000).toFixed(1)}s）`);
      } else if (lc && lc.mismatch) {
        console.log(`   · 歌词库无匹配版本（${lc.reason || "不符"}：${lc.cand}）→ 交给 flac_metadata_embedder.py 兜底`);
      } else {
        console.log(`   · 酷狗歌词库无此曲（可由 flac_metadata_embedder.py 走 Lrclib/NetEase 兜底）`);
      }
    } catch (e) {
      console.log(`   · 歌词失败: ${e.message}`);
    }
  }

  // ---- 索引（供 flac_metadata_embedder.py 复用）----
  const coverUrl = String(best.Image || best.AlbumImage || "").replace("{size}", String(IMG_SIZE)).replace(/^http:/, "https:");
  index[safeBase] = {
    file: fileName,
    src: "kugou",
    site: "kugou",
    br: info.bitRate,
    size: buf.length,
    quality: pick.q,
    track: {
      id: String(best.EMixSongID || best.MixSongID || best.Audioid || ""),
      name: best.SongName,
      artist: String(best.SingerName || "").split(/[、,&\/]/).map((s) => s.trim()).filter(Boolean),
      album: best.AlbumName || "",
      duration: best.Duration || info.duration,
      source: "kugou",
      pic_id: coverUrl,
      lyric_id: "",
      has_hires: pick.q === "hires" || realLossless,
    },
    cover_url: coverUrl,
    lyric,
    fetched: Date.now(),
  };
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
  return "ok";
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const cfg = { out: path.join(process.cwd(), "downloads"), quality: "flac", losslessOnly: false, delay: 2, max: 0, force: false, noLyric: false, probe: false, list: null, queries: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--out": cfg.out = path.resolve(next()); break;
      case "--quality": cfg.quality = next(); break;
      case "--lossless-only": case "--flac-only": cfg.losslessOnly = true; break;
      case "--delay": cfg.delay = parseFloat(next()); break;
      case "--max": cfg.max = parseInt(next(), 10); break;
      case "--force": cfg.force = true; break;
      case "--no-lyric": cfg.noLyric = true; break;
      case "--only-free": break; // 默认行为
      case "--probe": cfg.probe = true; break;
      case "--list": cfg.list = path.resolve(next()); break;
      case "--help": case "-h":
        console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^\/\*\*?/, ""));
        process.exit(0);
        break;
      default:
        if (a.startsWith("-")) { console.error(`未知参数: ${a}`); process.exit(1); }
        cfg.queries.push(a);
    }
  }
  return cfg;
}

function loadQueries(cfg) {
  const out = [];
  // 与 gd-browser-downloader.js 同一约定：`歌名 - 歌手`（分隔符 - 或 |）
  const push = (raw) => {
    const s = String(raw).trim();
    if (!s) return;
    const m = s.match(/^(.*?)\s*[|-]\s*(.+)$/);
    if (m) out.push({ title: m[1].trim(), artist: m[2].trim() });
    else out.push({ title: s, artist: "" });
  };
  if (cfg.list) {
    const raw = fs.readFileSync(cfg.list, "utf8");
    const t = raw.trim();
    if (t.startsWith("[") || t.startsWith("{")) {
      const arr = JSON.parse(t);
      if (!Array.isArray(arr)) throw new Error("JSON 列表必须是数组");
      for (const it of arr) {
        out.push({ title: String(it.name || it.title || "").trim(), artist: String(it.artist || "").trim() });
      }
    } else for (const line of raw.split(/\r?\n/)) push(line);
  }
  for (const q of cfg.queries) push(q);
  return cfg.max > 0 ? out.slice(0, cfg.max) : out;
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const queries = loadQueries(cfg);
  if (!queries.length) {
    console.error("用法: node kugou-downloader.js \"歌手 - 歌名\" [--out DIR] [--lossless-only]  或  --list songs.json");
    process.exit(1);
  }
  console.log("酷狗直连下载器 —— 免签名通道（仅免费曲目可下真无损）");
  console.log(`设备 mid: ${DEVICE.mid.slice(0, 12)}…   输出: ${cfg.out}   共 ${queries.length} 首`);
  const stat = { ok: 0, fail: 0, skip: 0, probe: 0 };
  for (let i = 0; i < queries.length; i++) {
    try {
      const r = await downloadOne(queries[i], i + 1, queries.length, cfg);
      stat[r] = (stat[r] || 0) + 1;
    } catch (e) {
      console.log(`   ✗ 异常: ${e.message}`);
      stat.fail++;
    }
    if (i < queries.length - 1 && !cfg.probe) await sleep(cfg.delay * 1000);
  }
  console.log(`\n完成：成功 ${stat.ok} / 失败 ${stat.fail} / 跳过 ${stat.skip}${stat.probe ? ` / 探测 ${stat.probe}` : ""}`);
}

// 作为库被 require 时不自动跑批（便于单测与其它脚本复用签名/歌词逻辑）
module.exports = { signWeb, searchSongs, resolveUrl, downloadLyric, krcDecode, krcToLrc, matchScore, qualityLadder, pickCandidate, DEVICE };

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
