#!/bin/bash
# 钢琴曲分风格 ×4 + 现有两板块扩容：direct 直连下载 → 全量内嵌
cd "/Users/tommydu/Documents/automatic downloading music"
N=/Users/tommydu/.workbuddy/binaries/node/versions/22.22.2-6/bin/node
PY=/Users/tommydu/.workbuddy/binaries/python/envs/default/bin/python
LOG="/Users/tommydu/Documents/automatic downloading music/playlist-exports"
PBASE="/Users/tommydu/Downloads/酷狗歌单导入/钢琴曲-分风格"
EXP="/Users/tommydu/Downloads/酷狗歌单导入/Embeat推荐-安静纯音乐"
dl () { # $1=list $2=dir
  echo "===== $(date '+%H:%M') 下载 $2 ====="
  env -u http_proxy -u https_proxy -u all_proxy "$N" gd-browser-downloader.js \
    --list "$1" --site org --direct --out "$2" --delay 6 >> "$LOG/piano-dl.log" 2>&1
}
mkdir -p "$PBASE/01-抒情钢琴" "$PBASE/02-爵士钢琴" "$PBASE/03-古典钢琴" "$PBASE/04-影视钢琴"
dl "$LOG/piano-lyrical.json"   "$PBASE/01-抒情钢琴"
dl "$LOG/piano-jazz.json"      "$PBASE/02-爵士钢琴"
dl "$LOG/piano-classical.json" "$PBASE/03-古典钢琴"
dl "$LOG/piano-film.json"      "$PBASE/04-影视钢琴"
dl "$LOG/expansion.json"       "$EXP"
echo "===== $(date '+%H:%M') 全部下载结束, 开始内嵌 ====="
rm -rf /tmp/embed_pe && mkdir -p /tmp/embed_pe/downloads
ln -s "$PBASE/01-抒情钢琴" /tmp/embed_pe/downloads/01-抒情钢琴-Piano
ln -s "$PBASE/02-爵士钢琴" /tmp/embed_pe/downloads/02-爵士钢琴-Jazz
ln -s "$PBASE/03-古典钢琴" /tmp/embed_pe/downloads/03-古典钢琴-Classical
ln -s "$PBASE/04-影视钢琴" /tmp/embed_pe/downloads/04-影视钢琴-Soundtrack
ln -s "$EXP" /tmp/embed_pe/downloads/05-Embeat扩容-Instrumental-Ballad
no_proxy='*' NO_PROXY='*' http_proxy= https_proxy= all_proxy= "$PY" flac_metadata_embedder.py \
  --downloads-dir /tmp/embed_pe >> "$LOG/piano-embed.log" 2>&1
echo "===== $(date '+%H:%M') ALL DONE ====="
