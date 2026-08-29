#!/usr/bin/env python3
"""
Lyrics Downloader — fetch SYNCED (timestamped) .lrc lyrics.

Powered by the `syncedlyrics` library, which aggregates multiple providers
(Lrclib, NetEase, Deezer, Genius, Musixmatch, ...). Works for BOTH Western
and Chinese (C-pop) songs, and returns time-synced LRC by default.

Two modes:
  1. Directory mode — batch-process every audio file in a folder (recursive).
  2. Single-song mode — fetch one song by title/artist.

Design rules (do not violate):
  - NEVER fabricate lyrics. If nothing is found, report it truthfully and
    write NO file (no empty placeholder pollution).
  - Prefer synced LRC; fall back to plain lyrics only if explicitly allowed.
  - Always print the full absolute save path of every .lrc written.

Usage:
  # Directory (batch)
  python3 download_lyrics.py <directory>
  python3 download_lyrics.py <directory> --force --plain-ok

  # Single song
  python3 download_lyrics.py --title "Fortnight" --artist "Taylor Swift" \
      --out "/path/to/save"
  python3 download_lyrics.py --song "Taylor Swift - Fortnight" --out ./

Options:
  --force         Re-download even if a .lrc already exists (dir mode)
  --plain-ok      Accept plain (non-synced) lyrics if synced not found
  --providers     Comma list, default "Lrclib,NetEase" (fast + CN-capable).
                  Musixmatch is excluded by default because it often times out.
  --delay N       Seconds between songs (dir mode, default 0.4)
  --out PATH      Output dir (single-song mode); default = current dir
  --lang CODE     Preferred lyric language hint (e.g. "zh")
"""

import os
import re
import sys
import time
import argparse

try:
    import syncedlyrics
except ImportError:
    sys.exit("ERROR: syncedlyrics not installed. Run:\n"
             f"  {sys.executable} -m pip install syncedlyrics")

# Optional: read embedded tags when filename lacks 'Artist - Title'
# 装了 mutagen 才能在文件名解析不出「歌手 - 歌名」时回落到内嵌标签
try:
    from mutagen import File as MutagenFile
    HAVE_MUTAGEN = True
except ImportError:
    HAVE_MUTAGEN = False

AUDIO_EXTS = {'.flac', '.mp3', '.m4a', '.aac', '.ogg', '.wav', '.wma'}
DEFAULT_PROVIDERS = ["Lrclib", "NetEase"]


# ----------------------------- file discovery -----------------------------

def find_audio_files(directory):
    """Recursively find audio files, skipping hidden dirs and macOS ._ junk."""
    out = []
    for root, dirs, files in os.walk(directory):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for f in files:
            if f.startswith('._'):        # macOS AppleDouble junk
                continue
            if os.path.splitext(f.lower())[1] in AUDIO_EXTS:
                out.append(os.path.join(root, f))
    return sorted(out)


def parse_filename(filepath):
    """Extract (artist, title) from filename patterns like:
       'The Weeknd - Blinding Lights.flac'
       '01. Taylor Swift - Fortnight.flac'
       '05. 周杰伦 - 东风破.flac'
    Returns (artist, title) or (None, None)."""
    name = os.path.splitext(os.path.basename(filepath))[0]
    name = re.sub(r'^\s*\d+[\.\-]?\s*', '', name)      # strip leading "01. "
    m = re.split(r'\s*[-–—]\s*', name, maxsplit=1)
    if len(m) == 2 and m[0].strip() and m[1].strip():
        return m[0].strip(), m[1].strip()
    return None, None


def tags_artist_title(filepath):
    """Fall back to embedded tags for artist/title."""
    if not HAVE_MUTAGEN:
        return None, None
    try:
        a = MutagenFile(filepath, easy=True)
        if a and a.tags:
            t = a.tags.get('title') or a.tags.get('TITLE')
            ar = a.tags.get('artist') or a.tags.get('ARTIST')
            t = (t[0] if isinstance(t, list) else t) if t else None
            ar = (ar[0] if isinstance(ar, list) else ar) if ar else None
            if t:
                return ar, t
    except Exception:
        pass
    return None, None


def resolve_artist_title(filepath):
    artist, title = parse_filename(filepath)
    if not title:
        artist, title = tags_artist_title(filepath)
    return artist, title


# ----------------------------- lyric fetching -----------------------------

def is_synced(text):
    return bool(re.search(r'\[\d{1,2}:\d{2}', text or ''))


def fetch_lyrics(artist, title, providers, plain_ok=False, lang=None):
    """Return (lyrics_text, synced_bool) or (None, False).
    Tries synced first; only accepts plain if plain_ok."""
    term = f"{title} {artist}".strip() if artist else str(title).strip()

    # 1) synced only
    try:
        r = syncedlyrics.search(term, synced_only=True,
                                providers=providers, lang=lang)
        if r and is_synced(r):
            return r, True
    except Exception:
        pass

    # 2) any (may be plain) if allowed
    if plain_ok:
        try:
            r = syncedlyrics.search(term, providers=providers, lang=lang)
            if r:
                return r, is_synced(r)
        except Exception:
            pass

    return None, False


def write_lrc(path, text):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text.strip() + '\n')
    return os.path.abspath(path)


# ----------------------------- modes -----------------------------

def run_directory(directory, providers, force, plain_ok, delay, lang):
    directory = os.path.abspath(directory)
    if not os.path.isdir(directory):
        sys.exit(f"ERROR: '{directory}' is not a directory")

    audio = find_audio_files(directory)
    if not audio:
        print(f"No audio files found in {directory}")
        return

    total = len(audio)
    added_synced = added_plain = skipped = notfound = unparse = 0
    written_paths = []
    notfound_list = []

    print(f"\nScanning {total} audio files in: {directory}")
    print(f"Providers: {', '.join(providers)} | synced-first | "
          f"plain_ok={plain_ok}\n")

    for i, fp in enumerate(audio, 1):
        artist, title = resolve_artist_title(fp)
        base = os.path.basename(fp)
        if not title:
            print(f"  [{i}/{total}] ⚠️  cannot parse: {base}")
            unparse += 1
            continue

        lrc_path = os.path.splitext(fp)[0] + '.lrc'
        if os.path.exists(lrc_path) and not force:
            skipped += 1
            continue

        who = f"{artist} - {title}" if artist else title
        print(f"  [{i}/{total}] 🔍 {who} ... ", end='', flush=True)

        text, synced = fetch_lyrics(artist, title, providers, plain_ok, lang)
        if text:
            p = write_lrc(lrc_path, text)
            written_paths.append(p)
            if synced:
                print("✅ synced")
                added_synced += 1
            else:
                print("✅ plain")
                added_plain += 1
        else:
            print("❌ not found")
            notfound += 1
            notfound_list.append(who)

        time.sleep(delay)

    # summary
    print(f"\n{'='*56}")
    print(f"Total audio:      {total}")
    print(f"  Synced added:   {added_synced}")
    print(f"  Plain added:    {added_plain}")
    print(f"  Skipped exist:  {skipped}")
    print(f"  Not found:      {notfound}")
    if unparse:
        print(f"  Unparseable:    {unparse}")
    print(f"{'='*56}")

    if written_paths:
        print("\nSaved .lrc files:")
        for p in written_paths:
            print(f"  {p}")
    if notfound_list:
        print("\nNot found (no file written, lyrics NOT fabricated):")
        for w in notfound_list:
            print(f"  - {w}")


def run_single(title, artist, out_dir, providers, plain_ok, lang):
    if not title:
        sys.exit("ERROR: --title required (or --song 'Artist - Title')")
    out_dir = os.path.abspath(out_dir or '.')
    os.makedirs(out_dir, exist_ok=True)

    who = f"{artist} - {title}" if artist else title
    print(f"Searching: {who}")
    print(f"Providers: {', '.join(providers)} | plain_ok={plain_ok}\n")

    text, synced = fetch_lyrics(artist, title, providers, plain_ok, lang)
    if not text:
        print(f"❌ No lyrics found for '{who}'. Lyrics were NOT fabricated. "
              f"No file written.")
        sys.exit(2)

    safe = re.sub(r'[/\\:]', '_', who)
    lrc_path = os.path.join(out_dir, f"{safe}.lrc")
    p = write_lrc(lrc_path, text)
    print(f"✅ {'synced' if synced else 'plain'} lyrics saved.")
    print(f"Full path: {p}")


# ----------------------------- CLI -----------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Fetch synced .lrc lyrics via syncedlyrics")
    ap.add_argument('directory', nargs='?',
                    help='Directory of audio files (batch mode)')
    ap.add_argument('--title', help='Song title (single-song mode)')
    ap.add_argument('--artist', help='Artist name (single-song mode)')
    ap.add_argument('--song', help="'Artist - Title' shorthand (single mode)")
    ap.add_argument('--out', help='Output dir for single-song mode')
    ap.add_argument('--force', action='store_true',
                    help='Re-download even if .lrc exists (dir mode)')
    ap.add_argument('--plain-ok', action='store_true',
                    help='Accept plain lyrics if synced not found')
    ap.add_argument('--providers', default=','.join(DEFAULT_PROVIDERS),
                    help='Comma-separated providers (default Lrclib,NetEase)')
    ap.add_argument('--delay', type=float, default=0.4,
                    help='Delay between songs in dir mode (default 0.4)')
    ap.add_argument('--lang', help='Preferred lyric language hint (e.g. zh)')
    args = ap.parse_args()

    providers = [p.strip() for p in args.providers.split(',') if p.strip()]

    # single-song shorthand
    title, artist = args.title, args.artist
    if args.song and not title:
        parts = re.split(r'\s*[-–—]\s*', args.song, maxsplit=1)
        if len(parts) == 2:
            artist, title = parts[0].strip(), parts[1].strip()
        else:
            title = args.song.strip()

    if title:   # single-song mode
        run_single(title, artist, args.out, providers, args.plain_ok, args.lang)
    elif args.directory:  # batch mode
        run_directory(args.directory, providers, args.force,
                      args.plain_ok, args.delay, args.lang)
    else:
        ap.print_help()
        sys.exit("\nERROR: provide a <directory> or --title/--song")


if __name__ == '__main__':
    main()
