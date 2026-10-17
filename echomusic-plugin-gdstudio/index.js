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
      try {
        return await attempt(true);
      } catch (retryError) {
        // 站点偶发把「刚刚超频」也回成 Invalid request，隔一会儿再试一次
        if (!retryError?.signatureRejected) throw retryError;
        await new Promise((resolve) => setTimeout(resolve, 900));
        return attempt(true);
      }
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
 * 下载引擎
 *
 * 走宿主传输引擎 (ctx.net.download)：沿用宿主代理、支持续传与进度、
 * 直接流式写入用户授权的目录（不在 renderer 里搬字节）。
 * 该 API 需要 EchoMusic >= 2.3.2-beta.10；2.3.1 上自动降级为「解析 + 复制直链」。
 * ------------------------------------------------------------------ */

const DIR_KEY = "download.dir";
const MAX_QUEUE = 200;
const DOWNLOAD_CONCURRENCY = 2; // 宿主对单个插件放宽到 2 个并发传输

const stripUnsafe = (text) =>
  String(text || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const trimSegment = (text, fallback, max = 80) => {
  const value = stripUnsafe(text).slice(0, max).replace(/[. ]+$/, "");
  return value || fallback;
};

const extFromUrl = (url, br) => {
  const matched = String(url).match(/\.([a-z0-9]{2,5})(?:\?|#|$)/i);
  const ext = matched ? matched[1].toLowerCase() : "";
  if (["flac", "mp3", "m4a", "ogg", "aac", "wav", "opus"].includes(ext)) return ext;
  return br >= 600 ? "flac" : "mp3";
};

/** 批量文本 → [{title, artist}]，支持「歌名 - 歌手」「歌名—歌手」「序号. 歌名 - 歌手」 */
const TRACK_SEP_RE = /\s+[-–—|]\s+|\t+|\s*—\s*/;

const parseTrackLines = (text) =>
  String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const cleaned = line.replace(/^\d{1,3}[.、)]\s*/, "").replace(/^#+\s*/, "").trim();
      const parts = cleaned.split(TRACK_SEP_RE).map((one) => one.trim()).filter(Boolean);
      if (parts.length >= 2) return { title: parts[0], artist: parts[1] };
      return { title: cleaned, artist: "" };
    })
    .filter((item) => item.title);

const createDownloadEngine = ({ ctx, runtime, getSettings }) => {
  const tasks = [];
  const listeners = new Set();
  let directory = null;
  let sequence = 0;
  let running = 0;
  let emitTimer = null;

  const canDownload = () =>
    typeof ctx.net?.download === "function" && typeof ctx.fs?.requestDirectory === "function";

  const capability = () => ({
    canDownload: canDownload(),
    canPickDirectory: typeof ctx.fs?.requestDirectory === "function",
    canClipboard: typeof navigator !== "undefined" && !!navigator.clipboard,
  });

  const snapshot = () =>
    tasks.map((task) => ({
      key: task.key,
      title: task.title,
      artist: task.artist,
      status: task.status,
      received: task.received,
      total: task.total,
      speed: task.speed,
      error: task.error,
      source: task.source,
      br: task.br,
      relativePath: task.relativePath,
    }));

  const emit = () => {
    if (emitTimer) return;
    emitTimer = setTimeout(() => {
      emitTimer = null;
      const payload = snapshot();
      listeners.forEach((handler) => {
        try {
          handler(payload);
        } catch {}
      });
    }, 150);
  };

  const subscribe = (handler) => {
    listeners.add(handler);
    handler(snapshot());
    return () => listeners.delete(handler);
  };

  const loadDirectory = async () => {
    if (directory) return directory;
    const saved = await ctx.storage.get(DIR_KEY).catch(() => null);
    if (!saved?.id) return null;
    // 授权可能被用户在「已授权文件与目录」里撤销
    try {
      const grants = await ctx.fs?.listDirectoryGrants?.();
      if (Array.isArray(grants)) {
        const hit = grants.find((one) => one.id === saved.id);
        if (hit && hit.available === false) return null;
      }
    } catch {}
    directory = saved;
    return directory;
  };

  const pickDirectory = async () => {
    if (typeof ctx.fs?.requestDirectory !== "function") {
      throw new Error("当前 EchoMusic 版本不支持选择保存目录（需要 2.3.2-beta.10 及以上）");
    }
    const selection = await ctx.fs.requestDirectory({
      access: "read-write",
      purpose: "保存 GD 音乐台下载的歌曲",
      persist: true,
    });
    if (!selection?.ok) throw new Error(selection?.error?.message || "选择目录失败");
    if (selection.canceled) return null;
    directory = {
      id: selection.directory.id,
      displayPath: selection.directory.displayPath || selection.directory.name,
      name: selection.directory.name,
    };
    await ctx.storage.set(DIR_KEY, directory).catch(() => {});
    return directory;
  };

  const getDirectory = () => directory;

  const qualityForBr = (maxBr) => (Number(maxBr) >= 740 ? "flac" : Number(maxBr) >= 320 ? "320" : "128");

  const buildRelativePath = (task, ext) => {
    const artist = trimSegment(task.artist, "未知歌手", 60);
    const title = trimSegment(task.title, "未命名", 80);
    return `${artist}/${title}.${ext}`;
  };

  const runTask = async (task) => {
    const settings = getSettings();
    task.status = "resolving";
    task.error = "";
    emit();

    const hit = await runtime.resolveTrack(
      {
        title: task.title,
        artist: task.artist,
        album: task.album,
        duration: task.duration,
      },
      qualityForBr(settings.maxBr),
    );
    if (!hit) throw new Error("没有找到可用的音源（可能是冷门曲目或音源被限流）");

    task.source = hit.source;
    task.br = hit.br;
    const ext = extFromUrl(hit.url, hit.br);
    task.relativePath = buildRelativePath(task, ext);
    task.status = "downloading";
    task.received = 0;
    task.total = 0;
    emit();

    const dir = directory || (await loadDirectory());
    if (!dir) throw new Error("还没有选择保存目录");

    const handle = await ctx.net.download({
      url: hit.url,
      target: { directoryId: dir.id, relativePath: task.relativePath },
      headers: { "User-Agent": UA, Referer: `https://${HOSTS[getSettings().site] || HOSTS.org}/` },
      name: `${task.artist || "未知歌手"} - ${task.title}`,
      conflict: "rename",
    });
    task.handle = handle;

    const unsubscribe = handle.subscribe((snap) => {
      task.received = Number(snap?.receivedBytes) || 0;
      task.total = Number(snap?.totalBytes) || 0;
      task.speed = Number(snap?.bytesPerSecond) || 0;
      if (snap?.state && snap.state !== task.status) {
        if (snap.state === "paused") task.status = "paused";
        else if (snap.state === "downloading" || snap.state === "connecting") task.status = "downloading";
      }
      emit();
    });

    try {
      const result = await handle.wait();
      task.status = "completed";
      task.received = Number(result?.bytes) || task.received || task.total;
      task.total = task.received;
      task.relativePath = result?.file?.relativePath || task.relativePath;
    } finally {
      unsubscribe?.();
      task.handle = null;
    }
  };

  const pump = () => {
    while (running < DOWNLOAD_CONCURRENCY) {
      const next = tasks.find((task) => task.status === "pending");
      if (!next) break;
      running += 1;
      void (async () => {
        try {
          await runTask(next);
        } catch (error) {
          if (next.canceled) {
            next.status = "canceled";
          } else {
            next.status = "failed";
            next.error = String(error?.message || error);
          }
        } finally {
          running -= 1;
          emit();
          pump();
        }
      })();
    }
  };

  const enqueue = (items) => {
    let added = 0;
    let skipped = 0;
    for (const item of Array.isArray(items) ? items : []) {
      const title = String(item?.title || "").trim();
      if (!title) {
        skipped += 1;
        continue;
      }
      const artist = String(item?.artist || "").trim();
      const dedupeKey = `${normalizeText(title)}|${normalizeText(artist)}`;
      const active = tasks.some(
        (task) =>
          task.dedupeKey === dedupeKey &&
          task.status !== "failed" &&
          task.status !== "canceled" &&
          task.status !== "completed",
      );
      if (active || tasks.length >= MAX_QUEUE) {
        skipped += 1;
        continue;
      }
      tasks.push({
        key: `gd-${++sequence}`,
        dedupeKey,
        title,
        artist,
        album: String(item?.album || ""),
        duration: Number(item?.duration) || 0,
        status: "pending",
        received: 0,
        total: 0,
        speed: 0,
        error: "",
        source: "",
        br: 0,
        relativePath: "",
        canceled: false,
        handle: null,
      });
      added += 1;
    }
    emit();
    if (!running) void loadDirectory().then(() => pump());
    else pump();
    return { added, skipped };
  };

  const cancel = (key) => {
    const task = tasks.find((one) => one.key === key);
    if (!task) return;
    task.canceled = true;
    if (task.handle) {
      try {
        void task.handle.cancel();
      } catch {}
    }
    if (task.status === "pending" || task.status === "resolving") task.status = "canceled";
    emit();
  };

  const retry = (key) => {
    const task = tasks.find((one) => one.key === key);
    if (!task) return;
    task.status = "pending";
    task.error = "";
    task.canceled = false;
    task.received = 0;
    task.total = 0;
    emit();
    pump();
  };

  const remove = (key) => {
    const index = tasks.findIndex((one) => one.key === key);
    if (index < 0) return;
    if (tasks[index].handle) cancel(key);
    tasks.splice(index, 1);
    emit();
  };

  const clearFinished = () => {
    for (let index = tasks.length - 1; index >= 0; index -= 1) {
      if (["completed", "failed", "canceled"].includes(tasks[index].status)) tasks.splice(index, 1);
    }
    emit();
  };

  return {
    capability,
    subscribe,
    snapshot,
    enqueue,
    parseTrackLines,
    cancel,
    retry,
    remove,
    clearFinished,
    loadDirectory,
    pickDirectory,
    getDirectory,
  };
};

/* ------------------------------------------------------------------ *
 * 代理（读写客户端全局网络设置）
 *
 * EchoMusic 的代理是应用级的：主进程 axios 走 Chromium adapter，下载也沿用宿主代理，
 * 所以插件里的所有请求本来就会跟随它。这里提供读写入口，省得来回翻设置页。
 * 写入通过 preload 暴露的 window.electron.network.update，与「设置 → 网络」同一通道。
 * ------------------------------------------------------------------ */

const createProxyApi = (ctx) => {
  const bridge = () => (typeof window !== "undefined" ? window.electron?.network : null);

  const supported = () => typeof bridge()?.update === "function";

  const read = async () => {
    const api = bridge();
    if (typeof api?.get === "function") {
      const result = await api.get();
      if (result?.settings) return result.settings;
    }
    const store = ctx.stores?.settings;
    if (!store) return null;
    return {
      proxyMode: store.proxyMode,
      proxyPacScript: store.proxyPacScript,
      proxyRules: store.proxyRules,
      proxyUsername: store.proxyUsername,
      proxyBypassRules: store.proxyBypassRules,
      kugouApiTimeoutSecs: store.kugouApiTimeoutSecs,
      playerNetworkTimeoutSecs: store.playerNetworkTimeoutSecs,
    };
  };

  const apply = async (patch) => {
    const api = bridge();
    if (typeof api?.update !== "function") {
      throw new Error("当前版本不支持从插件修改网络设置，请到「设置 → 网络」里配置");
    }
    const current = await read();
    const result = await api.update({ settings: { ...(current || {}), ...patch } });
    try {
      ctx.stores?.settings?.applyNetworkSettings?.(result.settings);
    } catch {}
    return result.settings;
  };

  /** 出口自检：Cloudflare trace 会回显客户端 IP 与落地机房，用来确认代理是否生效 */
  const egress = async () => {
    const startedAt = Date.now();
    const text = await ctx.net.request({
      url: `https://${HOSTS.org}/cdn-cgi/trace`,
      method: "GET",
      responseType: "text",
      timeoutMs: 10000,
      headers: { "User-Agent": UA },
    });
    const body = String(text?.data || "");
    const fields = {};
    body
      .trim()
      .split("\n")
      .forEach((line) => {
        const index = line.indexOf("=");
        if (index > 0) fields[line.slice(0, index)] = line.slice(index + 1);
      });
    return {
      ip: fields.ip || "",
      loc: fields.loc || "",
      colo: fields.colo || "",
      ms: Date.now() - startedAt,
      raw: body,
    };
  };

  return { read, apply, egress, supported };
};

/* ------------------------------------------------------------------ *
 * 前端：下载页（侧边栏入口）
 * ------------------------------------------------------------------ */

const PAGE_CSS = `
.gd-page { display: flex; flex-direction: column; gap: 14px; padding: 18px 20px 40px; color: var(--color-text-main, inherit); }
.gd-card { border: 1px solid var(--color-border, rgba(148,163,184,.28)); border-radius: 14px; padding: 14px 16px; background: color-mix(in srgb, var(--color-text-main, #64748b) 4%, transparent); }
.gd-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.gd-title h2 { margin: 0; font-size: 17px; font-weight: 700; }
.gd-title p { margin: 4px 0 0; font-size: 12px; opacity: .62; }
.gd-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.gd-btn { height: 30px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--color-border, rgba(148,163,184,.35)); background: transparent; color: inherit; font-size: 12.5px; cursor: pointer; transition: .15s; }
.gd-btn:hover { background: color-mix(in srgb, var(--color-text-main, #64748b) 8%, transparent); }
.gd-btn:disabled { opacity: .45; cursor: default; }
.gd-btn-primary { background: var(--color-primary, #0ea5e9); border-color: transparent; color: #fff; }
.gd-btn-primary:hover { filter: brightness(1.06); background: var(--color-primary, #0ea5e9); }
.gd-btn-danger { color: #dc2626; border-color: color-mix(in srgb, #dc2626 40%, transparent); }
.gd-input, .gd-select, .gd-textarea { border: 1px solid var(--color-border, rgba(148,163,184,.35)); background: transparent; color: inherit; border-radius: 8px; font-size: 13px; padding: 6px 10px; outline: none; font-family: inherit; }
.gd-input { height: 30px; flex: 1; min-width: 160px; }
.gd-select { height: 30px; }
.gd-textarea { width: 100%; min-height: 84px; resize: vertical; line-height: 1.55; }
.gd-hint { font-size: 12px; opacity: .62; line-height: 1.6; }
.gd-warn { font-size: 12.5px; line-height: 1.6; padding: 10px 12px; border-radius: 10px; background: color-mix(in srgb, #f59e0b 16%, transparent); border: 1px solid color-mix(in srgb, #f59e0b 40%, transparent); }
.gd-list { display: flex; flex-direction: column; gap: 6px; max-height: 320px; overflow: auto; }
.gd-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 8px 10px; border-radius: 10px; background: color-mix(in srgb, var(--color-text-main, #64748b) 5%, transparent); }
.gd-item-main { min-width: 0; }
.gd-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gd-sub { font-size: 11.5px; opacity: .6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
.gd-bar { height: 5px; border-radius: 999px; background: color-mix(in srgb, var(--color-text-main, #64748b) 14%, transparent); overflow: hidden; margin-top: 6px; }
.gd-bar-fill { height: 100%; border-radius: 999px; background: var(--color-primary, #0ea5e9); transition: width .25s; }
.gd-tag { display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 999px; font-size: 10.5px; background: color-mix(in srgb, var(--color-text-main, #64748b) 12%, transparent); }
.gd-tag.ok { background: color-mix(in srgb, #16a34a 22%, transparent); color: #16a34a; }
.gd-tag.err { background: color-mix(in srgb, #dc2626 20%, transparent); color: #dc2626; }
.gd-empty { font-size: 12.5px; opacity: .55; padding: 12px 2px; }
.gd-grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
`;

const createDownloadPage = ({ ctx, runtime, engine, getSettings, proxy }) => {
  const vue = ctx.vue || {};
  const defineComponent = vue.defineComponent || ((options) => options);
  const h = vue.h;
  const ref = vue.ref || ((value) => ({ value }));
  const onMounted = vue.onMounted || ((callback) => void callback());
  const onUnmounted = vue.onUnmounted || (() => {});

  return defineComponent({
    name: "GdDownloadPage",
    setup() {
      const caps = engine.capability();
      const tasks = ref(engine.snapshot());
      const directory = ref(engine.getDirectory());
      const keyword = ref("");
      const results = ref([]);
      const searching = ref(false);
      const batchText = ref("");
      const statusText = ref("");
      const busy = ref(false);
      const proxyState = ref(null);
      const egressInfo = ref(null);
      const proxyMode = ref("system");
      const proxyRules = ref("");
      const showProxy = ref(false);
      let unsubscribe = null;

      onMounted(async () => {
        unsubscribe = engine.subscribe((snapshot) => {
          tasks.value = snapshot;
        });
        directory.value = await engine.loadDirectory().catch(() => null);
        try {
          const state = await proxy.read();
          proxyState.value = state;
          if (state) {
            proxyMode.value = state.proxyMode || "system";
            proxyRules.value = state.proxyRules || "";
          }
        } catch {}
      });

      onUnmounted(() => {
        if (typeof unsubscribe === "function") unsubscribe();
      });

      const formatBytes = (bytes) => {
        const value = Number(bytes) || 0;
        if (value < 1024) return `${value} B`;
        if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
        if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
        return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
      };

      const statusLabel = (status) => {
        const map = {
          pending: "排队中",
          resolving: "匹配音源",
          downloading: "下载中",
          paused: "已暂停",
          completed: "已完成",
          failed: "失败",
          canceled: "已取消",
        };
        return map[status] || status;
      };

      const progressOf = (task) => {
        if (task.status === "completed") return 100;
        if (!task.total) return task.status === "downloading" ? 12 : 0;
        return Math.min(100, Math.round((task.received / task.total) * 100));
      };

      const chooseDirectory = async () => {
        try {
          const picked = await engine.pickDirectory();
          if (picked) {
            directory.value = picked;
            ctx.toast.success(`保存目录：${picked.displayPath}`);
          }
        } catch (error) {
          ctx.toast.danger(String(error?.message || error));
        }
      };

      /** 下载前必须有授权目录，否则任务会在引擎里失败得莫名其妙 */
      const requireDirectory = () => {
        if (!caps.canDownload) {
          ctx.toast.warning("当前版本没有下载接口，请用「复制直链」配合命令行下载器");
          return false;
        }
        if (!directory.value) {
          ctx.toast.warning("请先选择保存目录");
          return false;
        }
        return true;
      };

      const addBatch = () => {
        if (!requireDirectory()) return;
        const parsed = engine.parseTrackLines(batchText.value);
        if (!parsed.length) {
          ctx.toast.warning("没有解析到歌曲，每行一首，格式「歌名 - 歌手」");
          return;
        }
        const result = engine.enqueue(parsed);
        statusText.value = `已加入 ${result.added} 首${result.skipped ? `，跳过 ${result.skipped} 首（重复或超限）` : ""}`;
        if (result.added) batchText.value = "";
      };

      const addQueue = () => {
        if (!requireDirectory()) return;
        let songs = [];
        try {
          songs = ctx.playlist?.getQueueSongs?.() || [];
        } catch {}
        if (!songs.length) {
          ctx.toast.warning("当前播放队列是空的");
          return;
        }
        const result = engine.enqueue(
          songs.map((song) => ({
            title: song.title || song.name,
            artist: song.artist,
            album: song.albumName || song.album,
            duration: song.duration,
          })),
        );
        statusText.value = `队列导入 ${result.added} 首${result.skipped ? `，跳过 ${result.skipped} 首` : ""}`;
      };

      const addCurrent = () => {
        if (!requireDirectory()) return;
        const track = ctx.player?.currentTrack;
        if (!track) {
          ctx.toast.warning("当前没有播放中的歌曲");
          return;
        }
        const result = engine.enqueue([
          {
            title: track.title || track.name,
            artist: track.artist,
            album: track.albumName || track.album,
            duration: track.duration,
          },
        ]);
        if (!result.added) ctx.toast.info("这首歌已经在队列里了");
      };

      const doSearch = async () => {
        const value = keyword.value.trim();
        if (!value) return;
        searching.value = true;
        results.value = [];
        try {
          const sources = getSettings().sources || [];
          const collected = [];
          const seen = new Set();
          for (const source of sources) {
            let list = [];
            try {
              list = await runtime.search(value, source, 8);
            } catch (error) {
              continue;
            }
            for (const item of list) {
              const key = `${normalizeText(item.name)}|${normalizeText((item.artist || []).join(""))}`;
              if (seen.has(key)) continue;
              seen.add(key);
              collected.push({ ...item, gdSource: source });
            }
            if (collected.length >= 20) break;
          }
          results.value = collected.slice(0, 24);
          if (!collected.length) statusText.value = "没有搜到结果，换个关键词或音源试试";
        } finally {
          searching.value = false;
        }
      };

      const downloadItem = (item) => {
        if (!requireDirectory()) return;
        const result = engine.enqueue([
          {
            title: item.name,
            artist: (item.artist || []).join(" / "),
            album: item.album,
          },
        ]);
        if (result.added) ctx.toast.success(`已加入队列：${item.name}`);
        else ctx.toast.info("这首歌已经在队列里了");
      };

      const copyUrl = async (item) => {
        busy.value = true;
        try {
          const hit = await runtime.resolveTrack(
            {
              title: item.name,
              artist: (item.artist || []).join(" "),
              album: item.album,
            },
            Number(getSettings().maxBr) >= 740 ? "flac" : "320",
          );
          if (!hit) {
            ctx.toast.warning("没有取到可用直链");
            return;
          }
          await navigator.clipboard.writeText(hit.url);
          ctx.toast.success(`已复制 ${hit.source} 直链（${hit.br}kbps）`);
        } catch (error) {
          ctx.toast.danger(String(error?.message || error));
        } finally {
          busy.value = false;
        }
      };

      const applyProxy = async (mode, rules) => {
        busy.value = true;
        try {
          const state = await proxy.apply({
            proxyMode: mode,
            proxyRules: mode === "fixed_servers" ? rules : (proxyState.value?.proxyRules || ""),
          });
          proxyState.value = state;
          proxyMode.value = state.proxyMode;
          ctx.toast.success("网络代理已更新（对客户端全局生效）");
        } catch (error) {
          ctx.toast.danger(String(error?.message || error));
        } finally {
          busy.value = false;
        }
      };

      const checkEgress = async () => {
        busy.value = true;
        try {
          egressInfo.value = await proxy.egress();
        } catch (error) {
          ctx.toast.danger(`出口检测失败：${String(error?.message || error)}`);
        } finally {
          busy.value = false;
        }
      };

      const renderTask = (task) => {
        const pct = progressOf(task);
        const failed = task.status === "failed";
        return h("div", { class: "gd-item", key: task.key }, [
          h("div", { class: "gd-item-main" }, [
            h("div", { class: "gd-name" }, task.title || "未命名"),
            h("div", { class: "gd-sub" }, [
              task.artist || "未知歌手",
              task.source ? ` · ${task.source}` : "",
              task.br ? ` · ${task.br}kbps` : "",
              task.status === "downloading" && task.total
                ? ` · ${formatBytes(task.received)} / ${formatBytes(task.total)} · ${formatBytes(task.speed)}/s`
                : "",
              task.error ? ` · ${task.error}` : "",
            ]),
            h("div", { class: "gd-bar" }, [
              h("div", {
                class: "gd-bar-fill",
                style: `width:${pct}%;${failed ? "background:#dc2626" : ""}`,
              }),
            ]),
          ]),
          h("div", { class: "gd-row" }, [
            h(
              "span",
              { class: `gd-tag${task.status === "completed" ? " ok" : failed ? " err" : ""}` },
              statusLabel(task.status),
            ),
            ["pending", "resolving", "downloading", "paused"].includes(task.status)
              ? h("button", { class: "gd-btn", onClick: () => engine.cancel(task.key) }, "取消")
              : null,
            failed || task.status === "canceled"
              ? h("button", { class: "gd-btn", onClick: () => engine.retry(task.key) }, "重试")
              : null,
            ["completed", "failed", "canceled"].includes(task.status)
              ? h("button", { class: "gd-btn", onClick: () => engine.remove(task.key) }, "移除")
              : null,
          ]),
        ]);
      };

      return () =>
        h("div", { class: "gd-page" }, [
          h("div", { class: "gd-card" }, [
            h("div", { class: "gd-title" }, [
              h("div", null, [
                h("h2", null, "GD 音乐台下载"),
                h(
                  "p",
                  null,
                  `音源：${(getSettings().sources || []).join(" / ") || "未配置"} · 最高 ${getSettings().maxBr} 档 · ` +
                    `已启用音源接管：${getSettings().mode === "prefer" ? "优先" : getSettings().mode === "off" ? "关闭" : "兜底"}`,
                ),
              ]),
              h("div", { class: "gd-row" }, [
                h("button", { class: "gd-btn", onClick: addCurrent }, "下载当前播放"),
                h("button", { class: "gd-btn", onClick: addQueue }, "导入播放队列"),
              ]),
            ]),
          ]),

          h("div", { class: "gd-card" }, [
            h("div", { class: "gd-row", style: "justify-content:space-between;" }, [
              h("div", { class: "gd-hint" }, [
                "保存目录：",
                h(
                  "strong",
                  { style: "opacity:.9;" },
                  directory.value?.displayPath || "未选择",
                ),
              ]),
              h(
                "button",
                { class: "gd-btn", onClick: chooseDirectory, disabled: !caps.canPickDirectory },
                directory.value ? "更换目录" : "选择目录",
              ),
            ]),
            !caps.canDownload
              ? h(
                  "div",
                  { class: "gd-warn", style: "margin-top:10px;" },
                  "当前 EchoMusic 版本的插件还不提供下载传输接口（需要 2.3.2-beta.10 及以上）。" +
                    "你仍然可以搜索并用「复制直链」拿到地址，再用仓库里的命令行下载器落盘。",
                )
              : null,
          ]),

          h("div", { class: "gd-card" }, [
            h("div", { class: "gd-row", style: "margin-bottom:8px;" }, [
              h("strong", { style: "font-size:13px;" }, "批量添加"),
              h("span", { class: "gd-hint" }, "每行一首，「歌名 - 歌手」，例如：晴天 - 周杰伦"),
            ]),
            h("textarea", {
              class: "gd-textarea",
              value: batchText.value,
              placeholder: "晴天 - 周杰伦\n稻香 - 周杰伦\n富士山下 - 陈奕迅",
              onInput: (event) => {
                batchText.value = event.target.value;
              },
            }),
            h("div", { class: "gd-row", style: "margin-top:8px;" }, [
              h("button", { class: "gd-btn gd-btn-primary", onClick: addBatch }, "解析并加入队列"),
              h(
                "button",
                { class: "gd-btn", onClick: () => engine.clearFinished() },
                "清空已结束",
              ),
              statusText.value ? h("span", { class: "gd-hint" }, statusText.value) : null,
            ]),
          ]),

          h("div", { class: "gd-card" }, [
            h("div", { class: "gd-row", style: "margin-bottom:8px;" }, [
              h("strong", { style: "font-size:13px;" }, "搜索曲库"),
              h("input", {
                class: "gd-input",
                value: keyword.value,
                placeholder: "歌名 歌手",
                onInput: (event) => {
                  keyword.value = event.target.value;
                },
                onKeydown: (event) => {
                  if (event.key === "Enter") void doSearch();
                },
              }),
              h(
                "button",
                { class: "gd-btn", onClick: doSearch, disabled: searching.value },
                searching.value ? "搜索中…" : "搜索",
              ),
            ]),
            results.value.length
              ? h(
                  "div",
                  { class: "gd-list" },
                  results.value.map((item) =>
                    h("div", { class: "gd-item", key: `${item.gdSource}-${item.id}` }, [
                      h("div", { class: "gd-item-main" }, [
                        h("div", { class: "gd-name" }, item.name),
                        h(
                          "div",
                          { class: "gd-sub" },
                          `${(item.artist || []).join(" / ") || "未知歌手"}${item.album ? ` · ${item.album}` : ""} · ${item.gdSource}`,
                        ),
                      ]),
                      h("div", { class: "gd-row" }, [
                        h(
                          "button",
                          { class: "gd-btn", onClick: () => downloadItem(item) },
                          "下载",
                        ),
                        h(
                          "button",
                          { class: "gd-btn", onClick: () => copyUrl(item), disabled: busy.value },
                          "复制直链",
                        ),
                      ]),
                    ]),
                  ),
                )
              : h("div", { class: "gd-empty" }, "输入关键词搜索 QQ 音乐 / 酷我 / 网易云等音源"),
          ]),

          h("div", { class: "gd-card" }, [
            h("div", { class: "gd-row", style: "justify-content:space-between;margin-bottom:8px;" }, [
              h("strong", { style: "font-size:13px;" }, `下载队列${tasks.value.length ? `（${tasks.value.length}）` : ""}`),
              h("span", { class: "gd-hint" }, `并发 ${DOWNLOAD_CONCURRENCY} 个 · 站点限流约 50 次/5 分钟`),
            ]),
            tasks.value.length
              ? h("div", { class: "gd-list" }, tasks.value.map(renderTask))
              : h("div", { class: "gd-empty" }, "队列是空的。可以从搜索结果、当前播放或批量文本添加。"),
          ]),

          h("div", { class: "gd-card" }, [
            h("div", { class: "gd-row", style: "justify-content:space-between;" }, [
              h("div", null, [
                h("strong", { style: "font-size:13px;" }, "网络代理"),
                h(
                  "div",
                  { class: "gd-hint" },
                  proxyState.value
                    ? `当前：${proxyModeLabel(proxyState.value.proxyMode)}${proxyState.value.proxyRules ? ` · ${proxyState.value.proxyRules}` : ""}`
                    : "读取中…",
                ),
              ]),
              h(
                "button",
                { class: "gd-btn", onClick: () => (showProxy.value = !showProxy.value) },
                showProxy.value ? "收起" : "配置",
              ),
            ]),
            showProxy.value
              ? h("div", { style: "margin-top:12px;display:grid;gap:10px;" }, [
                  h("div", { class: "gd-hint" }, [
                    "插件不单独设代理：播放在线音源与下载都沿用客户端全局网络设置。",
                    h("br"),
                    "这里改的是「设置 → 网络」，会同时影响酷狗播放，所以换完建议先点「检测出口」。",
                  ]),
                  h("div", { class: "gd-row" }, [
                    h(
                      "select",
                      {
                        class: "gd-select",
                        value: proxyMode.value,
                        onChange: (event) => {
                          proxyMode.value = event.target.value;
                        },
                      },
                      [
                        h("option", { value: "system" }, "跟随系统代理"),
                        h("option", { value: "direct" }, "强制直连"),
                        h("option", { value: "fixed_servers" }, "自定义代理"),
                      ],
                    ),
                    proxyMode.value === "fixed_servers"
                      ? h("input", {
                          class: "gd-input",
                          value: proxyRules.value,
                          placeholder: "http://127.0.0.1:1087",
                          onInput: (event) => {
                            proxyRules.value = event.target.value;
                          },
                        })
                      : null,
                    h(
                      "button",
                      {
                        class: "gd-btn gd-btn-primary",
                        disabled: busy.value || !proxy.supported(),
                        onClick: () => void applyProxy(proxyMode.value, proxyRules.value),
                      },
                      "应用",
                    ),
                    h(
                      "button",
                      { class: "gd-btn", onClick: checkEgress, disabled: busy.value },
                      "检测出口",
                    ),
                  ]),
                  !proxy.supported()
                    ? h("div", { class: "gd-hint" }, "当前版本不允许插件改网络设置，请到「设置 → 网络」手动配置；下面的检测仍可使用。")
                    : null,
                  egressInfo.value
                    ? h(
                        "div",
                        { class: "gd-hint" },
                        `出口 IP ${egressInfo.value.ip || "未知"} · 地区 ${egressInfo.value.loc || "?"} · 机房 ${egressInfo.value.colo || "?"} · ${egressInfo.value.ms}ms`,
                      )
                    : null,
                ])
              : null,
          ]),
        ]);
    },
  });
};

const proxyModeLabel = (mode) => {
  if (mode === "direct") return "强制直连";
  if (mode === "fixed_servers") return "自定义代理";
  if (mode === "pac_script") return "PAC 脚本";
  return "跟随系统代理";
};

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

export function activate(ctx) {
  let settings = { ...DEFAULT_SETTINGS };
  const runtime = createRuntime(ctx, () => settings);
  const proxy = createProxyApi(ctx);
  const engine = createDownloadEngine({ ctx, runtime, getSettings: () => settings });
  let disposeResolver = null;
  let disposePage = null;
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

    // 下载页（侧边栏入口）
    try {
      if (typeof ctx.css?.inject === "function") ctx.css.inject(PAGE_CSS, { id: "gd-download" });
      const addPage = ctx.ui?.addPage || ctx.ui?.pages?.register;
      if (typeof addPage === "function") {
        disposePage = addPage.call(ctx.ui, {
          id: "downloads",
          title: "GD 下载",
          icon: "mdi:tray-arrow-down",
          order: 60,
          sidebar: { section: "plugins", title: "GD 下载" },
          component: createDownloadPage({
            ctx,
            runtime,
            engine,
            getSettings: () => settings,
            proxy,
          }),
        });
        runtime.log("下载页已注册");
      } else {
        runtime.warn("当前版本不支持注册插件页面，下载功能仅在设置面板外不可用");
      }
    } catch (error) {
      console.warn(LOG_TAG, "下载页注册失败", error);
    }
  })();

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    try {
      disposePage?.();
    } catch {}
    disposePage = null;
    disposeResolver?.();
    disposeResolver = null;
  };

  ctx.dispose?.(cleanup);

  return cleanup;
}

export function deactivate() {
  // resolve 注册项由宿主在禁用时统一清理；这里只做幂等兜底。
}

export default { activate, deactivate };
