// Tests for the adaptive gzip helper. CompressionStream/DecompressionStream
// are browser- and Node-native, so these run in both harnesses.

import { isPrecompressedType, maybeCompress, decompressWithLimit } from './compression.js'

function repetitiveBytes(n) {
  const bytes = new Uint8Array(n)
  for (let i = 0; i < n; i++) bytes[i] = i % 16
  return bytes
}

function randomBytes(n) {
  const bytes = new Uint8Array(n)
  for (let i = 0; i < n; i++) bytes[i] = (Math.random() * 256) | 0
  return bytes
}

export async function testCompressionRoundtrip() {
  const original = repetitiveBytes(50_000)
  const { bytes, compressed } = await maybeCompress(original, 'text/plain')
  const shrank = compressed === true && bytes.length < original.length

  const restored = await decompressWithLimit(bytes, original.length)
  let identical = restored.length === original.length
  if (identical) {
    for (let i = 0; i < restored.length; i++) {
      if (restored[i] !== original[i]) { identical = false; break }
    }
  }

  const pass = shrank && identical
  console.log('Compression roundtrip test:', pass ? 'PASS' : 'FAIL',
    { compressed, originalLen: original.length, wireLen: bytes.length, identical })
  return pass
}

export async function testCompressionSkipsSmallAndPrecompressed() {
  // Under the 768-byte floor: returned untouched even though compressible.
  const tiny = await maybeCompress(repetitiveBytes(500), 'text/plain')
  const tinySkipped = tiny.compressed === false && tiny.bytes.length === 500

  // Precompressed media type: skipped without attempting.
  const jpeg = await maybeCompress(repetitiveBytes(50_000), 'image/jpeg')
  const jpegSkipped = jpeg.compressed === false && jpeg.bytes.length === 50_000

  const typeChecks =
    isPrecompressedType('image/jpeg') === true &&
    isPrecompressedType('video/mp4') === true &&
    isPrecompressedType('application/zip') === true &&
    isPrecompressedType('application/vnd.openxmlformats-officedocument.wordprocessingml.document') === true &&
    isPrecompressedType('image/bmp') === false &&
    isPrecompressedType('audio/wav') === false &&
    isPrecompressedType('text/plain') === false &&
    isPrecompressedType('application/pdf') === false &&
    isPrecompressedType('') === false

  const pass = tinySkipped && jpegSkipped && typeChecks
  console.log('Compression skip test:', pass ? 'PASS' : 'FAIL',
    { tinySkipped, jpegSkipped, typeChecks })
  return pass
}

export async function testCompressionIncompressibleFallback() {
  // Random bytes with a compressible MIME type: gzip can't win, so the
  // original buffer must come back unmarked.
  const original = randomBytes(20_000)
  const { bytes, compressed } = await maybeCompress(original, 'text/plain')
  const pass = compressed === false && bytes === original
  console.log('Compression incompressible-fallback test:', pass ? 'PASS' : 'FAIL',
    { compressed, sameBuffer: bytes === original })
  return pass
}

export async function testDecompressCeilingAborts() {
  // The declared size in a gzip trailer arrives over the air like everything
  // else — the ceiling must count real output bytes and abort past it.
  const original = repetitiveBytes(100_000)
  const { bytes, compressed } = await maybeCompress(original, 'text/plain')
  if (!compressed) {
    console.log('Decompress ceiling test: FAIL (setup — payload did not compress)')
    return false
  }
  let aborted = false
  try {
    await decompressWithLimit(bytes, 1000)
  } catch {
    aborted = true
  }
  const pass = aborted
  console.log('Decompress ceiling test:', pass ? 'PASS' : 'FAIL', { aborted })
  return pass
}
