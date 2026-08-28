#!/usr/bin/env node

// 测试国际版 API 端点 music-api.gdstudio.xyz
const https = require('https');
const crypto = require('crypto');

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

// 测试搜索功能
async function testSearchAPI() {
    const host = 'music-api.gdstudio.xyz';
    const timestamp = Math.floor(Date.now() / 1000);
    const query = "HOME";
    
    // 基于洛雪音乐源脚本的实现
    const signInput = encodeURIComponent(query);
    const signature = crc32Hex(signInput);
    
    console.log('🔍 测试国际版搜索 API:');
    console.log(`时间戳: ${timestamp}`);
    console.log(`查询: ${query}`);
    console.log(`签名输入: ${signInput}`);
    console.log(`签名: ${signature}`);
    
    // 尝试不同的参数组合
    const testCases = [
        {
            name: '基础搜索',
            data: `types=search&name=${signInput}&s=${signature}`
        },
        {
            name: '带参数搜索',
            data: `types=search&count=20&source=netease&pages=1&name=${signInput}&s=${signature}`
        },
        {
            name: '酷我音乐搜索',
            data: `types=search&count=20&source=kuwo&pages=1&name=${signInput}&s=${signature}`
        }
    ];
    
    for (const testCase of testCases) {
        console.log(`\n📋 测试: ${testCase.name}`);
        console.log(`请求数据: ${testCase.data}`);
        
        try {
            const response = await makeAPIRequest(host, testCase.data);
            console.log(`状态码: ${response.statusCode}`);
            console.log(`响应: ${response.data.substring(0, 300)}...`);
            
            if (response.statusCode === 200 && response.data.includes('[')) {
                console.log('✅ 成功!');
            } else {
                console.log('❌ 失败');
            }
        } catch (error) {
            console.log(`❌ 错误: ${error.message}`);
        }
    }
}

// 测试 URL 获取功能
async function testUrlAPI() {
    const host = 'music-api.gdstudio.xyz';
    
    console.log('\n🎵 测试国际版 URL 获取 API:');
    
    // 假设的歌曲ID（需要先搜索获得真实的ID）
    const testCases = [
        {
            name: '网易云音乐测试',
            data: `types=url&source=netease&id=190137&br=320`
        },
        {
            name: '酷我音乐测试',
            data: `types=url&source=kuwo&id=654321&br=320`
        }
    ];
    
    for (const testCase of testCases) {
        console.log(`\n📋 测试: ${testCase.name}`);
        console.log(`请求数据: ${testCase.data}`);
        
        try {
            const response = await makeAPIRequest(host, testCase.data);
            console.log(`状态码: ${response.statusCode}`);
            console.log(`响应: ${response.data.substring(0, 300)}...`);
            
            if (response.statusCode === 200 && response.data.includes('http')) {
                console.log('✅ 成功!');
            } else {
                console.log('❌ 失败');
            }
        } catch (error) {
            console.log(`❌ 错误: ${error.message}`);
        }
    }
}

// 通用 API 请求函数
function makeAPIRequest(host, postData) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: host,
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
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    data: data
                });
            });
        });
        
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

// 主函数
async function main() {
    console.log('🚀 开始测试国际版 API 端点');
    console.log('=====================================');
    
    try {
        await testSearchAPI();
        await testUrlAPI();
        
        console.log('\n🎉 测试完成!');
        console.log('=====================================');
        console.log('基于洛雪音乐源项目的逆向工程测试');
        console.log('如果搜索功能正常，我们可以继续完善下载脚本');
        
    } catch (error) {
        console.error('测试过程中发生错误:', error);
    }
}

main().catch(console.error);