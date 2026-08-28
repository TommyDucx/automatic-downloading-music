#!/usr/bin/env node

// 国际版音乐下载器 - 支持 music-api.gdstudio.xyz
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// 配置
const CONFIG = {
    // 支持的域名
    DOMAINS: {
        ORIGINAL: 'music.gdstudio.org',
        INTERNATIONAL: 'music-api.gdstudio.xyz',
        // 镜像分流（参考 gdstudio-embeded-service config.yaml）
        MIRRORS: {
            cn: 'music-api-cn.gdstudio.xyz',
            hk: 'music-api-hk.gdstudio.xyz',
            us: 'music-api-us.gdstudio.xyz'
        }
    },

    // 音源 -> 镜像（migu/kugou/ximalaya→cn，joox→hk，qobuz/ytmusic→us，其余默认）
    MIRROR_BY_SOURCE: {
        migu: 'cn',
        kugou: 'cn',
        ximalaya: 'cn',
        joox: 'hk',
        qobuz: 'us',
        ytmusic: 'us'
    },
    
    // 默认设置
    DEFAULT_SOURCE: 'netease', // netease, kuwo
    DEFAULT_QUALITY: '999', // 128, 192, 320, 999 (FLAC)
    DEFAULT_COUNT: 20,
    DEFAULT_PAGES: 1,
    
    // 下载设置
    OUTPUT_DIR: '/Users/tommydu/Documents/automatic downloading music/downloads',
    DELAY_MIN: 1000,
    DELAY_MAX: 4000,
    MAX_RETRIES: 3,
    TIMEOUT: 30000,
    
    // 支持的音源
    SOURCES: {
        netease: { name: '网易云音乐', qualities: ['128', '320', '999'] },
        kuwo: { name: '酷我音乐', qualities: ['128', '192', '320', '999'] }
    }
};

// CRC32 实现
function crc32(input) {
    const polynomial = 0xEDB88320;
    let crc = 0xFFFFFFFF;
    let bytes = Buffer.from(input, 'utf8');
    for (let i = 0; i < bytes.length; i++) {
        crc ^= bytes[i];
        for (let j = 0; j < 8; j++) {
            if (crc & 1) crc = (crc >>> 1) ^ polynomial;
            else crc = crc >>> 1;
        }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function crc32Hex(input) {
    return crc32(input).toString(16).toUpperCase().padStart(8, '0');
}

// 按音源选择镜像域名
function domainForSource(source) {
    const mirror = CONFIG.MIRROR_BY_SOURCE[source];
    return mirror ? CONFIG.DOMAINS.MIRRORS[mirror] : CONFIG.DOMAINS.INTERNATIONAL;
}

// 工具函数
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getRandomDelay() {
    return Math.floor(Math.random() * (CONFIG.DELAY_MAX - CONFIG.DELAY_MIN + 1)) + CONFIG.DELAY_MIN;
}

// 日志函数
function log(message, type = 'info') {
    const timestamp = new Date().toISOString();
    const prefix = type === 'error' ? '❌' : type === 'success' ? '✅' : type === 'warning' ? '⚠️' : '📋';
    console.log(`[${timestamp}] ${prefix} ${message}`);
}

// HTTP 请求函数
function makeRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const requestOptions = {
            timeout: CONFIG.TIMEOUT,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Accept': 'application/json',
                ...options.headers
            },
            ...options
        };

        const req = https.request(url, requestOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    data: data
                });
            });
        });

        req.on('error', reject);
        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

// API 调用函数
async function apiCall(domain, params, depth = 0) {
    depth = depth || 0;
    
    // 计算签名
    const signInput = encodeURIComponent(String(params.name || params.id || ''));
    const signature = crc32Hex(signInput);
    
    // 构建请求体
    const parts = [];
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        parts.push(`${key}=${encodeURIComponent(String(value))}`);
    }
    parts.push(`s=${signature}`);
    const body = parts.join('&');
    
    log(`API调用: ${domain}/api.php`, 'info');
    
    // 发送请求
    const url = `https://${domain}/api.php`;
    try {
        const response = await makeRequest(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: body
        });
        
        // 429 / 显式限流：尊重 Retry-After（若有），否则指数冷却
        if (response.statusCode === 429) {
            if (depth < CONFIG.MAX_RETRIES) {
                const ra = parseFloat(response.headers?.['retry-after']);
                const cool = (Number.isFinite(ra) && ra > 0 ? ra : 5 * Math.pow(2, Math.min(depth, 3))) * 1000;
                log(`触发限流(429)，冷却 ${Math.round(cool / 1000)}s 后重试...`, 'warning');
                await delay(cool);
                return apiCall(domain, params, depth + 1);
            }
            throw new Error('触发站点限流(429)，请调大请求间隔稍后再试');
        }
        
        if (response.statusCode === 401 && response.data.includes('Invalid request')) {
            // 区分验证挑战 vs 普通签名失败
            const isVerify = /verify|验证|challenge|slide|captcha/i.test(response.data.slice(0, 500));
            if (isVerify && depth === 0) {
                log('站点要求安全验证，等待 12s 后重试一次...', 'warning');
                await delay(12000);
                return apiCall(domain, params, depth + 1);
            }
            // 签名失败，重试
            if (depth < CONFIG.MAX_RETRIES) {
                log('签名失败，延迟后重试...', 'warning');
                await delay(getRandomDelay() * Math.pow(2, Math.min(depth, 2)));
                return apiCall(domain, params, depth + 1);
            } else {
                throw new Error('签名校验失败，已达最大重试次数');
            }
        }
        
        try {
            const json = JSON.parse(response.data);
            return { status: response.statusCode, json: json };
        } catch (e) {
            return { status: response.statusCode, data: response.data };
        }
    } catch (error) {
        if (depth < CONFIG.MAX_RETRIES) {
            log(`请求失败，延迟后重试 (${depth + 1}/${CONFIG.MAX_RETRIES}): ${error.message}`, 'warning');
            await delay(getRandomDelay());
            return apiCall(domain, params, depth + 1);
        } else {
            throw error;
        }
    }
}

// 搜索音乐
async function searchMusic(domain, query, source = CONFIG.DEFAULT_SOURCE) {
    log(`搜索音乐: ${query} (${source})`, 'info');
    
    const params = {
        types: 'search',
        count: CONFIG.DEFAULT_COUNT,
        source: source,
        pages: CONFIG.DEFAULT_PAGES,
        name: query
    };
    
    const result = await apiCall(domain, params);
    
    if (result.status !== 200 || !Array.isArray(result.json)) {
        throw new Error(`搜索失败: ${result.status} - ${result.data || result.json}`);
    }
    
    log(`找到 ${result.json.length} 首歌曲`, 'success');
    return result.json;
}

// 获取音乐URL
async function getMusicUrl(domain, trackId, source = CONFIG.DEFAULT_SOURCE, quality = CONFIG.DEFAULT_QUALITY) {
    // 音质降级链：从目标档向下逐档（999→740→320→192→128），借鉴 EchoMusic resolver 候选降级思路。
    // 各源支持档位见 CONFIG.SOURCES[source].qualities，按该列表从目标档开始降级。
    const supported = CONFIG.SOURCES[source]?.qualities || ['128', '320', '999'];
    const ordered = [...supported].sort((a, b) => Number(b) - Number(a));
    const startIdx = ordered.indexOf(String(quality));
    const targets = startIdx >= 0 ? ordered.slice(startIdx) : [String(quality)];

    let lastError = null;
    let lastDenied = null;
    for (const q of targets) {
        log(`获取音乐URL: ${trackId} (${source}) - 质量: ${q}`, 'info');
        const params = {
            types: 'url',
            source: source,
            id: trackId,
            br: q
        };

        const result = await apiCall(domain, params);

        if (result.status !== 200 || !result.json) {
            lastError = new Error(`获取URL失败: ${result.status}`);
            continue;
        }

        if (result.json.br === -2 || result.json.br === -3) {
            lastDenied = { ...result.json, denied: true, br: q };
            continue;
        }
        if (result.json.br === -1 || !result.json.url || result.json.url === 'err') {
            continue;
        }

        log(`成功获取URL: ${result.json.url}`, 'success');
        return { ...result.json, requestedBr: q, degraded: Number(q) < Number(quality) };
    }
    if (lastDenied) return lastDenied;
    if (lastError) throw lastError;
    throw new Error(`音乐不可用或音质不支持（已尝试 ${targets.join('→')}）`);
}

// 下载音乐文件
async function downloadMusic(url, filename) {
    log(`下载音乐: ${filename}`, 'info');
    
    const outputPath = path.join(CONFIG.OUTPUT_DIR, filename);
    
    // 检查文件是否已存在
    if (fs.existsSync(outputPath)) {
        log(`文件已存在，跳过下载: ${filename}`, 'warning');
        return outputPath;
    }
    
    // 确保输出目录存在
    if (!fs.existsSync(CONFIG.OUTPUT_DIR)) {
        fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });
    }
    
    try {
        const response = await makeRequest(url);
        
        if (response.statusCode !== 200) {
            throw new Error(`下载失败: ${response.statusCode}`);
        }
        
        fs.writeFileSync(outputPath, response.data);
        log(`下载完成: ${filename}`, 'success');
        return outputPath;
    } catch (error) {
        throw new Error(`下载失败: ${error.message}`);
    }
}

// 格式化文件名
function formatFilename(track, quality) {
    const artist = Array.isArray(track.artist) ? track.artist.join('/') : track.artist || '未知艺术家';
    const title = track.name || '未知歌曲';
    const source = track.source || 'netease';
    const qualityStr = quality === '999' ? 'FLAC' : `${quality}k`;
    
    // 清理文件名，移除非法字符
    const cleanArtist = artist.replace(/[\/\\:*?"<>|]/g, '_');
    const cleanTitle = title.replace(/[\/\\:*?"<>|]/g, '_');
    
    return `${cleanArtist} - ${cleanTitle} [${source}-${qualityStr}].flac`;
}

// 检查文件是否已存在
function checkFileExists(filename) {
    const outputPath = path.join(CONFIG.OUTPUT_DIR, filename);
    return fs.existsSync(outputPath);
}

// 获取已下载的文件列表
function getExistingFiles() {
    const existingFiles = new Set();
    
    if (!fs.existsSync(CONFIG.OUTPUT_DIR)) {
        return existingFiles;
    }
    
    const folders = fs.readdirSync(CONFIG.OUTPUT_DIR);
    
    folders.forEach(folder => {
        const folderPath = path.join(CONFIG.OUTPUT_DIR, folder);
        const stats = fs.statSync(folderPath);
        
        if (stats.isDirectory()) {
            const files = fs.readdirSync(folderPath);
            files.forEach(file => {
                if (file.endsWith('.flac') || file.endsWith('.mp3')) {
                    existingFiles.add(file);
                }
            });
        }
    });
    
    return existingFiles;
}

// 主下载函数
async function downloadMusicTrack(domain, track, source = CONFIG.DEFAULT_SOURCE, quality = CONFIG.DEFAULT_QUALITY) {
    try {
        log(`开始下载: ${track.name} - ${track.artist?.join('/') || '未知'}`, 'info');
        
        // 获取音乐URL（含音质降级链）
        const urlResult = await getMusicUrl(domain, track.id, source, quality);
        
        if (urlResult.denied) {
            log(`无版权/试听受限（br=${urlResult.br}），跳过`, 'warning');
            return {
                success: false,
                track: track,
                denied: true,
                error: `无版权/试听受限（br=${urlResult.br}）`
            };
        }
        
        // 格式化文件名
        const filename = formatFilename(track, urlResult.requestedBr || urlResult.br || quality);
        
        // 下载音乐
        const outputPath = await downloadMusic(urlResult.url, filename);
        
        return {
            success: true,
            track: track,
            filename: filename,
            outputPath: outputPath,
            url: urlResult.url,
            quality: urlResult.br,
            degraded: urlResult.degraded
        };
    } catch (error) {
        log(`下载失败: ${track.name} - ${error.message}`, 'error');
        return {
            success: false,
            track: track,
            error: error.message
        };
    }
}

// 批量下载
async function batchDownload(domain, query, source = CONFIG.DEFAULT_SOURCE, quality = CONFIG.DEFAULT_QUALITY, maxResults = 10) {
    log(`开始批量下载: ${query} (${source})`, 'info');
    
    // 获取已下载的文件列表
    const existingFiles = getExistingFiles();
    log(`已下载文件数量: ${existingFiles.size}`, 'info');
    
    // 搜索音乐
    const tracks = await searchMusic(domain, query, source);
    
    if (tracks.length === 0) {
        throw new Error('未找到相关音乐');
    }
    
    // 限制下载数量
    const downloadTracks = tracks.slice(0, maxResults);
    log(`将下载 ${downloadTracks.length} 首歌曲`, 'info');
    
    const results = [];
    let skippedCount = 0;
    
    for (let i = 0; i < downloadTracks.length; i++) {
        const track = downloadTracks[i];
        const filename = formatFilename(track, quality);
        
        // 检查文件是否已存在
        if (existingFiles.has(filename)) {
            log(`文件已存在，跳过: ${track.name} - ${track.artist?.join('/') || '未知'}`, 'warning');
            skippedCount++;
            results.push({
                success: true,
                track: track,
                filename: filename,
                skipped: true,
                message: '文件已存在'
            });
            continue;
        }
        
        log(`处理第 ${i + 1 - skippedCount}/${downloadTracks.length - skippedCount} 首歌曲`, 'info');
        
        // 添加随机延迟防止限流
        if (i > 0) {
            const delayTime = getRandomDelay();
            log(`等待 ${delayTime}ms 后继续...`, 'info');
            await delay(delayTime);
        }
        
        const result = await downloadMusicTrack(domain, track, source, quality);
        results.push(result);
    }
    
    // 统计结果
    const successCount = results.filter(r => r.success && !r.skipped).length;
    const skipCount = results.filter(r => r.skipped).length;
    const failCount = results.filter(r => !r.success).length;
    
    log(`批量下载完成: ${successCount} 成功, ${skipCount} 跳过, ${failCount} 失败`, 'success');
    
    return {
        total: results.length,
        success: successCount,
        skipped: skipCount,
        failed: failCount,
        results: results
    };
}

// 命令行接口
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length < 1) {
        console.log('用法:');
        console.log('  node gd-international-downloader.js <搜索关键词> [音源] [音质] [数量] [镜像]');
        console.log('');
        console.log('示例:');
        console.log('  node gd-international-downloader.js "周杰伦" netease 999 5');
        console.log('  node gd-international-downloader.js "流行音乐" kuwo 320 10');
        console.log('  node gd-international-downloader.js "周杰伦" netease 999 5 cn   # 手动指定镜像');
        console.log('');
        console.log('支持的音源:');
        console.log('  镜像: cn / hk / us / default（缺省按音源自动选择，migu/kugou/ximalaya→cn，joox→hk，qobuz/ytmusic→us）');
        console.log('');
        Object.entries(CONFIG.SOURCES).forEach(([key, info]) => {
            console.log(`  ${key}: ${info.name}`);
        });
        console.log('');
        console.log('支持的音质:');
        console.log('  128: 128kbps');
        console.log('  192: 192kbps');
        console.log('  320: 320kbps');
        console.log('  999: FLAC');
        return;
    }
    
    const query = args[0];
    const source = args[1] || CONFIG.DEFAULT_SOURCE;
    const quality = args[2] || CONFIG.DEFAULT_QUALITY;
    const count = parseInt(args[3]) || 10;
    const domainArg = args[4] || 'default';
    
    // 验证参数
    if (!CONFIG.SOURCES[source]) {
        log(`不支持的音源: ${source}`, 'error');
        return;
    }
    
    if (!CONFIG.SOURCES[source].qualities.includes(quality)) {
        log(`音源 ${source} 不支持音质 ${quality}`, 'error');
        return;
    }
    
    // 选择域名：手动指定镜像优先，否则按音源自动分流
    let domain;
    if (domainArg && domainArg !== 'default' && CONFIG.DOMAINS.MIRRORS[domainArg]) {
        domain = CONFIG.DOMAINS.MIRRORS[domainArg];
    } else {
        domain = domainForSource(source);
    }

    log(`开始下载: ${query} (${CONFIG.SOURCES[source].name}) - ${quality === '999' ? 'FLAC' : quality + 'kbps'} @ ${domain}`, 'info');
    
    try {
        const result = await batchDownload(domain, query, source, quality, count);
        
        console.log('\n🎉 下载完成!');
        console.log(`总数量: ${result.total}`);
        console.log(`成功: ${result.success}`);
        console.log(`失败: ${result.failed}`);
        
        if (result.failed > 0) {
            console.log('\n❌ 失败的歌曲:');
            result.results.filter(r => !r.success).forEach(r => {
                console.log(`  - ${r.track.name} - ${r.error}`);
            });
        }
        
    } catch (error) {
        log(`下载失败: ${error.message}`, 'error');
    }
}

// 如果直接运行此脚本
if (require.main === module) {
    main().catch(error => {
        log(`错误: ${error.message}`, 'error');
        process.exit(1);
    });
}

module.exports = {
    CONFIG,
    crc32,
    crc32Hex,
    searchMusic,
    getMusicUrl,
    downloadMusicTrack,
    batchDownload
};