/**
 * 功能描述：本地 Mock Release API 服务器 — 模拟 Gitee/GitHub Releases API
 *
 * 使用方式：node scripts/mock-release-server.js
 * 逻辑说明：在本地 9801 端口启动 HTTP 服务，返回模拟的最新 Release 数据。
 *           默认返回版本 0.2.0（高于当前 0.1.0），模拟有可用更新。
 *           提供 /download 端点用于测试下载进度。按 Ctrl+C 停止。
 */

const http = require('http')
const fs = require('fs')
const path = require('path')

const PORT = 9801

/** 模拟下载文件大小（5MB，足够观察进度条变化） */
const MOCK_FILE_SIZE = 5 * 1024 * 1024

/** 真实 exe 路径 */
const REAL_EXE_PATH = 'C:\\Users\\Xwate\\Desktop\\Plain Craft Launcher 2.exe'
const REAL_EXE_BUFFER = fs.readFileSync(REAL_EXE_PATH)
const REAL_EXE_SIZE = REAL_EXE_BUFFER.length

/** 模拟 Release 数据 — downloadUrl 指向本地 Mock 服务器 */
const MOCK_RELEASE = {
  tag_name: 'v1.1.0',
  body: '新增功能：\n- IPv6 直连支持\n- P2P 打洞优化\n- 设置持久化\n- 国际化界面\n- 自动更新流程',
  assets: [
    {
      browser_download_url: `http://127.0.0.1:${PORT}/download/sgi-setup-0.2.0-win.exe`,
      name: 'sgi-setup-0.2.0-win.exe'
    },
    {
      browser_download_url: `http://127.0.0.1:${PORT}/download/sgi-setup-0.2.0-mac.dmg`,
      name: 'sgi-setup-0.2.0-mac.dmg'
    },
    {
      browser_download_url: `http://127.0.0.1:${PORT}/download/sgi-setup-0.2.0-linux.AppImage`,
      name: 'sgi-setup-0.2.0-linux.AppImage'
    }
  ]
}

const server = http.createServer((req, res) => {
  // 版本检查 API
  if (req.url.includes('releases/latest')) {
    console.log(`[mock] 版本检查: ${req.url}`)
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    })
    res.end(JSON.stringify(MOCK_RELEASE))
    return
  }

  // 文件下载端点 — 模拟大文件下载以测试进度条和断点续传
  if (req.url.includes('/download/')) {
    const fileName = req.url.split('/').pop()

    // Windows 平台：使用真实的 notepad.exe 验证安装流程
    const isWindowsExe = fileName.endsWith('-win.exe')

    // 解析 Range 请求头，支持断点续传
    const rangeHeader = req.headers['range'] || ''
    let startByte = 0
    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-/)
      if (match) startByte = parseInt(match[1], 10)
    }

    const fileSize = isWindowsExe ? REAL_EXE_SIZE : MOCK_FILE_SIZE
    const remaining = fileSize - startByte
    const statusCode = startByte > 0 ? 206 : 200
    console.log(`[mock] 下载: ${fileName} range=${startByte}- 剩余=${(remaining / 1024).toFixed(0)}KB`)

    const chunkSize = 64 * 1024 // 64KB 一块
    let bytesSent = 0

    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': String(remaining),
      'Accept-Ranges': 'bytes'
    }
    if (statusCode === 206) {
      headers['Content-Range'] = `bytes ${startByte}-${fileSize - 1}/${fileSize}`
    }
    res.writeHead(statusCode, headers)

    // 分块发送数据，每块间隔 50ms 以模拟下载速度
    function sendChunk() {
      if (bytesSent >= remaining) {
        res.end()
        if (startByte > 0) console.log(`[mock] 续传完成: ${fileName}`)
        else console.log(`[mock] 下载完成: ${fileName}`)
        return
      }

      const size = Math.min(chunkSize, remaining - bytesSent)
      const offset = startByte + bytesSent
      if (isWindowsExe && offset < REAL_EXE_SIZE) {
        res.write(REAL_EXE_BUFFER.slice(offset, offset + size))
      } else {
        const crypto = require('crypto')
        res.write(crypto.randomBytes(size))
      }
      bytesSent += size

      setTimeout(sendChunk, 50)
    }

    sendChunk()
    return
  }

  res.writeHead(404)
  res.end('Not Found')
})

server.listen(PORT, () => {
  console.log(`Mock Release API 服务器已启动: http://127.0.0.1:${PORT}`)
  console.log(`返回版本: v1.1.0 (当前应用版本 1.0.0), 使用 Plain Craft Launcher 2`)
  console.log('需要先在设置页重新下载更新包，点击安装后会启动 PCL2')
  console.log('按 Ctrl+C 停止服务')
})
