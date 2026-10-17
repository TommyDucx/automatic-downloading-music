/**
 * GD 音乐台音源插件（EchoMusic）
 *
 * 作用
 *   EchoMusic 的播放音源只有酷狗。酷狗 VIP / 无版权曲目在 `catalog` 阶段解析失败后，
 *   本插件在 `after-catalog` 阶段接管，改用 GD 音乐台的聚合音源（网易云 / QQ / 酷我 /
 *   Tidal / Apple / YouTube Music / Bilibili）取一个可播放地址。
 *   也可切换成「优先」模式，在 `before-catalog` 阶段先走 GD。
 *
 * 取流链路（2026-10-17 实测打通）
 *   1. GET https://<host>/js/player.js        → 取 mkPlayer.version（站点版本串）
 *   2. GET https://<host>/js/crc32.min.js     → 站点自己的签名函数
 *   3. 把签名脚本放进一个 Proxy + with 的伪全局里执行，拿到 crc32(input)
 *      —— 站点把「10 位秒级时间戳前 9 位 | hostname | version | 入参」喂给被改造过的 MD5，
 *         内核无法离线复刻，所以只能用它自己的函数（GDSTUDIO_REFERENCE.md 技巧 A）。
 *   4. GET /api.php?types=search&...&s=crc32(encodeURIComponent(name))
 *      GET /api.php?types=url&source=..&id=..&br=..&s=crc32(encodeURIComponent(id))
 *   5. 用 size/br 反推实际时长，与 track.duration 交叉校验，避免匹配到翻唱 / Live
 *
 * 注意
 *   - 站点的 WAF 对 TLS 指纹敏感，插件里不能起 curl，所以网络一律走
 *     `ctx.net.request`（主进程 Node HTTP），不用浏览器 fetch（会被 CORS 拦）。
 *   - 站点限流口径约 50 次 / 5 分钟，这里用串行队列 + 缓存把请求压到最低：
 *     搜索结果缓存 30 分钟，播放地址缓存 20 分钟（地址本身有时效）。
 *   - 站点的 `cache_sources`（apple / ytmusic / bilibili）会返回相对路径，
 *     需要补 `https://<host>/` 前缀。
 */

const LOG_TAG = "[gdstudio]";

const HOSTS = {
  org: "music.gdstudio.org",
  xyz: "music.gdstudio.xyz",
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

/** org 站点当前支持的音源（实测 2026-10-17；migu/kugou/spotify/deezer/ximalaya 返回 source not supported） */
const SOURCE_CATALOG = [
  { id: "tencent", label: "QQ 音乐" },
  { id: "kuwo", label: "酷我" },
  { id: "netease", label: "网易云" },
  { id: "tidal", label: "Tidal" },
  { id: "apple", label: "Apple Music" },
  { id: "ytmusic", label: "YouTube Music" },
  { id: "bilibili", label: "Bilibili" },
  { id: "joox", label: "JOOX" },
];

const SOURCE_IDS = SOURCE_CATALOG.map((item) => item.id);

const DEFAULT_SETTINGS = {
  /** off | fallback（酷狗失败后兜底） | prefer（先走 GD） */
  mode: "fallback",
  site: "org",
  /** 音源优先级，越靠前越先尝试 */
  sources: ["tencent", "kuwo", "netease"],
  /** 最高音质档位：999=24bit FLAC，740=16bit FLAC，320/128=有损 */
  maxBr: "999",
  /** 匹配分阈值（0~1），低于该值视为没找到同一首歌 */
  minScore: 0.55,
  /** 取流前最多比较几个候选 */
  maxCandidates: 3,
};

const STORAGE_KEY = "settings";
const SIGNER_STORAGE_KEY = "signer";
const SEARCH_TTL_MS = 30 * 60 * 1000;
const URL_TTL_MS = 20 * 60 * 1000;
const REQUEST_GAP_MS = 300;

/* ------------------------------------------------------------------ *
 * 文本归一化与相似度
 * ------------------------------------------------------------------ */

/** 常用繁体 → 简体（JOOX / 部分港台曲目返回繁体，不归一会被判成「歌手不符」） */
const T2S_PAIRS =
  "週周 傑杰 倫伦 陳陈 張张 學学 愛爱 夢梦 憶忆 記记 願愿 時时 間间 開开 關关 們们 這这 " +
  "說说 話话 聽听 見见 後后 來来 裡里 麼么 與与 為为 對对 錯错 過过 還还 進进 遠远 邊边 " +
  "讓让 從从 經经 歷历 無无 數数 億亿 萬万 點点 線线 體体 溫温 風风 雲云 傷伤 戀恋 樂乐 " +
  "陽阳 陰阴 舊旧 紅红 綠绿 藍蓝 黃黄 塵尘 響响 親亲 輕轻 轉转 載载 車车 連连 運运 長长 " +
  "門门 訊讯 誰谁 請请 謝谢 詩诗 詞词 語语 讀读 變变 豐丰 貝贝 質质 買买 賣卖 貴贵 賽赛 " +
  "讚赞 趕赶 蹟迹 農农 遙遥 適适 選选 鄰邻 釋释 鐘钟 鏡镜 鋼钢 錄录 鍵键 閃闪 際际 隨随 " +
  "險险 隱隐 雖虽 雙双 雜杂 雞鸡 離离 難难 電电 靈灵 靜静 頁页 頂顶 項项 順顺 須须 預预 " +
  "領领 頭头 題题 額额 顏颜 類类 顯显 飛飞 飯饭 飲饮 養养 馬马 驗验 騎骑 驚惊 髮发 鬥斗 " +
  "魚鱼 鳥鸟 鳳凤 麗丽 齊齐 龍龙 給给 緣缘 織织 純纯 紙纸 細细 終终 結结 絕绝 統统 絲丝 " +
  "綁绑 網网 緊紧 緒绪 編编 練练 縮缩 總总 繼继 續续 讓让 妳你 牠它 壞坏 夢梦 灑洒 籤签 " +
  "鬆松 嘆叹 嚇吓 嗎吗 呢呢 吧吧 呀呀 哦哦 喔喔 嘻戏 鬧闹 巖岩 場场 塵尘 牆墙 釣钓 餵喂 " +
  "嚮向 儘尽 佔占 傢家 兇凶 剋克 捲卷 掛挂 採采 揹背 撐撑 潑泼 燦灿 爛烂 瘋疯 癡痴 盪荡 " +
  "睜睁 瞭了 礙碍 祕秘 穀谷 窩窝 竪竖 筆笔 筍笋 紮扎 絃弦 緋绯 纔才 翹翘 聳耸 膩腻 薑姜 " +
  "蘇苏 蘿萝 蝦虾 蠟蜡 衹只 襯衬 覓觅 認认 誕诞 誇夸 誌志 謊谎 譜谱 豔艳 貓猫 賦赋 趕赶 " +
  "蹤踪 軌轨 軒轩 迴回 遙遥 醜丑 釀酿 鋪铺 錯错 鍊链 鑽钻 闆板 陣阵 霧雾 靦腆 韻韵 顆颗 " +
  "颱台 飽饱 餅饼 駕驾 驕骄 髒脏 鬱郁 魂魂 鳴鸣 鴻鸿 鵝鹅 麥麦 黴霉 齒齿 龐庞";

const T2S = (() => {
  const map = Object.create(null);
  for (const chunk of T2S_PAIRS.split(/\s+/)) {
    if (chunk.length < 2) continue;
    // 逐对处理，允许一段里连续写多对
    for (let i = 0; i + 1 < chunk.length; i += 2) {
      map[chunk[i]] = chunk[i + 1];
    }
  }
  return map;
})();

const toSimplified = (text) =>
  String(text || "")
    .split("")
    .map((ch) => T2S[ch] || ch)
    .join("");

const PUNCT_RE =
  /[\s\u3000\-_·・.,，。!！?？'"“”‘’`()（）\[\]【】{}<>《》~～&＆/\\|:：;；+＋=＝*#@%^]+/g;

const normalizeText = (text) =>
  toSimplified(String(text || "").normalize("NFKC"))
    .toLowerCase()
    .replace(PUNCT_RE, "");

const VERSION_WORDS = [
  ["live", /(live|现场|演唱會|演唱会)/i],
  ["remix", /(remix|混音|dj版|翻自)/i],
  ["instrumental", /(instrumental|伴奏|纯音乐|off ?vocal|karaoke)/i],
  ["cover", /(cover|翻唱)/i],
  ["acoustic", /(acoustic|不插电)/i],
];

const versionTags = (text) => {
  const raw = String(text || "");
  const tags = new Set();
  for (const [tag, re] of VERSION_WORDS) if (re.test(raw)) tags.add(tag);
  return tags;
};

/** 归一化后的二元组 Dice 系数，0~1 */
const diceCoefficient = (a, b) => {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bigrams = new Map();
  for (let i = 0; i < a.length - 1; i += 1) {
    const gram = a.slice(i, i + 2);
    bigrams.set(gram, (bigrams.get(gram) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const gram = b.slice(i, i + 2);
    const left = bigrams.get(gram) || 0;
    if (left > 0) {
      bigrams.set(gram, left - 1);
      hits += 1;
    }
  }
  return (2 * hits) / (a.length - 1 + (b.length - 1));
};

const similarity = (a, b) => {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    const ratio = Math.min(left.length, right.length) / Math.max(left.length, right.length);
    return 0.72 + 0.22 * ratio;
  }
  return diceCoefficient(left, right);
};

const ARTIST_SPLIT_RE = /[、,，&;；/]|\bfeat\.?\b|\bft\.?\b/i;
const artistList = (value) =>
  (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item || "").split(ARTIST_SPLIT_RE))
    .map((item) => normalizeText(item))
    .filter(Boolean);

const artistSimilarity = (a, b) => {
  const left = artistList(a);
  const right = artistList(b);
  if (!left.length || !right.length) return 0;
  let best = 0;
  for (const one of left) {
    for (const two of right) {
      if (one === two) return 1;
      const score = one.includes(two) || two.includes(one) ? 0.85 : diceCoefficient(one, two);
      if (score > best) best = score;
    }
  }
  return best;
};

/** 打分：0~1，低于阈值视为不是同一首 */
const scoreCandidate = (track, candidate) => {
  const titleScore = similarity(track.title || track.name, candidate.name);
  const artists = candidate.artist ?? candidate.artists ?? candidate.singer;
  const artistScore = artistSimilarity(track.artist || track.artists || track.singer, artists);

  let score = titleScore * 0.68 + artistScore * 0.32;

  // 专辑名作为弱信号，只在曲名/歌手都一般时起作用
  const trackAlbum = track.albumName || track.album;
  if (score < 0.9 && trackAlbum && candidate.album) {
    score += similarity(trackAlbum, candidate.album) * 0.03;
  }

  // 版本感知：查询没写 Live/Remix，候选带 → 重罚（防止下到现场版 / 翻唱）
  const wantTags = versionTags(`${track.title || ""} ${track.albumName || track.album || ""}`);
  const gotTags = versionTags(`${candidate.name || ""} ${candidate.album || ""}`);
  for (const tag of gotTags) {
    if (!wantTags.has(tag)) score -= tag === "cover" ? 0.5 : 0.38;
  }
  for (const tag of wantTags) {
    if (!gotTags.has(tag)) score -= 0.08;
  }

  return Math.max(0, Math.min(1, score));
};

/* ------------------------------------------------------------------ *
 * 签名器：在伪全局里跑站点自己的 crc32.min.js
 * ------------------------------------------------------------------ */

const buildSandboxSigner = (code, host, version) => {
  const store = Object.create(null);
  const fakeXhr = class FakeXMLHttpRequest {
    constructor() {
      this.readyState = 0;
      this.status = 0;
      this.responseText = "";
    }
    open(_method, url) {
      this._url = url;
    }
    setRequestHeader() {}
    send() {
      const self = this;
      setTimeout(() => {
        self.readyState = 4;
        self.status = 200;
        self.responseText = String(Math.floor(Date.now() / 1000));
        try {
          self.onreadystatechange?.();
        } catch {}
        try {
          self.onload?.();
        } catch {}
      }, 0);
    }
  };

  store.location = {
    hostname: host,
    host: host,
    href: `https://${host}/`,
    origin: `https://${host}`,
    protocol: "https:",
    pathname: "/",
  };
  store.document = {
    location: store.location,
    cookie: "",
    referrer: "",
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    getElementsByTagName: () => [],
  };
  store.navigator = { userAgent: UA, platform: "MacIntel", language: "zh-CN" };
  store.XMLHttpRequest = fakeXhr;
  store.mkPlayer = { version: version || "0" };

  let proxy = null;
  proxy = new Proxy(store, {
    has: () => true,
    get(target, key) {
      if (key === Symbol.unscopables) return undefined;
      if (key in target) return target[key];
      if (key === "window" || key === "globalThis" || key === "self" || key === "top") return proxy;
      return globalThis[key];
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });

  // with + has:true 的代理：站点脚本里任何未声明的标识符都会先落到 store，
  // 缺失的再从真实 globalThis 兜底，因此站点升级新增依赖也不会立刻炸。
  const body = `with (sandbox) {\n${code}\nreturn typeof crc32 === "function" ? crc32 : null;\n}`;
  const factory = new Function("sandbox", body);
  const crc32 = factory(proxy);
  if (typeof crc32 !== "function") throw new Error("crc32.min.js 没有暴露 crc32()");
  return (input) => crc32(String(input));
};

/* ------------------------------------------------------------------ *
 * 运行时
 * ------------------------------------------------------------------ */

const createRuntime = (ctx, getSettings) => {
  const searchCache = new Map();
  const urlCache = new Map();
  const signerCache = new Map();
  let queueTail = Promise.resolve();
  let lastRequestAt = 0;

  const log = (...args) => {
    if (getSettings().verbose) console.log(LOG_TAG, ...args);
  };

  const warn = (...args) => console.warn(LOG_TAG, ...args);

  /** 串行发送，保证不会瞬间打爆站点限流 */
  const enqueue = (task) => {
    const run = queueTail.then(async () => {
      const wait = REQUEST_GAP_MS - (Date.now() - lastRequestAt);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastRequestAt = Date.now();
      return task();
    });
    queueTail = run.catch(() => {});
    return run;
  };

  const fetchText = async (url, timeoutMs = 15000) => {
    const response = await ctx.net.request({
      url,
      method: "GET",
      responseType: "text",
      timeoutMs,
      headers: {
        "User-Agent": UA,
        "X-Requested-With": "XMLHttpRequest",
        Accept: "*/*",
      },
    });
    const { status, data } = response;
    if (status < 200 || status >= 300) {
      throw new Error(`HTTP ${status} ${String(data || "").slice(0, 120)}`);
    }
    return String(data ?? "");
  };

  const currentHost = () => HOSTS[getSettings().site] || HOSTS.org;

  const getSigner = async (force = false) => {
    const host = currentHost();
    const cached = signerCache.get(host);
    if (!force && cached) return cached;

    const saved = !force ? await ctx.storage.get(SIGNER_STORAGE_KEY).catch(() => null) : null;
    if (
      saved &&
      saved.host === host &&
      typeof saved.code === "string" &&
      saved.code.length > 1000 &&
      Date.now() - Number(saved.savedAt || 0) < 12 * 3600 * 1000
    ) {
      try {
        const sign = buildSandboxSigner(saved.code, host, saved.version);
        const entry = { host, version: saved.version, sign };
        signerCache.set(host, entry);
        return entry;
      } catch (error) {
        warn("缓存签名器不可用，重新拉取", error);
      }
    }

    const playerJs = await fetchText(`https://${host}/js/player.js`).catch(() => "");
    const version = (playerJs.match(/version:"([^"]+)"/) || [])[1] || "0";
    const code = await fetchText(`https://${host}/js/crc32.min.js`);
    if (!code || code.length < 1000) throw new Error("crc32.min.js 拉取失败");

    const sign = buildSandboxSigner(code, host, version);
    const entry = { host, version, sign };
    signerCache.set(host, entry);
    await ctx.storage
      .set(SIGNER_STORAGE_KEY, { host, version, code, savedAt: Date.now() })
      .catch(() => {});
    log("签名器就绪", host, version);
    return entry;
  };

  /**
   * 站点签名：s = crc32(encodeURIComponent(主参数))
   * 主参数：search/embeat 用 name，url/pic/lyric 用 id
   * 注意：入参必须「只编码一次」，且查询串里直接用编码后的值，不能再次编码。
   */
  const apiCall = async (params, primaryParam, primaryValue, options = {}) => {
    const attempt = async (force) => {
      const { host, sign } = await getSigner(force);
      const encoded = encodeURIComponent(String(primaryValue ?? ""));
      const pairs = [];
      for (const [key, value] of Object.entries(params)) {
        const raw = String(value);
        pairs.push(`${key}=${key === primaryParam ? encoded : encodeURIComponent(raw)}`);
      }
      pairs.push(`s=${sign(encoded)}`);
      const url = `https://${host}/api.php?${pairs.join("&")}`;
      const text = await enqueue(() => fetchText(url, options.timeoutMs || 15000));
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      if (data && typeof data === "object" && !Array.isArray(data) && data.detail) {
        const detail = String(data.detail);
        if (/invalid request|signature/i.test(detail)) {
          const error = new Error(`签名被拒: ${detail}`);
          error.signatureRejected = true;
          throw error;
        }
        const error = new Error(detail);
        error.business = true;
        throw error;
      }
      return { data, host };
    };

    try {
      return await attempt(false);
    } catch (error) {
      if (!error?.signatureRejected) throw error;
      log("签名被拒，刷新 crc32.min.js 重试一次");
      return attempt(true);
    }
  };

  const search = async (keyword, source, count = 12) => {
    const key = `${source}|${keyword}`;
    const hit = searchCache.get(key);
    if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.list;
    const { data } = await apiCall(
      { types: "search", count, source, pages: 1, name: keyword },
      "name",
      keyword,
    );
    const list = Array.isArray(data) ? data : [];
    if (list.length) searchCache.set(key, { at: Date.now(), list });
    return list;
  };

  const brChain = (requestedQuality) => {
    const settings = getSettings();
    const cap = Number(settings.maxBr) || 999;
    let preferred = ["999", "740", "320", "128"];
    if (requestedQuality === "320") preferred = ["320", "128"];
    else if (requestedQuality === "128") preferred = ["128"];
    const chain = preferred.filter((br) => Number(br) <= cap);
    return chain.length ? chain : [String(cap)];
  };

  const resolveUrl = async (source, id, br) => {
    const key = `${source}|${id}|${br}`;
    const hit = urlCache.get(key);
    if (hit && Date.now() - hit.at < URL_TTL_MS) return hit.value;
    const { data, host } = await apiCall(
      { types: "url", source, id, br },
      "id",
      String(id),
    );
    if (!data || typeof data !== "object" || !data.url) return null;
    let url = String(data.url);
    if (!/^https?:\/\//i.test(url)) url = `https://${host}/${url.replace(/^\/+/, "")}`;
    const value = {
      url,
      br: Number(data.br) || Number(br) || 0,
      size: Number(data.size) || 0,
      source,
    };
    urlCache.set(key, { at: Date.now(), value });
    return value;
  };

  /**
   * 站点返回的 `br` 是**标称档位**（999/740/320），不是真实码率——
   * 实测同一首《晴天》999 档 `br=999`，但 55MB/269s ≈ 1647kbps。
   * 所以真实码率只能用 size 和播放器已知时长反推：bitrate = size*8/duration。
   * 各档位的合理码率区间（用于识别「标称无损、实际是有损」或「拿错版本」）：
   */
  const BR_BANDS = {
    999: [420, 4600],
    740: [330, 3000],
    320: [230, 400],
    256: [190, 340],
    128: [88, 175],
  };

  const inspectValue = (value, requestedBr, trackDuration) => {
    const nominal = Number(value?.br) || Number(requestedBr) || 0;
    if (!value?.size || !trackDuration) return { ok: true, actualBr: nominal };
    const actualBr = Math.round((value.size * 8) / trackDuration / 1000);
    const band = BR_BANDS[String(requestedBr)] || [64, 5000];
    return { ok: actualBr >= band[0] && actualBr <= band[1], actualBr };
  };

  /**
   * 给定一首歌，找到可播放地址。
   * 策略：按音源优先级逐个搜索 → 该源内按匹配分降序尝试 → 每档音质都做「真实码率」校验。
   * 命中可靠（≥0.9）就不再打后面的源，省配额也省时间。
   * 返回 { url, quality, source, br, score } 或 null
   */
  const resolveTrack = async (track, quality) => {
    const settings = getSettings();
    const title = String(track.title || track.name || "").trim();
    if (!title) return null;
    const artist = String(track.artist || "").split(ARTIST_SPLIT_RE)[0] || "";
    // 站点 WAF 对 ' * ( ) 敏感（见 SKILL.md「假限流」），查询前先清洗
    const clean = (text) => text.replace(/['*()\[\]（）]/g, " ").replace(/\s+/g, " ").trim();
    const keyword = clean(`${title} ${artist}`).trim() || clean(title);
    const trackDuration = Number(track.duration) || 0;

    const configured = (settings.sources || []).filter((id) => SOURCE_IDS.includes(id));
    const orderedSources = configured.length ? configured : DEFAULT_SETTINGS.sources;
    const minScore = Number(settings.minScore) || DEFAULT_SETTINGS.minScore;
    const limit = Math.max(1, Number(settings.maxCandidates) || 3);
    const budgetMs = 8000;
    const startedAt = Date.now();

    const tryCandidate = async (candidate) => {
      for (const br of brChain(quality)) {
        let value = null;
        try {
          value = await resolveUrl(candidate.source, candidate.item.id, br);
        } catch (error) {
          if (error?.business) break; // 该源不支持该档位，别再降档重试
          warn(`取流失败 ${candidate.source}/${candidate.item.id}`, error?.message || error);
          break;
        }
        if (!value?.url) continue;

        const { ok, actualBr } = inspectValue(value, br, trackDuration);
        if (!ok) {
          log(`码率不符 band=${br} 实际≈${actualBr}kbps「${candidate.item.name}」`);
          continue; // 换下一档
        }
        return {
          url: value.url,
          br: actualBr,
          size: value.size,
          source: candidate.source,
          score: candidate.score,
          actualBr,
        };
      }
      return null;
    };

    for (const source of orderedSources) {
      if (Date.now() - startedAt > budgetMs) break;

      let list = [];
      try {
        list = await search(keyword, source);
      } catch (error) {
        warn(`搜索失败 ${source}`, error?.message || error);
        continue;
      }
      if (!list.length) continue;

      const ranked = list
        .map((item) => ({ source, item, score: scoreCandidate(track, item) }))
        .sort((a, b) => b.score - a.score);

      for (const candidate of ranked.slice(0, limit)) {
        if (candidate.score < minScore) break;
        const hit = await tryCandidate(candidate);
        if (hit) return hit;
        if (Date.now() - startedAt > budgetMs) break;
      }
    }

    return null;
  };

  const qualityLabel = (br) => (br >= 600 ? "flac" : br >= 250 ? "320" : "128");

  /** 诊断：逐个音源探一次，供设置面板「测试」按钮使用 */
  const diagnose = async (keyword, sources) => {
    const rows = [];
    const probe = sources?.length ? sources : DEFAULT_SETTINGS.sources;
    for (const source of probe) {
      const startedAt = Date.now();
      try {
        const list = await search(keyword, source, 5);
        const first = list[0];
        rows.push({
          source,
          ok: list.length > 0,
          count: list.length,
          sample: first ? `${first.name} — ${(first.artist || []).join("/")}` : "",
          ms: Date.now() - startedAt,
        });
      } catch (error) {
        rows.push({
          source,
          ok: false,
          count: 0,
          sample: String(error?.message || error),
          ms: Date.now() - startedAt,
        });
      }
    }
    return rows;
  };

  return {
    log,
    warn,
    search,
    resolveUrl,
    resolveTrack,
    diagnose,
    qualityLabel,
    clearCache: () => {
      searchCache.clear();
      urlCache.clear();
      signerCache.clear();
    },
  };
};

/* ------------------------------------------------------------------ *
 * 设置
 * ------------------------------------------------------------------ */

const mergeSettings = (saved) => {
  const merged = { ...DEFAULT_SETTINGS };
  if (!saved || typeof saved !== "object") return merged;
  if (saved.mode === "off" || saved.mode === "fallback" || saved.mode === "prefer") {
    merged.mode = saved.mode;
  }
  if (saved.site === "org" || saved.site === "xyz") merged.site = saved.site;
  if (Array.isArray(saved.sources)) {
    const list = saved.sources.filter((id) => SOURCE_IDS.includes(id));
    merged.sources = list.length ? list : [...DEFAULT_SETTINGS.sources];
  }
  if (["999", "740", "320", "128"].includes(String(saved.maxBr))) merged.maxBr = String(saved.maxBr);
  if (Number.isFinite(Number(saved.minScore))) {
    merged.minScore = Math.min(0.95, Math.max(0.2, Number(saved.minScore)));
  }
  merged.verbose = saved.verbose === true;
  return merged;
};

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

export function activate(ctx) {
  let settings = { ...DEFAULT_SETTINGS };
  const runtime = createRuntime(ctx, () => settings);
  let disposeResolver = null;
  let disposed = false;

  const persist = async () => {
    await ctx.storage.set(STORAGE_KEY, settings).catch(() => {});
  };

  const registerResolver = () => {
    disposeResolver?.();
    disposeResolver = null;
    if (settings.mode === "off") return;

    disposeResolver = ctx.player.audioSource.register({
      id: "gdstudio",
      position: settings.mode === "prefer" ? "before-catalog" : "after-catalog",
      order: 100,
      match({ track, effect }) {
        // 人声/伴奏分离等特效音轨 GD 没有，交回宿主链路
        return effect === "none" && !!track && !!(track.title || track.name);
      },
      async resolve({ track, quality }) {
        try {
          const hit = await runtime.resolveTrack(track, quality);
          if (!hit) return null;
          runtime.log(
            `命中 ${hit.source} ${hit.br}kbps 匹配${Math.round(hit.score * 100)} ` +
              `${track.title} — ${track.artist}`,
          );
          return {
            url: hit.url,
            quality: runtime.qualityLabel(hit.br),
            effect: "none",
            sourceKind: "plugin",
          };
        } catch (error) {
          runtime.warn("解析失败", error?.message || error);
          return null;
        }
      },
    });
  };

  const applySettings = async (next, { persist: shouldPersist = true } = {}) => {
    settings = mergeSettings(next);
    if (shouldPersist) await persist();
    registerResolver();
  };

  const buildSettingsPanel = () => {
    const vue = ctx.vue || {};
    // 这些 API 在宿主里都有，但缺省时给个等价兜底，避免插件因一个缺失项整体不可用
    const defineComponent = vue.defineComponent || ((options) => options);
    const h = vue.h;
    const ref = vue.ref || ((value) => ({ value }));
    const reactive = vue.reactive || ((value) => value);
    const computed =
      vue.computed ||
      ((getter) => ({
        get value() {
          return getter();
        },
      }));
    const onMounted =
      vue.onMounted ||
      ((callback) => {
        void callback();
      });

    const Panel = defineComponent({
      name: "GdStudioSettings",
      setup() {
        const state = reactive(mergeSettings(settings));
        const busy = ref(false);
        const rows = ref([]);
        const testKeyword = ref("晴天 周杰伦");
        const statusText = ref("");

        onMounted(async () => {
          const saved = await ctx.storage.get(STORAGE_KEY).catch(() => null);
          Object.assign(state, mergeSettings(saved));
        });

        const save = async () => {
          await applySettings({ ...state });
          ctx.toast.success("GD 音乐台音源设置已保存");
        };

        const move = (index, delta) => {
          const next = [...state.sources];
          const target = index + delta;
          if (target < 0 || target >= next.length) return;
          [next[index], next[target]] = [next[target], next[index]];
          state.sources = next;
        };

        const toggleSource = (id, checked) => {
          const set = new Set(state.sources);
          if (checked) set.add(id);
          else set.delete(id);
          state.sources = SOURCE_IDS.filter((item) => set.has(item));
        };

        const runTest = async () => {
          busy.value = true;
          statusText.value = "正在测试…";
          rows.value = [];
          const startedAt = Date.now();
          try {
            await applySettings({ ...state }, { persist: false });
            const result = await runtime.diagnose(
              testKeyword.value.trim() || "晴天 周杰伦",
              state.sources,
            );
            rows.value = result;
            const okCount = result.filter((item) => item.ok).length;
            statusText.value = `完成：${okCount}/${result.length} 个音源可用，耗时 ${Date.now() - startedAt}ms`;
            ctx.toast.success(`GD 音源测试完成（${okCount}/${result.length} 可用）`);
          } catch (error) {
            statusText.value = `测试失败：${String(error?.message || error)}`;
            ctx.toast.danger("GD 音源测试失败");
          } finally {
            busy.value = false;
          }
        };

        const fieldStyle =
          "display:grid;grid-template-columns:132px minmax(0,1fr);align-items:center;gap:10px;margin:10px 0;font-size:13px;";
        const selectStyle =
          "height:30px;border-radius:8px;border:1px solid var(--color-border,rgba(148,163,184,.35));background:transparent;color:inherit;padding:0 8px;font-size:13px;";
        const buttonStyle =
          "height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--color-border,rgba(148,163,184,.35));background:transparent;color:inherit;font-size:13px;cursor:pointer;";

        const modeHelp = computed(() => {
          if (state.mode === "off") return "插件不接管任何播放请求。";
          if (state.mode === "prefer")
            return "所有歌曲先向 GD 音乐台取流，失败再回落到酷狗（音质与曲库更全，但每次播放多 1~2 秒）。";
          return "仅当酷狗解析失败（VIP / 无版权）时才向 GD 音乐台取流（推荐）。";
        });

        return () =>
          h("div", { style: "display:grid;gap:6px;font-size:13px;" }, [
            h("div", { style: fieldStyle }, [
              h("span", "工作模式"),
              h(
                "select",
                {
                  style: selectStyle,
                  value: state.mode,
                  onChange: (event) => {
                    state.mode = event.target.value;
                    void save();
                  },
                },
                [
                  h("option", { value: "fallback" }, "兜底（酷狗失败后接管）"),
                  h("option", { value: "prefer" }, "优先（先走 GD 音乐台）"),
                  h("option", { value: "off" }, "关闭"),
                ],
              ),
            ]),
            h(
              "div",
              { style: "margin:-4px 0 8px 142px;opacity:.65;font-size:12px;line-height:1.5;" },
              modeHelp.value,
            ),
            h("div", { style: fieldStyle }, [
              h("span", "站点"),
              h(
                "select",
                {
                  style: selectStyle,
                  value: state.site,
                  onChange: (event) => {
                    state.site = event.target.value;
                    void save();
                  },
                },
                [
                  h("option", { value: "org" }, "music.gdstudio.org（国内版）"),
                  h("option", { value: "xyz" }, "music.gdstudio.xyz（国际版）"),
                ],
              ),
            ]),
            h("div", { style: fieldStyle }, [
              h("span", "最高音质"),
              h(
                "select",
                {
                  style: selectStyle,
                  value: state.maxBr,
                  onChange: (event) => {
                    state.maxBr = event.target.value;
                    void save();
                  },
                },
                [
                  h("option", { value: "999" }, "999 · 24bit 无损（优先）"),
                  h("option", { value: "740" }, "740 · 16bit 无损"),
                  h("option", { value: "320" }, "320 · 有损"),
                  h("option", { value: "128" }, "128 · 省流量"),
                ],
              ),
            ]),
            h("div", { style: "margin:16px 0 6px;font-weight:600;" }, "音源优先级"),
            h(
              "div",
              { style: "opacity:.65;font-size:12px;margin-bottom:6px;" },
              "勾选启用的音源，用 ↑ ↓ 调整尝试顺序（越靠前越优先，命中可靠时不再继续请求后面的源）。",
            ),
            h(
              "div",
              { style: "display:grid;gap:6px;" },
              state.sources.map((id, index) => {
                const meta = SOURCE_CATALOG.find((item) => item.id === id) || { label: id };
                return h(
                  "div",
                  {
                    style:
                      "display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:8px;" +
                      "border:1px solid var(--color-border,rgba(148,163,184,.22));",
                  },
                  [
                    h("input", {
                      type: "checkbox",
                      checked: true,
                      onChange: (event) => toggleSource(id, event.target.checked),
                    }),
                    h("span", { style: "flex:1;" }, `${index + 1}. ${meta.label}`),
                    h(
                      "button",
                      {
                        style: buttonStyle,
                        onClick: () => {
                          move(index, -1);
                          void save();
                        },
                      },
                      "↑",
                    ),
                    h(
                      "button",
                      {
                        style: buttonStyle,
                        onClick: () => {
                          move(index, 1);
                          void save();
                        },
                      },
                      "↓",
                    ),
                  ],
                );
              }),
            ),
            (() => {
              const unused = SOURCE_IDS.filter((id) => !state.sources.includes(id));
              if (!unused.length) return h("span");
              return h(
                "div",
                { style: "display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;" },
                unused.map((id) => {
                  const meta = SOURCE_CATALOG.find((item) => item.id === id) || { label: id };
                  return h(
                    "button",
                    {
                      style: buttonStyle,
                      onClick: () => {
                        toggleSource(id, true);
                        void save();
                      },
                    },
                    `+ ${meta.label}`,
                  );
                }),
              );
            })(),
            h("div", { style: "margin:18px 0 6px;font-weight:600;" }, "连通性测试"),
            h("div", { style: "display:flex;gap:8px;align-items:center;" }, [
              h("input", {
                value: testKeyword.value,
                placeholder: "歌名 歌手",
                style: `${selectStyle}flex:1;`,
                onInput: (event) => {
                  testKeyword.value = event.target.value;
                },
              }),
              h(
                "button",
                { style: buttonStyle, disabled: busy.value, onClick: runTest },
                busy.value ? "测试中…" : "测试",
              ),
            ]),
            h("div", { style: "opacity:.7;font-size:12px;margin-top:6px;" }, statusText.value),
            rows.value.length
              ? h(
                  "div",
                  { style: "display:grid;gap:4px;margin-top:8px;font-size:12px;" },
                  rows.value.map((row) =>
                    h(
                      "div",
                      {
                        style:
                          "display:grid;grid-template-columns:76px 52px minmax(0,1fr) 56px;gap:8px;" +
                          "align-items:center;padding:4px 6px;border-radius:6px;background:rgba(148,163,184,.10);",
                      },
                      [
                        h("span", null, row.source),
                        h("span", { style: row.ok ? "color:#16a34a;" : "color:#dc2626;" },
                          row.ok ? "可用" : "失败"),
                        h("span", { style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" },
                          row.sample || "—"),
                        h("span", { style: "text-align:right;opacity:.6;" }, `${row.ms}ms`),
                      ],
                    ),
                  ),
                )
              : h("span"),
          ]);
      },
    });

    ctx.ui.settings.define({
      title: "GD 音乐台音源",
      component: Panel,
    });
  };

  (async () => {
    try {
      const saved = await ctx.storage.get(STORAGE_KEY).catch(() => null);
      settings = mergeSettings(saved);
      registerResolver();
      runtime.log("已启用，模式", settings.mode, "音源", settings.sources.join(","));
    } catch (error) {
      console.warn(LOG_TAG, "音源注册失败", error);
    }

    // 设置面板单独兜底：面板渲染失败不该影响播放兜底
    try {
      buildSettingsPanel();
    } catch (error) {
      console.warn(LOG_TAG, "设置面板注册失败", error);
    }
  })();

  ctx.dispose?.(() => {
    disposed = true;
    disposeResolver?.();
    disposeResolver = null;
  });

  return () => {
    if (disposed) return;
    disposed = true;
    disposeResolver?.();
    disposeResolver = null;
  };
}

export function deactivate() {
  // resolve 注册项由宿主在禁用时统一清理；这里只做幂等兜底。
}

export default { activate, deactivate };
