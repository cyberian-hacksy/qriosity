// Golden wire-format vectors, pinned 2026-08-03 (the binary byte-mode QR +
// gzip metadata format, E2E-verified that day).
//
// These are regression pins, not behavior tests: sender and receiver derive
// everything below independently and never compare notes, so ANY change to
// these outputs is a breaking wire-format change — a dist/index.html someone
// saved today has to keep agreeing with a future receiver. If one of these
// fails, either revert the change or bump PROTOCOL_VERSION and document the
// break; never just update the pinned value to make the test pass.
//
// Deliberately decode-side for gzip: compressor OUTPUT differs across zlib
// versions, so we pin a known-good gzip blob and require it to inflate —
// that is the compatibility that matters (old sender → new receiver).

import { createPacket } from './packet.js'
import { createMetadataPayload, parseMetadataPayload } from './metadata.js'
import { deriveSymbolIndices } from './fountain-symbol.js'
import { getQRModules } from './qr-modules.js'
import { crc32 } from './hdmi-uvc/crc32.js'
import { decompressWithLimit } from './shared/compression.js'

const GOLDEN_PACKET_HEX =
  '0a010203040003e800002aa10e8695030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dc'

const GOLDEN_METADATA_HEX =
  '0a676f6c64656e2e62696e186170706c69636174696f6e2f6f637465742d73747265616d0001e240' +
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f0000004d1600001092'

const GOLDEN_INDICES = {
  'deadbeef/500/200': [128, 72, 131],
  '12345678/201/200': [77, 189, 138],
  '1/1/10': [0]
}

const GOLDEN_QR = { count: 29, crc: 'b7d55775' }

const GOLDEN_GZIP_B64 =
  'H4sIAAAAAAAAE0tKTczNTS0tUEjPz0lJzVNIr8osUChLTS7JL1IwMDQyNjE1M7ewBACRsnR5JgAAAA=='
const GOLDEN_GZIP_TEXT = 'beammeup golden gzip vector 0123456789'

const toHex = (u8) => Array.from(u8).map((b) => b.toString(16).padStart(2, '0')).join('')

export function testGoldenPacket() {
  const payload = new Uint8Array(32)
  for (let i = 0; i < 32; i++) payload[i] = (i * 7 + 3) & 0xff
  const packet = createPacket(0x01020304, 1000, 42, payload, false, 32, 1)
  const pass = toHex(packet) === GOLDEN_PACKET_HEX
  console.log('Golden packet vector:', pass ? 'PASS' : 'FAIL')
  if (!pass) console.log('  got ' + toHex(packet))
  return pass
}

export function testGoldenMetadata() {
  const hash = new Uint8Array(32)
  for (let i = 0; i < 32; i++) hash[i] = i
  const payload = createMetadataPayload('golden.bin', 'application/octet-stream', 123456, hash, 77, 2, {
    noRedundancy: true,
    compressed: true,
    transmittedSize: 4242
  })
  const bytesMatch = toHex(payload) === GOLDEN_METADATA_HEX

  // And the parse of the golden bytes keeps meaning the same thing.
  const parsed = parseMetadataPayload(payload)
  const parseMatch = parsed.filename === 'golden.bin' && parsed.fileSize === 123456 &&
    parsed.K === 77 && parsed.mode === 2 && parsed.noRedundancy === true &&
    parsed.compressed === true && parsed.transmittedSize === 4242

  const pass = bytesMatch && parseMatch
  console.log('Golden metadata vector:', pass ? 'PASS' : 'FAIL', { bytesMatch, parseMatch })
  if (!bytesMatch) console.log('  got ' + toHex(payload))
  return pass
}

export function testGoldenSymbolIndices() {
  const cases = [
    [0xDEADBEEF, 500, 200, GOLDEN_INDICES['deadbeef/500/200']],
    [0x12345678, 201, 200, GOLDEN_INDICES['12345678/201/200']],
    [1, 1, 10, GOLDEN_INDICES['1/1/10']]
  ]
  let pass = true
  for (const [fileId, symbolId, kPrime, expected] of cases) {
    const got = deriveSymbolIndices(fileId, symbolId, kPrime)
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      console.log('  indices(' + fileId.toString(16) + ',' + symbolId + ',' + kPrime + ') = ' +
        JSON.stringify(got) + ', expected ' + JSON.stringify(expected))
      pass = false
    }
  }
  console.log('Golden symbol-indices vector:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testGoldenQrMatrix() {
  const payload = new Uint8Array(32)
  for (let i = 0; i < 32; i++) payload[i] = (i * 7 + 3) & 0xff
  const packet = createPacket(0x01020304, 1000, 42, payload, false, 32, 1)
  const qr = getQRModules(packet, 'L')
  const bits = new Uint8Array(qr.count * qr.count)
  for (let r = 0; r < qr.count; r++) {
    for (let c = 0; c < qr.count; c++) bits[r * qr.count + c] = qr.isDark(r, c) ? 1 : 0
  }
  const crc = (crc32(bits) >>> 0).toString(16)
  const pass = qr.count === GOLDEN_QR.count && crc === GOLDEN_QR.crc
  console.log('Golden QR matrix vector:', pass ? 'PASS' : 'FAIL', { count: qr.count, crc })
  return pass
}

export async function testGoldenGzipDecode() {
  const gz = Uint8Array.from(atob(GOLDEN_GZIP_B64), (c) => c.charCodeAt(0))
  let text = null
  try {
    text = new TextDecoder().decode(await decompressWithLimit(gz, 1024))
  } catch {
    // fall through to FAIL
  }
  const pass = text === GOLDEN_GZIP_TEXT
  console.log('Golden gzip-decode vector:', pass ? 'PASS' : 'FAIL')
  return pass
}
