#!/bin/bash
# 补下载脚本：只下载失败的歌曲
cd "/Users/tommydu/Documents/automatic downloading music"
LOG="/tmp/gdmusic_retry.log"
: > "$LOG"

# 失败歌曲列表
FAILED_SONGS=(
"Brian Eno - An Ending (Ascent)"
"CASSIOPEIA - Jupiter"
"Christian Löffler - Sunson"
"FM-84 - Coastal Dusk"
"Idealism - Always Floating"
"Jim Yosef - Skyward"
"Jinsang - Solitude"
"Kiasmos - Fading Lights"
"Kupla - Snowy Peaks"
"Lexxy - Summer Smile"
"M3mo - 忆梦症"
"Marvel83 - Neon Glow"
"Michael Oakley - Childhood"
"Nujabes - Luv(sic) Pt.2"
"Ólafur Arnalds - Echo Mountain"
"Potsu - I'm Closing My Eyes"
"Saib - morning mist"
"Shirfine - 幻昼"
)

echo "开始补下载 $(date)" > "$LOG"

for song in "${FAILED_SONGS[@]}"; do
  # 解析歌手和歌名
  if [[ "$song" == *" - "* ]]; then
    artist="${song% - *}"
    title="${song#* - }"
    echo "重试: $artist - $title" >> "$LOG"
    
    # 创建临时歌单
    temp_json="/tmp/retry_${artist}_${title// /_}.json"
    echo "[{\"title\": \"$title\", \"artist\": \"$artist\"}]" > "$temp_json"
    
    # 尝试所有文件夹（按优先级）
    for folder in "downloads/05-极简太空漫游与深层沉浸-Space-Ambient-Modular-Synth/" "downloads/04-现代唯美电子与原声融合-Folktronica-Ambient-Pop/" "downloads/01-梦幻复古合成器与波形律动-Synthwave-Chillwave/" "downloads/02-空灵未来贝斯与电音切片-Melodic-Future-Bass-Glitch/" "downloads/03-治愈系电子爵士与氛围节拍-Chillhop-Lofi-Synth-Electronica/" "downloads/06-细腻情绪与独立氛围电音-Emotional-Synth-Melancholy/"; do
      if [ -f "$folder/playlist.json" ]; then
        node gd-flac-downloader.js --list "$temp_json" --out "$folder" --sources netease,tencent,kuwo,migu,qobuz,spotify,apple,ytmusic --delay 8 --fallback --force >> "$LOG" 2>&1
        # 检查是否成功
        if grep -q "\[+\] 完成.*$title" "$LOG" || grep -q "\[+\] 完成.*$artist" "$LOG"; then
          echo "成功: $artist - $title" >> "$LOG"
          rm -f "$temp_json"
          break
        fi
      fi
    done
    rm -f "$temp_json"
  fi
  echo "-----" >> "$LOG"
done

echo "补下载完成 $(date)" >> "$LOG"
echo "成功: $(grep -c "\[+\] 完成" "$LOG")"
echo "失败: $(grep -c "\[x\] 未能" "$LOG")"