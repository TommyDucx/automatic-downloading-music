#!/usr/bin/env node
/**
 * 歌单链接导入器（零第三方依赖，仅需 Node.js >= 18）
 *
 * 借鉴 EchoMusic src/main/external/providers/*.ts 的思路：
 * 把「分享链接 / 纯 ID / 文本」解析成标准曲目列表 [{title, artist, album?, duration?}]，
 * 输出为 playlist.json / songs.txt，供 gd-flac-downloader.js --list 直接使用。
 * 只做「找歌单」，不做音源解析——下载仍走 GD 音乐台多源搜索匹配。
 *
 * 支持平台：
 *   netease  网易云歌单   https://music.163.com/playlist?id=xxx  | 纯数字ID
 *   qqmusic  QQ音乐歌单   https://y.qq.com/n/ryqq/playlist/xxx    | 纯数字ID
 *   spotify  Spotify歌单  https://open.spotify.com/playlist/xxx   | spotify:playlist:xxx
 *   kugou    酷狗歌单     https://kugou.com/yy/special/single/xxx | 短链 t1.kugou.com
 *   qishui   汽水音乐     https://qishui.douyin.com/s/xxx（可选）
 *   text     文本        每行 "歌手 - 歌名" 或 JSON 数组
 *
 * 用法：
 *   node playlist-importer.js "https://music.163.com/playlist?id=xxx" --out downloads/01-xxx/playlist.json
 *   node playlist-importer.js 7403678821 --platform netease          # 纯 ID 需指定平台
 *   node playlist-importer.js "歌手 - 歌名" --out songs.json          # 文本直通
 *   node playlist-importer.js --help
 *
 * 输出格式（与 gd-flac-downloader.js --list 兼容）：
 *   JSON: [{"title":"...","artist":"..."}]
 *   TXT:  每行 "歌名 - 歌手"
 */

"use strict";

const fs = require("fs");
const path = require("path");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const TIMEOUT = 20000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------
async function fetchText(url, headers = {}) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/json,*/*;q=0.8", ...headers },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (r.status >= 400) throw new Error(`HTTP ${r.status} @ ${url.slice(0, 120)}`);
  return r.text();
}

async function fetchJson(url, headers = {}) {
  const txt = await fetchText(url, { Accept: "application/json, text/plain, */*", ...headers });
  return JSON.parse(txt);
}

async function postFormJson(url, form, headers = {}) {
  const body = new URLSearchParams(form).toString();
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (r.status >= 400) throw new Error(`HTTP ${r.status} @ ${url.slice(0, 120)}`);
  return JSON.parse(await r.text());
}

// ---------------------------------------------------------------------------
// 文本 / 通用
// ---------------------------------------------------------------------------
function parseTextTracks(input) {
  const tracks = [];
  const push = (raw) => {
    const s = String(raw).trim();
    if (!s) return;
    let m = s.match(/^(.*?)\s*[|-]\s*(.+)$/);
    if (m) tracks.push({ title: m[1].trim(), artist: m[2].trim() });
    else tracks.push({ title: s, artist: "" });
  };
  for (const line of String(input).split(/\r?\n/)) push(line);
  return tracks;
}

// ---------------------------------------------------------------------------
// 网易云
// ---------------------------------------------------------------------------
const NETEASE_ID_PATTERNS = [
  /music\.163\.com\/[^\s]*?[?#&]id=(\d+)/i,
  /music\.163\.com\/[^\s]*?playlist[\/]?(\d+)/i,
  /163cn\.tv\/[A-Za-z0-9]+/i,
];

function extractNeteaseId(input) {
  const trimmed = input.trim();
  if (/^\d{6,}$/.test(trimmed)) return trimmed;
  for (const p of NETEASE_ID_PATTERNS) {
    const m = trimmed.match(p);
    if (m && m[1] && /^\d+$/.test(m[1])) return m[1];
  }
  return null;
}

async function resolveNeteaseShortLink(input) {
  const m = input.match(/https?:\/\/163cn\.tv\/[A-Za-z0-9]+/);
  if (!m) return input;
  try {
    const text = await fetchText(m[0]);
    const target = text.match(/https?:\/\/[^\s"']*music\.163\.com[^\s"']*/);
    if (target) return target[0];
  } catch {}
  return input;
}

function mapNeteaseTrack(t) {
  const ar = Array.isArray(t.ar)
    ? t.ar.map((a) => (a && typeof a === "object" ? String(a.name ?? "") : "")).filter(Boolean).join(" / ")
    : "";
  const title = String(t?.name ?? "").trim();
  if (!title) return null;
  return {
    title,
    artist: ar,
    album: t?.al?.name ? String(t.al.name) : undefined,
    duration:
      typeof t?.dt === "number" && t.dt > 0
        ? Math.round(t.dt / 1000)
        : typeof t?.duration === "number" && t.duration > 0
          ? Math.round(t.duration / 1000)
          : undefined,
  };
}

async function fetchNeteasePlaylist(id) {
  const url = `https://music.163.com/api/v6/playlist/detail?id=${id}&n=100000`;
  const headers = { Referer: "https://music.163.com/" };
  const body = await fetchJson(url, headers);
  const playlist = body?.playlist;
  if (!playlist) throw new Error("网易云返回数据为空，可能歌单不存在或为私密歌单");

  const rawTracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
  const initial = new Map();
  for (const t of rawTracks) {
    const mapped = mapNeteaseTrack(t);
    if (mapped && t?.id != null) initial.set(String(t.id), mapped);
  }

  // playlist/detail 仅完整返回前若干首，按 trackIds 顺序分批补齐（参考 EchoMusic netease.ts）
  const orderedIds = Array.isArray(playlist.trackIds)
    ? playlist.trackIds
        .map((x) => (x && typeof x === "object" ? String(x.id ?? "") : String(x ?? "")))
        .filter(Boolean)
    : [];
  const missing = orderedIds.filter((id) => !initial.has(id));
  if (missing.length > 0) {
    const BATCH = 500;
    for (let i = 0; i < missing.length; i += BATCH) {
      const slice = missing.slice(i, i + BATCH);
      const c = JSON.stringify(slice.map((id) => ({ id })));
      try {
        const detail = await postFormJson(
          "https://music.163.com/api/v3/song/detail",
          { c },
          { Referer: "https://music.163.com/" },
        );
        const songs = Array.isArray(detail?.songs) ? detail.songs : [];
        for (const s of songs) {
          const mapped = mapNeteaseTrack(s);
          if (mapped && s?.id != null) initial.set(String(s.id), mapped);
        }
      } catch {
        // 单批失败不阻塞其余批次
      }
      await sleep(300);
    }
  }

  const tracks =
    orderedIds.length > 0
      ? orderedIds.map((id) => initial.get(id)).filter(Boolean)
      : Array.from(initial.values());

  return {
    provider: "netease",
    name: String(playlist.name ?? "未命名歌单"),
    coverUrl: playlist.coverImgUrl ? String(playlist.coverImgUrl) : undefined,
    creator: playlist.creator?.nickname ? String(playlist.creator.nickname) : undefined,
    tracks,
  };
}

// ---------------------------------------------------------------------------
// QQ 音乐
// ---------------------------------------------------------------------------
const QQ_ID_PATTERNS = [/y\.qq\.com\/n\/ryqq\/playlist\/(\d+)/i, /[?&]disstid=(\d+)/i];

function extractQqId(input) {
  const trimmed = input.trim();
  if (/^\d{6,}$/.test(trimmed)) return trimmed;
  for (const p of QQ_ID_PATTERNS) {
    const m = trimmed.match(p);
    if (m && m[1]) return m[1];
  }
  return null;
}

function mapQqTrack(t) {
  const singers = Array.isArray(t?.singer)
    ? t.singer.map((s) => (s && typeof s === "object" ? String(s.name ?? "") : "")).filter(Boolean).join(" / ")
    : "";
  const title = String(t?.songname ?? t?.title ?? "").trim();
  if (!title) return null;
  return {
    title,
    artist: singers,
    album: t?.albumname ? String(t.albumname) : undefined,
    duration: typeof t?.interval === "number" && t.interval > 0 ? t.interval : undefined,
  };
}

async function fetchQqPlaylist(id) {
  const url =
    `https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg` +
    `?type=1&disstid=${id}&format=json&utf8=1&outCharset=utf-8`;
  const body = await fetchJson(url, { Referer: "https://y.qq.com/" });
  const cd = Array.isArray(body?.cdlist) ? body.cdlist[0] : null;
  if (!cd) throw new Error("QQ 音乐返回数据为空，可能歌单不存在或为私密歌单");
  const rawTracks = Array.isArray(cd.songlist) ? cd.songlist : [];
  const tracks = rawTracks.map(mapQqTrack).filter(Boolean);
  return {
    provider: "qqmusic",
    name: String(cd.dissname ?? "未命名歌单"),
    coverUrl: cd.logo ? String(cd.logo) : undefined,
    creator: cd.nickname ? String(cd.nickname) : undefined,
    tracks,
  };
}

// ---------------------------------------------------------------------------
// Spotify
// ---------------------------------------------------------------------------
function extractSpotifyId(input) {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9]{22}$/.test(trimmed)) return trimmed;
  const url = trimmed.match(/open\.spotify\.com\/playlist\/([A-Za-z0-9]{22})/);
  if (url) return url[1];
  const uri = trimmed.match(/spotify:playlist:([A-Za-z0-9]{22})/);
  if (uri) return uri[1];
  return null;
}

async function fetchSpotifyPlaylist(id) {
  // embed 端点无需认证，返回 __NEXT_DATA__（参考 EchoMusic spotify.ts）
  const html = await fetchText(`https://open.spotify.com/embed/playlist/${id}`);
  const m = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("无法从 Spotify 页面提取数据，可能页面结构已变更");
  const nextData = JSON.parse(m[1]);
  const entity = nextData?.props?.pageProps?.state?.data?.entity ?? {};
  if (entity.type !== "playlist") throw new Error("该链接不是 Spotify 歌单");
  const rawTracks = Array.isArray(entity.trackList) ? entity.trackList : [];
  const tracks = rawTracks
    .map((t) => {
      const title = String(t?.title ?? "").trim();
      if (!title) return null;
      return {
        title,
        artist: String(t?.subtitle ?? "").trim(),
        duration:
          typeof t?.duration === "number" && t.duration > 0 ? Math.round(t.duration / 1000) : undefined,
      };
    })
    .filter(Boolean);
  const cover = Array.isArray(entity.coverArt?.sources) ? entity.coverArt.sources : [];
  return {
    provider: "spotify",
    name: String(entity.name ?? "未命名歌单"),
    coverUrl: cover[0]?.url,
    creator: String(entity.subtitle ?? "").trim() || undefined,
    tracks,
  };
}

// ---------------------------------------------------------------------------
// 酷狗
// ---------------------------------------------------------------------------
const KUGOU_MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";

function extractKugouId(input) {
  const trimmed = input.trim();
  const gid =
    trimmed.match(/global_collection_id=([a-zA-Z0-9_]+)/)?.[1] ||
    trimmed.match(/global_specialid=([a-zA-Z0-9_]+)/)?.[1] ||
    null;
  if (gid && gid.startsWith("collection_")) return gid;
  const special = trimmed.match(/\/special\/single\/(\d+)\.html/);
  if (special) return special[1];
  return null;
}

async function followRedirect(url) {
  try {
    const r = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": KUGOU_MOBILE_UA },
    });
    return r.headers.get("location");
  } catch (e) {
    return e?.response?.headers?.get("location") || null;
  }
}

function parseKugouMobilePage(html) {
  const match = html.match(/window\.\$output\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]);
    const info = data.info || {};
    const listinfo = info.listinfo || {};
    const songs = Array.isArray(info.songs) ? info.songs : [];
    const tracks = songs
      .filter((s) => s.name || s.audio_name)
      .map((s) => {
        const rawName = String(s.name || s.audio_name || "");
        const sepIdx = rawName.indexOf(" - ");
        let title = rawName;
        let artist = "";
        if (sepIdx > 0) {
          artist = rawName.substring(0, sepIdx);
          title = rawName.substring(sepIdx + 3);
        }
        return {
          title,
          artist,
          duration:
            typeof s.timelen === "number" ? Math.round(s.timelen / 1000) : undefined,
        };
      });
    return {
      name: String(listinfo.name || "酷狗歌单"),
      coverUrl: String(listinfo.pic || "").replace("{size}", "480") || undefined,
      creator: String(listinfo.list_create_username || "") || undefined,
      tracks,
    };
  } catch {
    return null;
  }
}

function parseKugouSharePage(html) {
  const match = html.match(/var\s+dataFromSmarty\s*=\s*(\[[\s\S]*?\])\s*[,;]/);
  if (!match) return [];
  try {
    const data = JSON.parse(match[1]);
    return data
      .filter((item) => item.song_name || item.audio_name)
      .map((item) => ({
        title: String(item.song_name || "").replace(/&amp;/g, "&"),
        artist: String(item.author_name || "").replace(/&amp;/g, "&"),
        duration:
          typeof item.timelength === "number" ? Math.round(item.timelength / 1000) : undefined,
      }));
  } catch {
    return [];
  }
}

async function fetchKugouPlaylist(input) {
  let url = input.trim();
  const id = extractKugouId(url);
  if (id && id.startsWith("collection_")) {
    // 有 gid 时直接走移动端接口页面
    url = `https://m3ws.kugou.com/songlist/gcid_${id.replace("collection_", "")}`;
  }
  // 短链：跟踪重定向
  if (/t1\.kugou\.com/.test(url)) {
    const loc = await followRedirect(url);
    if (loc) url = loc.replace(/^http:/, "https:");
  }
  // 移动端歌单页
  if (/kugou\.com\/songlist\//.test(url)) {
    const mUrl = url.replace(/^https?:\/\/(m\.)?kugou\.com/, "https://m3ws.kugou.com");
    try {
      const html = await fetchText(mUrl, { "User-Agent": KUGOU_MOBILE_UA });
      const parsed = parseKugouMobilePage(html);
      if (parsed && parsed.tracks.length > 0) return { provider: "kugou", ...parsed };
    } catch {}
  }
  // 通用页面：先移动端格式再 PC 分享格式
  const html = await fetchText(url, { "User-Agent": KUGOU_MOBILE_UA });
  const mobile = parseKugouMobilePage(html);
  if (mobile && mobile.tracks.length > 0) return { provider: "kugou", ...mobile };
  const share = parseKugouSharePage(html);
  if (share.length > 0) return { provider: "kugou", name: "酷狗分享歌单", tracks: share };
  throw new Error("无法从该酷狗链接中提取歌单信息，请检查链接是否正确");
}

// ---------------------------------------------------------------------------
// 汽水音乐（可选支持）
// ---------------------------------------------------------------------------
function extractQishuiId(input) {
  const trimmed = input.trim();
  const id = trimmed.match(/[?&]playlist_id=(\d+)/);
  if (id) return id[1];
  const short = trimmed.match(/https?:\/\/qishui\.douyin\.com\/s\/[A-Za-z0-9]+/);
  if (short) return short[0];
  return null;
}

async function fetchQishuiPlaylist(input) {
  let pageUrl = input.trim();
  const short = pageUrl.match(/https?:\/\/qishui\.douyin\.com\/s\/[A-Za-z0-9]+/);
  if (!short && /^\d{10,}$/.test(pageUrl)) {
    pageUrl = `https://music.douyin.com/qishui/share/playlist?playlist_id=${pageUrl}`;
  }
  const html = await fetchText(pageUrl);
  const startIdx = html.indexOf("_ROUTER_DATA");
  if (startIdx === -1) throw new Error("无法从汽水音乐页面提取数据，可能页面结构已变更");
  const jsonStart = html.indexOf("{", startIdx);
  const endMarkers = [";\nfunction", ";\n</script>", ";\n"];
  let jsonStr = "";
  for (const marker of endMarkers) {
    const endIdx = html.indexOf(marker, jsonStart);
    if (endIdx !== -1) {
      jsonStr = html.slice(jsonStart, endIdx);
      break;
    }
  }
  if (!jsonStr) throw new Error("无法从汽水音乐页面提取完整数据");
  const routerData = JSON.parse(jsonStr);
  const pageData = routerData?.loaderData?.playlist_page ?? {};
  const playlistInfo = pageData.playlistInfo;
  if (!playlistInfo) throw new Error("汽水音乐返回数据中无歌单信息");
  const medias = Array.isArray(pageData.medias) ? pageData.medias : [];
  const tracks = medias
    .map((media) => {
      const track = media?.entity?.track;
      if (!track?.name) return null;
      const artists = Array.isArray(track.artists)
        ? track.artists.map((a) => String(a?.name || a?.simple_display_name || "")).filter(Boolean).join(" / ")
        : "";
      return {
        title: String(track.name).trim(),
        artist: artists,
        album: track.album?.name ? String(track.album.name) : undefined,
        duration:
          typeof track.duration === "number" && track.duration > 0
            ? Math.round(track.duration / 1000)
            : undefined,
      };
    })
    .filter(Boolean);
  if (tracks.length === 0) throw new Error("该歌单没有歌曲或为私密歌单");
  return {
    provider: "qishui",
    name: String(playlistInfo.title ?? "未命名歌单"),
    coverUrl: undefined,
    creator: String(playlistInfo.owner?.nickname ?? playlistInfo.owner?.public_name ?? "") || undefined,
    tracks,
  };
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------
function detectPlatform(input) {
  const s = String(input);
  if (/music\.163\.com|163cn\.tv/.test(s)) return "netease";
  if (/y\.qq\.com|qq\.com\/n\/ryqq/.test(s)) return "qqmusic";
  if (/open\.spotify\.com|spotify:playlist:/.test(s)) return "spotify";
  if (/kugou\.com/.test(s)) return "kugou";
  if (/qishui\.douyin\.com|music\.douyin\.com\/qishui/.test(s)) return "qishui";
  if (/^https?:\/\//.test(s) || /^\d{6,}$/.test(s)) {
    // 纯 ID 或未知链接：默认按网易云尝试（最常见的纯 ID 形态）
    return "netease";
  }
  return "text";
}

async function importPlaylist(input, platform) {
  const value = String(input ?? "").trim();
  if (!value) throw new Error("输入为空");
  const plat = (platform || detectPlatform(value)).toLowerCase();

  switch (plat) {
    case "netease": {
      const resolved = await resolveNeteaseShortLink(value);
      const id = extractNeteaseId(resolved);
      if (!id) throw new Error("未能识别网易云歌单 ID");
      return fetchNeteasePlaylist(id);
    }
    case "qqmusic": {
      const id = extractQqId(value);
      if (!id) throw new Error("未能识别 QQ 音乐歌单 ID");
      return fetchQqPlaylist(id);
    }
    case "spotify": {
      const id = extractSpotifyId(value);
      if (!id) throw new Error("未能识别 Spotify 歌单 ID");
      return fetchSpotifyPlaylist(id);
    }
    case "kugou":
      return fetchKugouPlaylist(value);
    case "qishui": {
      const id = extractQishuiId(value);
      if (!id) throw new Error("未能识别汽水音乐歌单 ID/链接");
      return fetchQishuiPlaylist(id);
    }
    case "text": {
      const tracks = parseTextTracks(value);
      if (tracks.length === 0) throw new Error("文本中没有可解析的曲目");
      return { provider: "text", name: "文本歌单", tracks };
    }
    default:
      throw new Error(`不支持平台: ${plat}`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const cfg = { input: null, platform: null, out: null, txt: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--platform":
        cfg.platform = next();
        break;
      case "--out":
        cfg.out = path.resolve(next());
        break;
      case "--txt":
        cfg.txt = true;
        break;
      case "--verbose":
        cfg.verbose = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        if (a.startsWith("-")) {
          console.error(`未知参数: ${a}`);
          process.exit(1);
        }
        cfg.input = a;
    }
  }
  return cfg;
}

function printHelp() {
  console.log(`用法:
  node playlist-importer.js "<分享链接>" [--platform netease|qqmusic|spotify|kugou|qishui|text] [--out playlist.json] [--txt]
  node playlist-importer.js 7403678821 --platform netease        # 纯 ID 需指定平台

支持平台: 网易云 / QQ音乐 / Spotify / 酷狗 / 汽水 / 文本
输出: JSON [{title,artist}]（默认 stdout）；--out 写文件；--txt 输出 "歌名 - 歌手" 每行`);
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  if (!cfg.input) {
    console.error("缺少输入。用法见 --help。");
    process.exit(1);
  }
  try {
    const result = await importPlaylist(cfg.input, cfg.platform);
    if (cfg.verbose) {
      console.error(
        `[i] 平台=${result.provider} 歌单=${result.name} 曲目=${result.tracks.length}` +
          (result.creator ? ` 创建者=${result.creator}` : "")
      );
    }
    if (cfg.out) {
      const dir = path.dirname(cfg.out);
      fs.mkdirSync(dir, { recursive: true });
      const jsonOut = cfg.out.endsWith(".txt") ? cfg.out.replace(/\.txt$/, ".json") : cfg.out;
      fs.writeFileSync(jsonOut, JSON.stringify(result.tracks, null, 2) + "\n");
      if (cfg.txt) {
        const txtOut = jsonOut.replace(/\.json$/, ".txt");
        fs.writeFileSync(
          txtOut,
          result.tracks.map((t) => (t.artist ? `${t.title} - ${t.artist}` : t.title)).join("\n") + "\n"
        );
      }
      console.log(`[+] 已写入 ${jsonOut}（${result.tracks.length} 首）`);
    } else {
      if (cfg.txt) {
        console.log(result.tracks.map((t) => (t.artist ? `${t.title} - ${t.artist}` : t.title)).join("\n"));
      } else {
        console.log(JSON.stringify(result.tracks, null, 2));
      }
    }
  } catch (e) {
    console.error(`[x] 导入失败: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { importPlaylist, detectPlatform, parseTextTracks };

if (require.main === module) main().catch((e) => {
  console.error(`[!] 致命错误: ${e.message}`);
  process.exit(1);
});
