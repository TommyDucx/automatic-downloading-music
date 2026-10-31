#!/bin/bash
# 八歌单顺序下载：org 站直连（不走代理）；全新 Chrome profile 防签名会话陈旧
cd "/Users/tommydu/Documents/automatic downloading music"
NODE=/Users/tommydu/.workbuddy/binaries/node/versions/22.22.2-3/bin/node
ROOT="/Volumes/My Passport/歌单备份-2026-09-24"
EXP="/Users/tommydu/Documents/automatic downloading music/playlist-exports"
for n in 01 02 03 04 05 06 07 08; do
  list="$EXP/${n}-songs.json"
  [ -f "$list" ] || continue
  dir=$(ls -d "$ROOT"/${n}-* 2>/dev/null | head -1)
  [ -d "$dir" ] || continue
  echo "===== $(date '+%m-%d %H:%M:%S') 开始 $dir ====="
  "$NODE" gd-browser-downloader.js --list "$list" --site org --proxy "direct://" \
    --chrome-port 9334 --chrome-profile /tmp/gd-org-profile-0925 \
    --out "$dir" --delay 6 >> "$EXP/${n}-download.log" 2>&1
  echo "===== $(date '+%m-%d %H:%M:%S') 完成 $dir (exit $?) ====="
done
echo "ALL DONE $(date)"
