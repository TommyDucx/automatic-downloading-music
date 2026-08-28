#!/usr/bin/env node

// 测试国际版 music.gdstudio.xyz API，使用正确的 hostname 签名
const https = require('https');
const crypto = require('crypto');

// 正确的 CRC32 实现（考虑 hostname）
function crc32(input) {
    const polynomial = 0xEDB88320;
    let crc = 0xFFFFFFFF;
    
    let bytes;
    if (typeof input === 'string') {
        bytes = Buffer.from(input, 'utf8');
    } else if (Buffer.isBuffer(input)) {
        bytes = input;
    } else {
        throw new Error('Input must be string or Buffer');
    }
    
    for (let i = 0; i < bytes.length; i++) {
        crc ^= bytes[i];
        
        for (let j = 0; j < 8; j++) {
            if (crc & 1) {
                crc = (crc >>> 1) ^ polynomial;
            } else {
                crc = crc >>> 1;
            }
        }
    }
    
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function crc32Hex(input) {
    return crc32(input).toString(16).toUpperCase().padStart(8, '0');
}

// URL 编码
function urlEncode(str) {
    return encodeURIComponent(str);
}

// 测试搜索（使用正确的 hostname）
async function testSearchWithHostname() {
    const hostname = 'music.gdstudio.xyz';
    const query = "HOME";
    const encodedQuery = urlEncode(query);
    
    // 尝试不同的签名计算方式
    const signatureMethods = [
        { name: 'query only', signature: crc32Hex(encodedQuery) },
        { name: 'query + hostname', signature: crc32Hex(encodedQuery + hostname) },
        { name: 'hostname + query', signature: crc32Hex(hostname + encodedQuery) },
        { name: 'full url', signature: crc32Hex('https://' + hostname + '/api.php') },
        { name: 'timestamp + query', signature: crc32Hex(Math.floor(Date.now() / 1000) + encodedQuery) },
    ];
    
    console.log('🔍 测试不同的签名计算方法...');
    
    for (const method of signatureMethods) {
        console.log(`\n📝 方法: ${method.name}`);
        console.log(`   签名: ${method.signature}`);
        
        const postData = `types=search&count=20&source=netease&pages=1&name=${encodedQuery}&s=${method.signature}`;
        
        const options = {
            hostname: hostname,
            port: 443,
            path: '/api.php',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Content-Length': Buffer.byteLength(postData)
            }
        };
        
        try {
            const result = await new Promise((resolve, reject) => {
                const req = https.request(options, (res) => {
                    let data = '';
                    res.on('data', (chunk) => data += chunk);
                    res.on('end', () => {
                        try {
                            const result = JSON.parse(data);
                            resolve({ status: res.statusCode, data: result });
                        } catch (e) {
                            resolve({ status: res.statusCode, data: data });
                        }
                    });
                });
                
                req.on('error', reject);
                req.write(postData);
                req.end();
            });
            
            console.log(`   状态: ${result.status}`);
            if (result.status === 200 && result.data && result.data.length > 0) {
                console.log(`   ✅ 成功！找到 ${result.data.length} 首歌`);
                console.log(`   第一首: ${result.data[0].name} - ${result.data[0].artist}`);
                return result.data[0]; // 返回第一个成功的结果
            } else if (result.data && typeof result.data === 'string') {
                console.log(`   ❌ 失败: ${result.data}`);
            } else {
                console.log(`   ❌ 失败: ${JSON.stringify(result.data, null, 2).substring(0, 200)}...`);
            }
        } catch (error) {
            console.log(`   ❌ 错误: ${error.message}`);
        }
        
        // 避免请求过快
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    return null;
}

// 测试从 /time 获取时间戳并重新计算签名
async function testWithTimestamp() {
    const hostname = 'music.gdstudio.xyz';
    
    try {
        // 获取服务器时间戳
        const timestamp = await new Promise((resolve, reject) => {
            const options = {
                hostname: hostname,
                port: 443,
                path: '/time',
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
                }
            };
            
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => resolve(data.trim()));
            });
            
            req.on('error', reject);
            req.end();
        });
        
        console.log(`\n🕐 服务器时间戳: ${timestamp}`);
        
        const query = "HOME";
        const encodedQuery = urlEncode(query);
        
        // 尝试时间戳相关的签名
        const timestampSignature = crc32Hex(timestamp + encodedQuery);
        console.log(`时间戳+查询签名: ${timestampSignature}`);
        
        const postData = `types=search&count=20&source=netease&pages=1&name=${encodedQuery}&s=${timestampSignature}`;
        
        const options = {
            hostname: hostname,
            port: 443,
            path: '/api.php',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Content-Length': Buffer.byteLength(postData)
            }
        };
        
        const result = await new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        resolve({ status: res.statusCode, data: result });
                    } catch (e) {
                        resolve({ status: res.statusCode, data: data });
                    }
                });
            });
            
            req.on('error', reject);
            req.write(postData);
            req.end();
        });
        
        console.log(`状态: ${result.status}`);
        if (result.status === 200 && result.data && result.data.length > 0) {
            console.log(`✅ 成功！使用时间戳签名找到 ${result.data.length} 首歌`);
            return result.data[0];
        } else {
            console.log(`❌ 时间戳签名失败: ${JSON.stringify(result.data, null, 2).substring(0, 200)}...`);
        }
    } catch (error) {
        console.log(`❌ 获取时间戳失败: ${error.message}`);
    }
    
    return null;
}

// 主函数
async function main() {
    console.log('🔍 测试 music.gdstudio.xyz API（考虑 hostname）...');
    console.log(`时间戳: ${Math.floor(Date.now() / 1000)}`);
    
    // 测试不同的签名方法
    const firstSong = await testSearchWithHostname();
    
    if (!firstSong) {
        console.log('\n🔄 尝试使用服务器时间戳...');
        const timestampSong = await testWithTimestamp();
        
        if (!timestampSong) {
            console.log('\n❌ 所有方法都失败了');
            console.log('\n💡 可能的原因：');
            console.log('1. 国际版可能有不同的认证机制');
            console.log('2. 可能需要特殊的请求头');
            console.log('3. 可能需要 CSRF token');
            console.log('4. 可能需要 cookies');
            console.log('5. 国际版可能暂时不可用');
        }
    } else {
        console.log('\n🎉 成功找到歌曲！');
        
        // 测试获取URL
        console.log('\n🔗 测试获取下载URL...');
        const urlId = urlEncode(firstSong.id);
        const urlSignature = crc32Hex(urlId);
        
        try {
            const urlPostData = `types=url&id=${urlId}&source=netease&br=999&s=${urlSignature}`;
            
            const urlResult = await new Promise((resolve, reject) => {
                const options = {
                    hostname: hostname,
                    port: 443,
                    path: '/api.php',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'X-Requested-With': 'XMLHttpRequest',
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                        'Content-Length': Buffer.byteLength(urlPostData)
                    }
                };
                
                const req = https.request(options, (res) => {
                    let data = '';
                    res.on('data', (chunk) => data += chunk);
                    res.on('end', () => {
                        try {
                            const result = JSON.parse(data);
                            resolve({ status: res.statusCode, data: result });
                        } catch (e) {
                            resolve({ status: res.statusCode, data: data });
                        }
                    });
                });
                
                req.on('error', reject);
                req.write(urlPostData);
                req.end();
            });
            
            console.log('URL结果:', JSON.stringify(urlResult, null, 2));
        } catch (error) {
            console.log('❌ 获取URL失败:', error.message);
        }
    }
}

main().catch(console.error);