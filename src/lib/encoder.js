// LT Fountain Encoder with Raptor-Lite Pre-coding
// Encodes file data into a stream of fountain-coded symbols

import { QR_MODE } from './constants.js'
import { deriveSymbolIndices } from './fountain-symbol.js'
import { createPacket } from './packet.js'
import { createMetadataPayload } from './metadata.js'
import { calculateParityParams, generateParityMap, generateParityBlocks } from './precode.js'

export function createEncoder(fileData, filename, mimeType, hash, blockSize = 200, mode = QR_MODE.BW, options = {}) {
  // When `compressed`, fileData is the gzipped wire payload and `originalSize`
  // is the pre-compression byte count; metadata carries both so the receiver
  // can trim the wire stream (transmittedSize) and bound/verify the inflated
  // file (fileSize + hash, which stay end-to-end on the ORIGINAL bytes).
  const { noRedundancy = false, compressed = false, originalSize: originalSizeOption } = options
  // Pad file to multiple of blockSize
  const paddedSize = Math.ceil(fileData.byteLength / blockSize) * blockSize
  const paddedData = new Uint8Array(paddedSize)
  paddedData.set(new Uint8Array(fileData))

  const K = paddedSize / blockSize // Source block count
  const fileId = (Math.random() * 0xFFFFFFFF) >>> 0
  const originalSize = originalSizeOption ?? fileData.byteLength
  const transmittedSize = fileData.byteLength

  // Split into source blocks
  const sourceBlocks = []
  for (let i = 0; i < K; i++) {
    sourceBlocks.push(paddedData.slice(i * blockSize, (i + 1) * blockSize))
  }

  // Generate Raptor-Lite parity blocks (skipped entirely in no-redundancy mode)
  let parityMap = []
  let parityBlocks = []
  if (!noRedundancy) {
    const { G } = calculateParityParams(K)
    parityMap = generateParityMap(K, G)
    parityBlocks = generateParityBlocks(sourceBlocks, parityMap)
  }

  // Combine source and parity blocks into intermediate blocks
  // Use actual parity count (may differ from estimate due to edge cases)
  const M = parityBlocks.length
  const K_prime = K + M
  const intermediateBlocks = noRedundancy ? sourceBlocks : [...sourceBlocks, ...parityBlocks]

  function createMetadataPacketPayload(options = {}) {
    // Include K so receiver can derive parity parameters, and mode for redundancy.
    const rawMetadata = createMetadataPayload(filename, mimeType, originalSize, hash, K, mode, {
      noRedundancy,
      repairIdle: !!options.repairIdle,
      compressed,
      transmittedSize
    })
    const metadataPayload = new Uint8Array(blockSize)
    metadataPayload.set(rawMetadata)
    return metadataPayload
  }

  // Fail at create time (catchable by file-selection error handling) instead
  // of throwing RangeError on the first metadata frame of the render loop.
  {
    const metadataLength = createMetadataPayload(filename, mimeType, originalSize, hash, K, mode, { noRedundancy, compressed, transmittedSize }).length
    if (metadataLength > blockSize) {
      throw new Error(
        `File metadata (${metadataLength} bytes) exceeds block size (${blockSize} bytes) - ` +
        'shorten the filename or choose a larger data preset'
      )
    }
  }

  return {
    fileId,
    k: K,           // Source block count (for compatibility)
    K,              // Source block count
    K_prime,        // Total intermediate block count (K + parity)
    M,              // Parity block count
    originalSize,
    mode,           // QR mode (BW, PCCC, or Palette)
    noRedundancy,   // True when parity/fountain redundancy is disabled (YOLO)

    // Generate symbol by ID
    generateSymbol(symbolId, options = {}) {
      if (symbolId === 0) {
        // Metadata frame (padded to BLOCK_SIZE)
        return createPacket(fileId, K_prime, 0, createMetadataPacketPayload(options), true, blockSize, mode)
      }

      // Symbol id → intermediate-block indices. Shared with the decoder
      // (fountain-symbol.js) so the two derivations can never drift.
      const indices = deriveSymbolIndices(fileId, symbolId, K_prime)

      // XOR selected intermediate blocks
      const payload = new Uint8Array(blockSize)
      for (const idx of indices) {
        for (let i = 0; i < blockSize; i++) {
          payload[i] ^= intermediateBlocks[idx][i]
        }
      }

      return createPacket(fileId, K_prime, symbolId, payload, false, blockSize, mode)
    }
  }
}

// Test encoder
export async function testEncoder() {
  // Create test file
  const testData = new Uint8Array(500)
  for (let i = 0; i < 500; i++) testData[i] = i % 256

  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', testData))
  const encoder = createEncoder(testData.buffer, 'test.bin', 'application/octet-stream', hash)

  // Import parsePacket dynamically to avoid circular dependency in test
  const { parsePacket } = await import('./packet.js')
  const { BLOCK_SIZE } = await import('./constants.js')

  const metaPacket = encoder.generateSymbol(0)
  const dataPacket = encoder.generateSymbol(1)

  const meta = parsePacket(metaPacket)
  const data = parsePacket(dataPacket)

  // K=3 (500 bytes / 200), K_prime = 3 + 3*ceil(sqrt(3)) = 3 + 6 = 9
  const pass = meta.isMetadata === true &&
    meta.payload.length === BLOCK_SIZE &&
    data.isMetadata === false &&
    data.payload.length === BLOCK_SIZE &&
    encoder.K === 3 &&
    encoder.K_prime > encoder.K // Has parity blocks

  console.log('Encoder test:', pass ? 'PASS' : 'FAIL', {
    K: encoder.K,
    K_prime: encoder.K_prime,
    M: encoder.M,
    fileId: encoder.fileId
  })
  return pass
}

// No-redundancy encoder: no parity blocks, K' === K, every systematic symbol
// degree-1, metadata carries the flag.
export async function testEncoderNoRedundancy() {
  const testData = new Uint8Array(1000)
  for (let i = 0; i < 1000; i++) testData[i] = (i * 3) & 0xff
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', testData))
  const enc = createEncoder(testData.buffer, 't.bin', 'application/octet-stream', hash, 200, QR_MODE.BW, { noRedundancy: true })

  const { parsePacket } = await import('./packet.js')
  const { deriveSymbolIndices } = await import('./fountain-symbol.js')
  const { parseMetadataPayload } = await import('./metadata.js')

  // 1000 / 200 = 5 source blocks, no parity.
  const okK = enc.K === 5 && enc.K_prime === 5 && enc.M === 0

  let degreeOk = true
  for (let id = 1; id <= enc.K; id++) {
    if (deriveSymbolIndices(enc.fileId, id, enc.K_prime).length !== 1) degreeOk = false
  }

  const meta = parsePacket(enc.generateSymbol(0))
  const md = parseMetadataPayload(meta.payload)
  const flagOk = md.noRedundancy === true

  const pass = okK && degreeOk && flagOk
  console.log('Encoder no-redundancy test:', pass ? 'PASS' : 'FAIL', { K: enc.K, K_prime: enc.K_prime, M: enc.M, degreeOk, flagOk })
  return pass
}
