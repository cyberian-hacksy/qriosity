// Adaptive gzip for transfer payloads. Compress once at file selection when
// it actually shrinks the payload; skip formats that are already
// entropy-coded rather than paying a full-size allocation and a pass over
// every byte to discover gzip can't win. Deliberately a conservative list,
// not a heuristic: a wrong "skip" costs a few percent of transfer size, a
// wrong "try" costs a whole buffer.

const PRECOMPRESSED_TYPES = new Set([
  'application/gzip',
  'application/java-archive',
  'application/vnd.rar',
  'application/x-7z-compressed',
  'application/x-brotli',
  'application/x-bzip',
  'application/x-bzip2',
  'application/x-gzip',
  'application/x-lzma',
  'application/x-rar-compressed',
  'application/x-xz',
  'application/x-zip-compressed',
  'application/zip',
  'application/zstd'
])

// Image and audio subtypes that are NOT already compressed — the exceptions
// to the otherwise-safe "all image/*, all audio/*" rule.
const COMPRESSIBLE_IMAGES = /^image\/(bmp|x-ms-bmp|svg\+xml|tiff|x-icon|vnd\.microsoft\.icon)$/
const COMPRESSIBLE_AUDIO = /^audio\/(wav|x-wav|wave|vnd\.wave|aiff|x-aiff|basic|l16)$/

export function isPrecompressedType(type) {
  const media = (type || '').split(';')[0].trim().toLowerCase()
  if (media.startsWith('video/')) return true
  if (media.startsWith('image/')) return !COMPRESSIBLE_IMAGES.test(media)
  if (media.startsWith('audio/')) return !COMPRESSIBLE_AUDIO.test(media)
  // The OOXML and OpenDocument families are zip containers.
  if (media.startsWith('application/vnd.openxmlformats-officedocument.')) return true
  if (media.startsWith('application/vnd.oasis.opendocument.')) return true
  if (media.endsWith('+zip')) return true
  return PRECOMPRESSED_TYPES.has(media)
}

async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// Returns { bytes, compressed }. Inputs too small to be worth a gzip header,
// formats gzip cannot help with, and payloads gzip fails to shrink by more
// than its own overhead all come back as the original buffer, unmarked.
export async function maybeCompress(bytes, mimeType) {
  if (bytes.length < 768 || isPrecompressedType(mimeType)) {
    return { bytes, compressed: false }
  }
  const gz = await gzip(bytes)
  if (gz.length + 64 >= bytes.length) return { bytes, compressed: false }
  return { bytes: gz, compressed: true }
}

// Inflate with a hard output ceiling. The declared size in the gzip trailer
// arrived over the air like everything else — count real output bytes and
// abort past maxBytes instead of trusting it.
export async function decompressWithLimit(bytes, maxBytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  const reader = stream.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error('Decompressed data exceeds its declared length')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}
