"use strict";
// 酷狗概念版扫码登录（VIP）：web 签名 → v2/qrcode → 渲染二维码 → 轮询 v2/get_userinfo_qrcode → 保存 token/userid
// 平台：概念版 lite（appid=3116, clientver=11440, android 盐 LnT6xpN…, tracker 盐 185672dd…）
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const SALT_WEB = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";
const DEVICE_FILE = path.join(os.homedir(), ".kugou-downloader-device.json");
const AUTH_FILE = path.join(os.homedir(), ".kugou-vip-auth.json");

// 设备身份（与 kugou-downloader.js 共用同一 mid，风控粘性）
function loadDevice() {
  try {
    const d = JSON.parse(fs.readFileSync(DEVICE_FILE, "utf8"));
    if (d && d.mid) return d;
  } catch {}
  const d = { guid: crypto.randomUUID(), mid: md5(crypto.randomUUID()), createdAt: Date.now() };
  try { fs.writeFileSync(DEVICE_FILE, JSON.stringify(d, null, 2)); } catch {}
  return d;
}
const DEVICE = loadDevice();

// 概念版 lite 常量
const LITE_APPID = 3116, LITE_CLIENTVER = 11440, SRCAPPID = 2919;
const ANDROID_SALT_LITE = "LnT6xpN3khm36zse0QzvmgTZ3waWdRSA";
const TRACKER_SALT_LITE = "185672dd44712f60bb1736df5a377e82";

function webSign(params, data) {
  const s = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";
  const p = Object.keys(params).map(k => `${k}=${params[k]}`).sort().join("");
  return md5(`${s}${p}${data || ""}${s}`);
}
function androidSignLite(params, data) {
  const p = Object.keys(params).sort()
    .map(k => `${k}=${typeof params[k] === "object" ? JSON.stringify(params[k]) : params[k]}`)
    .join("");
  return md5(`${ANDROID_SALT_LITE}${p}${data || ""}${ANDROID_SALT_LITE}`);
}

function curlJson(url, method = "GET", body = null, extraHeaders = {}) {
  const args = ["-sS", "--max-time", "30", "-X", method, url,
    "-H", "User-Agent: Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi",
    "-H", "kg-rc: 1", "-H", "kg-thash: 5d816a0", "-H", "kg-rec: 1",
    "-H", "kg-rf: B9EDA08A64250DEFFBCADDEE00F8F25F"];
  for (const [k, v] of Object.entries(extraHeaders)) { args.push("-H", `${k}: ${v}`); }
  if (body) { args.push("-H", "Content-Type: application/json"); args.push("--data", body); }
  const out = execFileSync("curl", args, { maxBuffer: 20 * 1024 * 1024 }).toString();
  try { return JSON.parse(out); } catch { throw new Error("非JSON响应: " + out.slice(0, 200)); }
}

function buildDefaultParams(auth) {
  return {
    dfid: "-", mid: DEVICE.mid, uuid: "-",
    appid: LITE_APPID, clientver: LITE_CLIENTVER,
    clienttime: Math.floor(Date.now() / 1000),
    token: auth?.token || "", userid: auth?.userid || 0,
  };
}
function signedUrl(baseURL, urlPath, moduleParams, auth, extraDefault) {
  const params = Object.assign(buildDefaultParams(auth), moduleParams, extraDefault || {});
  params["signature"] = webSign(params, "");
  const qs = Object.keys(params).map(k => `${k}=${encodeURIComponent(String(params[k]))}`).join("&");
  return `${baseURL}${urlPath}?${qs}`;
}

(async () => {
  // 已有有效凭证则直接退出
  if (fs.existsSync(AUTH_FILE)) {
    const a = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    if (a.token && a.userid) { console.log("已有凭证:", a.userid); process.exit(0); }
  }

  // 1) 生成二维码 key
  const qrParams = {
    appid: 1001, type: 1, plat: 4, srcappid: SRCAPPID,
    qrcode_txt: `https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=${LITE_APPID}&`,
  };
  const qrUrl = signedUrl("https://login-user.kugou.com", "/v2/qrcode", qrParams, null,
    { clienttime: Math.floor(Date.now() / 1000) });
  const qrResp = curlJson(qrUrl);
  console.log("qrcode 响应:", JSON.stringify(qrResp).slice(0, 400));
  const data = qrResp.data || qrResp;
  const qrcodeKey = data.qrcode || data.qrcode_key || "";
  const qrImgB64 = (data.qrcode_img || "").replace(/^data:image\/png;base64,/, "");
  if (!qrcodeKey || !qrImgB64) { console.log("未拿到二维码 key"); process.exit(1); }

  // 2) 保存官方二维码 PNG（供手机酷狗概念版扫码）
  fs.writeFileSync("/tmp/kugou-login-qr.png", Buffer.from(qrImgB64, "base64"));
  console.log("QR 图片: /tmp/kugou-login-qr.png");

  // 3) 轮询授权状态（最多 10 分钟）
  for (let i = 0; i < 150; i++) {
    await new Promise(r => setTimeout(r, 4000));
    let resp;
    try {
      const checkParams = { plat: 4, appid: LITE_APPID, srcappid: SRCAPPID, qrcode: qrcodeKey };
      const url = signedUrl("https://login-user.kugou.com", "/v2/get_userinfo_qrcode", checkParams, null,
        { clienttime: Math.floor(Date.now() / 1000) });
      resp = curlJson(url);
    } catch (e) { console.log("poll err:", e.message.slice(0, 80)); continue; }
    const st = resp.data?.status ?? resp.status;
    if (st === 1) { if (i % 5 === 0) console.log("等待扫码…"); continue; }
    if (st === 2) { console.log("已扫码，等待手机确认…"); continue; }
    if (st === 4) {
      const d = resp.data;
      console.log("授权成功! userid:", d.userid, " token:", (d.token || "").slice(0, 12) + "…");
      console.log("登录响应全字段:", JSON.stringify(d).slice(0, 600));
      fs.writeFileSync(AUTH_FILE, JSON.stringify({
        token: d.token, userid: d.userid,
        mid: DEVICE.mid, dfid: "-", 
        vip_token: d.vip_token || "", vip_type: d.vip_type || 0,
        raw: d,
      }, null, 2));
      console.log("凭证已保存:", AUTH_FILE);
      process.exit(0);
    }
    console.log("状态", st, JSON.stringify(resp).slice(0, 200));
  }
  console.log("轮询超时（二维码过期）");
  process.exit(3);
})();
