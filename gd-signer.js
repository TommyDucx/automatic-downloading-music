#!/usr/bin/env node
/**
 * GD音乐台离线签名器（供 gd-browser-downloader.js --direct 与 emb eat-recommend.js 共用）
 *
 * 原理（2026-09-30 实测打通）：
 *   站点签名函数 crc32() 定义在 js/crc32.min.js（前端 JS）。把它放进 Node vm，
 *   配好 shims（location.hostname / mkPlayer.version / FakeXHR 返回 /time）即可现算签名：
 *     s = crc32(encodeURIComponent(主参数))     // 主参数 = name 或 id
 *   签名输入实际为 `ts9|hostname|version|入参` 经站点改造版 MD5 取后 8 位——内核无法离线复刻，
 *   但站点自己的函数可以拿来即用（与 GDSTUDIO_REFERENCE.md 技巧 A 相同）。
 *
 * 注意：
 *   - HTTP 一律走系统 curl：Node 内置 fetch/undici 的 TLS 指纹会被站点 WAF 拦，curl 不会；
 *   - /time shim 用本机当前时间（签名只取 10 位秒级时间戳的前 9 位，10 秒粒度；本机时钟准确即可）；
 *   - mkPlayer.version 每次从 js/player.js 动态解析，站点升级自动跟随；
 *   - crc32.min.js 缓存于 .gd-flac-cache/crc32-<host>.js，签名被拒时 fresh=true 强制刷新。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const CACHE_DIR = path.join(__dirname, ".gd-flac-cache");

/** 带浏览器 UA 的 curl GET（超时/失败抛错，返回响应文本） */
function curlText(url, timeoutSec = 30) {
  const r = spawnSync(
    "curl",
    ["-sS", "--max-time", String(timeoutSec), "-A", UA, "-H", "X-Requested-With: XMLHttpRequest", url],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  if (r.status !== 0) throw new Error(`curl 失败(退出 ${r.status}): ${String(r.stderr || "").slice(0, 160)}`);
  return r.stdout;
}

/**
 * 为 host 装载签名器。返回 { version, sign(input) -> 8位大写签名 }
 * @param {string} host  如 music.gdstudio.xyz / music.gdstudio.org
 * @param {{fresh?: boolean, cacheDir?: string}} [opts] fresh=true 时丢弃缓存重新拉 crc32.min.js
 */
function loadSigner(host, opts = {}) {
  const fresh = !!opts.fresh;
  const cacheDir = opts.cacheDir || CACHE_DIR;
  const cacheFile = path.join(cacheDir, `crc32-${host}.js`);
  if (fresh) { try { fs.unlinkSync(cacheFile); } catch {} }

  // mkPlayer.version：2026.09.25 → 站点内部拼成 20260925（每段补零 2 位）
  let version = null;
  try {
    const playerJs = curlText(`https://${host}/js/player.js`);
    version = (playerJs.match(/version:"([^"]+)"/) || [])[1] || null;
  } catch {}

  let code = null;
  try {
    if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 1000) code = fs.readFileSync(cacheFile, "utf8");
  } catch {}
  if (!code) {
    code = curlText(`https://${host}/js/crc32.min.js`);
    if (code && code.length > 1000) {
      try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(cacheFile, code); } catch {}
    }
  }
  if (!code || code.length < 1000) throw new Error("crc32.min.js 拉取失败");

  const ctx = {
    console, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
    setTimeout, clearTimeout, setInterval, clearInterval, isNaN, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent, unescape, escape, atob, btoa,
    location: { hostname: host, href: `https://${host}/`, protocol: "https:" },
    // FakeXHR：站点用它将 GET /time 填充为服务器时间；用本机当前秒级时间戳即可
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
  if (version) ctx.mkPlayer = { version };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  if (typeof ctx.crc32 !== "function") throw new Error("crc32.min.js 未暴露 crc32()");

  return {
    version: version || "(unknown)",
    sign: (input) => ctx.crc32(input),
  };
}

module.exports = { loadSigner, curlText, UA, CACHE_DIR };
