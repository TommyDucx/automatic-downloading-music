#!/usr/bin/env node
"use strict";
// 单曲恢复下载：宋雨琦 - Radio (Dum-Dum)（netease id 2685583481）
// 之前整批下载时该 id 的 url 解析接口 503 限流，这里单独带重试降级链重试。
const fs = require("fs");
const path = require("path");

const HOST = "music-api.gdstudio.xyz";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const API_HEADERS = {
  "User-Agent": UA,
  Accept: "application/json, text/javascript, */*; q=0.01",
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  "X-Requested-With": "XMLHttpRequest",
};

function pureCrc32(input) {
  let c = ~0 >>> 0;
  for (let i = 0; i < input.length; i++) {
    c ^= input.charCodeAt(i);
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
const crc32Hex = (input) => pureCrc32(input).toString(16).toUpperCase().padStart(8, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiCall(params, depth = 0) {
  const signInput = encodeURIComponent(String(params.id !== undefined ? params.id : params.name || ""));
  const s = crc32Hex(signInput);
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${encodeURIComponent(String(v))}`);
  }
  parts.push(`s=${s}`);
  const body = parts.join("&");
  const r = await fetch(`https://${HOST}/api.php`, { method: "POST", headers: API_HEADERS, body, signal: AbortSignal.timeout(60000) });
  const txt = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch {}
  return { status: r.status, json, raw: txt };
}

// 取流：从高码率往下试，遇到 503 / 空 url / br=-1 都退避重试（最多 5 轮）
async function resolveStream(id, src) {
  const BR_LADDER = [999, 740, 320];
  let lastErr = null;
  for (let round = 0; round < 5; round++) {
    for (const br of BR_LADDER) {
      try {
        const r = await apiCall({ types: "url", id, source: src, br });
        if (r.status === 503) {
          const cool = 8000 * Math.pow(2, Math.min(round, 3));
          console.log(`   [503] 限流，冷却 ${Math.round(cool / 1000)}s 后重试…`);
          lastErr = "503";
          await sleep(cool);
          break; // 跳出 br 循环，进入下一 round
        }
        const j = r.json;
        if (j && j.url && j.url !== "err" && j.br !== -1) {
          return { ...j, br: Number(j.br) > 0 ? Number(j.br) : br };
        }
        if (j && (j.br === -3 || j.br === -2)) {
          console.log(`   [${src}] br=${br} 无版权/试听受限，跳过`);
          continue;
        }
        // 空 url：可能是限流，退避后重试
        if (j && (!j.url || j.url === "err" || j.br === -1)) {
          console.log(`   [${src}] br=${br} 返回空 url（疑似限流），退避重试…`);
          lastErr = "empty";
          await sleep(6000 * Math.pow(2, Math.min(round, 3)));
          break;
        }
      } catch (e) {
        lastErr = e.message;
        console.log(`   [${src}] br=${br} 异常: ${e.message}，退避重试…`);
        await sleep(5000);
        break;
      }
    }
    if (lastErr === "503" || lastErr === "empty") {
      lastErr = null;
      continue; // 重新走 BR_LADDER
    }
    // 若某 br 成功返回了流，上面已 return
  }
  return null;
}

async function downloadFile(url, filePath) {
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(600000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
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

(async () => {
  const id = "2685583481";
  const src = "netease";
  const outDir = "/Volumes/My Passport/Music/03-宋雨琦-热门精选-Kpop";
  const file = path.join(outDir, "宋雨琦 - Radio.flac");
  console.log(`[i] 解析音流: netease id=${id}`);
  const stream = await resolveStream(id, src);
  if (!stream) {
    console.error("[x] 未能解析到可用音流（持续限流或地域限制）");
    process.exit(2);
  }
  console.log(`[i] 获得 URL (${stream.br || "?"}kbps): ${stream.url.split("?")[0].split("/").pop()}`);
  console.log(`[i] 下载到: ${file}`);
  const size = await downloadFile(stream.url, file);
  const magic = fs.readFileSync(file).subarray(0, 4).toString("ascii");
  if (!magic.startsWith("fLaC")) throw new Error(`魔数校验失败: ${JSON.stringify(magic)}`);
  console.log(`[+] 完成: ${file} (${Math.round(size / 1048576)}MB)`);
})().catch((e) => {
  console.error(`[!] ${e.stack || e.message}`);
  process.exit(1);
});
