#!/bin/bash
# 第三棒：等 K-ballad 结束后，补齐批次1剩余纯音乐 + 最终内嵌
cd "/Users/tommydu/Documents/automatic downloading music"
N=/Users/tommydu/.workbuddy/binaries/node/versions/22.22.2-6/bin/node
PY=/Users/tommydu/.workbuddy/binaries/python/envs/default/bin/python
DIR="/Users/tommydu/Downloads/酷狗歌单导入/Embeat推荐-安静纯音乐"
LOG="/Users/tommydu/Documents/automatic downloading music/playlist-exports"
while pgrep -f "gd-browser-downloader|flac_metadata_embedder" >/dev/null 2>&1; do sleep 30; done
echo "===== $(date '+%H:%M') K-ballad 结束, 补齐批次1剩余纯音乐 ====="
env -u http_proxy -u https_proxy -u all_proxy "$N" gd-browser-downloader.js \
  --list /tmp/embeat_final.json --site org --direct \
  --out "$DIR" --delay 6 >> "$LOG/pure-dl.log" 2>&1
echo "===== $(date '+%H:%M') 补齐结束, 最终内嵌 ====="
rm -rf /tmp/embed_em && mkdir -p /tmp/embed_em/downloads
ln -s "$DIR" /tmp/embed_em/downloads/01-Embeat推荐-Piano-Instrumental
no_proxy='*' NO_PROXY='*' http_proxy= https_proxy= "$PY" flac_metadata_embedder.py \
  --downloads-dir /tmp/embed_em >> "$LOG/embeat-embed.log" 2>&1
echo "===== $(date '+%H:%M') ALL DONE ====="
