// LT Fountain Decoder with Belief Propagation and Raptor-Lite Parity Recovery
// Decodes fountain-coded symbols back into original file

import { deriveSymbolIndices } from './fountain-symbol.js'
import { xorBytesInto } from './xor.js'
import { parsePacket } from './packet.js'
import { parseMetadataPayload } from './metadata.js'
import { calculateParityParams, generateParityMap, buildSourceToParityAdjacency } from './precode.js'
import { solveGF2 } from './gf2-solver.js'
import { decompressWithLimit } from './shared/compression.js'

export const TAIL_SOLVER_MISSING_LIMIT = 192
const TAIL_SOLVER_STALL_FRAME_THRESHOLD = 30

export function shouldRunTailSolver({
  missing,
  signature,
  lastTailSolveSignature,
  paritySweepComplete,
  stallFramesSinceLastSolve
}) {
  return missing > 0 &&
    missing <= TAIL_SOLVER_MISSING_LIMIT &&
    signature !== lastTailSolveSignature &&
    (paritySweepComplete || stallFramesSinceLastSolve >= TAIL_SOLVER_STALL_FRAME_THRESHOLD)
}

export function createDecoder() {
  let fileId = null
  let K = null          // Source block count
  let K_prime = null    // Intermediate block count (K + parity)
  let G = null          // Group size for parity
  let parityMap = null  // Parity relationships
  let metadata = null
  let blockSize = 200   // Block size from packet header
  let decodedBlocks = null
  let solved = 0        // Total intermediate blocks decoded
  let solvedSource = 0  // Source blocks decoded (first K blocks)
  let receivedSymbols = new Set()
  let pendingSymbols = [] // { indices: [], payload: Uint8Array }
  let paritySweepComplete = false          // True once the full parity-symbol-id sweep (K+1..K_prime) has been received (latches)
  let uniqueParitySymbolsSeen = 0          // Count of distinct parity symbolIds received (K < symbolId <= K_prime)
  let parityNoProgressSweeps = 0           // Count of parityRecovery() calls that swept the full map without recovering anything
  // Incremental symbol-type counters. Maintained on each accepted symbolId to
  // avoid a receivedSymbols scan from the getter; rebuilt in the metadata
  // branch once K/K_prime are finalized.
  let metadataSymbolCount = 0
  let sourceSymbolCount = 0
  let paritySymbolCount = 0
  let fountainSymbolCount = 0
  let stallFramesSinceLastSolve = 0        // Frames signalled via noteFrameBoundary() since last source solve
  let tailSolveTriggerCount = 0            // How many times the GF(2) fallback has been invoked (Phase 1)
  let lastSolvedSourceCount = 0            // Tracking value for stall detection
  let lastTailSolveSignature = -1          // (pendingSymbols.length, solved) snapshot — skip redundant solves

  // Event-driven parity recovery state. adj[s] lists parity rows referencing
  // source block s; parityUnknownCount[p] tracks remaining unknowns in row p;
  // parityKnown[p] latches when the parity block at K+p has been decoded;
  // dirtyParities queues rows whose state changed since the last drain.
  let adj = null
  let parityUnknownCount = null
  let parityKnown = null
  const dirtyParities = new Set()

  // Rebuild adjacency bookkeeping from current decodedBlocks state. Called on
  // metadata ingest (K becomes known) and after bulk mutations like the GF(2)
  // tail solver that bypass markSourceSolved/markParitySolved.
  function initParityAdjacency() {
    if (!parityMap || K === null || !decodedBlocks) return
    adj = buildSourceToParityAdjacency(K, parityMap)
    parityUnknownCount = new Uint16Array(parityMap.length)
    parityKnown = new Uint8Array(parityMap.length)
    dirtyParities.clear()
    for (let p = 0; p < parityMap.length; p++) {
      let unk = 0
      const srcIndices = parityMap[p]
      for (const s of srcIndices) {
        if (!decodedBlocks[s]) unk++
      }
      parityUnknownCount[p] = unk
      if (decodedBlocks[K + p]) {
        parityKnown[p] = 1
        if (unk === 1) dirtyParities.add(p)
      }
    }
  }

  // Record that source block `idx` transitioned from unknown → known.
  // Decrements unknown counts for each parity row that references it and
  // queues rows that are now one-unknown-and-parity-known.
  function markSourceSolved(idx) {
    if (!adj || K === null || idx >= K) return
    const parities = adj[idx]
    for (let i = 0; i < parities.length; i++) {
      const p = parities[i]
      if (parityUnknownCount[p] > 0) parityUnknownCount[p]--
      if (parityKnown[p] && parityUnknownCount[p] === 1) dirtyParities.add(p)
    }
  }

  // Record that parity block p transitioned from unknown → known.
  function markParitySolved(p) {
    if (!parityKnown || p < 0 || p >= parityKnown.length) return
    if (parityKnown[p]) return
    parityKnown[p] = 1
    if (parityUnknownCount[p] === 1) dirtyParities.add(p)
  }

  function reduce(symbol) {
    // Remove known blocks from symbol
    const remaining = []
    let payload = new Uint8Array(symbol.payload)

    for (const idx of symbol.indices) {
      if (decodedBlocks[idx]) {
        // XOR out known block
        xorBytesInto(payload, decodedBlocks[idx])
      } else {
        remaining.push(idx)
      }
    }

    return { indices: remaining, payload }
  }

  function propagate() {
    let changed = true
    while (changed) {
      changed = false

      for (let i = pendingSymbols.length - 1; i >= 0; i--) {
        const sym = pendingSymbols[i]
        const reduced = reduce(sym)

        if (reduced.indices.length === 0) {
          // Fully reduced, discard
          pendingSymbols.splice(i, 1)
          changed = true
        } else if (reduced.indices.length === 1) {
          // Degree 1 - decode!
          const idx = reduced.indices[0]
          if (!decodedBlocks[idx]) {
            decodedBlocks[idx] = reduced.payload
            solved++
            // Track source blocks separately (only if K is known). When K is
            // known we also update the event-driven parity bookkeeping so a
            // subsequent parityRecovery() can drain only the affected rows.
            if (K !== null) {
              if (idx < K) {
                solvedSource++
                markSourceSolved(idx)
              } else {
                markParitySolved(idx - K)
              }
            }
          }
          pendingSymbols.splice(i, 1)
          changed = true
        } else {
          // Update with reduced form
          pendingSymbols[i] = reduced
        }
      }
    }
  }

  // Event-driven parity recovery. Instead of sweeping every parity row on every
  // accepted packet, we drain `dirtyParities` — rows that transitioned to "one
  // unknown source and the parity block is known" since the last mutation.
  // Drain/propagate alternate until nothing new is enqueued: recoveries inside
  // the drain call markSourceSolved (re-populating the queue), and propagate()
  // after each drain may peel pending symbols that were waiting on the newly
  // recovered blocks (also re-populating the queue via mark*Solved).
  function parityRecovery() {
    if (!parityMap || K === null || !adj) return 0
    // Skip idle calls. Incrementing parityNoProgressSweeps only when there
    // was at least one dirty row keeps the counter a real signal of
    // "attempted parity work that produced nothing" instead of counting
    // every no-op invocation from ingestParsedPacket.
    if (dirtyParities.size === 0) return 0

    let totalRecovered = 0
    let recoveredThisRound
    do {
      recoveredThisRound = 0
      while (dirtyParities.size > 0) {
        // Pop one entry without constructing an iterator array.
        const p = dirtyParities.values().next().value
        dirtyParities.delete(p)
        if (!parityKnown[p]) continue
        if (parityUnknownCount[p] !== 1) continue

        const srcIndices = parityMap[p]
        let missingIdx = -1
        for (let i = 0; i < srcIndices.length; i++) {
          const s = srcIndices[i]
          if (!decodedBlocks[s]) { missingIdx = s; break }
        }
        if (missingIdx === -1) continue // State drifted; skip.

        const out = new Uint8Array(decodedBlocks[K + p])
        for (let i = 0; i < srcIndices.length; i++) {
          const s = srcIndices[i]
          if (s === missingIdx) continue
          xorBytesInto(out, decodedBlocks[s])
        }
        decodedBlocks[missingIdx] = out
        solved++
        solvedSource++
        recoveredThisRound++
        markSourceSolved(missingIdx)
      }
      if (recoveredThisRound > 0) {
        propagate()
      }
      totalRecovered += recoveredThisRound
    } while (recoveredThisRound > 0 && dirtyParities.size > 0)

    // Proxy counter for "parity-recovery call finished without progress." With
    // the event-driven queue this mostly ticks on no-op drains — still useful
    // for distinguishing active parity work from idle calls in telemetry.
    if (totalRecovered === 0) {
      parityNoProgressSweeps++
    }

    return totalRecovered
  }

  // Returns true iff every parity block has been decoded. O(M) worst case.
  function hasAllParitySymbolsDecoded() {
    if (!parityMap || K === null || !decodedBlocks) return false
    for (let p = 0; p < parityMap.length; p++) {
      if (!decodedBlocks[K + p]) return false
    }
    return true
  }

  // Rescan decodedBlocks[0..K_prime] and rebuild solved / solvedSource counts.
  function recountSolved() {
    solved = 0
    solvedSource = 0
    if (!decodedBlocks || K_prime === null) return
    for (let i = 0; i < K_prime; i++) {
      if (decodedBlocks[i]) {
        solved++
        if (K !== null && i < K) solvedSource++
      }
    }
  }

  // Remove any pendingSymbols whose indices all resolve in decodedBlocks.
  function pruneFullyReducedPending() {
    if (!decodedBlocks) return
    for (let i = pendingSymbols.length - 1; i >= 0; i--) {
      const sym = pendingSymbols[i]
      let fullyResolved = true
      for (const idx of sym.indices) {
        if (!decodedBlocks[idx]) { fullyResolved = false; break }
      }
      if (fullyResolved) pendingSymbols.splice(i, 1)
    }
  }

  function ingestParsedPacket(parsed) {
    if (!parsed) return false

    // First packet sets session
    if (fileId === null) {
      fileId = parsed.fileId
      K_prime = parsed.k  // Packet contains K' (intermediate block count)
      blockSize = parsed.blockSize  // Store block size from packet
      decodedBlocks = new Array(K_prime).fill(null)
    } else if (parsed.fileId !== fileId) {
      // New session detected - return special value so receiver can reset
      return 'new_session'
    }

    // Track unique symbols
    if (receivedSymbols.has(parsed.symbolId)) {
      return false // Duplicate
    }
    receivedSymbols.add(parsed.symbolId)

    // Track unique parity-symbol IDs as they arrive. Until K is known we
    // cannot classify; on metadata we'll do a single backfill scan.
    if (K !== null && K_prime !== null &&
        parsed.symbolId > K && parsed.symbolId <= K_prime) {
      uniqueParitySymbolsSeen++
    }

    // Incrementally update the symbol-type breakdown. Before K is known,
    // symbols in (K_prime_header, ∞) are still identifiable as fountain, but
    // source and parity collapse into source — the metadata branch rebuilds
    // the breakdown when K arrives.
    if (parsed.symbolId === 0) {
      metadataSymbolCount++
    } else if (K_prime !== null && parsed.symbolId > K_prime) {
      fountainSymbolCount++
    } else if (K !== null && parsed.symbolId > K) {
      paritySymbolCount++
    } else {
      sourceSymbolCount++
    }

    // Handle metadata - extract K and set up parity
    if (parsed.isMetadata || parsed.symbolId === 0) {
      if (!metadata) {
        metadata = parseMetadataPayload(parsed.payload)
        // Extract K from metadata and set up parity parameters
        K = metadata.K
        if (metadata.noRedundancy) {
          // No-redundancy stream: no parity blocks exist. Empty map → K' = K,
          // exact K-block allocation, and all parity bookkeeping no-ops.
          G = 0
          parityMap = []
        } else {
          const params = calculateParityParams(K)
          G = params.G
          parityMap = generateParityMap(K, G)
        }
        // K_prime is K + actual parity count (0 when no-redundancy)
        const newK_prime = K + parityMap.length

        // Resize array if needed, preserve existing decoded blocks
        if (K_prime !== newK_prime) {
          const oldBlocks = decodedBlocks || []
          K_prime = newK_prime
          decodedBlocks = new Array(K_prime).fill(null)
          // Copy over any previously decoded blocks
          for (let i = 0; i < Math.min(oldBlocks.length, K_prime); i++) {
            if (oldBlocks[i]) {
              decodedBlocks[i] = oldBlocks[i]
            }
          }
        }

        // Recount solved blocks now that K is known
        solved = 0
        solvedSource = 0
        for (let i = 0; i < K_prime; i++) {
          if (decodedBlocks[i]) {
            solved++
            if (i < K) solvedSource++
          }
        }

        // Backfill parity-symbol-id count and the symbol-type breakdown from
        // previously received symbols. Both require a rescan because before
        // metadata we could not distinguish source from parity.
        uniqueParitySymbolsSeen = 0
        sourceSymbolCount = 0
        paritySymbolCount = 0
        fountainSymbolCount = 0
        for (const sid of receivedSymbols) {
          if (sid === 0) continue
          if (sid > K && sid <= K_prime) uniqueParitySymbolsSeen++
          if (sid > K_prime) fountainSymbolCount++
          else if (sid > K) paritySymbolCount++
          else sourceSymbolCount++
        }

        // Seed event-driven parity bookkeeping from whatever state
        // decodedBlocks already holds (symbols that arrived before metadata).
        initParityAdjacency()
        // Pending symbols accepted before metadata may now collapse to
        // degree-1 once they're reduced against already-known blocks.
        propagate()
        parityRecovery()
      }
      return true
    }

    // Reconstruct indices via the shared derivation (fountain-symbol.js) so the
    // decoder can never drift from the encoder.
    const indices = deriveSymbolIndices(fileId, parsed.symbolId, K_prime)

    // Fast path for degree-1 (systematic symbols and degree-1 fountain): install
    // the block directly into decodedBlocks, skipping the reduce/propagate cycle
    // for this symbol. Other pending symbols still need propagate() below so
    // they can peel against the newly-known block. Replays of degree-1 symbols
    // whose block was already decoded are dropped — no state change means there
    // is nothing for propagate()/parityRecovery() to do.
    let stateChanged = false
    if (indices.length === 1) {
      const idx = indices[0]
      if (!decodedBlocks[idx]) {
        decodedBlocks[idx] = new Uint8Array(parsed.payload)
        solved++
        if (K !== null) {
          if (idx < K) {
            solvedSource++
            markSourceSolved(idx)
          } else {
            markParitySolved(idx - K)
          }
        }
        stateChanged = true
      }
    } else {
      pendingSymbols.push({ indices, payload: new Uint8Array(parsed.payload) })
      stateChanged = true
    }

    if (stateChanged) {
      propagate()
      if (!this.isComplete() && parityMap) parityRecovery()
    }

    // Latch parity-sweep-complete once we've received the whole (K, K_prime]
    // systematic parity range. This is a *schedule* observation matching the
    // `par=` count in the receiver log — not "parity blocks are decoded."
    if (!paritySweepComplete && K !== null && K_prime !== null &&
        uniqueParitySymbolsSeen >= (K_prime - K)) {
      paritySweepComplete = true
    }

    return true
  }

  // Evaluate the stall counter + GF(2) tail-solver trigger at a frame
  // boundary. The receiver calls this once per video frame (after all packets
  // from that frame have been ingested). The decoder alone can't know where
  // frame boundaries are — HDMI-UVC batches ~6 packets per frame, QR is 1:1 —
  // so keeping the frame signal out of ingest avoids miscounting.
  function runFrameBoundary() {
    if (K === null || !parityMap || !decodedBlocks) return 0

    if (solvedSource === lastSolvedSourceCount) stallFramesSinceLastSolve++
    else { stallFramesSinceLastSolve = 0; lastSolvedSourceCount = solvedSource }

    if (solvedSource >= K) return 0

    // Nothing for the GF(2) solver to work with: no pending equations and no
    // parity rows. Always true in no-redundancy mode (every symbol is degree-1,
    // so it is placed directly and never queued as pending). Skip before the
    // trigger so the tail solver does not spin on empty equation sets.
    if (pendingSymbols.length === 0 && parityMap.length === 0) return 0

    const missing = K - solvedSource
    const signature = (pendingSymbols.length * 0x10000) + solved
    const shouldTrySolver = shouldRunTailSolver({
      missing,
      signature,
      lastTailSolveSignature,
      paritySweepComplete,
      stallFramesSinceLastSolve
    })
    if (!shouldTrySolver) return 0

    lastTailSolveSignature = signature
    tailSolveTriggerCount++
    const equations = []
    for (const sym of pendingSymbols) {
      equations.push({ indices: sym.indices, payload: sym.payload })
    }
    for (let p = 0; p < parityMap.length; p++) {
      const pIdx = K + p
      if (!decodedBlocks[pIdx]) continue
      const srcIdx = parityMap[p]
      let unknownCount = 0
      for (const i of srcIdx) {
        if (!decodedBlocks[i]) {
          unknownCount++
          if (unknownCount >= 2) break
        }
      }
      if (unknownCount >= 2) {
        equations.push({ indices: srcIdx, payload: decodedBlocks[pIdx] })
      }
    }
    const got = solveGF2(equations, decodedBlocks, K_prime, blockSize)
    if (got > 0) {
      recountSolved()
      pruneFullyReducedPending()
      // GF(2) mutated decodedBlocks directly, bypassing mark*Solved. Rebuild
      // the event-driven bookkeeping from the current state before propagate
      // so any follow-on parity recovery uses accurate counts.
      initParityAdjacency()
      propagate()
      if (dirtyParities.size > 0) parityRecovery()
    }
    return got
  }

  function getReceivedSymbolBreakdown() {
    return {
      metadataCount: metadataSymbolCount,
      sourceCount: sourceSymbolCount,
      parityCount: paritySymbolCount,
      fountainCount: fountainSymbolCount
    }
  }

  return {
    get fileId() { return fileId },
    get k() { return K },        // Source block count (for compatibility)
    get K() { return K },        // Source block count
    get K_prime() { return K_prime },  // Intermediate block count
    get metadata() { return metadata },
    get blockSize() { return blockSize },
    get solved() { return solvedSource },  // Report source blocks solved
    get solvedTotal() { return solved },   // All intermediate blocks solved
    get uniqueSymbols() { return receivedSymbols.size },
    get symbolBreakdown() { return getReceivedSymbolBreakdown() },
    get telemetry() {
      return {
        paritySweepComplete,
        parityNoProgressSweeps,
        stallFramesSinceLastSolve,
        tailSolveTriggerCount,
        pendingSymbolCount: pendingSymbols.length,
        uniqueParitySymbolsSeen,
      }
    },
    get pendingSymbolCount() { return pendingSymbols.length },
    get unresolvedSourceCount() { return K !== null ? Math.max(0, K - solvedSource) : null },
    get unresolvedIntermediateCount() { return K_prime !== null ? Math.max(0, K_prime - solved) : null },
    get solvedSourceIds() {
      if (K === null || !decodedBlocks) return []
      const ids = []
      for (let i = 0; i < K; i++) {
        if (decodedBlocks[i]) ids.push(i + 1)
      }
      return ids
    },
    get progress() { return K ? solvedSource / K : 0 },

    isComplete() { return K !== null && solvedSource === K },

    // Reset decoder state for a new session
    reset() {
      fileId = null
      K = null
      K_prime = null
      G = null
      parityMap = null
      metadata = null
      blockSize = 200
      decodedBlocks = null
      solved = 0
      solvedSource = 0
      receivedSymbols = new Set()
      pendingSymbols = []
      paritySweepComplete = false
      uniqueParitySymbolsSeen = 0
      parityNoProgressSweeps = 0
      metadataSymbolCount = 0
      sourceSymbolCount = 0
      paritySymbolCount = 0
      fountainSymbolCount = 0
      stallFramesSinceLastSolve = 0
      tailSolveTriggerCount = 0
      lastSolvedSourceCount = 0
      lastTailSolveSignature = -1
      adj = null
      parityUnknownCount = null
      parityKnown = null
      dirtyParities.clear()
    },

    receive(packet) {
      const parsed = parsePacket(packet)
      return ingestParsedPacket.call(this, parsed)
    },

    receiveParsed(parsed) {
      return ingestParsedPacket.call(this, parsed)
    },

    // Call once per video frame after all packets from that frame have been
    // ingested. Updates stallFramesSinceLastSolve and, if appropriate, fires
    // the GF(2) tail solver. Returns the number of blocks recovered by the
    // solver (0 if it didn't run or didn't make progress).
    noteFrameBoundary() {
      return runFrameBoundary()
    },

    reconstruct() {
      if (!this.isComplete()) return null

      // Concatenate source blocks (first K) and trim to the wire size — the
      // gzipped byte count when the stream is compressed, the file size
      // otherwise (old metadata frames parse with transmittedSize = fileSize).
      const wireSize = metadata.transmittedSize ?? metadata.fileSize
      const result = new Uint8Array(wireSize)
      for (let i = 0; i < K; i++) {
        const block = decodedBlocks[i]
        const start = i * blockSize
        const end = Math.min(start + blockSize, wireSize)
        if (end <= start) break
        result.set(block.subarray(0, end - start), start)
      }

      return result
    },

    // The original file bytes: reconstruct() is the wire stream, this inflates
    // it when the sender compressed. fileSize bounds the inflation — the gzip
    // trailer's declared size arrived over the air and is not trusted.
    async reconstructFile() {
      const wire = this.reconstruct()
      if (!wire) return null
      if (!metadata.compressed) return wire
      return decompressWithLimit(wire, metadata.fileSize)
    },

    async verify() {
      let data
      try {
        data = await this.reconstructFile()
      } catch {
        return false // corrupt or oversized gzip stream is a failed transfer
      }
      if (!data) return false

      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data))

      // Compare hashes
      if (hash.length !== metadata.hash.length) return false
      for (let i = 0; i < hash.length; i++) {
        if (hash[i] !== metadata.hash[i]) return false
      }
      return true
    }
  }
}

