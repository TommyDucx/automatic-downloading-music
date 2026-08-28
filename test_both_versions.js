#!/usr/bin/env node

// 测试原版网站的 VM 签名计算
const https = require('https');
const crypto = require('crypto');

// 简化的 CRC32 实现（用于测试）
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

// 测试原版网站
async function testOriginal() {
    const host = 'music.gdstudio.org';
    const timestamp = Math.floor(Date.now() / 1000);
    const query = "HOME";
    
    // 模拟 VM 环境中的签名计算
    const signInput = encodeURIComponent(query);
    const signature = crc32Hex(signInput);
    
    console.log('原版网站测试:');
    console.log(`时间戳: ${timestamp}`);
    console.log(`查询: ${query}`);
    console.log(`签名输入: ${signInput}`);
    console.log(`签名: ${signature}`);
    
    const postData = `types=search&name=${signInput}&s=${signature}`;
    
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
    
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                console.log(`状态: ${res.statusCode}`);
                console.log(`响应: ${data.substring(0, 300)}`);
                resolve({ status: res.statusCode, data: data });
            });
        });
        
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

// 测试国际版（相同的签名计算方法）
async function testInternational() {
    const host = 'music.gdstudio.xyz';
    const timestamp = Math.floor(Date.now() / 1000);
    const query = "HOME";
    
    // 使用相同的签名计算方法
    const signInput = encodeURIComponent(query);
    const signature = crc32Hex(signInput);
    
    console.log('\n国际版网站测试:');
    console.log(`时间戳: ${timestamp}`);
    console.log(`查询: ${query}`);
    console.log(`签名输入: ${signInput}`);
    console.log(`签名: ${signature}`);
    
    const postData = `types=search&name=${signInput}&s=${signature}`;
    
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
    
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                console.log(`状态: ${res.statusCode}`);
                console.log(`响应: ${data.substring(0, 300)}`);
                resolve({ status: res.statusCode, data: data });
            });
        });
        
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

async function main() {
    console.log('🔍 测试原版 vs 国际版 API（使用相同的签名计算方法）');
    
    try {
        const originalResult = await testOriginal();
        
        if (originalResult.status === 200 && originalResult.data.includes('[')) {
            console.log('\n✅ 原版网站正常工作');
        } else {
            console.log('\n❌ 原版网站也有问题');
        }
        
        const internationalResult = await testInternational();
        
        if (internationalResult.status === 200 && internationalResult.data.includes('[')) {
            console.log('\n✅ 国际版网站正常工作');
        } else {
            console.log('\n❌ 国际版网站有问题');
        }
        
    } catch (error) {
        console.error('测试失败:', error.message);
    }
}

main().catch(console.error);