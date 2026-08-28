#!/bin/bash
# 批量下载：按 6 个风格文件夹顺序执行
cd "/Users/tommydu/Documents/automatic downloading music"
LOG="/tmp/gdmusic_batch.log"
: > "$LOG"
for d in downloads/0*/; do
  plist="$d/playlist.json"
  [ -f "$plist" ] || continue
  echo "===== $(basename "$d") =====" >> "$LOG"
  node gd-flac-downloader.js --list "$plist" --out "$d" --sources netease,joox --delay 4 --fallback >> "$LOG" 2>&1
  echo "===== 完成 $(basename "$d") =====" >> "$LOG"
done
echo "ALL DONE" >> "$LOG"
