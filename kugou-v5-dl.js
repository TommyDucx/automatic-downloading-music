"use strict";
// 陶喆剩余 22 首：酷狗概念版 VIP v5 gateway 明文无损下载
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".kugou-vip-auth.json"), "utf8"));
const device = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".kugou-downloader-device.json"), "utf8"));
const MID = device.mid;
const DFID = "kt" + md5(auth.userid + MID).slice(0, 22);

function norm(t) {
  t = t.normalize("NFKC").toLowerCase();
  return t.replace(/[\s.,!?()[\]\-_~*'“”&:：·～，。！？（）《》]+/g, "");
}
function searchSongs(keyword) {
  const params = {
    bitrate: 0, clienttime: Date.now(), clientver: 2000, dfid: "-", inputtype: 0,
    iscorrection: 1, keyword, mid: MID, page: 1, pagesize: 20, platform: "WebFilter",
    privilege_filter: 0, srcappid: 2919, token: "", userid: 0, uuid: String(Date.now()), appid: 1014,
  };
  const p = Object.keys(params).map(k => `${k}=${params[k]}`).sort().join("");
  params.signature = md5(`NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt${p}NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt`);
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const out = execFileSync("curl", ["-sS", "--max-time", "30",
    "-H", "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "-H", "Referer: https://www.kugou.com/",
    `https://complexsearch.kugou.com/v2/search/song?${qs}`], { maxBuffer: 20 * 1024 * 1024 }).toString();
  return (JSON.parse(out).data || {}).lists || [];
}
// 候选 hash 链：SQ(无损) → HQ(320) → File(128)
function qualityChain(s) {
  const chain = [];
  if (s.SQFileHash) chain.push({ q: "flac", hash: s.SQFileHash.toLowerCase(), priv: s.SQPrivilege });
  if (s.HQFileHash) chain.push({ q: "320", hash: s.HQFileHash.toLowerCase(), priv: s.HQPrivilege });
  if (s.FileHash) chain.push({ q: "128", hash: s.FileHash.toLowerCase(), priv: s.Privilege });
  return chain;
}
function v5Gateway(hash, albumId, albumAudioId) {
  const params = {
    dfid: DFID, mid: MID, uuid: "-", appid: 3116, clientver: 11440,
    clienttime: Math.floor(Date.now() / 1000), token: auth.token, userid: auth.userid,
    album_id: Number(albumId || 0), area_code: 1, hash,
    ssa_flag: "is_fromtrack", version: 11436, page_id: "967177915", quality: "flac",
    album_audio_id: Number(albumAudioId || 0), behavior: "play", pid: 411, cmd: 26,
    pidversion: 3001, IsFreePart: 0, ppage_id: "356753938,823673182,967485191",
    cdnBackup: 1, kcard: 0, module: "",
  };
  params.key = md5(hash + "185672dd44712f60bb1736df5a377e82" + "3116" + MID + auth.userid);
  const ps = Object.keys(params).sort().map(k => `${k}=${typeof params[k] === "object" ? JSON.stringify(params[k]) : params[k]}`).join("");
  params.signature = md5(`LnT6xpN3khm36zse0QzvmgTZ3waWdRSA${ps}LnT6xpN3khm36zse0QzvmgTZ3waWdRSA`);
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const cookie = `token=${auth.token}; userid=${auth.userid}; kg_mid=${MID}; kg_dfid=${DFID}`;
  const out = execFileSync("curl", ["-sS", "--max-time", "20",
    `https://gateway.kugou.com/v5/url?${qs}`,
    "-H", "User-Agent: Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi",
    "-H", "x-router: trackercdn.kugou.com",
    "-H", `dfid: ${DFID}`, "-H", `clienttime: ${params.clienttime}`, "-H", `mid: ${MID}`,
    "-H", "kg-rc: 1", "-H", "kg-thash: 5d816a0", "-H", "kg-rec: 1",
    "-H", "kg-rf: B9EDA08A64250DEFFBCADDEE00F8F25F", "-H", `Cookie: ${cookie}`]).toString();
  const j = JSON.parse(out);
  const d = j.data || j;
  const url = Array.isArray(d.url) ? d.url[0] : (d.url || d.play_url || d.play_backup_url || "");
  return url ? { url: String(url).replace(/\\\//g, "/"), priv: d.priv_status, q: d.quality } : null;
}

const [listFile, outDir] = process.argv.slice(2);
if (!listFile || !outDir) { console.error("用法: node kugou-v5-dl.js <list.json> <outDir>"); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

(async () => {
const songs = JSON.parse(fs.readFileSync(listFile, "utf8"));
let ok = 0; const failed = [];
for (const x of songs) {
  const t = x.title, a = (x.artist || "").split("/")[0];
  const kw = `${t} ${a}`.trim();
  console.log(`\n[?] ${kw}`);
  let lists = [];
  try { lists = searchSongs(kw); } catch (e) { console.log("  搜索失败:", e.message.slice(0, 80)); }
  const nt = norm(t), na = norm(a);
  const cand = lists.filter(r => norm(r.SongName || r.name || "").includes(nt)
    && (!na || norm(r.SingerName || r.singer || "").includes(na)))
    || [];
  let done = null;
  for (const r of (cand.length ? cand : lists).slice(0, 3)) {
    for (const c of qualityChain(r)) {
      try {
        const res = v5Gateway(c.hash, r.AlbumID || r.album_id || 0, r.MixSongID || r.Audioid || 0);
        if (!res || !res.url) continue;
        const ext = c.q === "flac" ? ".flac" : ".mp3";
        const fn = path.join(outDir, `${a} - ${t}${ext}`.trim());
        execFileSync("curl", ["-sS", "--max-time", "300", "-L", "-o", fn,
          "-H", "User-Agent: Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi", res.url],
          { maxBuffer: 300 * 1024 * 1024 });
        const sz = fs.existsSync(fn) ? fs.statSync(fn).size : 0;
        const magic = fs.readFileSync(fn).subarray(0, 4).toString();
        if (sz < 200000 || magic !== "fLaC") { console.log(`  ✗ ${c.q}: size=${sz} magic=${magic}`); continue; }
        done = { fn, q: c.q, size: sz };
        break;
      } catch (e) { console.log(`  ✗ ${c.q}:`, e.message.slice(0, 70)); }
    }
    if (done) break;
  }
  if (done) { ok++; console.log(`  ✓ ${path.basename(done.fn)} (${(done.size / 1048576).toFixed(1)}MB, ${done.q})`); }
  else { failed.push(kw); console.log("  ✗ 无可用无损源"); }
  await new Promise(r => setTimeout(r, 3000));
}
console.log(`\n完成: 成功 ${ok}, 失败 ${failed.length}`);
for (const f of failed) console.log("  缺:", f);
})();
