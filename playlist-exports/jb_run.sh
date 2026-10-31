#!/bin/bash
# Justin Bieber 全收录：org 直连下载 → 内嵌元数据
cd "/Users/tommydu/Documents/automatic downloading music"
NODE=/Users/tommydu/.workbuddy/binaries/node/versions/22.22.2-6/bin/node
PY=/Users/tommydu/.workbuddy/binaries/python/envs/default/bin/python
DIR="/Volumes/MEMORY CARD/Music/06-JustinBieber-全收录-Pop"
LOG="/Users/tommydu/Documents/automatic downloading music/playlist-exports"
echo "===== $(date '+%H:%M') 开始下载 ====="
"$NODE" gd-browser-downloader.js --list "$LOG/jb-songs.json" --site org --proxy "direct://" \
  --chrome-port 9334 --chrome-profile /tmp/gd-org-profile-0925 \
  --out "$DIR" --delay 6 >> "$LOG/jb-download.log" 2>&1
echo "===== $(date '+%H:%M') 下载结束 (exit $?), 开始内嵌 ====="
# 内嵌：目录名以 0 开头（embedder 的 glob 要求）
rm -rf /tmp/embed_jb && mkdir -p /tmp/embed_jb/downloads
ln -s "$DIR" /tmp/embed_jb/downloads/06-JustinBieber-全收录-Pop
no_proxy='*' NO_PROXY='*' http_proxy= https_proxy= "$PY" flac_metadata_embedder.py \
  --downloads-dir /tmp/embed_jb >> "$LOG/jb-embed.log" 2>&1
echo "===== $(date '+%H:%M') 内嵌结束 (exit $?) ALL DONE ====="
