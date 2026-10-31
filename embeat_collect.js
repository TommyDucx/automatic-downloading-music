"use strict";
// Embeat 种子歌推荐收集：5 首安静纯音乐种子 → embeat_by_track
// 启动策略：真无头 → open -j 隐藏实例（CF 严打时段的备胎）
const { spawn, execFileSync } = require("child_process");
const http = require("http");
const fs = require("fs");
function httpGetJson(url){ return new Promise((res,rej)=>{ http.get(url, r=>{ let d=""; r.on("data",c=>d+=c); r.on("end",()=>{ try{res(JSON.parse(d));}catch(e){rej(new Error(d.slice(0,150)));} }); }).on("error",rej); }); }
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const SEEDS = [
  {name:"いのちの名前", artist:"広橋真紀子"},
  {name:"Merry Christmas Mr. Lawrence", artist:"坂本龍一"},
  {name:"三葉のテーマ", artist:"RADWIMPS"},
  {name:"opus", artist:"坂本龍一"},
  {name:"IF YOU", artist:"BIGBANG"},
];
const PORT = 9336;
const PROFILE = process.env.GD_PROFILE || "/tmp/gd-embeat-collect";
const ARGS = ["--remote-debugging-port="+PORT,"--user-data-dir="+PROFILE,
  "--no-first-run","--no-default-browser-check","--no-sandbox","--disable-gpu","--disable-dev-shm-usage","about:blank"];

let child = null;
async function waitPort(ms){ for (let i=0;i<Math.floor(ms/500);i++){ try { const t = await httpGetJson(`http://127.0.0.1:${PORT}/json/list`); if (t && t.length) return t; } catch {} await sleep(500); } return null; }
async function passChallenge(evl, send, polls){
  await send("Page.enable");
  await send("Page.navigate",{url:"https://music.gdstudio.org/"});
  for (let i=0;i<polls;i++){ await sleep(5000); const t = await evl("typeof crc32 + '|' + document.title"); if (i%4===0) console.log("["+i+"] "+String(t).slice(0,55)); if (String(t).startsWith("function")) return true; }
  return false;
}
async function attachAndRun() {
  const targets = await waitPort(30000);
  if (!targets) throw new Error("调试端口未就绪");
  const page = targets.find(t=>t.type==="page") || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ ws.onopen=res; ws.onerror=rej; });
  let id=0; const pend=new Map();
  ws.onmessage = ev => { const m=JSON.parse(ev.data); if (m.id && pend.has(m.id)){ pend.get(m.id)(m); pend.delete(m.id);} };
  const send=(method,params={})=>new Promise((res,rej)=>{ const i=++id; pend.set(i,res); ws.send(JSON.stringify({id:i,method,params})); setTimeout(()=>{ if(pend.has(i)){pend.delete(i);rej(new Error("timeout "+method));} }, 45000); });
  const evl = async (expr) => { const r = await send("Runtime.evaluate",{expression:expr,awaitPromise:true,returnByValue:true}); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description||"").slice(0,150)); return r.result?.result?.value; };
  if (!(await passChallenge(evl, send, 14))) return false;
  const out = [];
  for (const seed of SEEDS) {
    const payload = JSON.stringify({name: seed.name, artist: seed.artist, id: "", isrc: ""});
    const nameJson = JSON.stringify(payload);
    const expr = "(async()=>{ const d=encodeURIComponent(" + nameJson + "); const r=await fetch('/api.php?types=embeat_by_track&count=15&source=netease&pages=1&name='+d+'&s='+crc32(String(d)),{headers:{'X-Requested-With':'XMLHttpRequest'}}); const b=await r.text(); return JSON.stringify({st:r.status, body:b.slice(0,5000)}); })()";
    const r = JSON.parse(await evl(expr));
    console.log(`== ${seed.name} → HTTP ${r.st}`);
    let arr = []; try { arr = JSON.parse(r.body); } catch { console.log("  非JSON:", r.body.slice(0,100)); }
    for (const t of arr) {
      const artist = typeof t.artist === "string" ? t.artist : (t.artist||[]).join(", ");
      out.push({ seed: seed.name, id: t.id, name: t.name, artist, album: t.album, source: "netease", duration: t.duration, isrc: t.isrc || "" });
    }
    await sleep(3000);
  }
  fs.writeFileSync("/tmp/embeat_recs.json", JSON.stringify(out, null, 1));
  console.log("共收集推荐:", out.length, "条 → /tmp/embeat_recs.json");
  return true;
}
(async () => {
  // 模式一：真无头
  child = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", ...ARGS], { stdio: "ignore" });
  try {
    if (await waitPort(20000)) {
      try { if (await attachAndRun()) { child.kill("SIGKILL"); process.exit(0); } }
      catch (e) { console.log("无头模式异常:", e.message.slice(0,100)); }
    }
    // 模式二：open -j 隐藏实例
    console.log("无头未过 → 换 open -j 隐藏实例…");
    try { child.kill("SIGKILL"); } catch {}
    await sleep(2000);
    execFileSync("open", ["-n","-j","-g","-a","Google Chrome.app","--args", ...ARGS]);
    if (!(await waitPort(30000))) throw new Error("隐藏实例端口未就绪");
    const done = await attachAndRun();
    if (!done) { console.log("隐藏实例也未通过挑战"); process.exit(2); }
    process.exit(0);
  } finally { try { child.kill("SIGKILL"); } catch {} try { execFileSync("pkill", ["-f", "user-data-dir="+PROFILE]); } catch {} }
})().catch(e=>{ console.error("ERR:", e.message); process.exit(1); });
