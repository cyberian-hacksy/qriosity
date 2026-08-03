// Metadata frame encoding/decoding
// Metadata frame payload:
// - Filename length (1 byte) + filename (UTF-8)
// - MIME type length (1 byte) + MIME type
// - Original file size (4 bytes)
// - SHA-256 hash (32 bytes)
// - Source block count K (4 bytes) - for Raptor-Lite parity derivation
// - Mode (1 byte) - QR mode (0=BW, 1=PCCC, 2=Palette)

import { QR_MODE } from './constants.js'

export function createMetadataPayload(filename, mimeType, fileSize, hash, K, mode = QR_MODE.BW, options = {}) {
  const { noRedundancy = false, repairIdle = false, compressed = false, transmittedSize = 0 } = options
  const encoder = new TextEncoder()
  const filenameBytes = encoder.encode(filename.slice(0, 255))
  const mimeBytes = encoder.encode(mimeType.slice(0, 255))

  const payload = new Uint8Array(1 + filenameBytes.length + 1 + mimeBytes.length + 4 + 32 + 4 + 1 + (compressed ? 4 : 0))
  let offset = 0

  payload[offset++] = filenameBytes.length
  payload.set(filenameBytes, offset)
  offset += filenameBytes.length

  payload[offset++] = mimeBytes.length
  payload.set(mimeBytes, offset)
  offset += mimeBytes.length

  new DataView(payload.buffer).setUint32(offset, fileSize, false)
  offset += 4

  payload.set(hash, offset)
  offset += 32

  new DataView(payload.buffer).setUint32(offset, K, false)
  offset += 4

  payload[offset++] = (mode & 0x03) | (noRedundancy ? 0x04 : 0) | (repairIdle ? 0x08 : 0) | (compressed ? 0x10 : 0)

  // The wire (compressed) byte count follows the flags byte only when bit 4
  // is set — old receivers ignore the tail, old frames never set the bit.
  if (compressed) {
    new DataView(payload.buffer).setUint32(offset, transmittedSize, false)
  }

  return payload
}

export function parseMetadataPayload(payload) {
  const decoder = new TextDecoder()
  let offset = 0

  const filenameLen = payload[offset++]
  const filename = decoder.decode(payload.slice(offset, offset + filenameLen))
  offset += filenameLen

  const mimeLen = payload[offset++]
  const mimeType = decoder.decode(payload.slice(offset, offset + mimeLen))
  offset += mimeLen

  const fileSize = new DataView(payload.buffer, payload.byteOffset + offset, 4).getUint32(0, false)
  offset += 4

  const hash = payload.slice(offset, offset + 32)
  offset += 32

  const K = new DataView(payload.buffer, payload.byteOffset + offset, 4).getUint32(0, false)
  offset += 4

  // Mode byte is optional for backwards compatibility with old metadata frames.
  // Bits 0-1 = QR mode; bit 2 = no-redundancy (YOLO) flag; bit 3 = ARQ
  // repair-idle beacon; bit 4 = gzip-compressed payload (adds a trailing
  // 4-byte transmitted size).
  const modeByte = getMetadataModeByte(payload)
  const mode = modeByte & 0x03
  const noRedundancy = (modeByte & 0x04) !== 0
  const repairIdle = (modeByte & 0x08) !== 0

  // `offset` currently sits just past K, i.e. at the mode byte. The payload
  // the decoder hands us is zero-padded to blockSize, so field presence is
  // decided by the walk from the front (offset), never by payload length.
  let compressed = false
  let transmittedSize = fileSize
  if ((modeByte & 0x10) !== 0 && offset + 1 + 4 <= payload.length) {
    compressed = true
    transmittedSize = new DataView(payload.buffer, payload.byteOffset + offset + 1, 4).getUint32(0, false)
  }

  return { filename, mimeType, fileSize, hash, K, mode, noRedundancy, repairIdle, compressed, transmittedSize }
}

// Offset of the mode byte per the layout above: [1+filenameLen][1+mimeLen]
// [4 size][32 hash][4 K] → mode. Single home for the byte-layout walk so the
// cheap flag peek can't drift from parseMetadataPayload.
function metadataModeByteOffset(payload) {
  if (!payload || payload.length < 1) return -1
  const mimeLenOffset = 1 + payload[0]
  if (mimeLenOffset >= payload.length) return -1
  const offset = mimeLenOffset + 1 + payload[mimeLenOffset] + 4 + 32 + 4
  return offset < payload.length ? offset : -1
}

export function getMetadataModeByte(payload) {
  const offset = metadataModeByteOffset(payload)
  return offset >= 0 ? payload[offset] : 0
}

export function isRepairIdleMetadataPayload(payload) {
  return (getMetadataModeByte(payload) & 0x08) !== 0
}

// Test metadata roundtrip
export function testMetadataRoundtrip() {
  const hash = new Uint8Array(32)
  hash.fill(0xAB)

  // Test BW mode (default)
  const payload1 = createMetadataPayload('test.pdf', 'application/pdf', 12345, hash, 500)
  const parsed1 = parseMetadataPayload(payload1)
  const pass1 = parsed1.filename === 'test.pdf' &&
    parsed1.mimeType === 'application/pdf' &&
    parsed1.fileSize === 12345 &&
    parsed1.hash.length === 32 &&
    parsed1.K === 500 &&
    parsed1.mode === QR_MODE.BW

  // Test PCCC mode
  const payload2 = createMetadataPayload('image.png', 'image/png', 54321, hash, 250, QR_MODE.PCCC)
  const parsed2 = parseMetadataPayload(payload2)
  const pass2 = parsed2.mode === QR_MODE.PCCC &&
    parsed2.filename === 'image.png'

  // Test Palette mode
  const payload3 = createMetadataPayload('doc.txt', 'text/plain', 1000, hash, 100, QR_MODE.PALETTE)
  const parsed3 = parseMetadataPayload(payload3)
  const pass3 = parsed3.mode === QR_MODE.PALETTE

  const pass = pass1 && pass2 && pass3
  console.log('Metadata roundtrip test:', pass ? 'PASS' : 'FAIL')
  console.log('  BW mode:', pass1 ? 'PASS' : 'FAIL')
  console.log('  PCCC mode:', pass2 ? 'PASS' : 'FAIL')
  console.log('  Palette mode:', pass3 ? 'PASS' : 'FAIL')
  return pass
}

// Test the no-redundancy flag in the mode byte (bit 2), alongside the mode bits.
export function testMetadataNoRedundancyFlag() {
  const hash = new Uint8Array(32)
  hash.fill(0xCD)

  // YOLO on; mode bits (PCCC) must be preserved alongside the flag.
  const p1 = createMetadataPayload('a.bin', 'application/octet-stream', 100, hash, 50, QR_MODE.PCCC, { noRedundancy: true })
  const d1 = parseMetadataPayload(p1)
  const ok1 = d1.noRedundancy === true && d1.mode === QR_MODE.PCCC && d1.K === 50

  // YOLO off (default options): flag false, mode default BW.
  const p2 = createMetadataPayload('a.bin', 'application/octet-stream', 100, hash, 50)
  const d2 = parseMetadataPayload(p2)
  const ok2 = d2.noRedundancy === false && d2.mode === QR_MODE.BW

  // Palette mode + flag together.
  const p3 = createMetadataPayload('a.bin', 'text/plain', 9, hash, 7, QR_MODE.PALETTE, { noRedundancy: true })
  const d3 = parseMetadataPayload(p3)
  const ok3 = d3.noRedundancy === true && d3.mode === QR_MODE.PALETTE

  const pass = ok1 && ok2 && ok3
  console.log('Metadata no-redundancy flag test:', pass ? 'PASS' : 'FAIL', { d1, d2, d3 })
  return pass
}

// Compressed payloads: bit 4 of the mode byte plus a trailing 4-byte
// transmitted (wire) size. Old frames without the tail must parse as
// uncompressed with transmittedSize === fileSize.
export function testMetadataCompressionFlag() {
  const hash = new Uint8Array(32)
  hash.fill(0x42)

  // Compressed: flag set, transmittedSize round-trips, other fields intact.
  const p1 = createMetadataPayload('big.txt', 'text/plain', 100000, hash, 500, QR_MODE.PCCC, {
    noRedundancy: true,
    compressed: true,
    transmittedSize: 4242
  })
  const d1 = parseMetadataPayload(p1)
  const ok1 = d1.compressed === true &&
    d1.transmittedSize === 4242 &&
    d1.fileSize === 100000 &&
    d1.mode === QR_MODE.PCCC &&
    d1.noRedundancy === true &&
    d1.filename === 'big.txt'

  // Uncompressed (no options): flag clear, transmittedSize falls back to fileSize.
  const p2 = createMetadataPayload('a.bin', 'application/octet-stream', 777, hash, 4)
  const d2 = parseMetadataPayload(p2)
  const ok2 = d2.compressed === false && d2.transmittedSize === 777

  // Zero-padded to a block (as the encoder transmits it): same results — the
  // parse walks length prefixes from the front, never the payload end.
  const padded = new Uint8Array(p1.length + 64)
  padded.set(p1)
  const d3 = parseMetadataPayload(padded)
  const ok3 = d3.compressed === true && d3.transmittedSize === 4242

  // Other flags unaffected by the new bit.
  const p4 = createMetadataPayload('b.bin', 'text/plain', 999, hash, 9, QR_MODE.BW, { repairIdle: true })
  const d4 = parseMetadataPayload(p4)
  const ok4 = d4.repairIdle === true && d4.compressed === false && isRepairIdleMetadataPayload(p4)

  const pass = ok1 && ok2 && ok3 && ok4
  console.log('Metadata compression flag test:', pass ? 'PASS' : 'FAIL', { ok1, ok2, ok3, ok4 })
  return pass
}

export function testMetadataRepairIdleFlag() {
  const hash = new Uint8Array(32)
  hash.fill(0xEF)

  const payload = createMetadataPayload('idle.bin', 'application/octet-stream', 321, hash, 9, QR_MODE.BW, { repairIdle: true })
  const parsed = parseMetadataPayload(payload)
  const normal = parseMetadataPayload(createMetadataPayload('idle.bin', 'application/octet-stream', 321, hash, 9))
  const pass = parsed.repairIdle === true &&
    isRepairIdleMetadataPayload(payload) === true &&
    isRepairIdleMetadataPayload(createMetadataPayload('idle.bin', 'application/octet-stream', 321, hash, 9)) === false &&
    parsed.noRedundancy === false &&
    normal.repairIdle === false
  console.log('Metadata repair-idle flag test:', pass ? 'PASS' : 'FAIL', { parsed, normal })
  return pass
}
