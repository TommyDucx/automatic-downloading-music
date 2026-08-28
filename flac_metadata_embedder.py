#!/usr/bin/env python3
"""
FLAC 文件元数据内嵌工具
支持：歌词、歌手、专辑、风格、年份、封面图片等
"""

import os
import json
import argparse
import subprocess
import requests
from pathlib import Path
from datetime import datetime

class FLACMetadataEmbedder:
    def __init__(self, downloads_dir):
        self.downloads_dir = Path(downloads_dir)
        
    def safe_filename(self, text):
        """生成安全的文件名"""
        import re
        return re.sub(r'[\\/*?:"<>|]', "", text).strip()
    
    def download_lyrics(self, title, artist, save_dir=None):
        """下载同步歌词，保存到歌曲所在文件夹
        save_dir: 歌词保存目录（缺省为歌曲所在文件夹）
        """
        save_dir = Path(save_dir) if save_dir else None
        try:
            import syncedlyrics
        except ImportError:
            print("syncedlyrics 未安装，正在安装...")
            subprocess.run([sys.executable, "-m", "pip", "install", "syncedlyrics"])
            import syncedlyrics
        
        query = f"{title} {artist}"
        lrc_content = syncedlyrics.search(query)
        
        if not lrc_content:
            # 尝备用API
            try:
                resp = requests.get(
                    "https://api.lrc.cx/api/v1/lyrics/single",
                    params={"title": title, "artist": artist},
                    timeout=10
                )
                if resp.status_code == 200:
                    lrc_content = resp.text
            except:
                pass
        
        if lrc_content:
            fn = self.safe_filename(f"{artist}-{title}.lrc")
            full_path = save_dir / fn if save_dir else self.downloads_dir / fn
            save_dir.mkdir(parents=True, exist_ok=True)
            with open(full_path, "w", encoding="utf-8") as f:
                f.write(lrc_content)
            return str(full_path)
        return None
    
    def get_metadata_from_filename(self, filename):
        """从文件名解析歌手和歌名"""
        # 处理格式：歌手 - 歌名.flac
        if " - " in filename:
            parts = filename.replace(".flac", "").split(" - ", 1)
            if len(parts) == 2:
                return parts[0].strip(), parts[1].strip()
        return None, None
    
    def get_genre_from_folder(self, folder_name):
        """根据文件夹名获取风格"""
        genre_mapping = {
            "Synthwave-Chillwave": "Synthwave, Chillwave",
            "Melodic-Future-Bass-Glitch": "Future Bass, Glitch",
            "Chillhop-Lofi-Synth-Electronica": "Chillhop, Lo-fi, Electronic",
            "Folktronica-Ambient-Pop": "Folktronica, Ambient, Pop",
            "Space-Ambient-Modular-Synth": "Space, Ambient, Modular Synth",
            "Emotional-Synth-Melancholy": "Emotional Synth, Melancholy"
        }
        
        for key, genre in genre_mapping.items():
            if key in folder_name:
                return genre
        return "Electronic"
    
    def get_album_info(self, artist, genre):
        """根据歌手和风格获取专辑信息"""
        album_info = {
            "周杰伦": {
                "album": "魔杰座",
                "year": "2008",
                "composer": "周杰伦",
                "albumartist": "周杰伦"
            },
            "Daft Punk": {
                "album": "Random Access Memories",
                "year": "2013",
                "composer": "Daft Punk",
                "albumartist": "Daft Punk"
            },
            "The Midnight": {
                "album": "Nocturnal",
                "year": "2022",
                "composer": "The Midnight",
                "albumartist": "The Midnight"
            },
            "HOME": {
                "album": "Resonance",
                "year": "2022",
                "composer": "HOME",
                "albumartist": "HOME"
            },
            "Nujabes": {
                "album": "Luv(sic) Hexalogy",
                "year": "2001-2013",
                "composer": "Nujabes",
                "albumartist": "Nujabes"
            }
        }
        
        return album_info.get(artist, {
            "album": f"{artist} Collection",
            "year": str(datetime.now().year),
            "composer": artist,
            "albumartist": artist
        })
    
    def embed_metadata(self, flac_path, metadata):
        """使用 metaflac 内嵌元数据"""
        try:
            # 构建元数据命令（不直接导入歌词文件，避免格式问题）
            cmd = ['metaflac', '--remove-all-tags', flac_path]
            
            # 添加标签
            tags = [
                f'TITLE={metadata.get("title", "")}',
                f'ARTIST={metadata.get("artist", "")}',
                f'ALBUM={metadata.get("album", "")}',
                f'ALBUMARTIST={metadata.get("albumartist", "")}',
                f'COMPOSER={metadata.get("composer", "")}',
                f'GENRE={metadata.get("genre", "")}',
                f'DATE={metadata.get("year", "")}',
                f'TRACKNUMBER={metadata.get("track", "")}',
                f'TOTALTRACKS={metadata.get("totaltracks", "")}',
                f'COMMENT={metadata.get("comment", "")}'
            ]
            
            # 如果有歌词，单独处理
            if metadata.get('lyrics'):
                # 将歌词转换为适合Vorbis注释的格式
                lyrics_content = metadata['lyrics']
                # 清理歌词格式，移除时间戳行，只保留文本
                cleaned_lyrics = []
                for line in lyrics_content.split('\n'):
                    line = line.strip()
                    if line and not line.startswith('[') and not line.startswith('<'):
                        cleaned_lyrics.append(line)
                
                if cleaned_lyrics:
                    # 合并歌词行，用空格分隔
                    lyrics_text = ' '.join(cleaned_lyrics)
                    # 截取前5000字符避免过长
                    lyrics_text = lyrics_text[:5000]
                    tags.append(f'LYRICS={lyrics_text}')
            
            # 添加所有标签
            for tag in tags:
                cmd.extend(['--set-tag', tag])
            
            # 执行命令
            result = subprocess.run(cmd, capture_output=True, text=True)
            
            if result.returncode == 0:
                print(f"✅ 元数据已内嵌: {flac_path}")
                return True
            else:
                print(f"❌ 元数据内嵌失败: {flac_path}")
                print(f"错误: {result.stderr}")
                return False
                
        except Exception as e:
            print(f"❌ 元数据内嵌异常: {flac_path}")
            print(f"错误: {e}")
            return False
    
    def process_all_files(self):
        """处理所有FLAC文件"""
        print("开始处理FLAC文件元数据...")
        
        total_files = 0
        processed_files = 0
        failed_files = 0
        
        # 遍历所有文件夹
        for folder in self.downloads_dir.glob("downloads/0*"):
            if not folder.is_dir():
                continue
                
            folder_name = folder.name
            genre = self.get_genre_from_folder(folder_name)
            
            # 读取歌单
            playlist_path = folder / "playlist.json"
            if playlist_path.exists():
                with open(playlist_path, 'r', encoding='utf-8') as f:
                    playlist = json.load(f)
            else:
                playlist = []
            
            # 处理FLAC文件
            for flac_file in folder.glob("*.flac"):
                total_files += 1
                
                # 从文件名解析歌手和歌名
                artist, title = self.get_metadata_from_filename(flac_file.name)
                
                if not artist or not title:
                    print(f"⚠️ 无法解析文件名: {flac_file.name}")
                    failed_files += 1
                    continue
                
                # 获取专辑信息
                album_info = self.get_album_info(artist, genre)
                
                # 下载歌词（保存到歌曲所在文件夹）
                lyrics_path = self.download_lyrics(title, artist, save_dir=folder)
                lyrics_content = None
                if lyrics_path:
                    with open(lyrics_path, 'r', encoding='utf-8') as f:
                        lyrics_content = f.read()
                
                # 构建元数据
                metadata = {
                    'title': title,
                    'artist': artist,
                    'album': album_info['album'],
                    'albumartist': album_info['albumartist'],
                    'composer': album_info['composer'],
                    'genre': genre,
                    'year': album_info['year'],
                    'track': '1',  # 默认为1，避免匹配问题
                    'totaltracks': str(len(playlist)),
                    'comment': f'Genre: {genre} | Source: music.gdstudio.org',
                    'lyrics': lyrics_content
                }
                
                # 内嵌元数据
                if self.embed_metadata(flac_file, metadata):
                    processed_files += 1
                else:
                    failed_files += 1
        
        print(f"\n处理完成:")
        print(f"总文件数: {total_files}")
        print(f"成功处理: {processed_files}")
        print(f"处理失败: {failed_files}")
        
        return processed_files, failed_files

def main():
    parser = argparse.ArgumentParser(description='FLAC文件元数据内嵌工具')
    parser.add_argument('--downloads-dir', default='/Users/tommydu/Documents/automatic downloading music', 
                       help='下载目录路径')
    parser.add_argument('--single-file', help='处理单个文件')
    parser.add_argument('--list-genres', action='store_true', help='列出所有风格')
    
    args = parser.parse_args()
    
    # 检查依赖
    try:
        import metaflac
    except ImportError:
        print("正在安装 metaflac...")
        if os.name == 'posix':
            subprocess.run(['brew', 'install', 'flac'])
        else:
            print("请手动安装 FLAC 工具: https://xiph.org/flac/")
    
    embedder = FLACMetadataEmbedder(args.downloads_dir)
    
    if args.list_genres:
        print("支持的风格:")
        for genre in embedder.get_genre_from_folder("test").split(", "):
            print(f"  - {genre}")
        return
    
    if args.single_file:
        # 处理单个文件
        flac_path = Path(args.single_file)
        if not flac_path.exists():
            print(f"文件不存在: {flac_path}")
            return
        
        artist, title = embedder.get_metadata_from_filename(flac_path.name)
        if not artist or not title:
            print(f"无法解析文件名: {flac_path.name}")
            return
        
        genre = "Electronic"  # 默认
        album_info = embedder.get_album_info(artist, genre)
        
        lyrics_path = embedder.download_lyrics(title, artist, save_dir=flac_path.parent)
        lyrics_content = None
        if lyrics_path:
            with open(lyrics_path, 'r', encoding='utf-8') as f:
                lyrics_content = f.read()
        
        metadata = {
            'title': title,
            'artist': artist,
            'album': album_info['album'],
            'albumartist': album_info['albumartist'],
            'composer': album_info['composer'],
            'genre': genre,
            'year': album_info['year'],
            'track': '1',
            'totaltracks': '1',
            'comment': f'Genre: {genre} | Source: music.gdstudio.org',
            'lyrics': lyrics_content
        }
        
        embedder.embed_metadata(flac_path, metadata)
    else:
        # 处理所有文件
        embedder.process_all_files()

if __name__ == "__main__":
    import sys
    main()