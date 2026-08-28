#!/usr/bin/env node

// 测试国际版 music.gdstudio.xyz API
const https = require('https');
const crypto = require('crypto');

// 获取当前时间戳
function getTimestamp() {
    return Math.floor(Date.now() / 1000);
}

// URL 编码
function urlEncode(str) {
    return encodeURIComponent(str);
}

// 简单的 CRC32 实现
function crc32(str) {
    const table = [
        0x00000000, 0x04c11db7, 0x09823b6e, 0x0d4326d9, 0x130476dc, 0x17c56b6b,
        0x1a864db2, 0x1e475005, 0x2608edb8, 0x22c9f00f, 0x2f8ad6d6, 0x2b4bcb61,
        0x350c9b64, 0x31cd86d3, 0x3c8ea00a, 0x384fbdbd, 0x4c11db70, 0x48d0c6c7,
        0x45f3c246, 0x4152fda9, 0x5f15adac, 0x5bd42473, 0x56c16aa6, 0x525e4f99,
        0x6a1936c8, 0x6ed82b7f, 0x639b0da6, 0x675a1011, 0x791d4014, 0x7ddc5da3,
        0x709f7b7a, 0x745e66cd, 0x9823b6e0, 0x9ce2ab57, 0x91a18d8e, 0x95609039,
        0x8b27c03c, 0x8fe6dd8b, 0x82a5fb52, 0x8664e6e5, 0xbe2b5b58, 0xbaea46ef,
        0xb7a96036, 0xb3687d81, 0xad2f2d84, 0xa9ee3033, 0xa4ad16ea, 0xa06c0b5d,
        0xd4326d90, 0xd0f37027, 0xddb056fe, 0xd9714b49, 0xc7361b4c, 0xc3f706fb,
        0xceb42022, 0xca753d95, 0xf23a8028, 0xf6fb9d9f, 0xfbb8bb46, 0xff79a6f1,
        0xe13ef6f4, 0xe5ffeb43, 0xe8bccd9a, 0xec7dd02d, 0x34867077, 0x30476dc0,
        0x3d044b19, 0x39c556ae, 0x27820624, 0x23431b1e, 0x2e003dc5, 0x2ac12072,
        0x128e9dcf, 0x164f8078, 0x1b0ca6a1, 0x1fcdbb16, 0x018aeb13, 0x054bf6a4,
        0x0808d07d, 0x0cc9cdca, 0x7897ab07, 0x7c56b6b0, 0x71159069, 0x75d48dde,
        0x6b580ee4, 0x6f4f4b76, 0x616ff43e, 0x6ab02011, 0x6bc020c8, 0x6ff0706b,
        0x63176d3a, 0x646d6ff3, 0x5d98ff9c, 0x594b8d29, 0x555c7318, 0x5155b364,
        0x251d3b9e, 0x21dc2623, 0x2c9f00f0, 0x285e1d47, 0x36194d42, 0x32d850f5,
        0x3f9b762c, 0x3b5a6b9b, 0x0315d863, 0x07d4cb31, 0x0a97ed48, 0x0e56f0ff,
        0x1011a0fa, 0x14de548f, 0x19939b94, 0x1d7361c3, 0x0120ddfd, 0x0408b5c4,
        0x0804b5c7, 0x0cc4697a, 0x1dc0118a, 0x1b4669a0, 0x17d60122, 0x136c9856,
        0x13583566, 0x179fd066, 0x1e0ad16c, 0x1c661b3d, 0x0128c9dc, 0x040853a4,
        0x0806d47d, 0x0c0454b5, 0x1cc9ea26, 0x1a8754df, 0x1682b90e, 0x12b7c523,
        0x1cb0af19, 0x1f852a78, 0x134d152e, 0x1767dfc3, 0x153e1763, 0x1a458eea,
        0x1d609f6b, 0x1a6c4e0d, 0x1562e5c7, 0x1296d0c8, 0x0e0bd962, 0x0c06d0e7,
        0x080cd7a5, 0x044f86d5, 0x4a4fc4b2, 0x470cdd2b, 0x43cdc09c, 0x4f8d7df4,
        0x5b5e139f, 0x5f15e202, 0x52b5f9eb, 0x56a3cc2d, 0x6a5a6e5b, 0x6e0d527f,
        0x6210e0a1, 0x66a0abbf, 0x7ca92ff6, 0x7fc28fff, 0x73b9130f, 0x776a9988,
        0x7f12c0e9, 0x7b77d1c4, 0x723d663a, 0x765a71d8, 0x687f236d, 0x6c5c9a6e,
        0x617dc6a7, 0x65aabebe, 0x6a6d85a2, 0x6ee8def8, 0x63b0d3a3, 0x675a1011,
        0x6e1c3056, 0x6a5a6e5b, 0x6d40c863, 0x69a994a4, 0x4b04d447, 0x4f45c66a,
        0x4285a23e, 0x463bd60c, 0x5d048d30, 0x59c09d14, 0x55d10d98, 0x51f84d45,
        0x5b5e139f, 0x5f15e202, 0x52b5f9eb, 0x56a3cc2d, 0x6a5a6e5b, 0x6e0d527f,
        0x6210e0a1, 0x66a0abbf, 0x7ca92ff6, 0x7fc28fff, 0x73b9130f, 0x776a9988,
        0x7f12c0e9, 0x7b77d1c4, 0x723d663a, 0x765a71d8, 0x687f236d, 0x6c5c9a6e,
        0x617dc6a7, 0x65aabebe, 0x6a6d85a2, 0x6ee8def8, 0x63b0d3a3, 0x675a1011
    ];
    
    let crc = 0xffffffff;
    for (let i = 0; i < str.length; i++) {
        crc = (crc >>> 8) ^ table[(crc ^ str.charCodeAt(i)) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
}

// 测试搜索
async function testSearch() {
    const timestamp = getTimestamp();
    const query = "HOME";
    const encodedQuery = urlEncode(query);
    const signature = crc32(encodedQuery);
    
    const postData = `types=search&count=20&source=netease&pages=1&name=${encodedQuery}&s=${signature}`;
    
    const options = {
        hostname: 'music.gdstudio.xyz',
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
    
    return new Promise((resolve, reject) => {
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
}

// 测试获取URL
async function testGetUrl(id) {
    const timestamp = getTimestamp();
    const encodedId = urlEncode(id);
    const signature = crc32(encodedId);
    
    const postData = `types=url&id=${encodedId}&source=netease&br=999&s=${signature}`;
    
    const options = {
        hostname: 'music.gdstudio.xyz',
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
    
    return new Promise((resolve, reject) => {
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
}

// 主函数
async function main() {
    console.log('🔍 测试 music.gdstudio.xyz API...');
    console.log(`时间戳: ${getTimestamp()}`);
    
    // 测试搜索
    console.log('\n📝 测试搜索 "HOME"...');
    const searchResult = await testSearch();
    console.log('搜索结果:', JSON.stringify(searchResult, null, 2));
    
    if (searchResult.status === 200 && searchResult.data && searchResult.data.length > 0) {
        const firstSong = searchResult.data[0];
        console.log(`\n🎵 找到歌曲: ${firstSong.name} - ${firstSong.artist}`);
        console.log(`ID: ${firstSong.id}, Source: ${firstSong.source}`);
        
        // 测试获取URL
        console.log('\n🔗 测试获取下载URL...');
        const urlResult = await testGetUrl(firstSong.id);
        console.log('URL结果:', JSON.stringify(urlResult, null, 2));
    } else {
        console.log('❌ 搜索失败或无结果');
    }
}

main().catch(console.error);