// Test functions for decoder.js, extracted from the production module.
// Registered via src/test-suite.js (?test).
import { createDecoder, shouldRunTailSolver } from './decoder.js'

// Test full codec roundtrip with Raptor-Lite pre-coding
export async function testCodecRoundtrip() {
  // Import encoder dynamically to avoid circular dependency
  const { createEncoder } = await import('./encoder.js')

  // Create test file with known content
  const originalData = new Uint8Array(450) // Just over 2 blocks
  for (let i = 0; i < originalData.length; i++) {
    originalData[i] = (i * 7 + 13) % 256
  }

  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', originalData))
  const encoder = createEncoder(originalData.buffer, 'roundtrip.bin', 'application/octet-stream', hash)
  const decoder = createDecoder()

  console.log('Codec test: K=' + encoder.K + ', K_prime=' + encoder.K_prime + ', generating symbols...')

  // Generate ~1.2x K_prime symbols (should be enough with parity recovery)
  const symbolCount = Math.ceil(encoder.K_prime * 1.2)
  const symbolIds = [0] // Start with metadata
  for (let i = 1; i <= symbolCount; i++) {
    symbolIds.push(i)
  }

  // Feed symbols to decoder
  for (const id of symbolIds) {
    const packet = encoder.generateSymbol(id)
    decoder.receive(packet)

    if (decoder.isComplete()) {
      console.log('Decoded after ' + decoder.uniqueSymbols + ' symbols (K=' + encoder.K + ', K_prime=' + encoder.K_prime + ')')
      break
    }
  }

  if (!decoder.isComplete()) {
    console.log('Codec roundtrip test: FAIL - incomplete after', decoder.uniqueSymbols, 'symbols')
    console.log('  Solved:', decoder.solved, '/', encoder.K, 'source blocks')
    return false
  }

  const verified = await decoder.verify()
  const reconstructed = decoder.reconstruct()

  // Compare data
  let dataMatch = reconstructed.length === originalData.length
  if (dataMatch) {
    for (let i = 0; i < originalData.length; i++) {
      if (reconstructed[i] !== originalData[i]) {
        dataMatch = false
        break
      }
    }
  }

  const pass = verified && dataMatch
  console.log('Codec roundtrip test:', pass ? 'PASS' : 'FAIL', {
    verified: verified,
    dataMatch: dataMatch,
    K: encoder.K,
    K_prime: encoder.K_prime,
    symbolsNeeded: decoder.uniqueSymbols
  })

  return pass
}

// Gzip-compressed codec roundtrip: the encoder carries compressed bytes with
// the original size and hash in metadata; reconstructFile() must gunzip and
// verify() must hash the ORIGINAL bytes (end-to-end, not the wire stream).
export async function testCodecRoundtripCompressed() {
  const { createEncoder } = await import('./encoder.js')
  const { maybeCompress } = await import('./shared/compression.js')

  // Highly compressible so maybeCompress actually engages.
  const originalData = new Uint8Array(3000)
  for (let i = 0; i < originalData.length; i++) {
    originalData[i] = i % 8
  }

  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', originalData))
  const { bytes: wireBytes, compressed } = await maybeCompress(originalData, 'text/plain')
  if (!compressed) {
    console.log('Compressed codec roundtrip test: FAIL - setup, payload did not compress')
    return false
  }

  const encoder = createEncoder(wireBytes.buffer, 'compressed.txt', 'text/plain', hash, 200, undefined, {
    compressed: true,
    originalSize: originalData.length
  })
  const decoder = createDecoder()

  const symbolCount = Math.ceil(encoder.K_prime * 1.5) + 2
  decoder.receive(encoder.generateSymbol(0))
  for (let id = 1; id <= symbolCount && !decoder.isComplete(); id++) {
    decoder.receive(encoder.generateSymbol(id))
  }

  if (!decoder.isComplete()) {
    console.log('Compressed codec roundtrip test: FAIL - incomplete after', decoder.uniqueSymbols, 'symbols')
    return false
  }

  // The raw reconstruction is the wire stream (compressed bytes)…
  const wire = decoder.reconstruct()
  const wireOk = wire !== null && wire.length === wireBytes.length

  // …and reconstructFile() is the original.
  const restored = await decoder.reconstructFile()
  let dataMatch = restored !== null && restored.length === originalData.length
  if (dataMatch) {
    for (let i = 0; i < originalData.length; i++) {
      if (restored[i] !== originalData[i]) { dataMatch = false; break }
    }
  }

  const verified = await decoder.verify()

  const pass = wireOk && dataMatch && verified
  console.log('Compressed codec roundtrip test:', pass ? 'PASS' : 'FAIL', {
    wireOk,
    dataMatch,
    verified,
    originalLen: originalData.length,
    wireLen: wireBytes.length
  })
  return pass
}

// Codec roundtrip with deliberate symbol loss — exercises the GF(2) tail solver.
// We drop a handful of systematic symbols (so the decoder stalls with a small
// residual set of unknown source blocks) and rely on fountain symbols plus
// parity equations for the tail solver to finish.
export async function testCodecRoundtripWithLoss() {
  const { createEncoder } = await import('./encoder.js')

  // K ≈ 100: 100 blocks × 200 bytes = 20000 bytes.
  const fileSize = 20000
  const originalData = new Uint8Array(fileSize)
  for (let i = 0; i < fileSize; i++) {
    originalData[i] = (i * 11 + 29) & 0xff
  }

  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', originalData))
  const encoder = createEncoder(originalData.buffer, 'lossy.bin', 'application/octet-stream', hash)
  const decoder = createDecoder()

  // Deterministically pick systematic source symbol IDs to drop (1-indexed;
  // symbolId i corresponds to source block i-1). The chosen set forms a
  // "stopping set" for Raptor-Lite parity recovery: a 2x2 grid across both the
  // consecutive-group axis and the strided axis. Every parity row that
  // references these blocks sees >=2 unknowns, so parityRecovery() cannot
  // make progress and the decoder must fall back to the GF(2) tail solver.
  //
  // For K=100, G=10: source blocks {0, 1, 10, 11} lie at rows 0-1 x cols 0-1.
  //   consecutive row 0 (blocks 0..9): {0, 1} -> 2 unknowns
  //   consecutive row 1 (blocks 10..19): {10, 11} -> 2 unknowns
  //   strided row 0 (blocks 0,10,20,...): {0, 10} -> 2 unknowns
  //   strided row 1 (blocks 1,11,21,...): {1, 11} -> 2 unknowns
  //   (offset rows start at index 5, none of these blocks intersect)
  const dropSet = new Set([1, 2, 11, 12])
  console.log('Codec-with-loss test: K=' + encoder.K + ', K_prime=' + encoder.K_prime +
    ', dropping systematic symbol IDs: ' + [...dropSet].join(','))

  // Send metadata first, then enough data symbols (systematic + fountain) to
  // give the GF(2) solver the independent equations it needs. The stopping set
  // has rank 3 in the parity rows alone; we need fountain symbols that touch
  // the missing set to raise it to rank 4. A 3x K_prime budget gives enough
  // fountain headroom (~270 fountain symbols → ~25 expected to touch the
  // missing set).
  const maxSymbolId = encoder.K_prime * 3
  decoder.receive(encoder.generateSymbol(0))
  decoder.noteFrameBoundary()
  for (let id = 1; id <= maxSymbolId; id++) {
    if (dropSet.has(id)) continue
    const packet = encoder.generateSymbol(id)
    decoder.receive(packet)
    // One packet per simulated frame — matches QR-mode assumption.
    decoder.noteFrameBoundary()
    if (decoder.isComplete()) break
  }

  if (!decoder.isComplete()) {
    console.log('Codec-with-loss test: FAIL - incomplete after', decoder.uniqueSymbols, 'symbols')
    console.log('  Solved:', decoder.solved, '/', encoder.K, 'source blocks')
    console.log('  Telemetry:', decoder.telemetry)
    return false
  }

  const verified = await decoder.verify()
  const reconstructed = decoder.reconstruct()

  let dataMatch = reconstructed.length === originalData.length
  if (dataMatch) {
    for (let i = 0; i < originalData.length; i++) {
      if (reconstructed[i] !== originalData[i]) { dataMatch = false; break }
    }
  }

  const tailFired = decoder.telemetry.tailSolveTriggerCount > 0
  const pass = verified && dataMatch && tailFired
  console.log('Codec-with-loss test:', pass ? 'PASS' : 'FAIL', {
    verified,
    dataMatch,
    tailSolveTriggerCount: decoder.telemetry.tailSolveTriggerCount,
    K: encoder.K,
    K_prime: encoder.K_prime,
    symbolsReceived: decoder.uniqueSymbols
  })

  return pass
}

export function testTailSolverTriggerAllowsWiderDenseBinaryTail() {
  const helperExists = typeof shouldRunTailSolver === 'function'
  const widerTail = helperExists ? shouldRunTailSolver({
    missing: 146,
    signature: 12,
    lastTailSolveSignature: 11,
    paritySweepComplete: true,
    stallFramesSinceLastSolve: 0
  }) : false
  const duplicateSignature = helperExists ? shouldRunTailSolver({
    missing: 146,
    signature: 12,
    lastTailSolveSignature: 12,
    paritySweepComplete: true,
    stallFramesSinceLastSolve: 0
  }) : true
  const overLimit = helperExists ? shouldRunTailSolver({
    missing: 193,
    signature: 13,
    lastTailSolveSignature: 12,
    paritySweepComplete: true,
    stallFramesSinceLastSolve: 0
  }) : true

  const pass = helperExists &&
    widerTail === true &&
    duplicateSignature === false &&
    overLimit === false
  console.log('Tail solver wider DenseBinary tail trigger test:', pass ? 'PASS' : 'FAIL', {
    helperExists,
    widerTail,
    duplicateSignature,
    overLimit
  })
  return pass
}

// Metadata can arrive mid-stream (every 10th frame in QR mode; longer gaps on
// HDMI). This test sends a mix of systematic, parity, and fountain symbols
// *before* metadata, holds metadata until the end of the initial burst, and
// then checks that the decoder still completes. Exercises the
// initParityAdjacency / replay-propagate path in the metadata branch.
export async function testCodecRoundtripDeferredMetadata() {
  const { createEncoder } = await import('./encoder.js')

  const fileSize = 20000
  const originalData = new Uint8Array(fileSize)
  for (let i = 0; i < fileSize; i++) {
    originalData[i] = (i * 23 + 41) & 0xff
  }
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', originalData))
  const encoder = createEncoder(originalData.buffer, 'deferred.bin', 'application/octet-stream', hash)
  const decoder = createDecoder()

  // Burst 1: every systematic symbol (1..K_prime) plus a fountain tail,
  // delivered before metadata. This includes parity symbols
  // (K < symbolId <= K_prime) which exercise markParitySolved via propagate.
  const preMetadataCount = encoder.K_prime + 30
  for (let id = 1; id <= preMetadataCount; id++) {
    decoder.receive(encoder.generateSymbol(id))
  }

  if (decoder.K !== null) {
    console.log('Deferred-metadata test FAIL - K leaked before metadata')
    return false
  }

  // Burst 2: metadata arrives now. initParityAdjacency should seed from the
  // blocks already filled in by propagate(), then replay propagate + parity
  // recovery in the metadata branch so no symbol is wasted.
  decoder.receive(encoder.generateSymbol(0))

  // Burst 3 (tail): a few more fountain symbols in case burst 1 wasn't enough.
  for (let id = preMetadataCount + 1; id <= preMetadataCount + 200 && !decoder.isComplete(); id++) {
    decoder.receive(encoder.generateSymbol(id))
  }

  if (!decoder.isComplete()) {
    console.log('Deferred-metadata test FAIL - incomplete after', decoder.uniqueSymbols, 'symbols')
    console.log('  Solved:', decoder.solved, '/', encoder.K, 'source blocks')
    console.log('  Telemetry:', decoder.telemetry)
    return false
  }

  const verified = await decoder.verify()
  const reconstructed = decoder.reconstruct()
  let dataMatch = reconstructed.length === originalData.length
  if (dataMatch) {
    for (let i = 0; i < originalData.length; i++) {
      if (reconstructed[i] !== originalData[i]) { dataMatch = false; break }
    }
  }

  const pass = verified && dataMatch
  console.log('Deferred-metadata test:', pass ? 'PASS' : 'FAIL', {
    verified,
    dataMatch,
    K: encoder.K,
    K_prime: encoder.K_prime,
    symbolsReceived: decoder.uniqueSymbols,
    parityNoProgressSweeps: decoder.telemetry.parityNoProgressSweeps,
  })

  return pass
}

// Full no-redundancy roundtrip: encoder with no parity, decoder fed systematic
// 1..K only. Must complete, verify, reconstruct exactly, with K'=K and the tail
// solver never firing.
export async function testCodecRoundtripNoRedundancy() {
  const { createEncoder } = await import('./encoder.js')
  const fileSize = 20000
  const originalData = new Uint8Array(fileSize)
  for (let i = 0; i < fileSize; i++) originalData[i] = (i * 7 + 13) & 0xff
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', originalData))
  const encoder = createEncoder(originalData.buffer, 'yolo.bin', 'application/octet-stream', hash, 200, 0, { noRedundancy: true })
  const decoder = createDecoder()

  decoder.receive(encoder.generateSymbol(0)) // metadata first
  decoder.noteFrameBoundary()
  for (let id = 1; id <= encoder.K && !decoder.isComplete(); id++) {
    decoder.receive(encoder.generateSymbol(id))
    decoder.noteFrameBoundary()
  }

  const complete = decoder.isComplete()
  const verified = complete && await decoder.verify()
  const recon = decoder.reconstruct()
  let match = !!recon && recon.length === originalData.length
  if (match) for (let i = 0; i < fileSize; i++) if (recon[i] !== originalData[i]) { match = false; break }
  const kEq = decoder.K_prime === decoder.K
  const noTail = decoder.telemetry.tailSolveTriggerCount === 0

  const pass = complete && verified && match && kEq && noTail
  console.log('Codec no-redundancy roundtrip test:', pass ? 'PASS' : 'FAIL',
    { K: encoder.K, K_prime: decoder.K_prime, kEq, noTail })
  return pass
}

// Loop recovery: drop one systematic symbol on pass 1; it arrives on the next
// loop. Models the sender's "loop raw blocks" behavior under a single drop.
export async function testNoRedundancyLoopRecovers() {
  const { createEncoder } = await import('./encoder.js')
  const fileSize = 20000
  const originalData = new Uint8Array(fileSize)
  for (let i = 0; i < fileSize; i++) originalData[i] = (i * 11 + 5) & 0xff
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', originalData))
  const encoder = createEncoder(originalData.buffer, 'loop.bin', 'application/octet-stream', hash, 200, 0, { noRedundancy: true })
  const decoder = createDecoder()

  decoder.receive(encoder.generateSymbol(0))
  const dropId = 3
  for (let id = 1; id <= encoder.K; id++) {
    if (id === dropId) continue
    decoder.receive(encoder.generateSymbol(id))
    decoder.noteFrameBoundary()
  }
  const incompleteAfterPass1 = !decoder.isComplete() && decoder.solved === encoder.K - 1

  // Pass 2 loop delivers the dropped block.
  decoder.receive(encoder.generateSymbol(dropId))
  const complete = decoder.isComplete()
  const verified = complete && await decoder.verify()

  const pass = incompleteAfterPass1 && complete && verified
  console.log('No-redundancy loop recovery test:', pass ? 'PASS' : 'FAIL', { incompleteAfterPass1, complete })
  return pass
}
