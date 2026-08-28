# 音乐批量下载与元数据内嵌技能

## 技能概述
这是一个完整的音乐批量下载和元数据内嵌解决方案，支持从 GD音乐台 批量下载高品质FLAC音乐，并自动内嵌歌词、歌手、专辑、风格等完整元数据。

## 功能特性
- 🎵 **批量下载**: 支持100+歌曲批量下载，自动分文件夹管理
- 🔍 **多音源**: netease、joox、tencent、kuwo、qobuz等8个音源
- 🎼 **智能匹配**: 自动匹配歌手、歌名、专辑、年份信息
- 📝 **歌词同步**: 自动下载同步LRC歌词并内嵌
- 🏷️ **元数据完整**: 内嵌标题、艺术家、专辑、风格、作曲家等信息
- 🚀 **防限流**: 智能延迟和重试机制，避免触发站点限制
- 📁 **自动分类**: 按音乐风格自动分文件夹管理
- 🔄 **断点续传**: 支持断点续跑，跳过已下载文件

## 适用场景
- 音乐收藏家批量收集高品质音乐
- 播放器库元数据完善
- 音乐风格分类整理
- 歌词同步需求
- 音乐研究资料收集

## 系统要求
- macOS (推荐)
- Python 3.8+
- Homebrew (用于安装FLAC工具)
- 网络连接

## 安装依赖

### 1. 安装系统依赖
```bash
# 安装FLAC工具
brew install flac

# 安装Python依赖
pip3 install requests beautifulsoup4 rapidfuzz soupsieve syncedlyrics
```

### 2. 获取技能文件
```bash
# 创建技能目录
mkdir -p ~/music-processing-skills
cd ~/music-processing-skills

# 下载技能文件
# (将以下所有文件保存到该目录)
```

## 技能文件结构

```
music-processing-skills/
├── README.md                    # 技能说明文档
├── music_downloader.py         # 主下载脚本
├── metadata_embedder.py         # 元数据内嵌工具
├── batch_runner.sh              # 批量运行脚本
├── config.json                  # 配置文件
├── requirements.txt             # Python依赖
└── examples/                    # 示例文件
    ├── sample_playlists/
    └── output_example/
```

## 使用方法

### 快速开始
```bash
# 1. 克隆技能到本地
cd ~/music-processing-skills

# 2. 配置音乐风格和歌单
cp config.json.example config.json
# 编辑config.json，设置你的音乐风格和歌单

# 3. 运行批量下载
chmod +x batch_runner.sh
./batch_runner.sh

# 4. 内嵌元数据
python3 metadata_embedder.py
```

### 详细步骤

#### 步骤1: 配置音乐风格和歌单
编辑 `config.json` 文件：
```json
{
  "music_styles": {
    "synthwave_chillwave": {
      "name": "梦幻复古合成器与波形律动",
      "description": "Synthwave & Chillwave",
      "folder_name": "01-梦幻复古合成器与波形律动-Synthwave-Chillwave"
    },
    "future_bass_glitch": {
      "name": "空灵未来贝斯与电音切片", 
      "description": "Melodic Future Bass & Glitch",
      "folder_name": "02-空灵未来贝斯与电音切片-Melodic-Future-Bass-Glitch"
    }
  },
  "playlists": {
    "synthwave_chillwave": [
      {"title": "Resonance", "artist": "HOME"},
      {"title": "Sunset", "artist": "The Midnight"}
    ]
  },
  "download_settings": {
    "sources": ["netease", "joox"],
    "delay": 4,
    "fallback": true,
    "max_retries": 3
  }
}
```

#### 步骤2: 创建下载目录
```bash
mkdir -p ~/music_downloads
cd ~/music_downloads
```

#### 步骤3: 运行批量下载
```bash
# 使用默认配置
python3 ~/music-processing-skills/music_downloader.py

# 或指定配置文件
python3 ~/music-processing-skills/music_downloader.py --config config.json
```

#### 步骤4: 内嵌元数据
```bash
# 处理所有下载的文件
python3 ~/music-processing-skills/metadata_embedder.py --downloads-dir ~/music_downloads

# 处理单个文件
python3 ~/music-processing-skills/metadata_embedder.py --single-file "~/music_downloads/song.flac"
```

## 配置选项

### 下载配置
```json
{
  "sources": ["netease", "joox", "tencent", "kuwo", "qobuz", "spotify", "apple", "ytmusic"],
  "delay": 4,                    // 请求间隔（秒）
  "fallback": true,              // 允许降级音质
  "max_retries": 3,              // 最大重试次数
  "timeout": 60,                 // 请求超时（秒）
  "force": false                 // 强制重新下载
}
```

### 元数据配置
```json
{
  "auto_gen_album": true,        // 自动生成专辑信息
  "download_lyrics": true,       // 自动下载歌词
  "lyric_sources": ["syncedlyrics", "lrc.cx"],
  "embed_cover_art": false,      // 内嵌封面图片（需额外配置）
  "genre_mapping": {
    "electronic": "Electronic",
    "classical": "Classical",
    "jazz": "Jazz"
  }
}
```

## 输出结构

### 目录结构
```
music_downloads/
├── 01-梦幻复古合成器与波形律动-Synthwave-Chillwave/
│   ├── playlist.json              # 歌单文件
│   ├── HOME - Resonance.flac      # 下载的音乐
│   └── HOME-Resonance.lrc         # 歌词与歌曲同文件夹
├── 02-空灵未来贝斯与电音切片-Melodic-Future-Bass-Glitch/
│   ├── playlist.json
│   └── ...
└── metadata_report.md             # 处理报告
```

### ⚠️ 歌词存放规则（重要）
**歌词文件必须保存在歌曲所在文件夹内，与音频文件同目录**（命名 `歌手-歌名.lrc`），不要放在独立的 `./lyrics/` 总目录。

原因：方便单文件夹整体拷贝/同步，播放器按目录读取歌词无需额外配置。

- `metadata_embedder.py` 的 `download_lyrics(title, artist, save_dir=歌曲所在文件夹)` 已内置此行为
- 若旧数据把歌词存在 `lyrics/` 总目录，需按「歌手-歌名 归一化匹配」脚本移动到歌曲文件夹，并删除空 lyrics 目录

### 元数据内容
每个FLAC文件包含以下元数据：
- **TITLE**: 歌曲名称
- **ARTIST**: 歌手名称  
- **ALBUM**: 专辑名称
- **ALBUMARTIST**: 专辑艺术家
- **COMPOSER**: 作曲家
- **GENRE**: 音乐风格
- **DATE**: 发行年份
- **TRACKNUMBER**: 曲目编号
- **TOTALTRACKS**: 总曲目数
- **COMMENT**: 备注信息
- **LYRICS**: 歌词文本（如果有）

## 高级功能

### 1. 自定义音源
```bash
# 编辑配置文件，添加自定义音源
python3 music_downloader.py --sources netease,spotify,custom_api
```

### 2. 断点续传
```bash
# 继续未完成的下载
python3 music_downloader.py --resume
```

### 3. 元数据验证
```bash
# 验证元数据完整性
python3 metadata_embedder.py --verify
```

### 4. 歌词更新
```bash
# 只更新歌词，不重新下载（歌词仍保存到歌曲所在文件夹）
python3 metadata_embedder.py --update-lyrics
```

## 故障排除

### 常见问题

#### 1. 下载失败
```bash
# 检查网络连接
ping music.gdstudio.org

# 查看详细日志
tail -f download.log

# 增加延迟重试
python3 music_downloader.py --delay 8
```

#### 2. 元数据内嵌失败
```bash
# 检查FLAC工具
which metaflac

# 验证文件权限
ls -la music_downloads/

# 重新处理单个文件
python3 metadata_embedder.py --single-file "song.flac"
```

#### 3. 歌词下载失败
```bash
# 检查歌曲所在文件夹是否有 .lrc 文件
ls -la music_downloads/01-风格文件夹/

# 手动测试歌词搜索
python3 -c "import syncedlyrics; print(syncedlyrics.search('song artist'))"
```

### 性能优化

#### 1. 并发下载
```bash
# 修改配置增加并发数
"concurrent_downloads": 3
```

#### 2. 缓存优化
```bash
# 启用缓存
"use_cache": true
"cache_dir": "./cache"
```

#### 3. 网络优化
```bash
# 使用代理
"proxy": "http://proxy.example.com:8080"

# 超时设置
"timeout": 120
```

## 示例用例

### 示例1: 收集电子音乐
```bash
# 配置电子音乐歌单
cat > electronic_playlist.json << EOF
[
  {"title": "Midnight City", "artist": "M83"},
  {"title": "Strobe", "artist": "deadmau5"},
  {"title": "Resonance", "artist": "HOME"}
]
EOF

# 运行下载
python3 music_downloader.py --playlist electronic_playlist.json --style electronic
```

### 示例2: 完整音乐库构建
```bash
# 批量处理多个风格
styles=("synthwave" "chillhop" "ambient" "future_bass")
for style in "${styles[@]}"; do
  python3 music_downloader.py --style "$style"
  python3 metadata_embedder.py --style "$style"
done
```

### 示例3: 元数据修复
```bash
# 修复缺失元数据的文件
find music_downloads -name "*.flac" -exec python3 metadata_embedder.py --single-file {} \;
```

## API 参考

### 音乐下载器类
```python
class MusicDownloader:
    def __init__(self, config_path=None):
        """初始化下载器"""
        
    def download_playlist(self, playlist, style_folder):
        """下载歌单"""
        
    def download_single(self, title, artist, output_dir):
        """下载单首歌曲"""
        
    def resume_download(self):
        """续传下载"""
```

### 元数据处理器类
```python
class MetadataEmbedder:
    def __init__(self, downloads_dir):
        """初始化元数据处理器"""
        
    def embed_metadata(self, flac_path, metadata):
        """内嵌元数据"""
        
    def download_lyrics(self, title, artist, save_dir=None):
        """下载歌词，保存到歌曲所在文件夹 (save_dir 缺省时存到 downloads_dir)"""
        
    def process_all_files(self):
        """处理所有文件"""
```

## 版本历史

### v1.0.0 (2026-08-28)
- 初始版本发布
- 支持批量下载和元数据内嵌
- 实现防限流机制
- 支持歌词同步

### v1.1.0 (计划中)
- 支持封面图片内嵌
- 增加更多音源支持
- 优化并发下载
- 添加Web界面

## 贡献指南

欢迎提交 Issue 和 Pull Request！

### 开发环境设置
```bash
# 克隆仓库
git clone https://github.com/yourusername/music-processing-skills.git
cd music-processing-skills

# 安装开发依赖
pip3 install -r requirements-dev.txt

# 运行测试
python3 -m pytest tests/
```

### 代码规范
- 遵循 PEP 8 规范
- 添加详细的注释
- 编写测试用例
- 更新文档

## 许可证

MIT License - 详见 LICENSE 文件

## 支持

- 📧 Email: your.email@example.com
- 🐛 Issues: https://github.com/yourusername/music-processing-skills/issues
- 📖 文档: https://yourusername.github.io/music-processing-skills

---

**注意**: 本工具仅供个人音乐收藏使用，请遵守相关版权法律法规。