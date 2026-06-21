/**
 * 功能描述：应用图标生成脚本
 *
 * 逻辑说明：将 SVG 图标转换为平台所需格式。
 *           生成 Windows ICO、macOS ICNS、Linux PNG 图标。
 *           使用纯 JS 生成含内嵌 PNG 的有效 ICO 文件。
 *
 * 使用方法：node scripts/generate-icons.js
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const SVG_PATH = path.join(__dirname, '..', 'resources', 'icons', 'icon.svg')
const OUTPUT_DIR = path.join(__dirname, '..', 'resources', 'icons')

// 读取 SVG 作为 PNG 占位（实际生产环境应使用 sharp 或 canvas 转换）
// 这里生成一个 ICO 容器，内嵌 32x32 PNG
// 开发环境可用 SVG 作为图标源，生产构建前请用专业工具生成

function createPlaceholderPng(size) {
  // 创建一个极简的有效 PNG（1x1 像素蓝色方块）
  // 实际项目中用 sharp: sharp(svg).resize(size).png().toFile(...)
  // 或使用：npx pwa-icon-generator resources/icons/icon.svg

  // 这里是手动构建有效的 1x1 PNG（极小，仅占位）
  // 构建 IHDR + IDAT + IEND
  const width = size
  const height = size

  // 生成原始像素数据 (RGBA)
  const rawData = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4
      // 紫色渐变
      const cx = x / width
      const cy = y / height
      rawData[idx] = Math.round(102 + cx * 20)     // R
      rawData[idx + 1] = Math.round(126 + cy * 20)  // G
      rawData[idx + 2] = Math.round(234 - cx * 30)  // B
      rawData[idx + 3] = 255                         // A
    }
  }

  // 添加 filter bytes (每个扫描行前加 0x00)
  const filtered = Buffer.alloc(rawData.length + height)
  for (let y = 0; y < height; y++) {
    filtered[y * (width * 4 + 1)] = 0 // None filter
    rawData.copy(filtered, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }

  // 压缩图像数据
  const deflated = zlib.deflateSync(filtered)

  // 构建 PNG 文件
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  // IHDR chunk
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(width, 0)
  ihdrData.writeUInt32BE(height, 4)
  ihdrData[8] = 8  // bit depth
  ihdrData[9] = 6  // color type: RGBA
  ihdrData[10] = 0 // compression
  ihdrData[11] = 0 // filter
  ihdrData[12] = 0 // interlace
  const ihdrChunk = createPngChunk('IHDR', ihdrData)

  // IDAT chunk
  const idatChunk = createPngChunk('IDAT', deflated)

  // IEND chunk
  const iendChunk = createPngChunk('IEND', Buffer.alloc(0))

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk])
}

function createPngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)

  const typeBuffer = Buffer.from(type, 'ascii')
  const crcData = Buffer.concat([typeBuffer, data])

  // CRC32
  let crc = 0xffffffff
  for (let i = 0; i < crcData.length; i++) {
    crc ^= crcData[i]
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  crc = (crc ^ 0xffffffff) >>> 0

  const crcBuffer = Buffer.alloc(4)
  crcBuffer.writeUInt32BE(crc, 0)

  return Buffer.concat([length, typeBuffer, data, crcBuffer])
}

/**
 * 功能描述：创建 ICO 文件（Windows 图标格式）
 *
 * 逻辑说明：ICO 文件头 + N 个目录项 + 各尺寸 PNG 图像数据。
 *           包含 256x256 和 32x32 两个条目，满足 electron-builder
 *           最低 256x256 要求，同时兼容旧版 Windows。
 *
 * @param {Array<{pngData: Buffer, size: number}>} entries - 图标条目列表
 * @returns {Buffer} ICO 文件二进制数据
 */
function createIco(entries) {
  const count = entries.length

  // ICO header
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)  // reserved
  header.writeUInt16LE(1, 2)  // ICO type
  header.writeUInt16LE(count, 4)  // number of images

  // Directory entries + image data
  const dirEntrySize = 16
  const headerSize = 6 + count * dirEntrySize
  let offset = headerSize
  const buffers = [header]

  for (const { pngData, size } of entries) {
    const entry = Buffer.alloc(dirEntrySize)
    entry.writeUInt8(size >= 256 ? 0 : size, 0)  // width (0 = 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1)  // height (0 = 256)
    entry.writeUInt8(0, 2)  // colors
    entry.writeUInt8(0, 3)  // reserved
    entry.writeUInt16LE(1, 4)  // planes
    entry.writeUInt16LE(32, 6) // bpp
    entry.writeUInt32LE(pngData.length, 8)  // image size
    entry.writeUInt32LE(offset, 12)  // offset from start of file
    buffers.push(entry)
    offset += pngData.length
  }

  for (const { pngData } of entries) {
    buffers.push(pngData)
  }

  return Buffer.concat(buffers)
}

/**
 * 功能描述：创建 ICNS 文件（macOS 图标格式）
 *
 * 逻辑说明：ICNS 容器格式，使用 ic07（128x128 PNG）类型。
 */
function createIcns(png128) {
  const TYPE_icns = Buffer.from('icns', 'ascii')
  const TYPE_ic07 = Buffer.from('ic07', 'ascii')

  // ICNS header
  const totalSize = 8 + 8 + png128.length
  const header = Buffer.alloc(8)
  TYPE_icns.copy(header, 0)
  header.writeUInt32BE(totalSize, 4)

  // Icon entry
  const entry = Buffer.alloc(8)
  TYPE_ic07.copy(entry, 0)
  entry.writeUInt32BE(8 + png128.length, 4)

  return Buffer.concat([header, entry, png128])
}

function main() {
  console.log('正在生成应用图标...')

  // 确保输出目录存在
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  }

  // 生成各尺寸 PNG
  const png32 = createPlaceholderPng(32)
  const png128 = createPlaceholderPng(128)
  const png256 = createPlaceholderPng(256)
  const png512 = createPlaceholderPng(512)

  // Windows ICO (256x256 + 32x32)
  const ico = createIco([
    { pngData: png256, size: 256 },
    { pngData: png32, size: 32 }
  ])
  fs.writeFileSync(path.join(OUTPUT_DIR, 'icon.ico'), ico)
  console.log('  ✓ icon.ico (Windows)')

  // macOS ICNS (128x128)
  const icns = createIcns(png128)
  fs.writeFileSync(path.join(OUTPUT_DIR, 'icon.icns'), icns)
  console.log('  ✓ icon.icns (macOS)')

  // Linux PNG (256x256)
  fs.writeFileSync(path.join(OUTPUT_DIR, 'icon.png'), png256)
  console.log('  ✓ icon.png (Linux)')

  // 额外尺寸
  fs.writeFileSync(path.join(OUTPUT_DIR, 'icon-512.png'), png512)
  console.log('  ✓ icon-512.png')

  console.log('\n图标生成完成！')
  console.log('注意：这些是程序化生成的占位图标。')
  console.log('生产环境请使用专业图标设计工具生成正式图标。')
}

main()
