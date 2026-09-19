#!/usr/bin/env python3
"""
FLAC 文件元数据内嵌工具
支持：歌词、歌手、专辑、风格、年份、封面图片、翻译歌词等

参考实现（GD音乐台 API 刮削）：
- github.com/Azincc/gdstudio-embeded-service 的 internal/service/gdstudio/client.go
  （types=search/url/pic/lyric、封面尺寸回退、tlyric 翻译、镜像分流 cn/hk/us、指数退避）
- 签名沿用本技能 gd-international-downloader.js 实测有效的 crc32 方案：
  s = crc32Hex(encodeURIComponent(name 或 id))，POST x-www-form-urlencoded 到 <mirror>/api.php
"""

import os
import sys
import json
import time
import re
import argparse
import subprocess
import tempfile
import urllib.parse
import requests
from pathlib import Path
from datetime import datetime

# metaflac 在非 UTF-8 locale（如 DSH 沙箱默认的 C locale）下会把标签里的非 ASCII
# 字节替换成 '#'/'?'，导致中文标签损坏。强制 UTF-8 locale 使写入恒为 UTF-8。
METAFLAC_ENV = {**os.environ, 'LC_ALL': 'en_US.UTF-8', 'LANG': 'en_US.UTF-8'}


class GDMusicClient:
    """GD音乐台 API 客户端：搜索 / 封面 pic / 歌词 lyric

    签名方案（与 gd-international-downloader.js 一致，本站实测有效）：
      s = crc32Hex(encodeURIComponent(name 或 id))
    镜像分流（参考 gdstudio-embeded-service config.yaml）：
      migu/kugou/ximalaya -> cn，joox -> hk，qobuz/ytmusic -> us，其余默认
    限流口径：约 50 次/5 分钟，请求间隔由外层控制；失败按 1s,2s,4s,8s... 指数退避（上限 30s）。
    """

    DOMAINS = {
        "default": "music-api.gdstudio.xyz",
        "cn": "music-api-cn.gdstudio.xyz",
        "hk": "music-api-hk.gdstudio.xyz",
        "us": "music-api-us.gdstudio.xyz",
    }
    MIRROR_BY_SOURCE = {
        "migu": "cn", "kugou": "cn", "ximalaya": "cn",
        "joox": "hk",
        "qobuz": "us", "ytmusic": "us",
    }
    COVER_SIZES = (1000, 640, 500, 300)
    COVER_REFERERS = {
        "netease": "https://music.163.com/",
        "qq": "https://y.qq.com/",
        "kuwo": "https://www.kuwo.cn/",
    }

    def __init__(self, source="netease", timeout=15, max_retries=4):
        self.source = source
        self.timeout = timeout
        self.max_retries = max_retries
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        })

    # ------------------------------------------------------------------ 签名
    @staticmethod
    def _crc32(data: bytes) -> int:
        """标准 CRC32（与 gd-international-downloader.js 的 crc32() 一致）"""
        poly = 0xEDB88320
        crc = 0xFFFFFFFF
        for b in data:
            crc ^= b
            for _ in range(8):
                if crc & 1:
                    crc = (crc >> 1) ^ poly
                else:
                    crc >>= 1
        return (crc ^ 0xFFFFFFFF) & 0xFFFFFFFF

    @staticmethod
    def js_encode_uri_component(value) -> str:
        """等价于 JS encodeURIComponent（不编码 !~*'() ）"""
        return urllib.parse.quote(str(value), safe="!~*'()")

    def sign(self, value) -> str:
        return f"{self._crc32(self.js_encode_uri_component(value).encode('utf-8')):08X}"

    # ------------------------------------------------------------------ 请求
    def mirror_for(self, source=None) -> str:
        src = (source or self.source or "").lower()
        return self.DOMAINS.get(self.MIRROR_BY_SOURCE.get(src, "default"), self.DOMAINS["default"])

    def api_call(self, params, source=None, depth=0):
        """POST form 到 <mirror>/api.php，附 crc32 签名；429/401/网络错误指数退避重试。

        错误细分（借鉴 EchoMusic 对 ssa-code/限流的处理）：
        - 429 或 Retry-After：显式限流，按 Retry-After 或指数冷却（上限 60s）
        - 401 + 验证挑战关键词（verify/captcha/验证/滑块）：等待 12s 单次重试，避免死循环
        - 401 + Invalid request（签名过期/隐性限流）：指数退避重试
        """
        src = source or self.source
        domain = self.mirror_for(src)
        parts = []
        for k, v in params.items():
            if v is None or v == "":
                continue
            parts.append(f"{k}={urllib.parse.quote(str(v), safe='')}")
        sign_input = params.get("name") or params.get("id") or ""
        parts.append(f"s={self.sign(sign_input)}")
        url = f"https://{domain}/api.php"

        def wait_backoff():
            if depth < self.max_retries:
                time.sleep(min(2 ** depth, 30))

        try:
            resp = self.session.post(url, data="&".join(parts), timeout=self.timeout)
        except requests.RequestException:
            if depth < self.max_retries:
                wait_backoff()
                return self.api_call(params, source, depth + 1)
            raise

        # 429 显式限流：尊重 Retry-After 头，否则指数冷却（上限 60s）
        if resp.status_code == 429:
            if depth < self.max_retries:
                retry_after = resp.headers.get("Retry-After") or resp.headers.get("retry-after")
                try:
                    cool = float(retry_after) if retry_after else min(2 ** depth, 60)
                except (TypeError, ValueError):
                    cool = min(2 ** depth, 60)
                time.sleep(cool)
                return self.api_call(params, source, depth + 1)
            raise RuntimeError("触发站点限流(429)，请增大请求间隔稍后再试")

        if resp.status_code == 401 or (resp.status_code == 200 and "Invalid request" in resp.text[:200]):
            head = resp.text[:500]
            # 验证挑战（ssa-code / verify / captcha / 滑块）：等待后单次重试
            is_verify = bool(re.search(r"verify|captcha|验证|滑块|challenge", head, re.IGNORECASE))
            if is_verify and depth == 0:
                time.sleep(12)
                return self.api_call(params, source, depth + 1)
            # 签名失败/隐性限流：指数退避重试
            if depth < self.max_retries:
                wait_backoff()
                return self.api_call(params, source, depth + 1)

        try:
            return resp.json()
        except ValueError:
            return {"raw": resp.text}

    # ------------------------------------------------------------------ 业务
    def search(self, query, source=None, count=20):
        """types=search -> 结果列表（数组）"""
        result = self.api_call({
            "types": "search",
            "source": source or self.source,
            "name": query,
            "count": count,
            "pages": 1,
        }, source)
        return result if isinstance(result, list) else []

    def cover_url(self, pic_id, source=None, sizes=COVER_SIZES):
        """types=pic -> 封面 URL（按尺寸回退尝试，参考 gdstudio-embeded-service）"""
        for size in sizes:
            result = self.api_call({
                "types": "pic",
                "source": source or self.source,
                "id": pic_id,
                "size": size,
            }, source)
            if isinstance(result, dict):
                url = result.get("url")
                if url and url != "err":
                    return url
        return None

    def lyric(self, lyric_id, source=None):
        """types=lyric -> {lyric, tlyric}（tlyric 为翻译歌词）"""
        result = self.api_call({
            "types": "lyric",
            "source": source or self.source,
            "id": lyric_id,
        }, source)
        if isinstance(result, dict):
            return {"lyric": result.get("lyric", ""), "tlyric": result.get("tlyric", "")}
        return {"lyric": "", "tlyric": ""}

    def download_cover(self, cover_url, source=None):
        """下载封面字节；按源带 Referer（163/qq/kuwo），避免 CDN 403"""
        referer = self.COVER_REFERERS.get((source or self.source or "").lower(), "")
        headers = {"Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"}
        if referer:
            headers["Referer"] = referer
        try:
            resp = requests.get(cover_url, headers=headers, timeout=self.timeout)
            if resp.status_code == 200 and resp.content:
                return resp.content
        except requests.RequestException:
            pass
        return None

    # ------------------------------------------------------------------ 匹配
    @staticmethod
    def _split_artists(value):
        for sep in (" / ", "、", ";", ",", "/"):
            value = value.replace(sep, "|")
        return [p.strip() for p in value.split("|") if p.strip()]

    @staticmethod
    def _norm_key(value):
        return " ".join(
            value.replace("’", "'").replace("‘", "'").replace("\x60", "'").replace("＇", "'").lower().split()
        )

    @staticmethod
    def _to_str(v):
        if v is None:
            return ""
        if isinstance(v, str):
            return v.strip()
        if isinstance(v, (list, tuple)):
            names = []
            for item in v:
                if isinstance(item, dict):
                    names.append(str(item.get("name") or item.get("artistName") or "").strip())
                else:
                    names.append(str(item).strip())
            return " / ".join(n for n in names if n)
        if isinstance(v, dict):
            return str(v.get("name") or v.get("artistName") or "").strip()
        return str(v).strip()

    def pick_metadata(self, items, title, artist):
        """从搜索结果挑出可信条目：曲名等值 + 歌手部分匹配优先，其次兜底取带 id 的条目。
        参考 gdstudio-embeded-service 的 pickMetadata / TAG_MATCHING_LOGIC.md。
        返回 dict(TrackID/Title/Artist/Album/PicID/LyricID) 或 None。
        """
        if not items:
            return None
        norm_title = self._norm_key(title or "")
        norm_artist = self._norm_key(artist or "")

        def make(item):
            pic_id = self._to_str(item.get("pic_id")) or self._to_str(item.get("picid"))
            lyric_id = self._to_str(item.get("lyric_id")) or self._to_str(item.get("lyricid"))
            return {
                "TrackID": self._to_str(item.get("id")),
                "Title": self._to_str(item.get("name")) or self._to_str(item.get("title")),
                "Artist": self._to_str(item.get("artist")),
                "Album": self._to_str(item.get("album")),
                "PicID": pic_id,
                "LyricID": lyric_id,
            }

        # 1) 曲名等值 + 歌手部分匹配（最强信号，避免同名翻唱/串曲）
        if norm_title:
            for item in items:
                m = make(item)
                if self._norm_key(m["Title"]) != norm_title:
                    continue
                if norm_artist:
                    item_artists = [self._norm_key(a) for a in self._split_artists(m["Artist"])]
                    expected = self._split_artists(norm_artist)
                    hit = any(
                        ea == ia or ea in ia or ia in ea
                        for ea in expected for ia in item_artists
                    )
                    if not hit:
                        continue
                return m
        # 2) 兜底：取第一条带 id 的搜索结果（目标源条目本身）
        for item in items:
            m = make(item)
            if m["TrackID"]:
                return m
        return None



class FLACMetadataEmbedder:
    # 歌词源：Lrclib（西语/通用）+ NetEase（中文）。
    # 不列 Musixmatch / Genius / Megalobiz——它们在受限网络下几乎必然超时。
    LYRIC_PROVIDERS = ["Lrclib", "NetEase"]

    def __init__(self, downloads_dir, gd_source="netease", use_gdmusic=True, embed_cover=True):
        self.downloads_dir = Path(downloads_dir)
        self.gd_source = gd_source
        self.use_gdmusic = use_gdmusic
        self.embed_cover = embed_cover
        self._gd = None
        # (归一化曲名, 归一化歌手) -> pick_metadata 结果，避免同一首歌重复打搜索 API
        self._gd_track_cache = {}

    @property
    def gd(self):
        if self._gd is None:
            self._gd = GDMusicClient(source=self.gd_source)
        return self._gd

    def safe_filename(self, text):
        """生成安全的文件名"""
        import re
        return re.sub(r'[\\/*?:"<>|]', "", text).strip()

    @staticmethod
    def _lyric_fetcher():
        """取同目录 download_lyrics.py 的 fetch_lyrics，失败返回 None（调用方走后续兜底）。

        歌词抓取统一委托出去，避免与 download_lyrics.py 两套实现漂移。
        注意 download_lyrics.py 缺 syncedlyrics 时会 sys.exit()，所以要连带捕获 SystemExit。
        """
        try:
            here = str(Path(__file__).resolve().parent)
            if here not in sys.path:
                sys.path.insert(0, here)
            from download_lyrics import fetch_lyrics
            return fetch_lyrics
        except (Exception, SystemExit) as e:
            print(f"   ⚠️ 无法加载 download_lyrics.py（{e}），歌词将走后续兜底")
            return None

    def download_lyrics(self, title, artist, save_dir=None, audio_path=None):
        """下载同步歌词，保存到歌曲所在文件夹。

        抓取逻辑委托 download_lyrics.py（providers=Lrclib,NetEase、sync 优先、绝不编造），
        抓不到再依次回落 lrc.cx → GD音乐台 types=lyric。

        save_dir:   歌词保存目录（缺省为 downloads 根）
        audio_path: 给出时 .lrc 用「音频同名」命名（与 download_lyrics.py 目录模式一致，
                    播放器可按同名自动匹配）；否则退回 `歌手 - 歌名.lrc`
        """
        save_dir = Path(save_dir) if save_dir else self.downloads_dir
        save_dir.mkdir(parents=True, exist_ok=True)

        lrc_content = None
        fetch = self._lyric_fetcher()
        if fetch:
            try:
                text, _synced = fetch(
                    artist, title, providers=self.LYRIC_PROVIDERS, plain_ok=False)
                if text:
                    lrc_content = text
            except Exception as e:
                print(f"   ⚠️ 歌词抓取异常（{title} - {artist}）: {e}")

        if not lrc_content:
            # 备用 API
            try:
                resp = requests.get(
                    "https://api.lrc.cx/api/v1/lyrics/single",
                    params={"title": title, "artist": artist},
                    timeout=10
                )
                if resp.status_code == 200:
                    lrc_content = resp.text
            except Exception:
                pass

        if not lrc_content:
            return None

        if audio_path is not None:
            full_path = Path(audio_path).with_suffix(".lrc")
        else:
            fn = self.safe_filename(f"{artist} - {title}.lrc")
            full_path = save_dir / fn
        with open(full_path, "w", encoding="utf-8") as f:
            f.write(lrc_content)
        return str(full_path)


    @staticmethod
    def _pretty_album(name):
        """搜索返回的专辑名常是全小写（如 `modal soul`），按需转成标题式大小写。
        已经是混合大小写（如 `Luv(sic) Hexalogy`）的原样保留，避免破坏既有写法。
        """
        name = (name or "").strip()
        if not name:
            return ""
        if name.islower() or name.isupper():
            return " ".join(w[:1].upper() + w[1:] for w in name.split())
        return name

    def resolve_gd_track(self, title, artist, count=20):
        """搜索并挑出可信条目，结果按 (title, artist) 缓存。

        一次搜索同时供给「专辑名 / 封面 / 歌词」三处使用，避免同一首歌重复打 API
        （既省配额，也降低触发站点限流的概率）。失败返回 None。
        """
        if not self.use_gdmusic:
            return None
        key = (GDMusicClient._norm_key(title), GDMusicClient._norm_key(artist))
        if key in self._gd_track_cache:
            return self._gd_track_cache[key]
        meta = None
        try:
            items = self.gd.search(f"{title} {artist}", count=count)
            meta = self.gd.pick_metadata(items, title, artist)
        except Exception as e:
            print(f"⚠️ GD音乐台搜索失败（{title} - {artist}）: {e}")
        self._gd_track_cache[key] = meta
        return meta

    def download_gd_lyrics(self, title, artist, save_dir=None, gd_meta=None, audio_path=None):
        """GD音乐台歌词兜底：搜索 -> 取 lyric_id -> types=lyric（含 tlyric 翻译）
        返回 (lrc_path, translation)；失败返回 (None, None)

        audio_path 给出时 .lrc 与音频同名，与 download_lyrics() / download_lyrics.py
        保持一致——否则同一首歌会被两条路径写出两份命名不同的 .lrc。
        """
        if not self.use_gdmusic:
            return None, None
        try:
            meta = gd_meta if gd_meta is not None else self.resolve_gd_track(title, artist)
            if not meta or not meta.get("LyricID"):
                return None, None
            data = self.gd.lyric(meta["LyricID"])
            lrc = (data.get("lyric") or "").strip()
            if not lrc:
                return None, None
            save_dir = Path(save_dir) if save_dir else self.downloads_dir
            save_dir.mkdir(parents=True, exist_ok=True)
            if audio_path is not None:
                path = Path(audio_path).with_suffix(".lrc")
            else:
                path = save_dir / self.safe_filename(f"{artist} - {title}.lrc")
            with open(path, "w", encoding="utf-8") as f:
                f.write(lrc)
            translation = (data.get("tlyric") or "").strip()
            return str(path), (translation or None)
        except Exception as e:
            print(f"⚠️ GD音乐台歌词获取失败（{title} - {artist}）: {e}")
            return None, None

    def resolve_cover(self, title, artist, gd_meta=None):
        """解析并下载封面：搜索 -> pick pic_id -> types=pic（尺寸回退）-> 下载字节
        返回封面字节或 None
        """
        if not self.use_gdmusic or not self.embed_cover:
            return None
        try:
            meta = gd_meta if gd_meta is not None else self.resolve_gd_track(title, artist)
            if not meta or not meta.get("PicID"):
                print(f"⚠️ 未找到封面（{title} - {artist}）")
                return None
            url = self.gd.cover_url(meta["PicID"])
            if not url:
                print(f"⚠️ 封面 URL 获取失败（{title} - {artist}）")
                return None
            data = self.gd.download_cover(url)
            if not data:
                print(f"⚠️ 封面下载失败（{title} - {artist}）")
                return None
            return data
        except Exception as e:
            print(f"⚠️ 封面解析异常（{title} - {artist}）: {e}")
            return None


    def get_metadata_from_filename(self, filename):
        """从文件名解析歌手和歌名（歌手 - 歌名.flac/.mp3/...）"""
        stem = Path(filename).stem
        if " - " in stem:
            parts = stem.split(" - ", 1)
            if len(parts) == 2:
                return parts[0].strip(), parts[1].strip()
        return None, None

    # 已知复合风格：拆分 StyleTag 时不能把它们切成两个词（Lo-fi 不能变 "Lo, fi"）
    GENRE_COMPOUNDS = (
        "Lo-Fi", "Hip-Hop", "Trip-Hop", "Future-Bass", "Nu-Disco", "Nu-Jazz",
        "Post-Rock", "Post-Punk", "Drum-Bass", "Synth-Pop", "Dream-Pop",
        "Ambient-Pop", "Chill-Wave", "Deep-House", "Tech-House", "Acid-Jazz",
        "Downtempo", "Nu-Gaze", "Electro-Swing", "Jazzhop",
        "Boom-Bap", "Jazz-Rap", "G-Funk", "West-Coast",
        "Emo-Phonk", "Drift-Phonk", "Emo-Rap", "Hyperpop", "Cloud-Rap",
    )

    @staticmethod
    def _has_cjk(text):
        return any('一' <= ch <= '鿿' for ch in text)

    @classmethod
    def _style_tag_from_folder(cls, folder_name):
        """从 `NN-中文描述-StyleTag` 里剥出 ASCII 风格标签段"""
        parts = []
        for p in str(folder_name).split("-"):
            p = p.strip()
            if not p or p.isdigit() or cls._has_cjk(p):
                continue
            parts.append(p)
        return "-".join(parts)

    @classmethod
    def derive_genre_from_tag(cls, style_tag):
        """把 StyleTag（`Jazzhop-Lo-fi-Hip-Hop`）拆成 `Jazzhop, Lo-fi, Hip-Hop`"""
        tokens = [t for t in re.split(r"[-_\s]+", style_tag or "") if t]
        if not tokens:
            return ""
        lowered = {c.lower() for c in cls.GENRE_COMPOUNDS}
        merged, i = [], 0
        while i < len(tokens):
            if i + 1 < len(tokens) and f"{tokens[i]}-{tokens[i + 1]}".lower() in lowered:
                merged.append(f"{tokens[i]}-{tokens[i + 1]}")
                i += 2
            else:
                merged.append(tokens[i])
                i += 1
        out, seen = [], set()
        for g in merged:
            if g.lower() not in seen:
                seen.add(g.lower())
                out.append(g)
        return ", ".join(out)

    def get_genre_from_folder(self, folder_name):
        """根据文件夹名获取风格。

        优先级：显式映射表 → 从 StyleTag 推导 → 兜底 Electronic（并告警，不再静默）。
        """
        genre_mapping = {
            "Synthwave-Chillwave": "Synthwave, Chillwave",
            "Melodic-Future-Bass-Glitch": "Future Bass, Glitch",
            "Chillhop-Lofi-Synth-Electronica": "Chillhop, Lo-fi, Electronic",
            "Folktronica-Ambient-Pop": "Folktronica, Ambient, Pop",
            "Space-Ambient-Modular-Synth": "Space, Ambient, Modular Synth",
            "Emotional-Synth-Melancholy": "Emotional Synth, Melancholy",
            "Emo-Phonk": "Phonk, Emo Rap, 意境说唱",
        }

        for key, genre in genre_mapping.items():
            if key in folder_name:
                return genre

        derived = self.derive_genre_from_tag(self._style_tag_from_folder(folder_name))
        if derived:
            print(f"ℹ️  风格标签未在映射表中，按目录名推导: {folder_name} → {derived}")
            return derived

        print(f"⚠️ 无法从目录名推导风格，回落 Electronic: {folder_name}"
              f"（建议用 `NN-中文描述-StyleTag` 命名，如 01-梦幻复古合成器-Synthwave）")
        return "Electronic"

    def get_album_info(self, artist, genre):
        """根据歌手和风格获取专辑信息"""
        album_info = {
            "周杰伦": {
                "album": "魔杰座",
                "year": "2008",
                "composer": "周杰伦",
                "albumartist": "周杰伦"
            },
            "Daft Punk": {
                "album": "Random Access Memories",
                "year": "2013",
                "composer": "Daft Punk",
                "albumartist": "Daft Punk"
            },
            "The Midnight": {
                "album": "Nocturnal",
                "year": "2022",
                "composer": "The Midnight",
                "albumartist": "The Midnight"
            },
            "HOME": {
                "album": "Resonance",
                "year": "2022",
                "composer": "HOME",
                "albumartist": "HOME"
            },
            "Nujabes": {
                "album": "Luv(sic) Hexalogy",
                "year": "2001-2013",
                "composer": "Nujabes",
                "albumartist": "Nujabes"
            }
        }

        return album_info.get(artist, {
            "album": f"{artist} Collection",
            "year": str(datetime.now().year),
            "composer": artist,
            "albumartist": artist
        })


    @staticmethod
    def _clean_lyrics_for_tag(lyrics_content, max_len=5000):
        """清理歌词为适合 Vorbis 注释的纯文本（剥离 LRC 时间戳与元信息，保留歌词文本）"""
        cleaned = []
        for line in lyrics_content.split('\n'):
            line = line.strip()
            if not line:
                continue
            # LRC 行形如 "[00:29.30] 故事的小黃花" 或 "[ti:歌名]"：
            # 剥离所有 [..] 前缀（时间戳与元信息标签），保留其后歌词文本
            while line.startswith('['):
                end = line.find(']')
                if end < 0:
                    line = ''
                    break
                line = line[end + 1:].strip()
            if not line:
                continue
            if line.startswith('<'):
                continue
            if any(line.startswith(k) for k in ("作曲:", "作词:", "编曲:", "制作人:", "演唱:")):
                continue
            cleaned.append(line)
        if not cleaned:
            return ""
        text = ' '.join(cleaned)
        return text[:max_len]

    @staticmethod
    def _normalize_cover_jpeg(data, max_size=1000):
        """把任意封面字节归一化为 JPEG（RGB、可选缩放到 max_size）。

        山灵等播放器只认 JPEG 封面，PNG 会被显示为「无封面」；GD 个别音源返回的就是
        PNG，故在写入前统一转格式，从源头杜绝 PNG 封面复发。转换失败则原样返回。
        """
        if not data:
            return data
        try:
            from io import BytesIO
            from PIL import Image
        except Exception:
            return data
        try:
            img = Image.open(BytesIO(data))
            if img.mode != "RGB":
                img = img.convert("RGB")
            if max(img.size) > max_size:
                img.thumbnail((max_size, max_size))
            buf = BytesIO()
            img.save(buf, "JPEG", quality=90)
            return buf.getvalue()
        except Exception:
            return data

    def embed_metadata(self, flac_path, metadata):
        """使用 metaflac 内嵌元数据（封面先处理，标签最后写，避免 PICTURE 重写影响标签）"""
        try:
            flac_path = str(flac_path)

            # 封面内嵌（先清旧 PICTURE 再导入；此步会重写文件，故标签放到最后再写）
            # 写入前统一归一化为 JPEG，避免个别音源返回的 PNG 封面在山灵上不显示
            cover_data = self._normalize_cover_jpeg(metadata.get("cover_data"))
            if cover_data:
                cover_tmp = None
                try:
                    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tf:
                        tf.write(cover_data)
                        cover_tmp = tf.name
                    r1 = subprocess.run(
                        ['metaflac', '--remove', '--block-type=PICTURE', flac_path],
                        capture_output=True, text=True, env=METAFLAC_ENV
                    )
                    r2 = subprocess.run(
                        ['metaflac', f'--import-picture-from={cover_tmp}', flac_path],
                        capture_output=True, text=True, env=METAFLAC_ENV
                    )
                    if r1.returncode != 0 or r2.returncode != 0:
                        print(f"⚠️ 封面内嵌失败: {flac_path}")
                        print(f"   metaflac: {r2.stderr or r1.stderr}")
                finally:
                    if cover_tmp:
                        try:
                            os.unlink(cover_tmp)
                        except OSError:
                            pass

            # 先清空旧标签，避免重复值堆积（PICTURE 块单独处理）
            cmd = ['metaflac', '--remove-all-tags', flac_path]

            # 添加标签
            tags = [
                f'TITLE={metadata.get("title", "")}',
                f'ARTIST={metadata.get("artist", "")}',
                f'ALBUM={metadata.get("album", "")}',
                f'ALBUMARTIST={metadata.get("albumartist", "")}',
                f'COMPOSER={metadata.get("composer", "")}',
                f'GENRE={metadata.get("genre", "")}',
                f'DATE={metadata.get("year", "")}',
                f'TRACKNUMBER={metadata.get("track", "")}',
                f'TOTALTRACKS={metadata.get("totaltracks", "")}',
                f'COMMENT={metadata.get("comment", "")}'
            ]

            # 多值艺术家标签（参考 gdstudio-embeded-service tagger）
            artist = metadata.get("artist", "")
            if artist:
                tags.append(f'ARTISTS={artist}')

            # 歌词
            if metadata.get('lyrics'):
                cleaned_lyrics = self._clean_lyrics_for_tag(metadata['lyrics'])
                if cleaned_lyrics:
                    tags.append(f'LYRICS={cleaned_lyrics}')

            # 翻译歌词
            if metadata.get('translation'):
                cleaned_trans = self._clean_lyrics_for_tag(metadata['translation'])
                if cleaned_trans:
                    tags.append(f'LYRICS_TRANSLATED={cleaned_trans}')

            # 添加所有标签
            for tag in tags:
                cmd.extend(['--set-tag', tag])

            # 执行命令（强制 UTF-8 locale，避免 C locale 下中文标签被替换为 #/?）
            result = subprocess.run(cmd, capture_output=True, text=True, env=METAFLAC_ENV)

            if result.returncode != 0:
                print(f"❌ 元数据内嵌失败: {flac_path}")
                print(f"错误: {result.stderr}")
                return False

            print(f"✅ 元数据已内嵌: {flac_path}"
                  + ("（含封面）" if cover_data else "")
                  + ("（含翻译歌词）" if metadata.get('translation') else ""))
            return True

        except Exception as e:
            print(f"❌ 元数据内嵌异常: {flac_path}")
            print(f"错误: {e}")
            return False

    def embed_metadata_mp3(self, mp3_path, metadata):
        """使用 mutagen 内嵌 MP3 元数据（封面 APIC + 基本 ID3 标签）。
        FLAC 之外的有损格式（如本次降级拿到的 MP3 320）也能在播放器显示专辑封面。"""
        try:
            from mutagen.mp3 import MP3
            from mutagen.id3 import ID3, TIT2, TPE1, TALB, TCON, TRCK, APIC, USLT, error
        except ImportError:
            print("⚠️ 未安装 mutagen，跳过 MP3 标签内嵌（pip install mutagen 后重试）")
            return False
        try:
            mp3_path = str(mp3_path)
            audio = MP3(mp3_path, ID3=ID3)
            try:
                audio.add_tags()
            except error:
                pass
            tags = audio.tags

            def set_frame(frame, val):
                if val:
                    tags.delall(frame.__name__)
                    tags.add(frame(encoding=3, text=val))

            set_frame(TIT2, metadata.get("title", ""))
            set_frame(TPE1, metadata.get("artist", ""))
            set_frame(TALB, metadata.get("album", ""))
            set_frame(TCON, metadata.get("genre", ""))
            trck = metadata.get("track", "")
            tt = metadata.get("totaltracks", "")
            if trck:
                set_frame(TRCK, f"{trck}/{tt}" if tt else trck)

            cover = self._normalize_cover_jpeg(metadata.get("cover_data"))
            if cover:
                # 归一化后保证为 JPEG（山灵等播放器只认 JPEG 封面）
                tags.delall("APIC")
                tags.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="Cover", data=cover))

            if metadata.get("lyrics"):
                cleaned = self._clean_lyrics_for_tag(metadata["lyrics"])
                if cleaned:
                    tags.delall("USLT")
                    tags.add(USLT(encoding=3, lang="eng", desc="", text=cleaned))

            audio.save(v2_version=3)
            print(f"✅ 元数据已内嵌(MP3): {mp3_path}" + ("（含封面）" if cover else ""))
            return True
        except Exception as e:
            print(f"❌ MP3 元数据内嵌异常: {mp3_path}")
            print(f"错误: {e}")
            return False


    @staticmethod
    def _track_number(playlist, title, artist, default="1"):
        """按 playlist.json 里的顺序取曲目号；未匹配则回落到 default"""
        want_t = GDMusicClient._norm_key(title)
        want_a = GDMusicClient._norm_key(artist)
        for i, entry in enumerate(playlist or [], start=1):
            if not isinstance(entry, dict):
                continue
            if (GDMusicClient._norm_key(entry.get("title", "")) == want_t
                    and GDMusicClient._norm_key(entry.get("artist", "")) == want_a):
                return str(i)
        return default

    def _build_metadata(self, flac_file, folder, playlist, genre, album_info,
                        title, artist, gd_meta=None):
        """构建并补全元数据（专辑 / 歌词 / 翻译 / 封面），返回 metadata dict

        gd_meta 为 resolve_gd_track() 的搜索命中条目；专辑名优先取其中的真实专辑，
        取不到才回落到「歌手 -> 内置专辑表」的硬编码值。
        """
        # 专辑：刮削结果优先，内置表兜底
        scraped_album = self._pretty_album((gd_meta or {}).get("Album"))
        album = scraped_album or album_info['album']
        if scraped_album and scraped_album != album_info['album']:
            print(f"   专辑: 采用刮削结果 {scraped_album!r}（内置表为 {album_info['album']!r}）")

        # 下载歌词（保存到歌曲所在文件夹，.lrc 与音频同名）
        lyrics_path = self.download_lyrics(title, artist, save_dir=folder, audio_path=flac_file)
        lyrics_content = None
        translation = None
        if lyrics_path:
            with open(lyrics_path, 'r', encoding='utf-8') as f:
                lyrics_content = f.read()
        else:
            # GD音乐台歌词兜底（含翻译）
            gd_path, translation = self.download_gd_lyrics(
                title, artist, save_dir=folder, gd_meta=gd_meta, audio_path=flac_file)
            if gd_path:
                with open(gd_path, 'r', encoding='utf-8') as f:
                    lyrics_content = f.read()

        # 封面
        cover_data = self.resolve_cover(title, artist, gd_meta=gd_meta)

        return {
            'title': title,
            'artist': artist,
            'album': album,
            'albumartist': album_info['albumartist'],
            'composer': album_info['composer'],
            'genre': genre,
            'year': album_info['year'],
            'track': self._track_number(playlist, title, artist),
            'totaltracks': str(len(playlist)),
            'comment': f'Genre: {genre} | Source: music.gdstudio.org',
            'lyrics': lyrics_content,
            'translation': translation,
            'cover_data': cover_data,
        }

    def process_all_files(self):
        """处理所有FLAC文件"""
        print("开始处理FLAC文件元数据...")

        total_files = 0
        processed_files = 0
        failed_files = 0

        # 遍历所有文件夹
        for folder in self.downloads_dir.glob("downloads/0*"):
            if not folder.is_dir():
                continue

            folder_name = folder.name
            genre = self.get_genre_from_folder(folder_name)

            # 读取歌单
            playlist_path = folder / "playlist.json"
            if playlist_path.exists():
                with open(playlist_path, 'r', encoding='utf-8') as f:
                    playlist = json.load(f)
            else:
                playlist = []

            # 处理 FLAC 与 MP3 文件（MP3 多为降级拿到的有损格式，同样内嵌封面/标签）
            audio_files = list(folder.glob("*.flac")) + list(folder.glob("*.mp3"))
            audio_files.sort()
            for audio_file in audio_files:
                total_files += 1

                # 从文件名解析歌手和歌名
                artist, title = self.get_metadata_from_filename(audio_file.name)

                if not artist or not title:
                    print(f"⚠️ 无法解析文件名: {audio_file.name}")
                    failed_files += 1
                    continue

                # 获取专辑信息（内置表兜底用）
                album_info = self.get_album_info(artist, genre)

                # 一次搜索供专辑名 / 封面 / 歌词共用
                gd_meta = self.resolve_gd_track(title, artist)

                metadata = self._build_metadata(audio_file, folder, playlist, genre,
                                                album_info, title, artist, gd_meta=gd_meta)

                # 内嵌元数据（FLAC 用 metaflac，MP3 用 mutagen）
                if audio_file.suffix.lower() == ".mp3":
                    ok = self.embed_metadata_mp3(audio_file, metadata)
                else:
                    ok = self.embed_metadata(audio_file, metadata)
                if ok:
                    processed_files += 1
                else:
                    failed_files += 1

        print(f"\n处理完成:")
        print(f"总文件数: {total_files}")
        print(f"成功处理: {processed_files}")
        print(f"处理失败: {failed_files}")

        return processed_files, failed_files



def main():
    parser = argparse.ArgumentParser(description='FLAC文件元数据内嵌工具')
    parser.add_argument('--downloads-dir', default=str(Path.cwd()),
                       help='下载目录路径（默认当前工作目录，需其下含 downloads/0* 风格文件夹）')
    parser.add_argument('--single-file', help='处理单个文件')
    parser.add_argument('--list-genres', action='store_true', help='列出所有风格')
    parser.add_argument('--gd-source', default='netease',
                       help='GD音乐台刮削音源（netease/kuwo/qobuz/joox/migu/ytmusic 等，默认 netease）')
    parser.add_argument('--no-gdmusic', action='store_true',
                       help='不使用 GD音乐台 API（跳过封面/翻译歌词/歌词兜底）')
    parser.add_argument('--no-cover', action='store_true',
                       help='不内嵌封面')

    args = parser.parse_args()

    # 检查 metaflac 依赖
    if subprocess.run(['which', 'metaflac'], capture_output=True).returncode != 0:
        print("metaflac 未安装，正在安装...")
        if os.name == 'posix':
            subprocess.run(['brew', 'install', 'flac'])
        else:
            print("请手动安装 FLAC 工具: https://xiph.org/flac/")

    embedder = FLACMetadataEmbedder(
        args.downloads_dir,
        gd_source=args.gd_source,
        use_gdmusic=not args.no_gdmusic,
        embed_cover=not args.no_cover,
    )

    if args.list_genres:
        print("支持的风格:")
        for genre in embedder.get_genre_from_folder("test").split(", "):
            print(f"  - {genre}")
        return

    if args.single_file:
        # 处理单个文件
        flac_path = Path(args.single_file)
        if not flac_path.exists():
            print(f"文件不存在: {flac_path}")
            return

        artist, title = embedder.get_metadata_from_filename(flac_path.name)
        if not artist or not title:
            print(f"无法解析文件名: {flac_path.name}")
            return

        # 风格同样按所在目录推导，不再一律写死 Electronic
        genre = embedder.get_genre_from_folder(flac_path.parent.name)
        album_info = embedder.get_album_info(artist, genre)
        gd_meta = embedder.resolve_gd_track(title, artist)

        metadata = embedder._build_metadata(
            flac_path, flac_path.parent, [], genre, album_info, title, artist, gd_meta=gd_meta
        )
        metadata['totaltracks'] = '1'

        if flac_path.suffix.lower() == ".mp3":
            embedder.embed_metadata_mp3(flac_path, metadata)
        else:
            embedder.embed_metadata(flac_path, metadata)
    else:
        # 处理所有文件
        embedder.process_all_files()


if __name__ == "__main__":
    main()
