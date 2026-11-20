#!/bin/bash
# 电音 + R&B 代表作：酷狗概念版 VIP 通道（明文 flac）→ 拷 SD → 内嵌
cd "/Users/tommydu/Documents/automatic downloading music"
N=/Users/tommydu/.workbuddy/binaries/node/versions/22.22.2-6/bin/node
PY=/Users/tommydu/.workbuddy/binaries/python/envs/default/bin/python
LOG="/Users/tommydu/Documents/automatic downloading music/playlist-exports"
ENVV="env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY"
echo "===== $(date '+%H:%M') 电音 ====="
$ENVV "$N" kugou-v5-dl.js "$LOG/edm-vicetone.json" "downloads/edm-staging" >> "$LOG/edm-dl.log" 2>&1
echo "===== $(date '+%H:%M') R&B ====="
$ENVV "$N" kugou-v5-dl.js "$LOG/rnb-classics.json" "downloads/rnb-staging" >> "$LOG/rnb-dl.log" 2>&1
echo "===== $(date '+%H:%M') 下载结束, 拷 SD ====="
rsync -a --exclude="*.metadata_edit" downloads/edm-staging/ "/Volumes/MEMORY CARD/Music/09-电音代表作-Vicetone等/" 2>&1 | tail -2
rsync -a --exclude="*.metadata_edit" downloads/rnb-staging/ "/Volumes/MEMORY CARD/Music/10-RnB-代表作/" 2>&1 | tail -2
echo "===== $(date '+%H:%M') 内嵌 ====="
rm -rf /tmp/embed_er && mkdir -p /tmp/embed_er/downloads
ln -s "/Volumes/MEMORY CARD/Music/09-电音代表作-Vicetone等" "/tmp/embed_er/downloads/09-电音代表作-EDM"
ln -s "/Volumes/MEMORY CARD/Music/10-RnB-代表作" "/tmp/embed_er/downloads/10-RnB代表作-RnB"
no_proxy='*' NO_PROXY='*' http_proxy= https_proxy= all_proxy= "$PY" flac_metadata_embedder.py --downloads-dir /tmp/embed_er >> "$LOG/edm-embed.log" 2>&1
echo "===== $(date '+%H:%M') ALL DONE ====="
