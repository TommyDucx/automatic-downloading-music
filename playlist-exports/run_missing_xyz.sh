#!/bin/bash
# 缺口补齐 v2：xyz 国际版走代理（2026-09-25 下午起国内直连 xyz TCP 不通），全新隔离 profile
cd "/Users/tommydu/Documents/automatic downloading music"
NODE=/Users/tommydu/.workbuddy/binaries/node/versions/22.22.2-3/bin/node
ROOT="/Volumes/My Passport/歌单备份-2026-09-24"
EXP="/Users/tommydu/Documents/automatic downloading music/playlist-exports"
for n in 01 02 03 04 05 06 07 08; do
  list="$EXP/${n}-missing.json"
  [ -f "$list" ] || continue
  dir=$(ls -d "$ROOT"/${n}-* 2>/dev/null | head -1)
  [ -d "$dir" ] || continue
  echo "===== $(date '+%H:%M:%S') 补缺 $dir ====="
  "$NODE" gd-browser-downloader.js --list "$list" --site xyz --proxy "http://127.0.0.1:7897" \
    --chrome-port 9444 --chrome-profile /tmp/gd-xyz-profile-0925p \
    --out "$dir" --delay 6 >> "$EXP/${n}-xyz.log" 2>&1
  echo "===== $(date '+%H:%M:%S') 完成 $dir (exit $?) ====="
done
echo "XYZ SUPPLEMENT DONE $(date)"
