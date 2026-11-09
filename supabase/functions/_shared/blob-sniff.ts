// 一份字节是什么:看文件头,不信客户端报的类型。图片(PNG、JPEG、GIF、WebP)给真实类型和宽高(气泡先按比例留位置、
// CDN 上按图片处理出缩略图);SVG 也是图片(image/svg+xml,宽高不读),但 OSS 的图片处理不认它(实测 400「This image
// format is not supported」),没有缩略图;别的一律 application/octet-stream,由 CDN 当附件下载(不在 CDN 的域名上当页面跑)。

export interface Sniffed {
  contentType: string
  image: boolean
  width: number | null
  height: number | null
}

const OCTET: Sniffed = { contentType: 'application/octet-stream', image: false, width: null, height: null }
const SVG = 'image/svg+xml'
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to))
const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8)
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0
const u32le = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0
const image = (contentType: string, width: number, height: number): Sniffed =>
  width > 0 && height > 0 ? { contentType, image: true, width, height } : { contentType, image: true, width: null, height: null }

// 开头去掉 BOM、空白、XML 声明、注释和 DOCTYPE 之后是 <svg 元素。只看前 4 KiB(声明和注释再长也够)。
const SVG_START = /^\uFEFF?\s*(?:<\?xml[^>]*\?>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)\s*)*<svg[\s/>]/i
function isSvg(b: Uint8Array): boolean {
  return SVG_START.test(new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 4096)))
}

/** 这种图片在 CDN 上有没有缩略图(x-oss-process):SVG 没有,客户端直接用原图。 */
export const hasThumbnail = (contentType: string): boolean => contentType.startsWith('image/') && contentType !== SVG

// OSS rejects image processing above 20 MiB (ImageTooLarge, 0040-00000001), and decoding sources above its documented
// 250 million px (MemLimitExceeded, 0040-00000012; devdb: 342M px decoded, 360M px refused) — small-byte images can exceed
// that. Long or wide sources are THUMB_PROCESS's job, not a reason to skip. Unknown dimensions: only the bytes limit is known.
export const OSS_IMAGE_PROCESS_MAX_BYTES = 20 * 1024 * 1024
export const OSS_IMAGE_PROCESS_MAX_PIXELS = 250_000_000
const withinPixels = (width: unknown, height: unknown): boolean =>
  !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || (width as number) * (height as number) <= OSS_IMAGE_PROCESS_MAX_PIXELS
export const canSignThumbnail = (contentType: string, sizeBytes: unknown, width?: unknown, height?: unknown): boolean =>
  hasThumbnail(contentType) && typeof sizeBytes === 'number' && Number.isSafeInteger(sizeBytes)
    && sizeBytes > 0 && sizeBytes <= OSS_IMAGE_PROCESS_MAX_BYTES && withinPixels(width, height)

/**
 * EXIF orientation (tag 0x0112 in IFD0) of an APP1 segment whose payload starts at `at`: null when the segment is not EXIF
 * (an XMP packet is APP1 too, often right after the EXIF one), 1 when the EXIF names none or cannot be read.
 */
function exifOrientation(b: Uint8Array, at: number, end: number): number | null {
  if (end > b.length || ascii(b, at, at + 6) !== 'Exif\0\0') return null
  const t = at + 6, le = ascii(b, t, t + 2) === 'II'
  const u16 = (i: number) => (i + 2 <= end ? (le ? u16le(b, i) : u16be(b, i)) : -1)
  const ifd = t + (le ? u32le(b, t + 4) : u32be(b, t + 4))
  for (let k = 0, n = u16(ifd); k < n; k++) {
    const entry = ifd + 2 + 12 * k
    if (u16(entry) === 0x0112) return u16(entry + 8)
  }
  return 1
}

function jpegSize(b: Uint8Array): Sniffed {
  // Orientations 5–8 turn the image a quarter: it is shown with width and height swapped, and it is laid out as shown.
  let turned = false
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return image('image/jpeg', 0, 0)
    const marker = b[i + 1]!
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const length = u16be(b, i + 2)
    // SOF0–SOF15,除了 DHT(C4)、JPG(C8)、DAC(CC)
    if (marker === 0xe1) {
      const o = exifOrientation(b, i + 4, i + 2 + length)
      if (o !== null) turned = o >= 5 && o <= 8
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const width = u16be(b, i + 7), height = u16be(b, i + 5)
      return turned ? image('image/jpeg', height, width) : image('image/jpeg', width, height)
    }
    i += 2 + length
  }
  return image('image/jpeg', 0, 0)
}

export function sniff(b: Uint8Array): Sniffed {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG' && ascii(b, 12, 16) === 'IHDR') {
    return image('image/png', u32be(b, 16), u32be(b, 20))
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpegSize(b)
  if (b.length >= 10 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return image('image/gif', u16le(b, 6), u16le(b, 8))
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') {
    const fourcc = ascii(b, 12, 16)
    if (fourcc === 'VP8 ') return image('image/webp', u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff)
    if (fourcc === 'VP8L') {
      const bits = u32le(b, 21)
      return image('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
    }
    if (fourcc === 'VP8X') return image('image/webp', u24le(b, 24) + 1, u24le(b, 27) + 1)
    return image('image/webp', 0, 0)
  }
  if (isSvg(b)) return { contentType: SVG, image: true, width: null, height: null }
  return OCTET
}

/**
 * 存进 OSS 时对象上的响应头:内容寻址、永不改变 ⇒ 一年 immutable。不是图片的,不管库里记它是什么类型,对象上一律
 * octet-stream + 当附件下载:CDN 的域名上不让 HTML / PDF 当页面跑。SVG 带真实类型(<img> 才画得出来),也当附件下载:
 * 在 <img> 里它本来就不跑脚本,直接打开链接是下载、不在 CDN 的域名上当页面跑。❌ 靠 Content-Security-Policy:OSS 不存
 * 这种自定义响应头(实测 PUT 200、HEAD 和 CDN 都不回它)。
 */
export function objectHeaders(s: Sniffed, immutable: string): Record<string, string> {
  if (!s.image) return { 'Content-Type': 'application/octet-stream', 'Cache-Control': immutable, 'Content-Disposition': 'attachment' }
  return s.contentType === SVG
    ? { 'Content-Type': SVG, 'Cache-Control': immutable, 'Content-Disposition': 'attachment' }
    : { 'Content-Type': s.contentType, 'Cache-Control': immutable }
}
