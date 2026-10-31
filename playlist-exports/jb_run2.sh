#!/bin/bash
# JB v2：先下到本地 staging（规避 SD 掉盘），完成后整包拷 SD + 内嵌
cd "/Users/tommydu/Documents/automatic downloading music"
NODE=/Users/tommydu/.workbuddy/binaries/node/versions/22.22.2-6/bin/node
PY=/Users/tommydu/.workbuddy/binaries/python/envs/default/bin/python
LOG="/Users/tommydu/Documents/automatic downloading music/playlist-exports"
WS="/Users/tommydu/Documents/automatic downloading music"
STAGE="$WS/downloads/jb-staging"
mkdir -p "$STAGE"
SD="/Volumes/MEMORY CARD/Music/06-JustinBieber-全收录-Pop"
echo "===== $(date '+%H:%M') 开始下载到 staging ====="
"$NODE" gd-browser-downloader.js --list "$LOG/jb-songs.json" --site org --proxy "direct://" \
  --chrome-port 9334 --chrome-profile /tmp/gd-org-profile-0925 \
  --out "$STAGE" --delay 6 >> "$LOG/jb-download2.log" 2>&1
echo "===== $(date '+%H:%M') 下载结束 (exit $?), 拷贝到 SD ====="
rsync -a "$STAGE/" "$SD/" >> "$LOG/jb-download2.log" 2>&1
echo "===== $(date '+%H:%M') 拷贝完成, 开始内嵌 ====="
rm -rf /tmp/embed_jb && mkdir -p /tmp/embed_jb/downloads
ln -s "$SD" /tmp/embed_jb/downloads/06-JustinBieber-全收录-Pop
no_proxy='*' NO_PROXY='*' http_proxy= https_proxy= "$PY" flac_metadata_embedder.py \
  --downloads-dir /tmp/embed_jb >> "$LOG/jb-embed.log" 2>&1
echo "===== $(date '+%H:%M') 内嵌结束 ALL DONE ====="
