// HDMI-UVC frame encoding/decoding with anchor-based layout

import {
  FRAME_MAGIC, HEADER_SIZE, ANCHOR_SIZE, MARGIN_SIZE, BLOCK_SIZE,
  ANCHOR_PATTERN, HDMI_MODE, HDMI_MODE_NAMES, getModeBitsPerBlock, getModeDataBlockSize,
  getModeHeaderBlockSize, getModePayloadBlockSize, isDenseBinaryMode, isDenseLuma1Mode
} from './hdmi-uvc-constants.js'
// crc32WithFallback prefers the WASM kernel (Phase 4) once loaded and
// transparently falls back to the JS implementation before instantiation,
// exposing a JS-compatible signature so callers need not know which backend
// ran.
import {
  crc32WithFallback as crc32,
  isHdmiUvcWasmActive,
  wasmReadLuma1Payload,
  wasmClassifyCompat4Cells,
  wasmClassifyLuma2Cells,
  wasmPackBinary1Payload
} from './hdmi-uvc-wasm.js'
// Anchor detection lives in its own module; frame.js re-exports the public
// pieces below so existing importers keep working through this façade.
import { sampleBlockAt, verifyAnchorAt } from './hdmi-uvc-frame-anchors.js'
export { sampleBlockAt, detectAnchors, dataRegionFromAnchors } from './hdmi-uvc-frame-anchors.js'
// The WASM cell classifier can be disabled via the diagnostics panel. The
// composition points (receiver init, worker boot) push that setting in via
// setWasmClassifierEnabled rather than the codec reading the global
// diagnostics store — keeps this module a pure function of its inputs.
let wasmClassifierEnabled = true
export function setWasmClassifierEnabled(enabled) {
  wasmClassifierEnabled = !!enabled
}

// Per-decode timing accumulator for the WASM payload-cell classifier.
// The receiver resets this before each decodeDataRegion call and reads it
// after so the frame perf log can attribute classifier cost separately
// from the rest of decode. Main thread and worker each see their own
// module copy — neither can read the other's. The receiver wires only
// the main-thread accumulator into its frame perf telemetry today.
let classifierMsAccumulator = 0
export function resetClassifierPerfAccumulator() { classifierMsAccumulator = 0 }
export function getClassifierPerfAccumulator() { return classifierMsAccumulator }
const classifierPerfNow = (typeof performance !== 'undefined' && typeof performance.now === 'function')
  ? () => performance.now()
  : () => Date.now()

// --- Binary modulation (1 bit per block) ---
// Each byte is encoded as 8 blocks (MSB first): bit=1 → white (255), bit=0 → black (0).
// Receiver thresholds at 128. MJPEG corrupts values by ±20 but binary has 108+ margin.

const BITS_PER_BYTE = 8
const HEADER_BLOCKS = HEADER_SIZE * BITS_PER_BYTE // 22 bytes × 8 bits = 176 blocks
const GRAY2_LEVEL_FRACTIONS = [0.00, 0.333, 0.667, 1.00]
const GRAY2_THRESHOLD_FRACTIONS = [0.167, 0.50, 0.833]
const RGB3_PALETTE = [
  [255, 255, 255],
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255]
]
const RGB3_PILOT_SYMBOLS = [0, 1, 2, 3]
const RGB3_NORMALIZED_PALETTE = RGB3_PALETTE.map((color) => color.map((channel) => channel / 255))
const ENABLE_BINARY_PILOTS = false
const ENABLE_PAYLOAD_INTERLEAVING = false
const BINARY_PILOT_SPACING = 16
const BINARY_PILOT_OFFSET = 8
const payloadCellOrderCache = new Map()
const DENSE_BINARY_MIN_HEADER_BAND_ROWS = 1
const DENSE_BINARY_HEADER_PAD_BYTE = 0xAA
const DENSE_BINARY_HEADER_BLOCK_SIZE = 4
const BINARY_3_PAYLOAD_BLOCK_SIZE = 3
const LUMA1_EDGE_GUARD_CELLS = 1
const DENSE_BINARY_REF_STRIP_WIDTH_4X4 = 1
const DENSE_BINARY_REF_STRIP_PX = DENSE_BINARY_REF_STRIP_WIDTH_4X4 * DENSE_BINARY_HEADER_BLOCK_SIZE
const LUMA1_GRAY_SYMBOL_TO_LEVEL = [0, 1, 3, 2]
const LUMA1_GRAY_LEVEL_TO_SYMBOL = [0, 1, 3, 2]
const LUMA1_LEVEL_COUNT = 4
// Sender-side output values per luma level. The capture chain applies a
// nonlinear luma transform (display gamma/ICC) that binary endpoints survive
// but intermediate levels do not — measured live: 85 lands near 136 and 170
// near 178, collapsing the L1/L2 gap. The mid levels are therefore tunable so
// the sender can pre-compensate until the *captured* levels are evenly spaced.
// The receiver needs no matching constant: it learns levels from the ramp
// strips, which are rendered from this same table.
const LUMA1_SENDER_LEVELS = GRAY2_LEVEL_FRACTIONS.map((f) => Math.round(255 * f))

export function setLuma1SenderMidLevels(mid1, mid2) {
  const lo = Math.round(mid1)
  const hi = Math.round(mid2)
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false
  if (lo <= 0 || hi <= lo || hi >= 255) return false
  LUMA1_SENDER_LEVELS[1] = lo
  LUMA1_SENDER_LEVELS[2] = hi
  return true
}

export function getLuma1SenderLevels() {
  return LUMA1_SENDER_LEVELS.slice()
}

// Fixed pseudo-random calibration payload. The sender transmits it in
// calibration mode; the receiver regenerates it to compute exact per-cell
// error maps and measure the channel's mixing behavior directly.
const LUMA1_CAL_SEED = 0xC0FFEE42
let luma1CalCache = new Uint8Array(0)
export function getLuma1CalibrationPayload(length) {
  if (luma1CalCache.length < length) {
    const buf = new Uint8Array(length)
    let s = LUMA1_CAL_SEED
    for (let i = 0; i < length; i++) {
      s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0
      buf[i] = s & 0xff
    }
    luma1CalCache = buf
  }
  return luma1CalCache.length === length ? luma1CalCache : luma1CalCache.subarray(0, length)
}

// A CRC-valid frame whose payload IS the calibration pattern carries no
// packets by design — the receiver must treat it as link-validation success
// instead of routing it into the packet pipeline (where zero ingested
// packets reads as failure and tears the lock down).
export function isLuma1CalibrationPayload(payload) {
  if (!payload || payload.length === 0) return false
  const expected = getLuma1CalibrationPayload(payload.length)
  for (let i = 0; i < payload.length; i++) {
    if (payload[i] !== expected[i]) return false
  }
  return true
}

// Sweep budget: while the receiver is in CRC-failure backoff, full blind
// sweeps (all phase/guard combos ≈ 0.5s) would still saturate the main
// thread. Fast mode reads only strip-identified phases at the default guard.
let luma1SweepBudgetFast = false
export function setLuma1SweepBudgetFast(fast) {
  luma1SweepBudgetFast = !!fast
}

// Hard wall-clock cap for one blind sweep call. Each phase/guard candidate is
// a full-frame payload read (~80ms at 1080p), so an uncapped sweep blocks the
// main thread for most of a second. The strips pre-order the true phase
// first, so a decodable frame still passes on the first candidate; the budget
// only truncates sweeps that were going to fail anyway. null = unlimited
// (Node tests and sims sweep exhaustively).
let luma1SweepTimeBudgetMs = null
export function setLuma1SweepTimeBudgetMs(ms) {
  luma1SweepTimeBudgetMs = Number.isFinite(ms) && ms > 0 ? ms : null
  return luma1SweepTimeBudgetMs
}

// The failed-sweep evidence block (strips/histogram/purity/CAL analysis) costs
// ~100ms to build but is only ever printed on layout invalidation. The
// receiver enables capture just for the sweep whose failure will invalidate;
// default on so Node tests and sims always get the evidence.
let luma1DebugCaptureEnabled = true
export function setLuma1DebugCapture(enabled) {
  luma1DebugCaptureEnabled = !!enabled
}

// Horizontal-peaking correction. The capture dongle applies a 1D unsharp
// mask along rows (measured live: v = u + λ·(u − (L+R)/2), λ≈0.45, R²≈1.0,
// vertical term ≈ 0). The kernel [−λ/2, 1+λ, −λ/2] is diagonally dominant,
// so each payload row can be deconvolved exactly with a tridiagonal solve.
let luma1SharpenLambda = null
export function setLuma1SharpenCorrection(lambda) {
  luma1SharpenLambda = Number.isFinite(lambda) && lambda >= 0.05 && lambda <= 1.5 ? lambda : null
  return luma1SharpenLambda
}
export function getLuma1SharpenCorrection() {
  return luma1SharpenLambda
}

let luma1SolveScratch = null
function getLuma1SolveScratch(n) {
  if (!luma1SolveScratch || luma1SolveScratch.length < n * 2) {
    luma1SolveScratch = new Float32Array(n * 2)
  }
  return luma1SolveScratch
}

let luma1RowBuffer = null
function getLuma1RowBuffer(n) {
  if (!luma1RowBuffer || luma1RowBuffer.length < n) {
    luma1RowBuffer = new Float32Array(n)
  }
  return luma1RowBuffer
}

// Rail-pinning headroom. The deconvolution pins rail-valued samples as exact
// (u = v), which is only sound while no mid-level cell can overshoot past the
// pin threshold under the current lambda — past that, clamping makes a hot
// mid (e.g. 182*1.45 = 264 -> clamps to 255) indistinguishable from true
// white and the solve degrades badly in BOTH directions (unpinning instead
// sacrifices true whites, whose clamped overshoot is even larger). Live
// captured levels [0/91/169/255] leave ~6 gray of headroom; this probe turns
// a drift toward the rails into a log warning instead of a silent failure.
export function getLuma1SharpenRailHeadroom(lumaLevels, lambda) {
  const black = lumaLevels[0]
  const white = lumaLevels[LUMA1_LEVEL_COUNT - 1]
  const topMid = lumaLevels[LUMA1_LEVEL_COUNT - 2]
  const maxMidObs = topMid + lambda * (topMid - black) // both neighbors black
  return Math.round((white - 6) - maxMidObs)
}

// In-place row deconvolution. Values at the rails are pinned (u = v): the
// ISP clamps rail overshoot, mid levels cannot reach the rails under this
// model, and a pinned cell splits the row into independently solvable
// segments with exact Dirichlet boundaries. Row ends use a Neumann boundary
// — the edge guard cells mirror the first/last data cell by construction.
export function unsharpenLuma1Row(vals, count, lambda, railLo, railHi) {
  const sub = -lambda / 2
  const diagMain = 1 + lambda
  const diagEnd = 1 + lambda / 2
  const scratch = getLuma1SolveScratch(count)
  let segStart = 0
  while (segStart < count) {
    if (vals[segStart] <= railLo || vals[segStart] >= railHi) {
      segStart++
      continue
    }
    let segEnd = segStart
    while (segEnd + 1 < count && vals[segEnd + 1] > railLo && vals[segEnd + 1] < railHi) {
      segEnd++
    }
    const n = segEnd - segStart + 1
    const leftPinned = segStart > 0
    const rightPinned = segEnd < count - 1
    if (n === 1) {
      // Single unpinned cell: both boundary terms act on the same equation.
      let diag = diagMain
      let rhs = vals[segStart]
      if (leftPinned) rhs -= sub * vals[segStart - 1]
      else diag += sub
      if (rightPinned) rhs -= sub * vals[segEnd + 1]
      else diag += sub
      vals[segStart] = rhs / diag
      segStart = segEnd + 1
      continue
    }
    if (n === 2) {
      // Closed-form 2x2 — with rails on half the cells, runs of one or two
      // mids hold most of the work, so skipping the scratch sweep here is a
      // measurable win on the hot locked-read path.
      const dA = leftPinned ? diagMain : diagEnd
      const dB = rightPinned ? diagMain : diagEnd
      const rA = vals[segStart] - (leftPinned ? sub * vals[segStart - 1] : 0)
      const rB = vals[segEnd] - (rightPinned ? sub * vals[segEnd + 1] : 0)
      const inv = 1 / (dA * dB - sub * sub)
      vals[segStart] = (rA * dB - sub * rB) * inv
      vals[segEnd] = (dA * rB - sub * rA) * inv
      segStart = segEnd + 1
      continue
    }
    // Thomas forward sweep. scratch[2i] = c'_i, scratch[2i+1] = d'_i.
    const diag0 = leftPinned ? diagMain : diagEnd
    const rhs0 = vals[segStart] - (leftPinned ? sub * vals[segStart - 1] : 0)
    scratch[0] = sub / diag0
    scratch[1] = rhs0 / diag0
    for (let i = 1; i < n; i++) {
      const isLast = i === n - 1
      const diag = isLast ? (rightPinned ? diagMain : diagEnd) : diagMain
      let rhs = vals[segStart + i]
      if (isLast && rightPinned) rhs -= sub * vals[segEnd + 1]
      const denom = diag - sub * scratch[(i - 1) * 2]
      scratch[i * 2] = (isLast ? 0 : sub) / denom
      scratch[i * 2 + 1] = (rhs - sub * scratch[(i - 1) * 2 + 1]) / denom
    }
    // Back substitution.
    vals[segEnd] = scratch[(n - 1) * 2 + 1]
    for (let i = n - 2; i >= 0; i--) {
      vals[segStart + i] = scratch[i * 2 + 1] - scratch[i * 2] * vals[segStart + i + 1]
    }
    segStart = segEnd + 1
  }
  return vals
}

// Candidate peaking strengths for the blind sweep below. The dongle measured
// live sits at ~0.45; the ladder brackets it widely enough to cover other
// capture hardware while staying inside setLuma1SharpenCorrection's accepted
// range. λ=0 is deliberately absent — the caller has already decoded once at
// the current setting, which is the uncorrected case whenever nothing is armed.
export const LUMA1_SHARPEN_LADDER = [0.45, 0.35, 0.55, 0.25, 0.65, 0.8]

// Blind λ recovery. The correction used to be armed only from a sender
// calibration frame; with that path gone, a receiver that has never stored a λ
// can never decode a peaked channel and fails every frame forever. Re-decoding
// one already-failed frame across the ladder costs a handful of decodes once
// per lock and needs no cooperation from the sender: a valid payload CRC is
// proof the λ is right, since a wrong deconvolution cannot forge one.
//
// Returns { lambda, result } on success and leaves that λ armed; on failure
// restores the λ that was in effect on entry and returns null.
export function sweepLuma1SharpenCorrection(imageData, width, region, options = {}) {
  const previous = getLuma1SharpenCorrection()
  const ladder = options.ladder || LUMA1_SHARPEN_LADDER
  const wasDebugCapture = luma1DebugCaptureEnabled
  // The evidence block costs ~100ms per decode and nothing reads it here.
  setLuma1DebugCapture(false)
  try {
    for (const lambda of ladder) {
      if (setLuma1SharpenCorrection(lambda) === null) continue
      const result = decodeDataRegion(imageData, width, region, options.decodeOptions || {})
      if (result?.crcValid) return { lambda, result }
    }
    setLuma1SharpenCorrection(previous)
    return null
  } catch (err) {
    setLuma1SharpenCorrection(previous)
    throw err
  } finally {
    setLuma1DebugCapture(wasDebugCapture)
  }
}

function getDenseBinaryPayloadEdgeGuardCells(mode, explicit = null) {
  return Number.isFinite(explicit) && explicit >= 0
    ? explicit
    : mode === HDMI_MODE.LUMA_1 ? LUMA1_EDGE_GUARD_CELLS : 0
}

function getDenseBinaryPayloadBlockSize(mode) {
  return getModePayloadBlockSize(mode) || BINARY_3_PAYLOAD_BLOCK_SIZE
}

export const CODEBOOK3_PATTERNS = [
  [0, 0, 0, 0],
  [1, 1, 1, 1],
  [1, 1, 0, 0],
  [0, 0, 1, 1],
  [1, 0, 1, 0],
  [0, 1, 0, 1],
  [1, 0, 0, 1],
  [0, 1, 1, 0]
]
export const LUMA2_PATTERNS = [
  [1, 1, 0, 0],
  [0, 0, 1, 1],
  [1, 0, 1, 0],
  [0, 1, 0, 1]
]
const GLYPH5_GRID_SIZE = 4
const GLYPH5_SYMBOL_COUNT = 32
export const GLYPH5_CODEBOOK = buildGlyph5Codebook()

function popcount16(mask) {
  let value = mask
  let count = 0
  while (value) {
    value &= value - 1
    count++
  }
  return count
}

function hammingDistance16(a, b) {
  return popcount16(a ^ b)
}

function buildGlyph5Pattern(mask) {
  const pattern = new Array(GLYPH5_GRID_SIZE * GLYPH5_GRID_SIZE)
  for (let i = 0; i < pattern.length; i++) {
    pattern[i] = (mask >> (pattern.length - 1 - i)) & 1
  }
  return pattern
}

function glyph5TransitionScore(mask) {
  let score = 0
  for (let row = 0; row < GLYPH5_GRID_SIZE; row++) {
    for (let col = 0; col < GLYPH5_GRID_SIZE; col++) {
      const idx = row * GLYPH5_GRID_SIZE + col
      const bit = (mask >> (15 - idx)) & 1
      if (col + 1 < GLYPH5_GRID_SIZE) {
        const right = (mask >> (15 - (idx + 1))) & 1
        if (bit !== right) score++
      }
      if (row + 1 < GLYPH5_GRID_SIZE) {
        const down = (mask >> (15 - (idx + GLYPH5_GRID_SIZE))) & 1
        if (bit !== down) score++
      }
    }
  }
  return score
}

function buildGlyph5Candidates() {
  const candidates = []
  for (let mask = 0; mask < 0x10000; mask++) {
    if (popcount16(mask) !== 8) continue

    let valid = true
    for (let row = 0; row < GLYPH5_GRID_SIZE; row++) {
      let rowCount = 0
      for (let col = 0; col < GLYPH5_GRID_SIZE; col++) {
        rowCount += (mask >> (15 - (row * GLYPH5_GRID_SIZE + col))) & 1
      }
      if (rowCount < 1 || rowCount > 3) {
        valid = false
        break
      }
    }
    if (!valid) continue

    for (let col = 0; col < GLYPH5_GRID_SIZE; col++) {
      let colCount = 0
      for (let row = 0; row < GLYPH5_GRID_SIZE; row++) {
        colCount += (mask >> (15 - (row * GLYPH5_GRID_SIZE + col))) & 1
      }
      if (colCount < 1 || colCount > 3) {
        valid = false
        break
      }
    }
    if (!valid) continue

    candidates.push({
      mask,
      pattern: buildGlyph5Pattern(mask),
      score: glyph5TransitionScore(mask)
    })
  }

  candidates.sort((a, b) => b.score - a.score || a.mask - b.mask)
  return candidates
}

function buildGlyph5Codebook() {
  const candidates = buildGlyph5Candidates()
  const selected = []
  const usedMasks = new Set()

  for (let minDistance = 8; minDistance >= 4 && selected.length < GLYPH5_SYMBOL_COUNT; minDistance--) {
    for (const candidate of candidates) {
      if (usedMasks.has(candidate.mask)) continue
      const ok = selected.every((entry) => hammingDistance16(entry.mask, candidate.mask) >= minDistance)
      if (!ok) continue
      selected.push(candidate)
      usedMasks.add(candidate.mask)
      if (selected.length >= GLYPH5_SYMBOL_COUNT) break
    }
  }

  if (selected.length < GLYPH5_SYMBOL_COUNT) {
    throw new Error(`Failed to build Glyph5 codebook (${selected.length}/${GLYPH5_SYMBOL_COUNT})`)
  }

  return selected.slice(0, GLYPH5_SYMBOL_COUNT).map((entry) => entry.pattern)
}

// Encode a byte into 8 binary block values (returned as array of 0/255)
function encodeBits(byte) {
  const bits = new Array(8)
  for (let i = 0; i < 8; i++) {
    bits[i] = (byte >> (7 - i)) & 1 ? 255 : 0
  }
  return bits
}

// Decode 8 sampled block values into a byte (threshold at 128)
function decodeBits(values) {
  let byte = 0
  for (let i = 0; i < 8; i++) {
    if (values[i] > 128) byte |= (1 << (7 - i))
  }
  return byte
}

function encodeGray2(symbol) {
  return Math.round(255 * GRAY2_LEVEL_FRACTIONS[symbol & 0x3])
}

function decodeGray2(sample, blackLevel = 0, whiteLevel = 255) {
  const minLevel = Math.max(0, Math.min(blackLevel, whiteLevel))
  const maxLevel = Math.min(255, Math.max(blackLevel, whiteLevel))
  const span = Math.max(64, maxLevel - minLevel)
  const t1 = minLevel + span * GRAY2_THRESHOLD_FRACTIONS[0]
  const t2 = minLevel + span * GRAY2_THRESHOLD_FRACTIONS[1]
  const t3 = minLevel + span * GRAY2_THRESHOLD_FRACTIONS[2]

  if (sample < t1) return 0
  if (sample < t2) return 1
  if (sample < t3) return 2
  return 3
}

function encodeLuma1Symbol(symbol) {
  return LUMA1_SENDER_LEVELS[LUMA1_GRAY_SYMBOL_TO_LEVEL[symbol & 0x3]]
}

function decodeLuma1Symbol(sample, blackLevel = 0, whiteLevel = 255) {
  return LUMA1_GRAY_LEVEL_TO_SYMBOL[decodeGray2(sample, blackLevel, whiteLevel)]
}

function getDefaultLuma1Levels(blackLevel = 0, whiteLevel = 255) {
  const minLevel = Math.max(0, Math.min(blackLevel, whiteLevel))
  const maxLevel = Math.min(255, Math.max(blackLevel, whiteLevel))
  const span = Math.max(64, maxLevel - minLevel)
  return GRAY2_LEVEL_FRACTIONS.map((fraction) => minLevel + span * fraction)
}

function normalizeLuma1Levels(levels, blackLevel = 0, whiteLevel = 255) {
  const fallback = getDefaultLuma1Levels(blackLevel, whiteLevel)
  const normalized = fallback.slice()
  if (levels && levels.length >= LUMA1_LEVEL_COUNT) {
    for (let i = 0; i < LUMA1_LEVEL_COUNT; i++) {
      if (Number.isFinite(levels[i])) normalized[i] = levels[i]
    }
  }

  for (let i = 1; i < LUMA1_LEVEL_COUNT; i++) {
    if (normalized[i] <= normalized[i - 1] + 2) return fallback
  }
  if (normalized[LUMA1_LEVEL_COUNT - 1] - normalized[0] < 48) return fallback
  return normalized
}

// Nearest-centroid classification over four fixed levels is a pure function
// of the (integer) sample, so the per-cell Math.abs scan collapses into a
// 256-entry lookup table — the locked Luma4 reader classifies ~1.9M cells per
// 1080p frame, making this the hottest call in the receive path. Rebuilt only
// when the strip levels actually change (they're stable within a frame).
// Ties at exact midpoints resolve to the lower level, matching the strict-<
// comparison in decodeLuma1SymbolFromLevels.
let luma1ClassifyLut = null
const luma1ClassifyLutLevels = [NaN, NaN, NaN, NaN]
function getLuma1ClassifyLut(levels) {
  if (
    luma1ClassifyLut &&
    luma1ClassifyLutLevels[0] === levels[0] &&
    luma1ClassifyLutLevels[1] === levels[1] &&
    luma1ClassifyLutLevels[2] === levels[2] &&
    luma1ClassifyLutLevels[3] === levels[3]
  ) {
    return luma1ClassifyLut
  }
  if (!luma1ClassifyLut) luma1ClassifyLut = new Uint8Array(256)
  const t01 = (levels[0] + levels[1]) / 2
  const t12 = (levels[1] + levels[2]) / 2
  const t23 = (levels[2] + levels[3]) / 2
  for (let v = 0; v < 256; v++) {
    const level = v <= t01 ? 0 : v <= t12 ? 1 : v <= t23 ? 2 : 3
    luma1ClassifyLut[v] = LUMA1_GRAY_LEVEL_TO_SYMBOL[level]
  }
  luma1ClassifyLutLevels[0] = levels[0]
  luma1ClassifyLutLevels[1] = levels[1]
  luma1ClassifyLutLevels[2] = levels[2]
  luma1ClassifyLutLevels[3] = levels[3]
  return luma1ClassifyLut
}

function decodeLuma1SymbolFromLevels(sample, levels, blackLevel = 0, whiteLevel = 255) {
  const normalized = levels && levels.length >= LUMA1_LEVEL_COUNT
    ? levels
    : getDefaultLuma1Levels(blackLevel, whiteLevel)
  let bestLevel = 0
  let bestDistance = Infinity
  for (let level = 0; level < LUMA1_LEVEL_COUNT; level++) {
    const distance = Math.abs(sample - normalized[level])
    if (distance < bestDistance) {
      bestDistance = distance
      bestLevel = level
    }
  }
  return LUMA1_GRAY_LEVEL_TO_SYMBOL[bestLevel]
}

function encodeRgb3(symbol) {
  return RGB3_PALETTE[symbol & 0x7]
}

function normalizeRgbSample(sample, blackLevels = [0, 0, 0], whiteLevels = [255, 255, 255]) {
  const normalized = [0, 0, 0]
  for (let channel = 0; channel < 3; channel++) {
    const minLevel = Math.max(0, Math.min(blackLevels[channel], whiteLevels[channel]))
    const maxLevel = Math.min(255, Math.max(blackLevels[channel], whiteLevels[channel]))
    const span = Math.max(64, maxLevel - minLevel)
    const value = (sample[channel] - minLevel) / span
    normalized[channel] = Math.max(0, Math.min(1, value))
  }
  return normalized
}

function decodeRgb3(sample, blackLevels = [0, 0, 0], whiteLevels = [255, 255, 255], palette = RGB3_NORMALIZED_PALETTE) {
  const normalized = normalizeRgbSample(sample, blackLevels, whiteLevels)

  let bestSymbol = 0
  let bestError = Infinity
  for (let symbol = 0; symbol < palette.length; symbol++) {
    const target = palette[symbol]
    let error = 0
    for (let channel = 0; channel < 3; channel++) {
      const delta = normalized[channel] - target[channel]
      error += delta * delta
    }
    if (error < bestError) {
      bestError = error
      bestSymbol = symbol
    }
  }

  return bestSymbol
}

function normalizeBinarySample(sample, blackLevel = 0, whiteLevel = 255) {
  const span = Math.max(48, Math.abs(whiteLevel - blackLevel))
  const polarity = whiteLevel >= blackLevel ? 1 : -1
  const normalized = (polarity * (sample - blackLevel)) / span
  return Math.max(0, Math.min(1, normalized))
}

function decodeQuadrantCodebook(samples, blackLevel = 0, whiteLevel = 255, patterns) {
  const normalized = samples.map((sample) => normalizeBinarySample(sample, blackLevel, whiteLevel))
  let bestSymbol = 0
  let bestError = Infinity

  for (let symbol = 0; symbol < patterns.length; symbol++) {
    const pattern = patterns[symbol]
    let error = 0
    for (let i = 0; i < 4; i++) {
      const delta = normalized[i] - pattern[i]
      error += delta * delta
    }
    if (error < bestError) {
      bestError = error
      bestSymbol = symbol
    }
  }

  return bestSymbol
}

export function decodeCodebook3(samples, blackLevel = 0, whiteLevel = 255) {
  return decodeQuadrantCodebook(samples, blackLevel, whiteLevel, CODEBOOK3_PATTERNS)
}

export function decodeLuma2(samples, blackLevel = 0, whiteLevel = 255) {
  const normalized = samples.map((sample) => normalizeBinarySample(sample, blackLevel, whiteLevel))
  const top = (normalized[0] + normalized[1]) * 0.5
  const bottom = (normalized[2] + normalized[3]) * 0.5
  const left = (normalized[0] + normalized[2]) * 0.5
  const right = (normalized[1] + normalized[3]) * 0.5

  const horizontalContrast = Math.abs(top - bottom)
  const verticalContrast = Math.abs(left - right)

  if (horizontalContrast >= verticalContrast) {
    return top >= bottom ? 0 : 1
  }

  return left >= right ? 2 : 3
}

export function decodeGlyph5(samples, blackLevel = 0, whiteLevel = 255) {
  const normalized = samples.map((sample) => normalizeBinarySample(sample, blackLevel, whiteLevel))
  let bestSymbol = 0
  let bestError = Infinity

  for (let symbol = 0; symbol < GLYPH5_CODEBOOK.length; symbol++) {
    const pattern = GLYPH5_CODEBOOK[symbol]
    let error = 0
    for (let i = 0; i < pattern.length; i++) {
      const delta = normalized[i] - pattern[i]
      error += delta * delta
    }
    if (error < bestError) {
      bestError = error
      bestSymbol = symbol
    }
  }

  return bestSymbol
}

function fillBlockSolid(imageData, width, startX, startY, size, r, g, b) {
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const i = ((startY + dy) * width + (startX + dx)) * 4
      imageData[i] = r
      imageData[i + 1] = g
      imageData[i + 2] = b
    }
  }
}

function fillRectSolid(imageData, width, startX, startY, rectWidth, rectHeight, r, g, b) {
  for (let dy = 0; dy < rectHeight; dy++) {
    for (let dx = 0; dx < rectWidth; dx++) {
      const i = ((startY + dy) * width + (startX + dx)) * 4
      imageData[i] = r
      imageData[i + 1] = g
      imageData[i + 2] = b
    }
  }
}

function renderLuma1ReferenceStrip(imageData, width, startX, startY, stripWidth, stripHeight, reverse = false) {
  for (let dx = 0; dx < stripWidth; dx++) {
    const levelSlot = Math.min(
      LUMA1_LEVEL_COUNT - 1,
      Math.floor((dx * LUMA1_LEVEL_COUNT) / Math.max(1, stripWidth))
    )
    const level = reverse ? (LUMA1_LEVEL_COUNT - 1 - levelSlot) : levelSlot
    const val = LUMA1_SENDER_LEVELS[level]
    for (let dy = 0; dy < stripHeight; dy++) {
      const i = ((startY + dy) * width + (startX + dx)) * 4
      imageData[i] = val
      imageData[i + 1] = val
      imageData[i + 2] = val
    }
  }
}

function renderQuadrantCodebookBlock(imageData, width, startX, startY, size, pattern) {
  const xMid = Math.max(startX + 1, Math.min(startX + size - 1, startX + Math.round(size / 2)))
  const yMid = Math.max(startY + 1, Math.min(startY + size - 1, startY + Math.round(size / 2)))
  const quadrants = [
    [startX, startY, xMid, yMid],
    [xMid, startY, startX + size, yMid],
    [startX, yMid, xMid, startY + size],
    [xMid, yMid, startX + size, startY + size]
  ]

  for (let q = 0; q < quadrants.length; q++) {
    const [x0, y0, x1, y1] = quadrants[q]
    const val = pattern[q] ? 255 : 0
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const i = (py * width + px) * 4
        imageData[i] = val
        imageData[i + 1] = val
        imageData[i + 2] = val
      }
    }
  }
}

export function renderCodebook3Block(imageData, width, startX, startY, size, symbol) {
  renderQuadrantCodebookBlock(imageData, width, startX, startY, size, CODEBOOK3_PATTERNS[symbol & 0x7])
}

export function renderLuma2Block(imageData, width, startX, startY, size, symbol) {
  renderQuadrantCodebookBlock(imageData, width, startX, startY, size, LUMA2_PATTERNS[symbol & 0x3])
}

export function renderGlyph5Block(imageData, width, startX, startY, size, symbol) {
  const pattern = GLYPH5_CODEBOOK[symbol & 0x1F]
  for (let row = 0; row < GLYPH5_GRID_SIZE; row++) {
    const y0 = startY + Math.floor((row * size) / GLYPH5_GRID_SIZE)
    const y1 = startY + Math.floor(((row + 1) * size) / GLYPH5_GRID_SIZE)
    for (let col = 0; col < GLYPH5_GRID_SIZE; col++) {
      const x0 = startX + Math.floor((col * size) / GLYPH5_GRID_SIZE)
      const x1 = startX + Math.floor(((col + 1) * size) / GLYPH5_GRID_SIZE)
      const val = pattern[row * GLYPH5_GRID_SIZE + col] ? 255 : 0
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const i = (py * width + px) * 4
          imageData[i] = val
          imageData[i + 1] = val
          imageData[i + 2] = val
        }
      }
    }
  }
}

function extractBits(data, bitPos, count) {
  let value = 0
  for (let i = 0; i < count; i++) {
    const absoluteBit = bitPos + i
    const byteIdx = Math.floor(absoluteBit / BITS_PER_BYTE)
    const bitIdx = absoluteBit % BITS_PER_BYTE
    const bit = byteIdx < data.length ? ((data[byteIdx] >> (7 - bitIdx)) & 1) : 0
    value = (value << 1) | bit
  }
  return value
}

function appendSymbolBits(payload, state, symbol, bitsPerBlock) {
  state.bitBuffer = (state.bitBuffer << bitsPerBlock) | symbol
  state.bitCount += bitsPerBlock

  while (state.bitCount >= BITS_PER_BYTE && state.index < payload.length) {
    payload[state.index++] = (state.bitBuffer >> (state.bitCount - BITS_PER_BYTE)) & 0xFF
    state.bitCount -= BITS_PER_BYTE
    if (state.bitCount > 0) {
      state.bitBuffer &= (1 << state.bitCount) - 1
    } else {
      state.bitBuffer = 0
    }
  }
}

// --- Anchor rendering ---

// Draw an anchor pattern at (originX, originY) into RGBA imageData
export function renderAnchor(imageData, width, originX, originY) {
  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 8; bx++) {
      const val = ANCHOR_PATTERN[by][bx] ? 255 : 0
      const startX = originX + bx * BLOCK_SIZE
      const startY = originY + by * BLOCK_SIZE
      for (let dy = 0; dy < BLOCK_SIZE; dy++) {
        for (let dx = 0; dx < BLOCK_SIZE; dx++) {
          const px = startX + dx
          const py = startY + dy
          if (px >= 0 && px < width) {
            const i = (py * width + px) * 4
            imageData[i] = val
            imageData[i + 1] = val
            imageData[i + 2] = val
            // Alpha already set to 255
          }
        }
      }
    }
  }
}

// --- Data region geometry ---

// Get the data region bounds for a frame of given dimensions
export function getDataRegion(width, height) {
  return {
    x: MARGIN_SIZE,
    y: MARGIN_SIZE,
    w: width - 2 * MARGIN_SIZE,
    h: height - 2 * MARGIN_SIZE
  }
}

function getDenseBinaryHeaderBandRows(headerCellsX) {
  return Math.max(
    DENSE_BINARY_MIN_HEADER_BAND_ROWS,
    Math.ceil((HEADER_SIZE * BITS_PER_BYTE) / Math.max(1, headerCellsX))
  )
}

// Calculate payload capacity in bytes (binary modulation: 8 data-blocks per byte)
export function getPayloadCapacity(width, height, mode = HDMI_MODE.COMPAT_4) {
  if (isDenseBinaryMode(mode)) {
    const dr = getDataRegion(width, height)
    const payloadBlockSize = getDenseBinaryPayloadBlockSize(mode)
    const headerCellsX = Math.floor(dr.w / DENSE_BINARY_HEADER_BLOCK_SIZE)
    const headerBandRows = getDenseBinaryHeaderBandRows(headerCellsX)
    const payloadW = dr.w - 2 * DENSE_BINARY_REF_STRIP_PX
    const payloadH = dr.h - headerBandRows * DENSE_BINARY_HEADER_BLOCK_SIZE
    const edgeGuardCells = getDenseBinaryPayloadEdgeGuardCells(mode)
    const payloadCellsX = Math.max(0, Math.floor(payloadW / payloadBlockSize) - edgeGuardCells * 2)
    const payloadCellsY = Math.floor(payloadH / payloadBlockSize)
    const bitsPerCell = getModeBitsPerBlock(mode) || 1
    return Math.max(0, Math.floor((payloadCellsX * payloadCellsY * bitsPerCell) / BITS_PER_BYTE))
  }

  const dataBlockSize = getModePayloadBlockSize(mode)
  const bitsPerBlock = getModeBitsPerBlock(mode)
  if (!dataBlockSize || !bitsPerBlock) return 0
  const dr = getDataRegion(width, height)
  const blocksX = Math.floor(dr.w / dataBlockSize)
  const blocksY = Math.floor(dr.h / dataBlockSize)
  const payloadBlocks = getUsablePayloadBlocks(mode, blocksX, blocksY)
  return Math.max(0, Math.floor((payloadBlocks * bitsPerBlock) / BITS_PER_BYTE))
}

// Native-geometry guidance string used by the sender's resample warning. Tested
// here because hdmi-uvc-frame.js is the module that test runners import.
export function buildNativeGeometryGuidance() {
  return [
    'Native 1080p required for dense modes. Checklist:',
    '  1. Sender display mode: 1920x1080 @ 60',
    '  2. Browser fullscreen: real 1920x1080',
    '  3. Canvas internal: 1920x1080',
    '  4. Canvas CSS size: 1920x1080',
    '  5. Browser zoom: 100%',
    '  6. OS display scaling: off / true 1080p output',
    '  7. No CSS transform on canvas',
    '  8. image-rendering: pixelated'
  ].join('\n')
}

export function isNative1080pGeometry(metrics) {
  if (!hasEffectiveOneToOnePresentation(metrics)) return false
  return !!metrics &&
    metrics.renderPresetId === '1080p' &&
    metrics.width === 1920 &&
    metrics.height === 1080 &&
    (metrics.displayX || 0) === 0 &&
    (metrics.displayY || 0) === 0 &&
    metrics.fullscreenActive === true
}

export function hasEffectiveOneToOnePresentation(metrics) {
  const dpr = metrics?.devicePixelRatio || 1
  const physicalWidth = Number.isFinite(metrics?.physicalDisplayWidth)
    ? metrics.physicalDisplayWidth
    : Math.round((metrics?.displayWidth || 0) * dpr)
  const physicalHeight = Number.isFinite(metrics?.physicalDisplayHeight)
    ? metrics.physicalDisplayHeight
    : Math.round((metrics?.displayHeight || 0) * dpr)
  const effectiveScale = Number.isFinite(metrics?.effectiveDisplayScale)
    ? metrics.effectiveDisplayScale
    : Math.min(
      metrics?.width ? physicalWidth / metrics.width : 0,
      metrics?.height ? physicalHeight / metrics.height : 0
    )

  return !!metrics &&
    Math.abs(physicalWidth - metrics.width) <= 2 &&
    Math.abs(physicalHeight - metrics.height) <= 2 &&
    Math.abs(effectiveScale - 1) <= 0.002
}

export function classifyStep(stepX, stepY) {
  const nearestX = Math.round(stepX)
  const nearestY = Math.round(stepY)
  const driftX = Math.abs(stepX - nearestX)
  const driftY = Math.abs(stepY - nearestY)
  const skew = Math.abs(stepX - stepY)

  if (skew > 0.10) return 'skewed'
  if (driftX > 0.05 || driftY > 0.05) return 'fractional'
  return 'integer'
}

function getBinaryPilotConfig(mode) {
  if (!ENABLE_BINARY_PILOTS || mode !== HDMI_MODE.COMPAT_4) return null
  return {
    spacing: BINARY_PILOT_SPACING,
    offsetX: BINARY_PILOT_OFFSET,
    offsetY: BINARY_PILOT_OFFSET
  }
}

function getPilotBit(config, bx, by) {
  const gx = Math.floor((bx - config.offsetX) / config.spacing)
  const gy = Math.floor((by - config.offsetY) / config.spacing)
  return (gx + gy) & 1
}

function isPilotBlock(mode, bx, by, blockIdx) {
  const config = getBinaryPilotConfig(mode)
  if (!config || blockIdx < HEADER_BLOCKS) return false
  if (bx < config.offsetX || by < config.offsetY) return false
  return ((bx - config.offsetX) % config.spacing === 0) &&
    ((by - config.offsetY) % config.spacing === 0)
}

function countPilotBlocks(mode, blocksX, blocksY) {
  const config = getBinaryPilotConfig(mode)
  if (!config) return 0

  let count = 0
  for (let by = config.offsetY; by < blocksY; by += config.spacing) {
    for (let bx = config.offsetX; bx < blocksX; bx += config.spacing) {
      const blockIdx = by * blocksX + bx
      if (blockIdx >= HEADER_BLOCKS) count++
    }
  }
  return count
}

function getReservedPayloadCells(mode) {
  return mode === HDMI_MODE.RAW_RGB ? RGB3_PILOT_SYMBOLS.length : 0
}

function getUsablePayloadBlocks(mode, blocksX, blocksY) {
  const totalBlocks = blocksX * blocksY
  const payloadBlocks = Math.max(0, totalBlocks - HEADER_BLOCKS)
  return Math.max(0, payloadBlocks - countPilotBlocks(mode, blocksX, blocksY) - getReservedPayloadCells(mode))
}

function gcd(a, b) {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y !== 0) {
    const next = x % y
    x = y
    y = next
  }
  return x || 1
}

function choosePayloadInterleaveStride(count) {
  if (count < 2) return 1

  let stride = Math.max(1, Math.floor(count * 0.61803398875))
  while (stride > 1 && gcd(stride, count) !== 1) {
    stride--
  }
  return Math.max(1, stride)
}

function getPayloadCellOrder(mode, blocksX, blocksY) {
  const cacheKey = `${mode}:${blocksX}x${blocksY}:${ENABLE_PAYLOAD_INTERLEAVING ? 1 : 0}`
  const cached = payloadCellOrderCache.get(cacheKey)
  if (cached) return cached

  const cells = []
  let blockIdx = 0
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      if (blockIdx >= HEADER_BLOCKS && !isPilotBlock(mode, bx, by, blockIdx)) {
        cells.push({ bx, by })
      }
      blockIdx++
    }
  }

  if (!ENABLE_PAYLOAD_INTERLEAVING || mode !== HDMI_MODE.COMPAT_4 || cells.length < 2) {
    payloadCellOrderCache.set(cacheKey, cells)
    return cells
  }

  const stride = choosePayloadInterleaveStride(cells.length)
  const interleaved = new Array(cells.length)
  for (let logicalIdx = 0; logicalIdx < cells.length; logicalIdx++) {
    interleaved[logicalIdx] = cells[(logicalIdx * stride) % cells.length]
  }

  payloadCellOrderCache.set(cacheKey, interleaved)
  return interleaved
}

// --- Header serialization ---

export function buildHeader(mode, width, height, fps, symbolId, payloadLength, payloadCrc) {
  const header = new ArrayBuffer(HEADER_SIZE)
  const view = new DataView(header)
  view.setUint32(0, FRAME_MAGIC, false)
  view.setUint8(4, mode)
  view.setUint16(5, width, false)
  view.setUint16(7, height, false)
  view.setUint8(9, fps)
  view.setUint32(10, symbolId, false)
  view.setUint32(14, payloadLength, false)
  view.setUint32(18, payloadCrc, false)
  return new Uint8Array(header)
}

export function parseHeader(data) {
  if (data.length < HEADER_SIZE) return null
  const MAGIC_BYTES = [0xFF, 0x00, 0xFF, 0x00]
  const TOLERANCE = 0 // exact match — prevents 1-bit-shifted [0xFE,0x01] from passing as [0xFF,0x00]
  for (let i = 0; i < 4; i++) {
    if (Math.abs(data[i] - MAGIC_BYTES[i]) > TOLERANCE) return null
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const mode = view.getUint8(4)
  if (!getModeHeaderBlockSize(mode) || !getModePayloadBlockSize(mode)) return null
  const width = view.getUint16(5, false)
  const height = view.getUint16(7, false)
  if (width < 100 || width > 8000 || height < 100 || height > 8000) return null
  const payloadLength = view.getUint32(14, false)
  if (payloadLength === 0 || payloadLength > width * height * 3) return null
  return {
    magic: FRAME_MAGIC,
    mode,
    width,
    height,
    fps: view.getUint8(9),
    symbolId: view.getUint32(10, false),
    payloadLength,
    payloadCrc: view.getUint32(18, false)
  }
}

// --- Frame building (sender) ---

export function initializeFrameBuffer(imageData, width, height) {
  imageData.fill(0)
  for (let i = 3; i < imageData.length; i += 4) {
    imageData[i] = 255
  }

  renderAnchor(imageData, width, 0, 0)                                      // top-left
  renderAnchor(imageData, width, width - ANCHOR_SIZE, 0)                    // top-right
  renderAnchor(imageData, width, 0, height - ANCHOR_SIZE)                   // bottom-left
  renderAnchor(imageData, width, width - ANCHOR_SIZE, height - ANCHOR_SIZE) // bottom-right
}

export function createFrameBuffer(width, height) {
  const imageData = new Uint8ClampedArray(width * height * 4)
  initializeFrameBuffer(imageData, width, height)
  return imageData
}

function buildDenseBinaryFrame(payload, mode, width, height, fps, symbolId, targetBuffer = null, edgeGuardOverride = null) {
  const payloadCrc = crc32(payload)
  const headerBytes = buildHeader(mode, width, height, fps, symbolId, payload.length, payloadCrc)
  const payloadBlockSize = getDenseBinaryPayloadBlockSize(mode)

  const expectedLength = width * height * 4
  const imageData = targetBuffer && targetBuffer.length === expectedLength
    ? targetBuffer
    : createFrameBuffer(width, height)

  const dr = getDataRegion(width, height)
  fillRectSolid(imageData, width, dr.x, dr.y, dr.w, dr.h, 0, 0, 0)

  const headerCellsX = Math.floor(dr.w / DENSE_BINARY_HEADER_BLOCK_SIZE)
  const headerBandRows = getDenseBinaryHeaderBandRows(headerCellsX)
  const headerBandHeightPx = headerBandRows * DENSE_BINARY_HEADER_BLOCK_SIZE
  const totalHeaderBits = headerCellsX * headerBandRows
  const totalHeaderBytes = Math.ceil(totalHeaderBits / BITS_PER_BYTE)
  const paddedHeader = new Uint8Array(totalHeaderBytes)
  paddedHeader.set(headerBytes, 0)
  for (let i = headerBytes.length; i < totalHeaderBytes; i++) {
    paddedHeader[i] = DENSE_BINARY_HEADER_PAD_BYTE
  }

  let bitIdx = 0
  let byteIdx = 0
  for (let by = 0; by < headerBandRows; by++) {
    for (let bx = 0; bx < headerCellsX; bx++) {
      const bit = (paddedHeader[byteIdx] >> (7 - bitIdx)) & 1
      const val = bit ? 255 : 0
      fillBlockSolid(
        imageData,
        width,
        dr.x + bx * DENSE_BINARY_HEADER_BLOCK_SIZE,
        dr.y + by * DENSE_BINARY_HEADER_BLOCK_SIZE,
        DENSE_BINARY_HEADER_BLOCK_SIZE,
        val,
        val,
        val
      )
      bitIdx++
      if (bitIdx >= BITS_PER_BYTE) {
        bitIdx = 0
        byteIdx++
      }
    }
  }

  const payloadBandHeight = Math.max(0, dr.h - headerBandHeightPx)
  const stripRows = Math.floor(payloadBandHeight / DENSE_BINARY_HEADER_BLOCK_SIZE)
  const rightStripX = dr.x + dr.w - DENSE_BINARY_REF_STRIP_PX
  const isLuma1 = isDenseLuma1Mode(mode)
  for (let row = 0; row < stripRows; row++) {
    const y = dr.y + headerBandHeightPx + row * DENSE_BINARY_HEADER_BLOCK_SIZE
    if (isLuma1) {
      renderLuma1ReferenceStrip(imageData, width, dr.x, y, DENSE_BINARY_REF_STRIP_PX, DENSE_BINARY_HEADER_BLOCK_SIZE, false)
      renderLuma1ReferenceStrip(imageData, width, rightStripX, y, DENSE_BINARY_REF_STRIP_PX, DENSE_BINARY_HEADER_BLOCK_SIZE, true)
    } else {
      const leftVal = (row & 1) ? 255 : 0
      const rightVal = leftVal ? 0 : 255
      fillRectSolid(imageData, width, dr.x, y, DENSE_BINARY_REF_STRIP_PX, DENSE_BINARY_HEADER_BLOCK_SIZE, leftVal, leftVal, leftVal)
      fillRectSolid(imageData, width, rightStripX, y, DENSE_BINARY_REF_STRIP_PX, DENSE_BINARY_HEADER_BLOCK_SIZE, rightVal, rightVal, rightVal)
    }
  }

  const payloadX = dr.x + DENSE_BINARY_REF_STRIP_PX
  const payloadY = dr.y + headerBandHeightPx
  const payloadW = dr.w - 2 * DENSE_BINARY_REF_STRIP_PX
  const edgeGuardCells = getDenseBinaryPayloadEdgeGuardCells(mode, edgeGuardOverride)
  const payloadCellsX = Math.max(0, Math.floor(payloadW / payloadBlockSize) - edgeGuardCells * 2)
  const payloadCellsY = Math.floor(payloadBandHeight / payloadBlockSize)
  const payloadDataX = payloadX + edgeGuardCells * payloadBlockSize
  const rightGuardX = payloadDataX + payloadCellsX * payloadBlockSize
  const bitsPerPayloadCell = getModeBitsPerBlock(mode) || 1
  const payloadBitLength = payload.length * BITS_PER_BYTE
  let payloadBitPos = 0

  for (let cy = 0; cy < payloadCellsY; cy++) {
    let firstVal = 0
    let lastVal = 0
    for (let cx = 0; cx < payloadCellsX; cx++) {
      const symbol = payloadBitPos < payloadBitLength ? extractBits(payload, payloadBitPos, bitsPerPayloadCell) : 0
      payloadBitPos += bitsPerPayloadCell
      const val = isLuma1 ? encodeLuma1Symbol(symbol) : (symbol ? 255 : 0)
      if (cx === 0) firstVal = val
      lastVal = val
      fillBlockSolid(
        imageData,
        width,
        payloadDataX + cx * payloadBlockSize,
        payloadY + cy * payloadBlockSize,
        payloadBlockSize,
        val,
        val,
        val
      )
    }
    if (edgeGuardCells > 0 && payloadCellsX > 0) {
      const rowY = payloadY + cy * payloadBlockSize
      fillRectSolid(
        imageData,
        width,
        payloadX,
        rowY,
        edgeGuardCells * payloadBlockSize,
        payloadBlockSize,
        firstVal,
        firstVal,
        firstVal
      )
      fillRectSolid(
        imageData,
        width,
        rightGuardX,
        rowY,
        edgeGuardCells * payloadBlockSize,
        payloadBlockSize,
        lastVal,
        lastVal,
        lastVal
      )
    }
  }

  return imageData
}

// Build a complete frame: static background/anchors plus header + payload blocks.
// When `targetBuffer` is provided, it must already contain the initialized static
// frame base (black background, alpha=255, anchors).
export function buildFrame(payload, mode, width, height, fps, symbolId, targetBuffer = null) {
  if (isDenseBinaryMode(mode)) {
    return buildDenseBinaryFrame(payload, mode, width, height, fps, symbolId, targetBuffer)
  }

  const headerBlockSize = getModeHeaderBlockSize(mode)
  const payloadBlockSize = getModePayloadBlockSize(mode)
  const dataBlockSize = payloadBlockSize
  const bitsPerBlock = getModeBitsPerBlock(mode)
  if (!headerBlockSize || !payloadBlockSize || !bitsPerBlock) {
    throw new Error(`Unsupported HDMI-UVC mode: ${mode}`)
  }
  const payloadCrc = crc32(payload)
  const headerBytes = buildHeader(mode, width, height, fps, symbolId, payload.length, payloadCrc)

  const expectedLength = width * height * 4
  const imageData = targetBuffer && targetBuffer.length === expectedLength
    ? targetBuffer
    : createFrameBuffer(width, height)

  // Fill data region with mode-sized blocks. The HDMI header remains binary for
  // robust lock; some modes carry more than 1 bit per payload block.
  const dr = getDataRegion(width, height)
  const blocksX = Math.floor(dr.w / dataBlockSize)
  const blocksY = Math.floor(dr.h / dataBlockSize)
  const payloadCells = getPayloadCellOrder(mode, blocksX, blocksY)
  const reservedPayloadCells = getReservedPayloadCells(mode)
  let headerByteIdx = 0
  let headerBitIdx = 0
  let payloadBitPos = 0
  const payloadBitLength = payload.length * BITS_PER_BYTE

  let blockIdx = 0
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      let r = 0
      let g = 0
      let b = 0
      if (blockIdx < HEADER_BLOCKS) {
        let val = 0
        if (headerByteIdx < headerBytes.length) {
          val = (headerBytes[headerByteIdx] >> (7 - headerBitIdx)) & 1 ? 255 : 0
        }
        r = val
        g = val
        b = val
        headerBitIdx++
        if (headerBitIdx >= 8) {
          headerBitIdx = 0
          headerByteIdx++
        }
      } else if (isPilotBlock(mode, bx, by, blockIdx)) {
        const val = getPilotBit(getBinaryPilotConfig(mode), bx, by) ? 255 : 0
        r = val
        g = val
        b = val
      }

      // Fill the mode-specific data block.
      const blockSize = blockIdx < HEADER_BLOCKS ? headerBlockSize : payloadBlockSize
      const startX = dr.x + bx * blockSize
      const startY = dr.y + by * blockSize
      fillBlockSolid(imageData, width, startX, startY, blockSize, r, g, b)
      blockIdx++
    }
  }

  if (mode === HDMI_MODE.RAW_RGB) {
    for (let cellIdx = 0; cellIdx < reservedPayloadCells && cellIdx < payloadCells.length; cellIdx++) {
      const { bx, by } = payloadCells[cellIdx]
      const [r, g, b] = encodeRgb3(RGB3_PILOT_SYMBOLS[cellIdx])
      const startX = dr.x + bx * dataBlockSize
      const startY = dr.y + by * dataBlockSize
      fillBlockSolid(imageData, width, startX, startY, dataBlockSize, r, g, b)
    }
  }

  for (let cellIdx = reservedPayloadCells; cellIdx < payloadCells.length && payloadBitPos < payloadBitLength; cellIdx++) {
    const { bx, by } = payloadCells[cellIdx]
    const symbol = extractBits(payload, payloadBitPos, bitsPerBlock)
    payloadBitPos += bitsPerBlock
    const startX = dr.x + bx * dataBlockSize
    const startY = dr.y + by * dataBlockSize

    let r = 0
    let g = 0
    let b = 0
    if (mode === HDMI_MODE.RAW_RGB) {
      [r, g, b] = encodeRgb3(symbol)
      fillBlockSolid(imageData, width, startX, startY, dataBlockSize, r, g, b)
      continue
    }
    if (mode === HDMI_MODE.GLYPH_5) {
      renderGlyph5Block(imageData, width, startX, startY, dataBlockSize, symbol)
      continue
    }
    if (mode === HDMI_MODE.CODEBOOK_3) {
      renderCodebook3Block(imageData, width, startX, startY, dataBlockSize, symbol)
      continue
    }
    if (mode === HDMI_MODE.LUMA_2) {
      renderLuma2Block(imageData, width, startX, startY, dataBlockSize, symbol)
      continue
    } else {
      const val = bitsPerBlock === 2 ? encodeGray2(symbol) : (symbol ? 255 : 0)
      r = val
      g = val
      b = val
    }

    fillBlockSolid(imageData, width, startX, startY, dataBlockSize, r, g, b)
  }

  return imageData
}

// --- Anchor detection (receiver) ---

// Sample a single pixel's R value at integer coordinates
function samplePixel(imageData, width, x, y) {
  return imageData[(y * width + x) * 4]
}


function sampleBlockRgbAt(imageData, width, px, py, bs) {
  const cx = Math.round(px + bs / 2) - 1
  const cy = Math.round(py + bs / 2) - 1
  const sums = [0, 0, 0]
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const i = ((cy + dy) * width + (cx + dx)) * 4
      sums[0] += imageData[i]
      sums[1] += imageData[i + 1]
      sums[2] += imageData[i + 2]
    }
  }
  return [sums[0] / 4, sums[1] / 4, sums[2] / 4]
}

export function sampleCodebook3At(imageData, width, px, py, bs) {
  const xMid = px + bs / 2
  const yMid = py + bs / 2
  const quadrants = [
    [px, py, xMid, yMid],
    [xMid, py, px + bs, yMid],
    [px, yMid, xMid, py + bs],
    [xMid, yMid, px + bs, py + bs]
  ]

  return quadrants.map(([x0f, y0f, x1f, y1f]) => {
    const x0 = Math.max(0, Math.round(x0f))
    const y0 = Math.max(0, Math.round(y0f))
    const x1 = Math.min(width, Math.max(x0 + 1, Math.round(x1f)))
    const y1 = Math.min(imageData.length / (width * 4), Math.max(y0 + 1, Math.round(y1f)))
    let sum = 0
    let count = 0
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        sum += imageData[(y * width + x) * 4]
        count++
      }
    }
    return count > 0 ? sum / count : 0
  })
}

export function sampleGlyph5At(imageData, width, px, py, bs) {
  const imgHeight = imageData.length / (width * 4)
  const samples = new Array(GLYPH5_GRID_SIZE * GLYPH5_GRID_SIZE)

  for (let row = 0; row < GLYPH5_GRID_SIZE; row++) {
    const y0 = Math.max(0, Math.round(py + (row * bs) / GLYPH5_GRID_SIZE))
    const y1 = Math.min(imgHeight, Math.max(y0 + 1, Math.round(py + ((row + 1) * bs) / GLYPH5_GRID_SIZE)))
    for (let col = 0; col < GLYPH5_GRID_SIZE; col++) {
      const x0 = Math.max(0, Math.round(px + (col * bs) / GLYPH5_GRID_SIZE))
      const x1 = Math.min(width, Math.max(x0 + 1, Math.round(px + ((col + 1) * bs) / GLYPH5_GRID_SIZE)))
      let sum = 0
      let count = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += imageData[(y * width + x) * 4]
          count++
        }
      }
      samples[row * GLYPH5_GRID_SIZE + col] = count > 0 ? sum / count : 0
    }
  }

  return samples
}

function sampleBinaryPilotField(imageData, width, region, rx, ry, stepX, stepY, bs, blocksX, blocksY, mode) {
  const config = getBinaryPilotConfig(mode)
  if (!config) return null

  const imgHeight = imageData.length / (width * 4)
  const rows = []
  let blackSum = 0
  let whiteSum = 0
  let blackCount = 0
  let whiteCount = 0

  for (let by = config.offsetY; by < blocksY; by += config.spacing) {
    const row = []
    for (let bx = config.offsetX; bx < blocksX; bx += config.spacing) {
      const blockIdx = by * blocksX + bx
      if (blockIdx < HEADER_BLOCKS) {
        row.push(null)
        continue
      }

      const px = rx + Math.round(bx * stepX)
      const py = ry + Math.round(by * stepY)
      let sample = 0
      if (px >= 0 && px < width && py >= 0 && py < imgHeight) {
        sample = sampleBlockAt(imageData, width, px, py, bs)
      }

      const bit = getPilotBit(config, bx, by)
      row.push({ bit, sample })
      if (bit) {
        whiteSum += sample
        whiteCount++
      } else {
        blackSum += sample
        blackCount++
      }
    }
    rows.push(row)
  }

  return {
    config,
    rows,
    cols: rows[0]?.length || 0,
    rowCount: rows.length,
    globalBlackLevel: blackCount > 0 ? blackSum / blackCount : 0,
    globalWhiteLevel: whiteCount > 0 ? whiteSum / whiteCount : 255
  }
}

function estimateBinaryPilotLevelsAt(field, bx, by, fallbackBlack = 0, fallbackWhite = 255) {
  if (!field || field.rowCount === 0 || field.cols === 0) {
    return { blackLevel: fallbackBlack, whiteLevel: fallbackWhite }
  }

  const { config, rows, cols, rowCount } = field
  const gx = (bx - config.offsetX) / config.spacing
  const gy = (by - config.offsetY) / config.spacing
  const centerX = Math.round(gx)
  const centerY = Math.round(gy)
  let blackSum = 0
  let whiteSum = 0
  let blackWeight = 0
  let whiteWeight = 0

  for (let py = Math.max(0, centerY - 1); py <= Math.min(rowCount - 1, centerY + 1); py++) {
    for (let px = Math.max(0, centerX - 1); px <= Math.min(cols - 1, centerX + 1); px++) {
      const sample = rows[py]?.[px]
      if (!sample) continue

      const weight = 1 / (1 + Math.abs(px - gx) + Math.abs(py - gy))
      if (sample.bit) {
        whiteSum += sample.sample * weight
        whiteWeight += weight
      } else {
        blackSum += sample.sample * weight
        blackWeight += weight
      }
    }
  }

  return {
    blackLevel: blackWeight > 0 ? blackSum / blackWeight : (field.globalBlackLevel ?? fallbackBlack),
    whiteLevel: whiteWeight > 0 ? whiteSum / whiteWeight : (field.globalWhiteLevel ?? fallbackWhite)
  }
}

function binaryConfidence(value, threshold) {
  return Math.min(128, Math.abs(value - threshold)) | 0
}

function buildPaddedDenseBinaryHeader(header, headerCellsX) {
  const headerBandRows = getDenseBinaryHeaderBandRows(headerCellsX)
  const totalHeaderBits = headerCellsX * headerBandRows
  const totalHeaderBytes = Math.ceil(totalHeaderBits / BITS_PER_BYTE)
  const paddedHeader = new Uint8Array(totalHeaderBytes)
  const headerBytes = buildHeader(
    header.mode,
    header.width,
    header.height,
    header.fps,
    header.symbolId,
    header.payloadLength,
    header.payloadCrc
  )
  paddedHeader.set(headerBytes, 0)
  for (let i = headerBytes.length; i < totalHeaderBytes; i++) {
    paddedHeader[i] = DENSE_BINARY_HEADER_PAD_BYTE
  }
  return { paddedHeader, headerBandRows }
}

function estimateDenseBinaryLevelsFromHeader(imageData, width, rx, ry, stepX, stepY, bs, headerCellsX, header) {
  const { paddedHeader, headerBandRows } = buildPaddedDenseBinaryHeader(header, headerCellsX)
  const imgHeight = imageData.length / (width * 4)
  let blackSum = 0
  let blackCount = 0
  let whiteSum = 0
  let whiteCount = 0
  let bitIdx = 0
  let byteIdx = 0

  for (let by = 0; by < headerBandRows; by++) {
    for (let bx = 0; bx < headerCellsX; bx++) {
      const px = rx + Math.round(bx * stepX)
      const py = ry + Math.round(by * stepY)
      let val = 0
      if (px >= 0 && px < width && py >= 0 && py < imgHeight) {
        val = sampleBlockAt(imageData, width, px, py, bs)
      }
      const expected = (paddedHeader[byteIdx] >> (7 - bitIdx)) & 1
      if (expected) {
        whiteSum += val
        whiteCount++
      } else {
        blackSum += val
        blackCount++
      }
      bitIdx++
      if (bitIdx >= BITS_PER_BYTE) {
        bitIdx = 0
        byteIdx++
      }
    }
  }

  return {
    blackLevel: blackCount > 0 ? blackSum / blackCount : 0,
    whiteLevel: whiteCount > 0 ? whiteSum / whiteCount : 255
  }
}

function fillMissingDenseBinaryReferenceRows(levels, fallback) {
  const { rowBlackLevels, rowWhiteLevels } = levels
  for (let i = 0; i < rowBlackLevels.length; i++) {
    if (!Number.isFinite(rowBlackLevels[i])) {
      const prev = i > 0 ? rowBlackLevels[i - 1] : NaN
      const next = i + 1 < rowBlackLevels.length ? rowBlackLevels[i + 1] : NaN
      rowBlackLevels[i] = Number.isFinite(prev) ? prev : (Number.isFinite(next) ? next : fallback.blackLevel)
    }
    if (!Number.isFinite(rowWhiteLevels[i])) {
      const prev = i > 0 ? rowWhiteLevels[i - 1] : NaN
      const next = i + 1 < rowWhiteLevels.length ? rowWhiteLevels[i + 1] : NaN
      rowWhiteLevels[i] = Number.isFinite(prev) ? prev : (Number.isFinite(next) ? next : fallback.whiteLevel)
    }
  }
}

function sampleDenseBinaryReferenceRows(imageData, width, region, rx, ry, stepX, stepY, bs, headerCellsX, header) {
  const headerBandRows = getDenseBinaryHeaderBandRows(headerCellsX)
  const headerBandHeightCapture = headerBandRows * stepY
  const payloadStartY = ry + headerBandHeightCapture
  const payloadEndX = rx + region.w - stepX * DENSE_BINARY_REF_STRIP_WIDTH_4X4
  const stripRows = Math.max(0, Math.floor((region.h - headerBandHeightCapture) / stepY))
  const rowBlackLevels = new Float32Array(stripRows)
  const rowWhiteLevels = new Float32Array(stripRows)
  rowBlackLevels.fill(NaN)
  rowWhiteLevels.fill(NaN)

  const imgHeight = imageData.length / (width * 4)
  for (let row = 0; row < stripRows; row++) {
    const y = payloadStartY + Math.round(row * stepY)
    let leftVal = NaN
    let rightVal = NaN
    if (y >= 0 && y < imgHeight) {
      if (rx >= 0 && rx < width) leftVal = sampleBlockAt(imageData, width, rx, y, bs)
      if (payloadEndX >= 0 && payloadEndX < width) rightVal = sampleBlockAt(imageData, width, payloadEndX, y, bs)
    }
    if (!Number.isFinite(leftVal) || !Number.isFinite(rightVal)) continue
    if (row & 1) {
      rowWhiteLevels[row] = leftVal
      rowBlackLevels[row] = rightVal
    } else {
      rowBlackLevels[row] = leftVal
      rowWhiteLevels[row] = rightVal
    }
  }

  const headerLevels = estimateDenseBinaryLevelsFromHeader(
    imageData,
    width,
    rx,
    ry,
    stepX,
    stepY,
    bs,
    headerCellsX,
    header
  )
  fillMissingDenseBinaryReferenceRows({ rowBlackLevels, rowWhiteLevels }, headerLevels)

  return {
    rowBlackLevels,
    rowWhiteLevels,
    headerLevels,
    headerBandRows,
    headerBandHeightCapture,
    stripRows
  }
}

export function precomputeDenseBinarySampleOffsets(layout, region) {
  const payloadBlockSize = getDenseBinaryPayloadBlockSize(layout.frameMode)
  const headerStepX = layout.headerStepX || (layout.stepX * (DENSE_BINARY_HEADER_BLOCK_SIZE / payloadBlockSize))
  const headerStepY = layout.headerStepY || (layout.stepY * (DENSE_BINARY_HEADER_BLOCK_SIZE / payloadBlockSize))
  const headerBlocksX = layout.headerBlocksX || Math.floor(region.w / headerStepX)
  const headerBandRows = getDenseBinaryHeaderBandRows(headerBlocksX)
  const stripWidthCapture = headerStepX * DENSE_BINARY_REF_STRIP_WIDTH_4X4
  const edgeGuardCells = getDenseBinaryPayloadEdgeGuardCells(layout.frameMode, layout.payloadEdgeGuardCells)
  const payloadPhaseX = layout.payloadPhaseX || 0
  const payloadStepX = layout.stepX || (headerStepX * (payloadBlockSize / DENSE_BINARY_HEADER_BLOCK_SIZE))
  const payloadStepY = layout.stepY || (headerStepY * (payloadBlockSize / DENSE_BINARY_HEADER_BLOCK_SIZE))
  const payloadStartX = region.x + (layout.xOff || 0) + stripWidthCapture + edgeGuardCells * payloadStepX + payloadPhaseX
  const payloadStartY = region.y + (layout.yOff || 0) + headerBandRows * headerStepY
  const payloadW = region.w - 2 * stripWidthCapture - 2 * edgeGuardCells * payloadStepX
  const payloadH = region.h - headerBandRows * headerStepY
  const cellsX = Math.max(0, Math.floor(payloadW / payloadStepX))
  const cellsY = Math.max(0, Math.floor(payloadH / payloadStepY))
  const offsets = new Int32Array(2 * cellsX * cellsY)
  let i = 0

  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      offsets[i++] = payloadStartX + Math.round(cx * payloadStepX)
      offsets[i++] = payloadStartY + Math.round(cy * payloadStepY)
    }
  }

  return {
    offsets,
    cellsX,
    cellsY,
    region: {
      x: region.x,
      y: region.y,
      w: region.w,
      h: region.h
    }
  }
}

function getRegionSafePrecomputedOffsets(layout, region, explicitOffsets = null) {
  const offsets = explicitOffsets || layout?.precomputedOffsets || null
  if (!offsets) return null

  const precomputedRegion = layout?.precomputedRegion
  if (!precomputedRegion) return offsets

  return precomputedRegion.x === region.x &&
    precomputedRegion.y === region.y &&
    precomputedRegion.w === region.w &&
    precomputedRegion.h === region.h
    ? offsets
    : null
}

function getImageDataBytes(imageData) {
  return imageData?.data || imageData
}

function sampleBinary2PayloadCellFast(imageData, width, height, px, py) {
  if (px < 0 || py < 0 || px + 1 >= width || py + 1 >= height) return NaN
  const base = ((py * width) + px) * 4
  const rowStride = width * 4
  return (
    imageData[base] +
    imageData[base + 4] +
    imageData[base + rowStride] +
    imageData[base + rowStride + 4]
  ) * 0.25
}

function sampleBinary2ReferenceThreshold(imageData, width, height, leftX, rightX, y, bs, fallbackThreshold) {
  let leftVal = NaN
  let rightVal = NaN
  if (y >= 0 && y < height) {
    if (leftX >= 0 && leftX < width) leftVal = sampleBlockAt(imageData, width, leftX, y, bs)
    if (rightX >= 0 && rightX < width) rightVal = sampleBlockAt(imageData, width, rightX, y, bs)
  }
  return Number.isFinite(leftVal) && Number.isFinite(rightVal)
    ? (leftVal + rightVal) * 0.5
    : fallbackThreshold
}

function sampleDenseReferenceLevels(imageData, width, height, leftX, rightX, y, bs, stripIdx, fallbackBlack, fallbackWhite) {
  let leftVal = NaN
  let rightVal = NaN
  if (y >= 0 && y < height) {
    if (leftX >= 0 && leftX < width) leftVal = sampleBlockAt(imageData, width, leftX, y, bs)
    if (rightX >= 0 && rightX < width) rightVal = sampleBlockAt(imageData, width, rightX, y, bs)
  }
  if (!Number.isFinite(leftVal) || !Number.isFinite(rightVal)) {
    return { black: fallbackBlack, white: fallbackWhite }
  }
  return (stripIdx & 1)
    ? { black: rightVal, white: leftVal }
    : { black: leftVal, white: rightVal }
}

function sampleLuma1ReferenceColumn(imageData, width, height, stripX, y, bs, column) {
  const x0 = Math.round(stripX + (column * bs) / LUMA1_LEVEL_COUNT)
  const x1 = Math.max(
    x0 + 1,
    Math.round(stripX + ((column + 1) * bs) / LUMA1_LEVEL_COUNT)
  )
  const y0 = Math.round(y)
  const y1 = Math.max(y0 + 1, Math.round(y + bs))
  let sum = 0
  let count = 0

  for (let py = Math.max(0, y0); py < Math.min(height, y1); py++) {
    for (let px = Math.max(0, x0); px < Math.min(width, x1); px++) {
      sum += imageData[(py * width + px) * 4]
      count++
    }
  }

  return count > 0 ? sum / count : NaN
}

// Raw strip readout: per-level averages of the ramp columns, NaN where the
// strip was unreadable. Diagnostics use this directly; the decode path runs
// it through default-filling + normalizeLuma1Levels below.
function measureLuma1ReferenceLevelsRaw(imageData, width, height, leftX, rightX, y, bs) {
  const sums = new Float32Array(LUMA1_LEVEL_COUNT)
  const counts = new Uint8Array(LUMA1_LEVEL_COUNT)

  for (let column = 0; column < LUMA1_LEVEL_COUNT; column++) {
    const leftVal = sampleLuma1ReferenceColumn(imageData, width, height, leftX, y, bs, column)
    if (Number.isFinite(leftVal)) {
      sums[column] += leftVal
      counts[column]++
    }

    const rightVal = sampleLuma1ReferenceColumn(imageData, width, height, rightX, y, bs, column)
    const rightLevel = LUMA1_LEVEL_COUNT - 1 - column
    if (Number.isFinite(rightVal)) {
      sums[rightLevel] += rightVal
      counts[rightLevel]++
    }
  }

  const raw = new Array(LUMA1_LEVEL_COUNT)
  for (let level = 0; level < LUMA1_LEVEL_COUNT; level++) {
    raw[level] = counts[level] > 0 ? sums[level] / counts[level] : NaN
  }
  return raw
}

function isLuma1LevelSetUsable(levels) {
  for (let i = 1; i < LUMA1_LEVEL_COUNT; i++) {
    if (!Number.isFinite(levels[i]) || !Number.isFinite(levels[i - 1])) return false
    if (levels[i] <= levels[i - 1] + 2) return false
  }
  return levels[LUMA1_LEVEL_COUNT - 1] - levels[0] >= 48
}

function sampleLuma1ReferenceLevels(imageData, width, height, leftX, rightX, y, bs, fallbackBlack, fallbackWhite) {
  const raw = measureLuma1ReferenceLevelsRaw(imageData, width, height, leftX, rightX, y, bs)
  const levels = getDefaultLuma1Levels(fallbackBlack, fallbackWhite)
  for (let level = 0; level < LUMA1_LEVEL_COUNT; level++) {
    if (Number.isFinite(raw[level])) levels[level] = raw[level]
  }
  return normalizeLuma1Levels(levels, fallbackBlack, fallbackWhite)
}

function readDenseBinary1PayloadLockedNativeGrid({
  imageData,
  width,
  height,
  offsets,
  offsetTranslateX,
  offsetTranslateY,
  payloadCellsX,
  payloadCellsY,
  payloadLength,
  headerStepY,
  payloadStepY,
  payloadStartY,
  rx,
  rightStripX,
  headerBs,
  fallbackThreshold,
  stripRows,
  stats = null
}) {
  if (isHdmiUvcWasmActive()) {
    try {
      const rowStarts = new Int32Array(payloadCellsY * 2)
      const thresholds = new Float32Array(payloadCellsY)
      let lastStripIdx = -1
      let threshold = fallbackThreshold
      for (let cy = 0; cy < payloadCellsY; cy++) {
        const stripIdx = Math.min(
          stripRows - 1,
          Math.max(0, Math.floor((cy * payloadStepY) / headerStepY))
        )
        if (stripIdx !== lastStripIdx) {
          const refY = payloadStartY + Math.round(stripIdx * headerStepY)
          threshold = sampleBinary2ReferenceThreshold(
            imageData,
            width,
            height,
            rx,
            rightStripX,
            refY,
            headerBs,
            fallbackThreshold
          )
          lastStripIdx = stripIdx
        }
        const rowOffsetIdx = cy * payloadCellsX * 2
        rowStarts[cy * 2] = offsets[rowOffsetIdx] + offsetTranslateX
        rowStarts[cy * 2 + 1] = offsets[rowOffsetIdx + 1] + offsetTranslateY
        thresholds[cy] = threshold
      }
      const wasmPayload = wasmPackBinary1Payload(
        imageData,
        width,
        height,
        rowStarts,
        thresholds,
        payloadCellsX,
        payloadCellsY,
        payloadLength
      )
      if (wasmPayload) {
        if (stats) stats.reader = 'binary1-wasm'
        return wasmPayload
      }
    } catch (_) {
      // Fall back to the JS byte packer if the WASM kernel is unavailable or rejects geometry.
    }
  }

  const payload = new Uint8Array(payloadLength)
  let bitBuffer = 0
  let bitCount = 0
  let byteIdx = 0
  let lastStripIdx = -1
  let threshold = fallbackThreshold

  for (let cy = 0; cy < payloadCellsY && byteIdx < payloadLength; cy++) {
    const stripIdx = Math.min(
      stripRows - 1,
      Math.max(0, Math.floor((cy * payloadStepY) / headerStepY))
    )
    if (stripIdx !== lastStripIdx) {
      const refY = payloadStartY + Math.round(stripIdx * headerStepY)
      threshold = sampleBinary2ReferenceThreshold(
        imageData,
        width,
        height,
        rx,
        rightStripX,
        refY,
        headerBs,
        fallbackThreshold
      )
      lastStripIdx = stripIdx
    }

    const rowOffsetIdx = cy * payloadCellsX * 2
    const rowX = offsets[rowOffsetIdx] + offsetTranslateX
    const rowY = offsets[rowOffsetIdx + 1] + offsetTranslateY
    if (rowX < 0 || rowY < 0 || rowY >= height) return null
    if (rowX + payloadCellsX - 1 >= width) return null

    let base = ((rowY * width) + rowX) * 4
    let cx = 0
    while (cx < payloadCellsX && byteIdx < payloadLength) {
      if (bitCount === 0 && cx + BITS_PER_BYTE <= payloadCellsX) {
        const fullBytes = Math.min(payloadLength - byteIdx, (payloadCellsX - cx) >> 3)
        for (let i = 0; i < fullBytes; i++) {
          payload[byteIdx++] =
            (imageData[base] >= threshold ? 0x80 : 0) |
            (imageData[base + 4] >= threshold ? 0x40 : 0) |
            (imageData[base + 8] >= threshold ? 0x20 : 0) |
            (imageData[base + 12] >= threshold ? 0x10 : 0) |
            (imageData[base + 16] >= threshold ? 0x08 : 0) |
            (imageData[base + 20] >= threshold ? 0x04 : 0) |
            (imageData[base + 24] >= threshold ? 0x02 : 0) |
            (imageData[base + 28] >= threshold ? 0x01 : 0)
          base += 32
        }
        cx += fullBytes * BITS_PER_BYTE
        continue
      }

      bitBuffer = (bitBuffer << 1) | (imageData[base] >= threshold ? 1 : 0)
      bitCount++
      base += 4
      cx++
      if (bitCount >= BITS_PER_BYTE) {
        payload[byteIdx++] = bitBuffer & 0xff
        bitBuffer = 0
        bitCount = 0
      }
    }
  }

  return byteIdx === payloadLength ? payload : null
}

function readDenseLuma1PayloadLockedNativeGrid({
  imageData,
  width,
  height,
  offsets,
  offsetTranslateX,
  offsetTranslateY,
  payloadCellsX,
  payloadCellsY,
  payloadLength,
  headerStepY,
  payloadStepY,
  payloadStartY,
  rx,
  rightStripX,
  headerBs,
  fallbackBlack,
  fallbackWhite,
  stripRows,
  nativeStep,
  stats = null
}) {
  if (isHdmiUvcWasmActive()) {
    try {
      // Same per-row prep as the JS path below (strips sampled from the
      // original frame), then the gather/deconvolve/classify/pack hot loop
      // runs in one WASM pass.
      const rowStarts = new Int32Array(payloadCellsY * 2)
      const rowParams = new Float64Array(payloadCellsY * 5)
      let lastStripIdx = -1
      let levels = getDefaultLuma1Levels(fallbackBlack, fallbackWhite)
      for (let cy = 0; cy < payloadCellsY; cy++) {
        const stripIdx = Math.min(
          stripRows - 1,
          Math.max(0, Math.floor((cy * payloadStepY) / headerStepY))
        )
        if (stripIdx !== lastStripIdx) {
          const refY = payloadStartY + Math.round(stripIdx * headerStepY)
          levels = sampleLuma1ReferenceLevels(
            imageData,
            width,
            height,
            rx,
            rightStripX,
            refY,
            headerBs,
            fallbackBlack,
            fallbackWhite
          )
          lastStripIdx = stripIdx
        }
        const rowOffsetIdx = cy * payloadCellsX * 2
        rowStarts[cy * 2] = offsets[rowOffsetIdx] + offsetTranslateX
        rowStarts[cy * 2 + 1] = offsets[rowOffsetIdx + 1] + offsetTranslateY
        const p = cy * 5
        rowParams[p] = (levels[0] + levels[1]) / 2
        rowParams[p + 1] = (levels[1] + levels[2]) / 2
        rowParams[p + 2] = (levels[2] + levels[3]) / 2
        rowParams[p + 3] = levels[0] + 6
        rowParams[p + 4] = levels[3] - 6
      }
      const wasmPayload = wasmReadLuma1Payload(
        imageData,
        width,
        height,
        rowStarts,
        rowParams,
        payloadCellsX,
        payloadCellsY,
        payloadLength,
        Math.max(1, Math.round(nativeStep || 1)),
        luma1SharpenLambda || 0
      )
      if (wasmPayload) {
        if (stats) stats.reader = 'luma1-wasm'
        return wasmPayload
      }
    } catch (_) {
      // Fall back to the JS reader if the WASM kernel is unavailable or rejects geometry.
    }
  }

  const payload = new Uint8Array(payloadLength)
  const pixelStep = Math.max(1, Math.round(nativeStep || 1))
  const byteStep = pixelStep * 4
  let byteIdx = 0
  let bitBuffer = 0
  let bitCount = 0
  let lastStripIdx = -1
  let black = fallbackBlack
  let white = fallbackWhite
  let lumaLevels = getDefaultLuma1Levels(fallbackBlack, fallbackWhite)

  for (let cy = 0; cy < payloadCellsY && byteIdx < payloadLength; cy++) {
    const stripIdx = Math.min(
      stripRows - 1,
      Math.max(0, Math.floor((cy * payloadStepY) / headerStepY))
    )
    if (stripIdx !== lastStripIdx) {
      const refY = payloadStartY + Math.round(stripIdx * headerStepY)
      lumaLevels = sampleLuma1ReferenceLevels(
        imageData,
        width,
        height,
        rx,
        rightStripX,
        refY,
        headerBs,
        fallbackBlack,
        fallbackWhite
      )
      lastStripIdx = stripIdx
    }

    const rowOffsetIdx = cy * payloadCellsX * 2
    const rowX = offsets[rowOffsetIdx] + offsetTranslateX
    const rowY = offsets[rowOffsetIdx + 1] + offsetTranslateY
    if (rowX < 0 || rowY < 0 || rowY >= height) return null
    const lastSampleX = rowX + (payloadCellsX - 1) * pixelStep
    if (lastSampleX >= width) return null

    let base = ((rowY * width) + rowX) * 4
    const lut = getLuma1ClassifyLut(lumaLevels)
    if (luma1SharpenLambda) {
      // Deconvolve the horizontal peaking before classification. Gather the
      // row, invert, then classify from the corrected buffer. The solve
      // returns floats that can stray a hair past the rails — clamp and
      // round before the table lookup.
      const rowBuf = getLuma1RowBuffer(payloadCellsX)
      let p = base
      for (let cx = 0; cx < payloadCellsX; cx++, p += byteStep) {
        rowBuf[cx] = imageData[p]
      }
      unsharpenLuma1Row(rowBuf, payloadCellsX, luma1SharpenLambda, lumaLevels[0] + 6, lumaLevels[3] - 6)
      for (let cx = 0; cx < payloadCellsX; cx++) {
        const v = rowBuf[cx]
        rowBuf[cx] = v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0
      }
      let cx = 0
      while (cx < payloadCellsX && byteIdx < payloadLength) {
        if (bitCount === 0 && cx + 4 <= payloadCellsX) {
          const fullBytes = Math.min(payloadLength - byteIdx, (payloadCellsX - cx) >> 2)
          for (let i = 0; i < fullBytes; i++) {
            payload[byteIdx++] =
              (lut[rowBuf[cx]] << 6) |
              (lut[rowBuf[cx + 1]] << 4) |
              (lut[rowBuf[cx + 2]] << 2) |
              lut[rowBuf[cx + 3]]
            cx += 4
          }
          continue
        }
        bitBuffer = (bitBuffer << 2) | lut[rowBuf[cx]]
        bitCount += 2
        cx++
        if (bitCount >= BITS_PER_BYTE) {
          payload[byteIdx++] = (bitBuffer >> (bitCount - BITS_PER_BYTE)) & 0xff
          bitCount -= BITS_PER_BYTE
          bitBuffer = bitCount > 0 ? (bitBuffer & ((1 << bitCount) - 1)) : 0
        }
      }
      continue
    }
    let cx = 0
    while (cx < payloadCellsX && byteIdx < payloadLength) {
      if (bitCount === 0 && cx + 4 <= payloadCellsX) {
        const fullBytes = Math.min(payloadLength - byteIdx, (payloadCellsX - cx) >> 2)
        for (let i = 0; i < fullBytes; i++) {
          payload[byteIdx++] =
            (lut[imageData[base]] << 6) |
            (lut[imageData[base + byteStep]] << 4) |
            (lut[imageData[base + byteStep * 2]] << 2) |
            lut[imageData[base + byteStep * 3]]
          base += byteStep * 4
        }
        cx += fullBytes * 4
        continue
      }

      bitBuffer = (bitBuffer << 2) | lut[imageData[base]]
      bitCount += 2
      base += byteStep
      cx++
      if (bitCount >= BITS_PER_BYTE) {
        payload[byteIdx++] = (bitBuffer >> (bitCount - BITS_PER_BYTE)) & 0xff
        bitCount -= BITS_PER_BYTE
        bitBuffer = bitCount > 0 ? (bitBuffer & ((1 << bitCount) - 1)) : 0
      }
    }
  }

  return byteIdx === payloadLength ? payload : null
}

function readDenseBinaryPayloadLockedNativeGrid({
  imageData,
  width,
  height,
  offsets,
  offsetTranslateX,
  offsetTranslateY,
  payloadCellsX,
  payloadCellsY,
  payloadLength,
  headerStepY,
  payloadStepY,
  payloadStartY,
  rx,
  rightStripX,
  headerBs,
  fallbackThreshold,
  stripRows,
  nativeStep,
  sampleMode = 'average'
}) {
  const payload = new Uint8Array(payloadLength)
  const rowStride = width * 4
  const useSinglePixel = sampleMode === 'single'
  const pixelStep = Math.max(1, Math.round(nativeStep || 1))
  const byteStep = pixelStep * 4
  let bitBuffer = 0
  let bitCount = 0
  let byteIdx = 0
  let lastStripIdx = -1
  let threshold4 = fallbackThreshold * 4

  for (let cy = 0; cy < payloadCellsY && byteIdx < payloadLength; cy++) {
    const stripIdx = Math.min(
      stripRows - 1,
      Math.max(0, Math.floor((cy * payloadStepY) / headerStepY))
    )
    if (stripIdx !== lastStripIdx) {
      const refY = payloadStartY + Math.round(stripIdx * headerStepY)
      threshold4 = sampleBinary2ReferenceThreshold(
        imageData,
        width,
        height,
        rx,
        rightStripX,
        refY,
        headerBs,
        fallbackThreshold
      ) * 4
      lastStripIdx = stripIdx
    }

    const rowOffsetIdx = cy * payloadCellsX * 2
    const rowX = offsets[rowOffsetIdx] + offsetTranslateX
    const rowY = offsets[rowOffsetIdx + 1] + offsetTranslateY
    if (rowX < 0 || rowY < 0) return null
    const lastSampleX = rowX + (payloadCellsX - 1) * pixelStep
    if (useSinglePixel) {
      if (lastSampleX >= width || rowY >= height) return null
    } else if (lastSampleX + 1 >= width || rowY + 1 >= height) {
      return null
    }

    let base = ((rowY * width) + rowX) * 4
    for (let cx = 0; cx < payloadCellsX && byteIdx < payloadLength;) {
      if (bitCount === 0 && cx + BITS_PER_BYTE <= payloadCellsX) {
        let value = 0
        for (let i = 0; i < BITS_PER_BYTE; i++) {
          let bit
          if (useSinglePixel) {
            bit = (imageData[base] * 4) >= threshold4 ? 1 : 0
          } else {
            const sum = imageData[base] +
              imageData[base + 4] +
              imageData[base + rowStride] +
              imageData[base + rowStride + 4]
            bit = sum >= threshold4 ? 1 : 0
          }
          value = (value << 1) | bit
          base += byteStep
        }
        payload[byteIdx++] = value
        cx += BITS_PER_BYTE
        continue
      }

      let bit
      if (useSinglePixel) {
        bit = (imageData[base] * 4) >= threshold4 ? 1 : 0
      } else {
        const sum = imageData[base] +
          imageData[base + 4] +
          imageData[base + rowStride] +
          imageData[base + rowStride + 4]
        bit = sum >= threshold4 ? 1 : 0
      }
      bitBuffer = (bitBuffer << 1) | bit
      bitCount++
      base += byteStep
      cx++
      if (bitCount >= BITS_PER_BYTE) {
        payload[byteIdx++] = bitBuffer & 0xff
        bitBuffer = 0
        bitCount = 0
      }
    }
  }

  return byteIdx === payloadLength ? payload : null
}

function readDenseBinaryPayloadLocked(imageData, width, region, layout, payloadLength, precomputedOffsets = null, options = {}) {
  const frameMode = layout?.frameMode ?? HDMI_MODE.COMPAT_4
  if (frameMode !== HDMI_MODE.BINARY_2 && frameMode !== HDMI_MODE.BINARY_1 && frameMode !== HDMI_MODE.LUMA_1) return null
  if (!payloadLength || payloadLength <= 0) return null

  const offsets = precomputedOffsets || layout?.precomputedOffsets || null
  if (!offsets) return null
  const precomputedRegion = layout?.precomputedRegion
  let offsetTranslateX = 0
  let offsetTranslateY = 0
  if (precomputedRegion) {
    if (precomputedRegion.w !== region.w || precomputedRegion.h !== region.h) return null
    offsetTranslateX = region.x - precomputedRegion.x
    offsetTranslateY = region.y - precomputedRegion.y
  }

  const payloadBlockSize = getDenseBinaryPayloadBlockSize(frameMode)
  const payloadStepX = layout.stepX
  const payloadStepY = layout.stepY
  const payloadBs = layout.dataBs || Math.min(payloadStepX, payloadStepY)
  if (!payloadStepX || !payloadStepY || Math.abs(payloadBs - payloadBlockSize) > 0.5) return null

  const rx = region.x + (layout.xOff || 0)
  const ry = region.y + (layout.yOff || 0)
  const headerStepX = layout.headerStepX || (payloadStepX * (DENSE_BINARY_HEADER_BLOCK_SIZE / payloadBlockSize))
  const headerStepY = layout.headerStepY || (payloadStepY * (DENSE_BINARY_HEADER_BLOCK_SIZE / payloadBlockSize))
  const headerBs = layout.headerBs || (payloadBs * (DENSE_BINARY_HEADER_BLOCK_SIZE / payloadBlockSize))
  if (!headerStepX || !headerStepY || !headerBs) return null

  const headerBlocksX = layout.headerBlocksX || Math.floor(region.w / headerStepX)
  const headerBandRows = getDenseBinaryHeaderBandRows(headerBlocksX)
  const headerBandHeightCapture = headerBandRows * headerStepY
  const stripWidthCapture = headerStepX * DENSE_BINARY_REF_STRIP_WIDTH_4X4
  const edgeGuardCells = getDenseBinaryPayloadEdgeGuardCells(frameMode, layout.payloadEdgeGuardCells)
  const payloadPhaseX = layout.payloadPhaseX || 0
  const payloadStartX = rx + stripWidthCapture + edgeGuardCells * payloadStepX + payloadPhaseX
  const payloadStartY = ry + headerBandHeightCapture
  const rightStripX = rx + region.w - stripWidthCapture
  const payloadEndX = rightStripX - edgeGuardCells * payloadStepX + payloadPhaseX
  const payloadCellsX = Math.max(0, Math.floor((payloadEndX - payloadStartX) / payloadStepX))
  const payloadCellsY = Math.max(0, Math.floor((region.h - headerBandHeightCapture) / payloadStepY))
  if (!payloadCellsX || !payloadCellsY) return null
  if (offsets.length < payloadCellsX * payloadCellsY * 2) return null

  const imgHeight = imageData.length / (width * 4)
  const fallbackBlack = layout.blackLevel ?? 0
  const fallbackWhite = layout.whiteLevel ?? 255
  const fallbackThreshold = (fallbackBlack + fallbackWhite) * 0.5
  const stripRows = Math.max(1, Math.floor((region.h - headerBandHeightCapture) / headerStepY))
  if (
    (Math.abs(payloadStepX - 2) < 0.01 || Math.abs(payloadStepX - 1) < 0.01) &&
    Math.abs(payloadStepY - payloadStepX) < 0.01 &&
    Number.isInteger(offsetTranslateX) &&
    Number.isInteger(offsetTranslateY)
  ) {
    const nativePayload = frameMode === HDMI_MODE.LUMA_1
      ? readDenseLuma1PayloadLockedNativeGrid({
          imageData,
          width,
          height: imgHeight,
          offsets,
          offsetTranslateX,
          offsetTranslateY,
          payloadCellsX,
          payloadCellsY,
          payloadLength,
          headerStepY,
          payloadStepY,
          payloadStartY,
          rx: rx + payloadPhaseX,
          rightStripX: rightStripX + payloadPhaseX,
          headerBs,
          fallbackBlack,
          fallbackWhite,
          stripRows,
          nativeStep: payloadStepX,
          stats: options.stats || null
        })
      : frameMode === HDMI_MODE.BINARY_1
      ? readDenseBinary1PayloadLockedNativeGrid({
          imageData,
          width,
          height: imgHeight,
          offsets,
          offsetTranslateX,
          offsetTranslateY,
          payloadCellsX,
          payloadCellsY,
          payloadLength,
          headerStepY,
          payloadStepY,
          payloadStartY,
          rx,
          rightStripX,
          headerBs,
          fallbackThreshold,
          stripRows,
          stats: options.stats || null
        })
      : readDenseBinaryPayloadLockedNativeGrid({
          imageData,
          width,
          height: imgHeight,
          offsets,
          offsetTranslateX,
          offsetTranslateY,
          payloadCellsX,
          payloadCellsY,
          payloadLength,
          headerStepY,
          payloadStepY,
          payloadStartY,
          rx,
          rightStripX,
          headerBs,
          fallbackThreshold,
          stripRows,
          nativeStep: payloadStepX,
          sampleMode: options.binary2SampleMode === 'single' ? 'single' : 'average'
        })
    if (nativePayload) {
      if (options.stats) {
        options.stats.reader ||= frameMode === HDMI_MODE.LUMA_1
          ? 'luma1-bytepack'
          : frameMode === HDMI_MODE.BINARY_1
          ? 'binary1-bytepack'
          : 'binary2-native-grid'
      }
      return nativePayload
    }
  }

  const payload = new Uint8Array(payloadLength)
  const decodeState = { index: 0, bitBuffer: 0, bitCount: 0 }
  const bitsPerPayloadCell = getModeBitsPerBlock(frameMode) || 1
  let lastStripIdx = -1
  let threshold = fallbackThreshold
  let black = fallbackBlack
  let white = fallbackWhite
  let lumaLevels = getDefaultLuma1Levels(fallbackBlack, fallbackWhite)

  for (let cy = 0; cy < payloadCellsY && decodeState.index < payloadLength; cy++) {
    const stripIdx = Math.min(
      stripRows - 1,
      Math.max(0, Math.floor((cy * payloadStepY) / headerStepY))
    )
    if (stripIdx !== lastStripIdx) {
      const refY = payloadStartY + Math.round(stripIdx * headerStepY)
      if (frameMode === HDMI_MODE.LUMA_1) {
        // Strip columns are payload-cell wide; follow the locked layout's
        // phase correction like the payload offsets do.
        lumaLevels = sampleLuma1ReferenceLevels(
          imageData,
          width,
          imgHeight,
          rx + payloadPhaseX,
          rightStripX + payloadPhaseX,
          refY,
          headerBs,
          fallbackBlack,
          fallbackWhite
        )
      } else {
        threshold = sampleBinary2ReferenceThreshold(
          imageData,
          width,
          imgHeight,
          rx,
          rightStripX,
          refY,
          headerBs,
          fallbackThreshold
        )
      }
      lastStripIdx = stripIdx
    }

    for (let cx = 0; cx < payloadCellsX && decodeState.index < payloadLength; cx++) {
      const offsetIdx = (cy * payloadCellsX + cx) * 2
      const px = offsets[offsetIdx] + offsetTranslateX
      const py = offsets[offsetIdx + 1] + offsetTranslateY
      const val = frameMode === HDMI_MODE.LUMA_1
        ? sampleBlockAt(imageData, width, px, py, payloadBs)
        : sampleBinary2PayloadCellFast(imageData, width, imgHeight, px, py)
      const symbol = frameMode === HDMI_MODE.LUMA_1
        ? decodeLuma1SymbolFromLevels(val, lumaLevels, black, white)
        : (val >= threshold ? 1 : 0)
      appendSymbolBits(payload, decodeState, symbol, bitsPerPayloadCell)
    }
  }

  return decodeState.index === payloadLength ? payload : null
}

// Diagnostics for a fully CRC-failed LUMA_1 decode. Cost is bounded (a few
// hundred strip samples + a sparse payload sweep) and it only runs after all
// phase/guard attempts already failed, so it never taxes the happy path.
function buildLuma1DecodeDebug({
  imageData,
  width,
  imgHeight,
  region,
  rx,
  ry,
  rightStripX,
  payloadStartY,
  headerStepX,
  headerStepY,
  headerBs,
  stripRows,
  payloadStepX,
  payloadStepY,
  payloadBs,
  payloadCellsY,
  stripWidthCapture,
  phases,
  mode,
  payloadLength
}) {
  const rowIndices = [...new Set([
    0,
    Math.max(0, Math.floor(stripRows / 2)),
    Math.max(0, stripRows - 1)
  ])]

  const strips = phases.map((phase) => ({
    phase,
    rows: rowIndices.map((stripIdx) => {
      const refY = payloadStartY + Math.round(stripIdx * headerStepY)
      const raw = measureLuma1ReferenceLevelsRaw(
        imageData,
        width,
        imgHeight,
        rx + phase,
        rightStripX + phase,
        refY,
        headerBs
      )
      return {
        row: stripIdx,
        raw: raw.map((v) => (Number.isFinite(v) ? Math.round(v) : -1)),
        usable: isLuma1LevelSetUsable(raw)
      }
    })
  }))

  // Sparse payload-band luma histogram at phase 0 / mode-default guard. Bin
  // width 4 keeps centroid resolution while staying log-friendly.
  const edgeGuardCells = getDenseBinaryPayloadEdgeGuardCells(mode)
  const payloadStartXBase = rx + stripWidthCapture + edgeGuardCells * payloadStepX
  const payloadEndX = rightStripX - edgeGuardCells * payloadStepX
  const payloadCellsX = Math.max(0, Math.floor((payloadEndX - payloadStartXBase) / payloadStepX))
  const hist = new Array(64).fill(0)
  let sampled = 0
  for (let cy = 0; cy < payloadCellsY; cy += 8) {
    const py = payloadStartY + Math.round(cy * payloadStepY)
    if (py < 0 || py >= imgHeight) continue
    for (let cx = 0; cx < payloadCellsX; cx += 8) {
      const px = payloadStartXBase + Math.round(cx * payloadStepX)
      if (px < 0 || px >= width) continue
      const val = sampleBlockAt(imageData, width, px, py, payloadBs)
      hist[Math.min(63, Math.max(0, val >> 2))]++
      sampled++
    }
  }

  // Peak summary: local maxima of the 3-bin-smoothed histogram. Four clean
  // peaks => channel preserves the levels and the bug is geometric; a smear
  // => the modulation itself is below the channel noise floor.
  const smooth = hist.map((_, i) =>
    (hist[i - 1] || 0) * 0.25 + hist[i] * 0.5 + (hist[i + 1] || 0) * 0.25
  )
  const minPeak = Math.max(4, sampled * 0.005)
  const peaks = []
  for (let i = 0; i < 64; i++) {
    if (smooth[i] < minPeak) continue
    if ((smooth[i - 1] || 0) > smooth[i] || (smooth[i + 1] || 0) > smooth[i]) continue
    const last = peaks[peaks.length - 1]
    if (last && i - last.bin <= 2) {
      if (smooth[i] > last.score) peaks[peaks.length - 1] = { bin: i, score: smooth[i], n: hist[i] }
      continue
    }
    peaks.push({ bin: i, score: smooth[i], n: hist[i] })
  }

  // Vertical edge profile across the static black-margin → header-band
  // boundary, averaged over columns whose first header block is white this
  // frame. The transition row(s) expose the capture's vertical kernel
  // directly: a hard step = vertically sharp; one intermediate value = 2-tap
  // blend (its level IS the blend weight); several = wider blur. Because the
  // structure is static, cross-frame mixing cannot show up here — payload
  // mixing with a sharp edge profile means temporal blending.
  let vEdge = null
  let vEdgeColumns = 0
  if (Number.isFinite(ry) && headerStepX > 0) {
    const profiles = []
    const headerMidY = Math.round(ry + headerStepY / 2)
    for (let k = 1; profiles.length < 24; k += 2) {
      const x = Math.round(rx + k * headerStepX + headerStepX / 2)
      if (x >= width || x >= rightStripX) break
      if (headerMidY < 0 || headerMidY >= imgHeight || ry - 3 < 0) break
      const inHeader = imageData[(headerMidY * width + x) * 4]
      const aboveMargin = imageData[((ry - 3) * width + x) * 4]
      if (inHeader <= 200 || aboveMargin >= 40) continue
      const profile = []
      for (let dy = -3; dy <= 4; dy++) {
        const y = ry + dy
        profile.push(y >= 0 && y < imgHeight ? imageData[(y * width + x) * 4] : -1)
      }
      profiles.push(profile)
    }
    vEdgeColumns = profiles.length
    if (profiles.length) {
      vEdge = profiles[0].map((_, i) =>
        Math.round(profiles.reduce((sum, p) => sum + p[i], 0) / profiles.length)
      )
    }
  }

  // Per-row-class / per-column-class purity: the fraction of payload samples
  // sitting within ±10 of a measured strip level, bucketed by (row mod k)
  // and (col mod k). A fixed-phase resampler with period k shows one clean
  // class and k-1 contaminated ones; uniform impurity across every k rules
  // out a positional phase structure. Column step 17 is coprime with all
  // tested k so each class is sampled evenly.
  let purityRows = null
  let purityCols = null
  let purityPhase = 0
  let refLevels = null
  for (const strip of strips) {
    const usableRow = strip.rows.find((row) => row.usable)
    if (usableRow) {
      refLevels = usableRow.raw
      purityPhase = strip.phase
      break
    }
  }
  if (refLevels) {
    const ks = [2, 3, 4, 5, 6, 7, 8]
    const pureCounts = ks.map((k) => ({ rows: new Array(k).fill(0), cols: new Array(k).fill(0) }))
    const totals = ks.map((k) => ({ rows: new Array(k).fill(0), cols: new Array(k).fill(0) }))
    for (let cy = 0; cy < payloadCellsY; cy++) {
      const py = payloadStartY + Math.round(cy * payloadStepY)
      if (py < 0 || py >= imgHeight) continue
      for (let cx = 0; cx < payloadCellsX; cx += 17) {
        const px = payloadStartXBase + Math.round(cx * payloadStepX) + purityPhase
        if (px < 0 || px >= width) continue
        const val = sampleBlockAt(imageData, width, px, py, payloadBs)
        const pure = refLevels.some((level) => Math.abs(val - level) <= 10)
        for (let i = 0; i < ks.length; i++) {
          const k = ks[i]
          totals[i].rows[cy % k]++
          totals[i].cols[cx % k]++
          if (pure) {
            pureCounts[i].rows[cy % k]++
            pureCounts[i].cols[cx % k]++
          }
        }
      }
    }
    const toPercent = (counts, total) => counts.map((n, i) =>
      total[i] > 0 ? Math.round((100 * n) / total[i]) : -1
    )
    purityRows = ks.map((k, i) => ({ k, pct: toPercent(pureCounts[i].rows, totals[i].rows) }))
    purityCols = ks.map((k, i) => ({ k, pct: toPercent(pureCounts[i].cols, totals[i].cols) }))
  }

  // Calibration analysis: if the sender transmits the fixed calibration
  // payload, every cell's true symbol is known, so errors and the mixing
  // fraction become direct measurements instead of inferences. Detection is
  // automatic — symbol match rate ≫ chance (25%) means this is a calibration
  // frame. Per cell we regress the blend fraction f against the row below
  // and above (v = (1-f)·own + f·neighbor) wherever the expected contrast is
  // large enough to make f well-conditioned.
  let cal = null
  if (refLevels && payloadLength > 0 && payloadCellsY > 1) {
    const expected = getLuma1CalibrationPayload(payloadLength)
    const bitLen = payloadLength * BITS_PER_BYTE
    const expectedLevelAt = (cy, cx) => {
      const bitPos = (cy * payloadCellsX + cx) * 2
      if (bitPos + 2 > bitLen) return -1
      const sym = (expected[bitPos >> 3] >> (6 - (bitPos & 7))) & 3
      return LUMA1_GRAY_SYMBOL_TO_LEVEL[sym]
    }
    const BANDS = 16
    const modKs = [2, 3, 4, 5, 6]
    const errMod = modKs.map((k) => ({ k, err: new Array(k).fill(0), n: new Array(k).fill(0) }))
    const errBands = { err: new Array(BANDS).fill(0), n: new Array(BANDS).fill(0) }
    // Per-band f samples; reported as medians. A mean would be contaminated
    // by the ~25% of cells whose other-side neighbor shares the level of the
    // true mixing partner.
    const fBelowSamples = Array.from({ length: BANDS }, () => [])
    const fAboveSamples = Array.from({ length: BANDS }, () => [])
    const fHist = new Array(14).fill(0)
    let match = 0
    let total = 0
    // Sharpening fit: deviation d = v − own regressed against the expected
    // horizontal/vertical Laplacians (ph = own − (L+R)/2, pv = own −
    // (A+B)/2). An unsharp-mask ISP gives d ≈ λh·ph + λv·pv with high R²,
    // and subtracting the fitted term predicts the corrected error rate.
    const sharpVals = []
    const sharpOwn = []
    const sharpPh = []
    const sharpPv = []

    for (let cy = 0; cy < payloadCellsY; cy++) {
      const py = payloadStartY + Math.round(cy * payloadStepY)
      if (py < 0 || py >= imgHeight) continue
      const band = Math.min(BANDS - 1, Math.floor((cy * BANDS) / payloadCellsY))
      for (let cx = 0; cx < payloadCellsX; cx += 17) {
        const ownLevel = expectedLevelAt(cy, cx)
        if (ownLevel < 0) continue
        const px = payloadStartXBase + Math.round(cx * payloadStepX) + purityPhase
        if (px < 0 || px >= width) continue
        const val = sampleBlockAt(imageData, width, px, py, payloadBs)
        let best = 0
        let bestDist = Infinity
        for (let level = 0; level < LUMA1_LEVEL_COUNT; level++) {
          const dist = Math.abs(val - refLevels[level])
          if (dist < bestDist) { bestDist = dist; best = level }
        }
        const ok = best === ownLevel
        total++
        if (ok) match++
        for (const entry of errMod) {
          entry.n[cy % entry.k]++
          if (!ok) entry.err[cy % entry.k]++
        }
        errBands.n[band]++
        if (!ok) errBands.err[band]++

        const own = refLevels[ownLevel]
        const belowLevel = cy + 1 < payloadCellsY ? expectedLevelAt(cy + 1, cx) : -1
        const aboveLevel = cy > 0 ? expectedLevelAt(cy - 1, cx) : -1
        // Direction discrimination requires the two vertical neighbors to
        // differ: when they share a level, mixing with either one looks
        // identical and would contaminate the opposite-direction estimate.
        const neighborsDiffer = belowLevel >= 0 && aboveLevel >= 0 &&
          Math.abs(refLevels[belowLevel] - refLevels[aboveLevel]) >= 60
        if (neighborsDiffer && Math.abs(refLevels[belowLevel] - own) >= 60) {
          const f = (val - own) / (refLevels[belowLevel] - own)
          fBelowSamples[band].push(f)
          const bin = Math.min(13, Math.max(0, Math.floor((f + 0.2) * 10)))
          fHist[bin]++
        }
        if (neighborsDiffer && Math.abs(refLevels[aboveLevel] - own) >= 60) {
          const f = (val - own) / (refLevels[aboveLevel] - own)
          fAboveSamples[band].push(f)
        }

        if (aboveLevel >= 0 && belowLevel >= 0 && cx > 0) {
          const leftLevel = expectedLevelAt(cy, cx - 1)
          const rightLevel = expectedLevelAt(cy, cx + 1)
          if (leftLevel >= 0 && rightLevel >= 0) {
            sharpVals.push(val)
            sharpOwn.push(ownLevel)
            sharpPh.push(own - (refLevels[leftLevel] + refLevels[rightLevel]) / 2)
            sharpPv.push(own - (refLevels[aboveLevel] + refLevels[belowLevel]) / 2)
          }
        }
      }
    }

    if (total > 500 && match / total > 0.45) {
      const pct = (err, n) => err.map((e, i) => (n[i] > 0 ? Math.round((100 * e) / n[i]) : -1))
      const fMedian = (samplesPerBand) => samplesPerBand.map((samples) => {
        if (samples.length < 8) return null
        samples.sort((a, b) => a - b)
        return Math.round(100 * samples[samples.length >> 1]) / 100
      })
      let sharpen = null
      if (sharpVals.length > 2000) {
        // Fit only on mid-level cells: rail cells (levels 0/3) clamp their
        // overshoot at 0/255, zeroing the deviation and biasing the slope.
        // Mid cells are also where all the classification errors live.
        let a = 0, b = 0, c = 0, e = 0, g = 0, dd = 0
        for (let i = 0; i < sharpVals.length; i++) {
          if (sharpOwn[i] === 0 || sharpOwn[i] === LUMA1_LEVEL_COUNT - 1) continue
          const d = sharpVals[i] - refLevels[sharpOwn[i]]
          a += sharpPh[i] * sharpPh[i]
          b += sharpPh[i] * sharpPv[i]
          c += sharpPv[i] * sharpPv[i]
          e += d * sharpPh[i]
          g += d * sharpPv[i]
          dd += d * d
        }
        const det = a * c - b * b
        if (det > 1e-3 && dd > 1e-3) {
          const lh = (e * c - g * b) / det
          const lv = (g * a - e * b) / det
          let residual = 0
          let errBefore = 0
          let errAfter = 0
          const railLo = refLevels[0] + 25
          const railHi = refLevels[LUMA1_LEVEL_COUNT - 1] - 25
          for (let i = 0; i < sharpVals.length; i++) {
            const own = refLevels[sharpOwn[i]]
            const d = sharpVals[i] - own
            const pred = lh * sharpPh[i] + lv * sharpPv[i]
            if (sharpOwn[i] !== 0 && sharpOwn[i] !== LUMA1_LEVEL_COUNT - 1) {
              residual += (d - pred) * (d - pred)
            }
            // Rail-adjacent raw values had their overshoot clamped away, so
            // applying the correction there would re-introduce it.
            const corrected = sharpVals[i] > railLo && sharpVals[i] < railHi
              ? sharpVals[i] - pred
              : sharpVals[i]
            let best = 0
            let bestDist = Infinity
            let bestRaw = 0
            let bestRawDist = Infinity
            for (let level = 0; level < LUMA1_LEVEL_COUNT; level++) {
              const dist = Math.abs(corrected - refLevels[level])
              if (dist < bestDist) { bestDist = dist; best = level }
              const rawDist = Math.abs(sharpVals[i] - refLevels[level])
              if (rawDist < bestRawDist) { bestRawDist = rawDist; bestRaw = level }
            }
            if (best !== sharpOwn[i]) errAfter++
            if (bestRaw !== sharpOwn[i]) errBefore++
          }
          // True post-correction floor: run the actual row deconvolution on
          // full contiguous rows (clamp pinning + boundary handling included)
          // and count classification errors before/after.
          let solve = null
          if (lh > 0.05) {
            const rowBuf = new Float32Array(payloadCellsX)
            const rawRow = new Float32Array(payloadCellsX)
            let sTotal = 0
            let sRawErr = 0
            let sSolvedErr = 0
            const classify = (value) => {
              let best = 0
              let bestDist = Infinity
              for (let level = 0; level < LUMA1_LEVEL_COUNT; level++) {
                const dist = Math.abs(value - refLevels[level])
                if (dist < bestDist) { bestDist = dist; best = level }
              }
              return best
            }
            for (let r = 0; r < 24; r++) {
              const cy = Math.floor(((r + 0.5) * payloadCellsY) / 24)
              const py = payloadStartY + Math.round(cy * payloadStepY)
              if (py < 0 || py >= imgHeight) continue
              for (let cx = 0; cx < payloadCellsX; cx++) {
                const px = payloadStartXBase + Math.round(cx * payloadStepX) + purityPhase
                rowBuf[cx] = px >= 0 && px < width
                  ? sampleBlockAt(imageData, width, px, py, payloadBs)
                  : 0
                rawRow[cx] = rowBuf[cx]
              }
              unsharpenLuma1Row(rowBuf, payloadCellsX, lh, refLevels[0] + 6, refLevels[LUMA1_LEVEL_COUNT - 1] - 6)
              for (let cx = 0; cx < payloadCellsX; cx++) {
                const ownLevel = expectedLevelAt(cy, cx)
                if (ownLevel < 0) continue
                sTotal++
                if (classify(rawRow[cx]) !== ownLevel) sRawErr++
                if (classify(rowBuf[cx]) !== ownLevel) sSolvedErr++
              }
            }
            if (sTotal > 1000) {
              solve = {
                raw: Math.round((1000 * sRawErr) / sTotal) / 10,
                solved: Math.round((1000 * sSolvedErr) / sTotal) / 10,
                n: sTotal
              }
            }
          }

          sharpen = {
            lh: Math.round(100 * lh) / 100,
            lv: Math.round(100 * lv) / 100,
            r2: Math.round(100 * (1 - residual / dd)) / 100,
            errBefore: Math.round((1000 * errBefore) / sharpVals.length) / 10,
            errAfter: Math.round((1000 * errAfter) / sharpVals.length) / 10,
            n: sharpVals.length,
            railHeadroom: getLuma1SharpenRailHeadroom(refLevels, lh),
            solve
          }
        }
      }

      cal = {
        match: Math.round((1000 * match) / total) / 10,
        total,
        errRowMod: errMod.map((entry) => ({ k: entry.k, pct: pct(entry.err, entry.n) })),
        errRowBands: pct(errBands.err, errBands.n),
        fBelowBands: fMedian(fBelowSamples),
        fAboveBands: fMedian(fAboveSamples),
        fHist,
        sharpen
      }
    }
  }

  return {
    strips,
    hist,
    sampled,
    peaks: peaks.map((p) => ({ v: p.bin * 4 + 2, n: p.n })),
    vEdge,
    vEdgeColumns,
    purityRows,
    purityCols,
    purityPhase,
    cal
  }
}

function readDenseBinaryPayload(
  imageData,
  width,
  region,
  rx,
  ry,
  headerStepX,
  headerStepY,
  headerBs,
  headerCellsX,
  header,
  options = {},
  precomputedOffsets = null
) {
  const payloadBlockSize = getDenseBinaryPayloadBlockSize(header.mode)
  const payloadStepX = headerStepX * (payloadBlockSize / DENSE_BINARY_HEADER_BLOCK_SIZE)
  const payloadStepY = headerStepY * (payloadBlockSize / DENSE_BINARY_HEADER_BLOCK_SIZE)
  const payloadBs = headerBs * (payloadBlockSize / DENSE_BINARY_HEADER_BLOCK_SIZE)
  const stripWidthCapture = headerStepX * DENSE_BINARY_REF_STRIP_WIDTH_4X4
  const ref = sampleDenseBinaryReferenceRows(
    imageData,
    width,
    region,
    rx,
    ry,
    headerStepX,
    headerStepY,
    headerBs,
    headerCellsX,
    header
  )
  const payloadStartY = ry + ref.headerBandHeightCapture
  const rightStripX = rx + region.w - stripWidthCapture
  const payloadCellsY = Math.max(0, Math.floor((region.h - ref.headerBandHeightCapture) / payloadStepY))
  const bitsPerPayloadCell = getModeBitsPerBlock(header.mode) || 1
  const imgHeight = imageData.length / (width * 4)

  const makeResult = (payloadPhaseX = 0, edgeGuardCells = getDenseBinaryPayloadEdgeGuardCells(header.mode)) => {
    const payloadStartXBase = rx + stripWidthCapture + edgeGuardCells * payloadStepX
    const payloadEndX = rightStripX - edgeGuardCells * payloadStepX
    const payloadCellsX = Math.max(0, Math.floor((payloadEndX - payloadStartXBase) / payloadStepX))
    const payload = new Uint8Array(header.payloadLength)
    const confidence = options.collectConfidence !== false && bitsPerPayloadCell === 1
      ? new Uint8Array(header.payloadLength * BITS_PER_BYTE)
      : null
    const decodeState = { index: 0, bitBuffer: 0, bitCount: 0 }
    let confidenceIdx = 0
    let measuredLumaLevels = null

    for (let cy = 0; cy < payloadCellsY && decodeState.index < header.payloadLength; cy++) {
      const stripIdx = Math.min(
        Math.max(0, ref.stripRows - 1),
        Math.max(0, Math.round((cy * payloadStepY) / headerStepY))
      )
      const black = header.mode === HDMI_MODE.LUMA_1
        ? ref.headerLevels.blackLevel
        : (Number.isFinite(ref.rowBlackLevels[stripIdx]) ? ref.rowBlackLevels[stripIdx] : ref.headerLevels.blackLevel)
      const white = header.mode === HDMI_MODE.LUMA_1
        ? ref.headerLevels.whiteLevel
        : (Number.isFinite(ref.rowWhiteLevels[stripIdx]) ? ref.rowWhiteLevels[stripIdx] : ref.headerLevels.whiteLevel)
      const threshold = (black + white) * 0.5
      // The ramp-strip columns are a single payload cell wide, so the strip
      // read must follow the same sub-cell phase correction as the payload
      // grid. Sampling them at the unphased rx is what produced garbage
      // centroids (and a silent linear fallback) whenever the header probe
      // settled one pixel off.
      const lumaLevels = header.mode === HDMI_MODE.LUMA_1
        ? sampleLuma1ReferenceLevels(
            imageData,
            width,
            imgHeight,
            rx + payloadPhaseX,
            rightStripX + payloadPhaseX,
            payloadStartY + Math.round(stripIdx * headerStepY),
            headerBs,
            black,
            white
          )
        : null
      if (lumaLevels && !measuredLumaLevels) measuredLumaLevels = lumaLevels

      if (header.mode === HDMI_MODE.LUMA_1 && luma1SharpenLambda) {
        // Deconvolve the dongle's horizontal peaking: gather the whole cell
        // row first (the solve needs full row context), invert, classify.
        const rowBuf = getLuma1RowBuffer(payloadCellsX)
        for (let cx = 0; cx < payloadCellsX; cx++) {
          const offsetIdx = (cy * payloadCellsX + cx) * 2
          const px = precomputedOffsets && offsetIdx + 1 < precomputedOffsets.length
            ? precomputedOffsets[offsetIdx] + payloadPhaseX
            : payloadStartXBase + Math.round(cx * payloadStepX) + payloadPhaseX
          const py = precomputedOffsets && offsetIdx + 1 < precomputedOffsets.length
            ? precomputedOffsets[offsetIdx + 1]
            : payloadStartY + Math.round(cy * payloadStepY)
          rowBuf[cx] = px >= 0 && px < width && py >= 0 && py < imgHeight
            ? sampleBlockAt(imageData, width, px, py, payloadBs)
            : 0
        }
        unsharpenLuma1Row(rowBuf, payloadCellsX, luma1SharpenLambda, lumaLevels[0] + 6, lumaLevels[3] - 6)
        for (let cx = 0; cx < payloadCellsX && decodeState.index < header.payloadLength; cx++) {
          const symbol = decodeLuma1SymbolFromLevels(rowBuf[cx], lumaLevels, black, white)
          appendSymbolBits(payload, decodeState, symbol, bitsPerPayloadCell)
        }
        continue
      }

      for (let cx = 0; cx < payloadCellsX && decodeState.index < header.payloadLength; cx++) {
        const offsetIdx = (cy * payloadCellsX + cx) * 2
        const px = precomputedOffsets && offsetIdx + 1 < precomputedOffsets.length
          ? precomputedOffsets[offsetIdx] + payloadPhaseX
          : payloadStartXBase + Math.round(cx * payloadStepX) + payloadPhaseX
        const py = precomputedOffsets && offsetIdx + 1 < precomputedOffsets.length
          ? precomputedOffsets[offsetIdx + 1]
          : payloadStartY + Math.round(cy * payloadStepY)

        let val = 0
        if (px >= 0 && px < width && py >= 0 && py < imgHeight) {
          val = sampleBlockAt(imageData, width, px, py, payloadBs)
        }
        const symbol = header.mode === HDMI_MODE.LUMA_1
          ? decodeLuma1SymbolFromLevels(val, lumaLevels, black, white)
          : (val >= threshold ? 1 : 0)
        if (confidence && confidenceIdx < confidence.length) {
          confidence[confidenceIdx++] = binaryConfidence(val, threshold)
        }
        appendSymbolBits(payload, decodeState, symbol, bitsPerPayloadCell)
      }
    }

    const actualCrc = crc32(payload)
    const levels = {
      blackLevel: ref.headerLevels.blackLevel,
      whiteLevel: ref.headerLevels.whiteLevel,
      rowBlackLevels: ref.rowBlackLevels,
      rowWhiteLevels: ref.rowWhiteLevels
    }
    const result = {
      header,
      payload,
      crcValid: actualCrc === header.payloadCrc,
      levels,
      _diag: {
        frameMode: header.mode,
        blocksX: payloadCellsX,
        blocksY: payloadCellsY,
        headerBlocksX: headerCellsX,
        headerBlocksY: Math.floor(region.h / headerStepY),
        dataBs: payloadBs,
        headerBs,
        stepX: payloadStepX,
        stepY: payloadStepY,
        headerStepX,
        headerStepY,
        xOff: rx - region.x,
        yOff: ry - region.y,
        payloadPhaseX,
        payloadEdgeGuardCells: edgeGuardCells,
        lumaLevels: measuredLumaLevels ? measuredLumaLevels.map((v) => Math.round(v)) : undefined,
        blackLevel: ref.headerLevels.blackLevel,
        whiteLevel: ref.headerLevels.whiteLevel,
        stripRows: ref.stripRows
      }
    }
    if (confidence) result.confidence = confidence
    return result
  }

  const phases = header.mode === HDMI_MODE.LUMA_1 && Number.isFinite(options.payloadPhaseX)
    ? [options.payloadPhaseX]
    : header.mode === HDMI_MODE.LUMA_1 ? [0, 1, -1, 2, -2] : [0]
  const guardOptions = header.mode === HDMI_MODE.LUMA_1 && Number.isFinite(options.payloadEdgeGuardCells)
    ? [options.payloadEdgeGuardCells]
    : header.mode === HDMI_MODE.LUMA_1 ? [LUMA1_EDGE_GUARD_CELLS, 0] : [0]

  // The ramp strips identify the most plausible phases up front: try phases
  // with a monotone strip readout first so a decodable frame passes CRC on
  // the first or second attempt instead of after several full-frame reads.
  // Phases are only reordered, never dropped — degraded strips can still
  // decode via the per-row fallback levels.
  let phaseOrder = phases
  if (header.mode === HDMI_MODE.LUMA_1 && phases.length > 1) {
    const rowsToCheck = [0, Math.max(0, Math.floor(ref.stripRows / 2))]
    const usable = new Set(phases.filter((phase) =>
      rowsToCheck.some((stripIdx) => isLuma1LevelSetUsable(
        measureLuma1ReferenceLevelsRaw(
          imageData,
          width,
          imgHeight,
          rx + phase,
          rightStripX + phase,
          payloadStartY + Math.round(stripIdx * headerStepY),
          headerBs
        )
      ))
    ))
    if (usable.size > 0 && usable.size < phases.length) {
      phaseOrder = luma1SweepBudgetFast
        ? phases.filter((phase) => usable.has(phase))
        : [
            ...phases.filter((phase) => usable.has(phase)),
            ...phases.filter((phase) => !usable.has(phase))
          ]
    } else if (luma1SweepBudgetFast) {
      phaseOrder = phases.slice(0, 1)
    }
  }
  const guardOrder = luma1SweepBudgetFast && guardOptions.length > 1
    ? guardOptions.slice(0, 1)
    : guardOptions

  let firstResult = null
  const sweepStartMs = luma1SweepTimeBudgetMs !== null ? performance.now() : 0
  let sweepTried = 0
  let sweepBudgetHit = false
  outer: for (const guardCells of guardOrder) {
    for (const phase of phaseOrder) {
      const result = makeResult(phase, guardCells)
      sweepTried++
      if (!firstResult) firstResult = result
      if (result.crcValid) return result
      if (
        luma1SweepTimeBudgetMs !== null &&
        header.mode === HDMI_MODE.LUMA_1 &&
        performance.now() - sweepStartMs > luma1SweepTimeBudgetMs
      ) {
        sweepBudgetHit = true
        break outer
      }
    }
  }

  // Every phase/guard combination failed CRC. Attach the channel evidence an
  // investigation needs: per-phase raw strip readouts (are the ramp strips
  // even readable, and at which phase?), a luma histogram of the payload
  // band (does the capture preserve four separable levels at all?), and a
  // vertical edge profile across the static margin→header boundary (is the
  // capture blending rows spatially? — payload mixing without edge blur
  // points at cross-frame mixing instead).
  if (header.mode === HDMI_MODE.LUMA_1 && firstResult) {
    firstResult._diag.sweepTried = sweepTried
    firstResult._diag.sweepBudgetHit = sweepBudgetHit
  }
  if (header.mode === HDMI_MODE.LUMA_1 && firstResult && luma1DebugCaptureEnabled) {
    firstResult._diag.lumaDebug = buildLuma1DecodeDebug({
      imageData,
      width,
      imgHeight,
      region,
      rx,
      ry,
      rightStripX,
      payloadStartY,
      headerStepX,
      headerStepY,
      headerBs,
      stripRows: ref.stripRows,
      payloadStepX,
      payloadStepY,
      payloadBs,
      payloadCellsY,
      stripWidthCapture,
      phases,
      mode: header.mode,
      payloadLength: header.payloadLength
    })
  }
  return firstResult
}


// --- Data region decoding (receiver) ---

// Read payload using binary modulation (8 blocks per byte, threshold at 128).
function readPayloadAt(
  imageData,
  width,
  region,
  rx,
  ry,
  stepX,
  stepY,
  bs,
  blocksX,
  header,
  expectedBlocksY = null,
  headerLayout = null,
  options = {},
  precomputedOffsets = null
) {
  if (isDenseBinaryMode(header.mode)) {
    const payloadBlockSize = getDenseBinaryPayloadBlockSize(header.mode)
    const headerSamplingLayout = headerLayout || {
      rx,
      ry,
      stepX: stepX * (DENSE_BINARY_HEADER_BLOCK_SIZE / payloadBlockSize),
      stepY: stepY * (DENSE_BINARY_HEADER_BLOCK_SIZE / payloadBlockSize),
      bs: bs * (DENSE_BINARY_HEADER_BLOCK_SIZE / payloadBlockSize),
      blocksX: Math.floor(region.w / (stepX * (DENSE_BINARY_HEADER_BLOCK_SIZE / payloadBlockSize)))
    }
    return readDenseBinaryPayload(
      imageData,
      width,
      region,
      headerSamplingLayout.rx,
      headerSamplingLayout.ry,
      headerSamplingLayout.stepX,
      headerSamplingLayout.stepY,
      headerSamplingLayout.bs,
      headerSamplingLayout.blocksX,
      header,
      options,
      precomputedOffsets
    )
  }

  const blocksY = expectedBlocksY ?? Math.floor(region.h / stepY)
  const bitsPerBlock = getModeBitsPerBlock(header.mode) || 1
  const payloadCells = getPayloadCellOrder(header.mode, blocksX, blocksY)
  const reservedPayloadCells = getReservedPayloadCells(header.mode)
  const headerSamplingLayout = headerLayout || {
    rx,
    ry,
    stepX,
    stepY,
    bs,
    blocksX,
    blocksY
  }
  const levels = header.mode === HDMI_MODE.RAW_RGB
    ? estimateRgbPayloadLevelsFromHeader(
      imageData,
      width,
      region,
      headerSamplingLayout.rx,
      headerSamplingLayout.ry,
      headerSamplingLayout.stepX,
      headerSamplingLayout.stepY,
      headerSamplingLayout.bs,
      headerSamplingLayout.blocksX,
      header,
      headerSamplingLayout.blocksY
    )
    : estimatePayloadLevelsFromHeader(
      imageData,
      width,
      region,
      headerSamplingLayout.rx,
      headerSamplingLayout.ry,
      headerSamplingLayout.stepX,
      headerSamplingLayout.stepY,
      headerSamplingLayout.bs,
      headerSamplingLayout.blocksX,
      header,
      headerSamplingLayout.blocksY
    )
  const pilotField = bitsPerBlock === 1
    ? sampleBinaryPilotField(imageData, width, region, rx, ry, stepX, stepY, bs, blocksX, blocksY, header.mode)
    : null
  const payload = new Uint8Array(header.payloadLength)
  const confidence = options.collectConfidence && bitsPerBlock === 1
    ? new Uint8Array(header.payloadLength * BITS_PER_BYTE)
    : null
  let confidenceIdx = 0
  const decodeState = { index: 0, bitBuffer: 0, bitCount: 0 }
  const height = imageData.length / (width * 4)

  // Phase 4 Task 4.3: batch classify COMPAT_4 (binary) and LUMA_2 cells in
  // WASM when the module is loaded. The per-cell JS branches stay as the
  // fallback for other modes (RAW_RGB, GLYPH_5, CODEBOOK_3, RAW_GRAY) and
  // whenever the WASM kernel throws. `preComputedSymbols` is a Uint8Array of
  // length (payloadCells.length - reservedPayloadCells); index 0 corresponds
  // to cellIdx = reservedPayloadCells.
  const isCompat4Binary = bitsPerBlock === 1 &&
    header.mode !== HDMI_MODE.RAW_RGB &&
    header.mode !== HDMI_MODE.GLYPH_5 &&
    header.mode !== HDMI_MODE.CODEBOOK_3 &&
    header.mode !== HDMI_MODE.LUMA_2
  const isLuma2 = header.mode === HDMI_MODE.LUMA_2
  let preComputedSymbols = null
  if (!confidence && (isCompat4Binary || isLuma2) && isHdmiUvcWasmActive()) {
    preComputedSymbols = batchClassifyPayloadCells({
      imageData, width, height,
      payloadCells, reservedPayloadCells,
      rx, ry, stepX, stepY, bs,
      mode: isCompat4Binary ? 'compat4' : 'luma2',
      levels, pilotField
    })
  }

  for (let cellIdx = reservedPayloadCells; cellIdx < payloadCells.length && decodeState.index < header.payloadLength; cellIdx++) {
    const { bx, by } = payloadCells[cellIdx]
    const px = rx + Math.round(bx * stepX)
    const py = ry + Math.round(by * stepY)
    let symbol = 0
    if (preComputedSymbols) {
      // WASM already handled sampling + classification. The per-cell bounds
      // check is baked into sample2x2R / sampleQuadrants which return 0 for
      // out-of-bounds centers — matching the JS default-symbol-0 behavior.
      symbol = preComputedSymbols[cellIdx - reservedPayloadCells]
    } else if (px >= 0 && px < width && py >= 0 && py < height) {
      if (header.mode === HDMI_MODE.RAW_RGB) {
        const rgb = sampleBlockRgbAt(imageData, width, px, py, bs)
        symbol = decodeRgb3(rgb, levels?.blackLevels, levels?.whiteLevels, levels?.rgbPalette)
      } else if (header.mode === HDMI_MODE.LUMA_2) {
        const samples = sampleCodebook3At(imageData, width, px, py, bs)
        symbol = decodeLuma2(samples, levels?.blackLevel, levels?.whiteLevel)
      } else if (header.mode === HDMI_MODE.GLYPH_5) {
        const samples = sampleGlyph5At(imageData, width, px, py, bs)
        symbol = decodeGlyph5(samples, levels?.blackLevel, levels?.whiteLevel)
      } else if (header.mode === HDMI_MODE.CODEBOOK_3) {
        const samples = sampleCodebook3At(imageData, width, px, py, bs)
        symbol = decodeCodebook3(samples, levels?.blackLevel, levels?.whiteLevel)
      } else if (bitsPerBlock === 2) {
        const val = sampleBlockAt(imageData, width, px, py, bs)
        symbol = decodeGray2(val, levels?.blackLevel, levels?.whiteLevel)
      } else {
        const val = sampleBlockAt(imageData, width, px, py, bs)
        const localLevels = pilotField
          ? estimateBinaryPilotLevelsAt(pilotField, bx, by, levels?.blackLevel, levels?.whiteLevel)
          : levels
        const threshold = ((localLevels?.blackLevel ?? 0) + (localLevels?.whiteLevel ?? 255)) * 0.5
        symbol = val >= threshold ? 1 : 0
        if (confidence && confidenceIdx < confidence.length) {
          confidence[confidenceIdx++] = binaryConfidence(val, threshold)
        }
      }
    }
    appendSymbolBits(payload, decodeState, symbol, bitsPerBlock)
  }

  const actualCrc = crc32(payload)
  const result = { header, payload, crcValid: actualCrc === header.payloadCrc, levels }
  if (confidence) result.confidence = confidence
  return result
}

// Pre-compute per-cell symbols for COMPAT_4 (binary) or LUMA_2 (4-level) by
// batching into the WASM classifier. Returns a Uint8Array or null on failure
// (or when the diagnostic toggle is off). Index 0 corresponds to
// payloadCells[reservedPayloadCells]; out-of-bounds cells are handled by the
// WASM sampler returning 0 (matches JS default). Total wall time is added
// to classifierMsAccumulator so the receiver can surface it in perf logs.
function batchClassifyPayloadCells({
  imageData, width, height, payloadCells, reservedPayloadCells,
  rx, ry, stepX, stepY, bs, mode, levels, pilotField
}) {
  if (!wasmClassifierEnabled) return null
  const n = payloadCells.length - reservedPayloadCells
  if (n <= 0) return null
  const start = classifierPerfNow()
  try {
    const cells = new Array(n)
    if (mode === 'compat4') {
      for (let i = 0; i < n; i++) {
        const cell = payloadCells[reservedPayloadCells + i]
        const px = rx + Math.round(cell.bx * stepX)
        const py = ry + Math.round(cell.by * stepY)
        const localLevels = pilotField
          ? estimateBinaryPilotLevelsAt(pilotField, cell.bx, cell.by, levels?.blackLevel, levels?.whiteLevel)
          : levels
        const threshold = ((localLevels?.blackLevel ?? 0) + (localLevels?.whiteLevel ?? 255)) * 0.5
        cells[i] = [px, py, bs, threshold]
      }
      try {
        return wasmClassifyCompat4Cells(imageData, width, height, cells)
      } catch (_) {
        return null
      }
    }
    // mode === 'luma2'
    const black = levels?.blackLevel ?? 0
    const white = levels?.whiteLevel ?? 255
    for (let i = 0; i < n; i++) {
      const cell = payloadCells[reservedPayloadCells + i]
      const px = rx + Math.round(cell.bx * stepX)
      const py = ry + Math.round(cell.by * stepY)
      cells[i] = [px, py, bs, black, white]
    }
    try {
      return wasmClassifyLuma2Cells(imageData, width, height, cells)
    } catch (_) {
      return null
    }
  } finally {
    classifierMsAccumulator += classifierPerfNow() - start
  }
}

// Read a fixed payload length from a known-good grid layout without relying on a
// newly decoded HDMI header. Used after session lock, where inner packet CRCs can
// validate individual packets even if the outer frame header is damaged.
export function readPayloadWithLayout(imageData, width, region, layout, payloadLength, precomputedOffsets = null, options = {}) {
  if (!layout || !payloadLength || payloadLength <= 0) return null

  const imageBytes = getImageDataBytes(imageData)
  if (!imageBytes) return null

  const blocksX = layout.blocksX
  const blocksY = layout.blocksY ?? Math.floor(region.h / layout.stepY)
  const frameMode = layout.frameMode ?? HDMI_MODE.COMPAT_4
  if (!blocksX || !blocksY) return null

  const rx = region.x + (layout.xOff || 0)
  const ry = region.y + (layout.yOff || 0)
  const bitsPerBlock = layout.bitsPerBlock || 1

  if (isDenseBinaryMode(frameMode)) {
    const payloadBlockSize = getDenseBinaryPayloadBlockSize(frameMode)
    const headerStepX = layout.headerStepX || (layout.stepX * (DENSE_BINARY_HEADER_BLOCK_SIZE / payloadBlockSize))
    const headerStepY = layout.headerStepY || (layout.stepY * (DENSE_BINARY_HEADER_BLOCK_SIZE / payloadBlockSize))
    const headerBs = layout.headerBs || (layout.dataBs * (DENSE_BINARY_HEADER_BLOCK_SIZE / payloadBlockSize))
    const headerBlocksX = layout.headerBlocksX || Math.floor(region.w / headerStepX)
    const header = {
      mode: frameMode,
      width: layout.frameWidth ?? 0,
      height: layout.frameHeight ?? 0,
      fps: layout.fps ?? 0,
      symbolId: 0,
      payloadLength,
      payloadCrc: 0
    }
    const safePrecomputedOffsets = getRegionSafePrecomputedOffsets(layout, region, precomputedOffsets)
    const lockedBinary2Offsets = precomputedOffsets || layout.precomputedOffsets || null
    const lockedDenseBinaryPayload = readDenseBinaryPayloadLocked(
      imageBytes,
      width,
      region,
      layout,
      payloadLength,
      lockedBinary2Offsets,
      options
    )
    if (lockedDenseBinaryPayload) return lockedDenseBinaryPayload

    const result = readDenseBinaryPayload(
      imageBytes,
      width,
      region,
      rx,
      ry,
      headerStepX,
      headerStepY,
      headerBs,
      headerBlocksX,
      header,
      {
        collectConfidence: false,
        ...options,
        payloadPhaseX: layout.payloadPhaseX || 0,
        payloadEdgeGuardCells: getDenseBinaryPayloadEdgeGuardCells(frameMode, layout.payloadEdgeGuardCells)
      },
      safePrecomputedOffsets
    )
    return result?.payload?.length === payloadLength ? result.payload : null
  }

  const payloadCells = getPayloadCellOrder(frameMode, blocksX, blocksY)
  const reservedPayloadCells = getReservedPayloadCells(frameMode)
  const pilotField = bitsPerBlock === 1
    ? sampleBinaryPilotField(
      imageBytes,
      width,
      region,
      rx,
      ry,
      layout.stepX,
      layout.stepY,
      layout.dataBs,
      blocksX,
      blocksY,
      frameMode
    )
    : null
  const rgbPalette = frameMode === HDMI_MODE.RAW_RGB
    ? (() => {
      const palette = []
      const pilotCount = Math.min(RGB3_PILOT_SYMBOLS.length, payloadCells.length)
      for (let i = 0; i < pilotCount; i++) {
        const { bx, by } = payloadCells[i]
        const px = rx + Math.round(bx * layout.stepX)
        const py = ry + Math.round(by * layout.stepY)
        let rgb = RGB3_PALETTE[i]
        if (px >= 0 && px < width && py >= 0 && py < imageBytes.length / (width * 4)) {
          rgb = sampleBlockRgbAt(imageBytes, width, px, py, layout.dataBs)
        }
        palette.push(normalizeRgbSample(rgb, layout.blackLevels, layout.whiteLevels))
      }
      while (palette.length < RGB3_PILOT_SYMBOLS.length) {
        palette.push(RGB3_NORMALIZED_PALETTE[palette.length])
      }
      return palette
    })()
    : null
  const payload = new Uint8Array(payloadLength)
  const decodeState = { index: 0, bitBuffer: 0, bitCount: 0 }
  const height = imageBytes.length / (width * 4)

  for (let cellIdx = reservedPayloadCells; cellIdx < payloadCells.length && decodeState.index < payloadLength; cellIdx++) {
    const { bx, by } = payloadCells[cellIdx]
    const px = rx + Math.round(bx * layout.stepX)
    const py = ry + Math.round(by * layout.stepY)
    let symbol = 0
    if (px >= 0 && px < width && py >= 0 && py < height) {
      if (frameMode === HDMI_MODE.RAW_RGB) {
        const rgb = sampleBlockRgbAt(imageBytes, width, px, py, layout.dataBs)
        symbol = decodeRgb3(rgb, layout.blackLevels, layout.whiteLevels, rgbPalette)
      } else if (frameMode === HDMI_MODE.LUMA_2) {
        const samples = sampleCodebook3At(imageBytes, width, px, py, layout.dataBs)
        symbol = decodeLuma2(samples, layout.blackLevel, layout.whiteLevel)
      } else if (frameMode === HDMI_MODE.GLYPH_5) {
        const samples = sampleGlyph5At(imageBytes, width, px, py, layout.dataBs)
        symbol = decodeGlyph5(samples, layout.blackLevel, layout.whiteLevel)
      } else if (frameMode === HDMI_MODE.CODEBOOK_3) {
        const samples = sampleCodebook3At(imageBytes, width, px, py, layout.dataBs)
        symbol = decodeCodebook3(samples, layout.blackLevel, layout.whiteLevel)
      } else if (bitsPerBlock === 2) {
        const val = sampleBlockAt(imageBytes, width, px, py, layout.dataBs)
        symbol = decodeGray2(val, layout.blackLevel, layout.whiteLevel)
      } else {
        const val = sampleBlockAt(imageBytes, width, px, py, layout.dataBs)
        const localLevels = pilotField
          ? estimateBinaryPilotLevelsAt(pilotField, bx, by, layout.blackLevel, layout.whiteLevel)
          : layout
        const threshold = ((localLevels?.blackLevel ?? 0) + (localLevels?.whiteLevel ?? 255)) * 0.5
        symbol = val >= threshold ? 1 : 0
      }
    }
    appendSymbolBits(payload, decodeState, symbol, bitsPerBlock)
  }

  return decodeState.index === payloadLength ? payload : null
}

// Score a candidate header: higher = better. CRC-valid candidates always win.
function scoreCandidate(result) {
  if (result.crcValid) return 10000
  let score = 0
  // Strongly prefer the original small-packet diagnostic shape (256 blockSize + packet header)
  if (result.header.payloadLength === 272) score += 1000
  else if (result.header.payloadLength > 0 && result.header.payloadLength <= 16384) score += 10
  return score
}

function getHeaderSpanMetrics(header, region) {
  const measuredFrameW = region.frameW || null
  const measuredFrameH = region.frameH || null
  return {
    measuredFrameW,
    measuredFrameH,
    decodedFrameW: header.width,
    decodedFrameH: header.height,
    decodedToMeasuredX: measuredFrameW ? header.width / measuredFrameW : null,
    decodedToMeasuredY: measuredFrameH ? header.height / measuredFrameH : null,
    measuredToDecodedX: measuredFrameW ? measuredFrameW / header.width : null,
    measuredToDecodedY: measuredFrameH ? measuredFrameH / header.height : null,
    geometryClass: classifyHeaderGeometry(header, region)
  }
}

function summarizeDecisionCandidate(result, region) {
  if (!result) return null
  const diag = result._diag || {}
  const metrics = getHeaderSpanMetrics(result.header, region)
  return {
    hypothesis: diag.hypothesis || 'base',
    refined: !!diag.refined,
    crcValid: !!result.crcValid,
    score: diag.score ?? scoreCandidate(result),
    mode: result.header.mode,
    width: result.header.width,
    height: result.header.height,
    fps: result.header.fps,
    symbolId: result.header.symbolId,
    payloadLength: result.header.payloadLength,
    xOff: diag.xOff,
    yOff: diag.yOff,
    payloadEdgeGuardCells: diag.payloadEdgeGuardCells,
    payloadPhaseX: diag.payloadPhaseX,
    dataBs: diag.dataBs,
    stepX: diag.stepX,
    stepY: diag.stepY,
    blocksX: diag.blocksX,
    blocksY: diag.blocksY,
    ...metrics
  }
}

function attachDecisionTrace(result, decision, region) {
  if (!result) return
  if (!result._diag) result._diag = {}
  result._diag.score ??= scoreCandidate(result)
  Object.assign(result._diag, getHeaderSpanMetrics(result.header, region))
  result._diag.decision = decision
}

// Read header bytes using binary modulation at given alignment.
// Returns parsed header or null. Reads HEADER_BLOCKS blocks, decodes 8 per byte.
function probeHeaderBinary(imageData, width, region, rx, ry, stepX, stepY, bs, blocksX, expectedBlocksY = null) {
  const headerBytes = new Uint8Array(HEADER_SIZE)
  let byteIdx = 0, bitIdx = 0, currentByte = 0
  const imgHeight = imageData.length / (width * 4)
  const blocksY = expectedBlocksY ?? Math.floor(region.h / stepY)

  for (let by = 0; by < blocksY && byteIdx < HEADER_SIZE; by++) {
    for (let bx = 0; bx < blocksX && byteIdx < HEADER_SIZE; bx++) {
      const px = rx + Math.round(bx * stepX)
      const py = ry + Math.round(by * stepY)
      let val = 0
      if (px >= 0 && px < width && py >= 0 && py < imgHeight) {
        val = sampleBlockAt(imageData, width, px, py, bs)
      }
      if (val > 128) currentByte |= (1 << (7 - bitIdx))
      bitIdx++
      if (bitIdx >= 8) {
        headerBytes[byteIdx++] = currentByte
        currentByte = 0
        bitIdx = 0
      }
    }
  }

  return parseHeader(headerBytes)
}

function estimatePayloadLevelsFromHeader(imageData, width, region, rx, ry, stepX, stepY, bs, blocksX, header, expectedBlocksY = null) {
  const headerBytes = buildHeader(
    header.mode,
    header.width,
    header.height,
    header.fps,
    header.symbolId,
    header.payloadLength,
    header.payloadCrc
  )
  let byteIdx = 0
  let bitIdx = 0
  const imgHeight = imageData.length / (width * 4)
  const blocksY = expectedBlocksY ?? Math.floor(region.h / stepY)
  let blackSum = 0
  let whiteSum = 0
  let blackCount = 0
  let whiteCount = 0

  for (let by = 0; by < blocksY && byteIdx < HEADER_SIZE; by++) {
    for (let bx = 0; bx < blocksX && byteIdx < HEADER_SIZE; bx++) {
      const px = rx + Math.round(bx * stepX)
      const py = ry + Math.round(by * stepY)
      let val = 0
      if (px >= 0 && px < width && py >= 0 && py < imgHeight) {
        val = sampleBlockAt(imageData, width, px, py, bs)
      }

      const expectedBit = (headerBytes[byteIdx] >> (7 - bitIdx)) & 1
      if (expectedBit) {
        whiteSum += val
        whiteCount++
      } else {
        blackSum += val
        blackCount++
      }

      bitIdx++
      if (bitIdx >= 8) {
        bitIdx = 0
        byteIdx++
      }
    }
  }

  return {
    blackLevel: blackCount > 0 ? blackSum / blackCount : 0,
    whiteLevel: whiteCount > 0 ? whiteSum / whiteCount : 255
  }
}

function estimateRgbPayloadLevelsFromHeader(imageData, width, region, rx, ry, stepX, stepY, bs, blocksX, header, expectedBlocksY = null) {
  const headerBytes = buildHeader(
    header.mode,
    header.width,
    header.height,
    header.fps,
    header.symbolId,
    header.payloadLength,
    header.payloadCrc
  )
  let byteIdx = 0
  let bitIdx = 0
  const imgHeight = imageData.length / (width * 4)
  const blocksY = expectedBlocksY ?? Math.floor(region.h / stepY)
  const blackSums = [0, 0, 0]
  const whiteSums = [0, 0, 0]
  let blackCount = 0
  let whiteCount = 0

  for (let by = 0; by < blocksY && byteIdx < HEADER_SIZE; by++) {
    for (let bx = 0; bx < blocksX && byteIdx < HEADER_SIZE; bx++) {
      const px = rx + Math.round(bx * stepX)
      const py = ry + Math.round(by * stepY)
      let rgb = [0, 0, 0]
      if (px >= 0 && px < width && py >= 0 && py < imgHeight) {
        rgb = sampleBlockRgbAt(imageData, width, px, py, bs)
      }

      const expectedBit = (headerBytes[byteIdx] >> (7 - bitIdx)) & 1
      if (expectedBit) {
        whiteSums[0] += rgb[0]
        whiteSums[1] += rgb[1]
        whiteSums[2] += rgb[2]
        whiteCount++
      } else {
        blackSums[0] += rgb[0]
        blackSums[1] += rgb[1]
        blackSums[2] += rgb[2]
        blackCount++
      }

      bitIdx++
      if (bitIdx >= 8) {
        bitIdx = 0
        byteIdx++
      }
    }
  }

  const blackLevels = blackCount > 0 ? blackSums.map((sum) => sum / blackCount) : [0, 0, 0]
  const whiteLevels = whiteCount > 0 ? whiteSums.map((sum) => sum / whiteCount) : [255, 255, 255]
  const payloadCells = getPayloadCellOrder(header.mode, blocksX, blocksY)
  const rgbPalette = []
  const pilotCount = Math.min(RGB3_PILOT_SYMBOLS.length, payloadCells.length)

  for (let i = 0; i < pilotCount; i++) {
    const { bx, by } = payloadCells[i]
    const px = rx + Math.round(bx * stepX)
    const py = ry + Math.round(by * stepY)
    let rgb = RGB3_PALETTE[i]
    if (px >= 0 && px < width && py >= 0 && py < imgHeight) {
      rgb = sampleBlockRgbAt(imageData, width, px, py, bs)
    }
    rgbPalette.push(normalizeRgbSample(rgb, blackLevels, whiteLevels))
  }

  while (rgbPalette.length < RGB3_PILOT_SYMBOLS.length) {
    rgbPalette.push(RGB3_NORMALIZED_PALETTE[rgbPalette.length])
  }

  return {
    blackLevels,
    whiteLevels,
    rgbPalette
  }
}

// Once a plausible header is found, derive a more precise capture scale from the
// measured frame span. This reduces horizontal drift across later header fields.
function refineCandidateFromHeader(imageData, width, region, header, rx, ry, hypothesis = 'base', options = {}) {
  if (!region.frameW || !region.frameH) return null
  if (header.width < 100 || header.height < 100) return null
  const headerBlockSize = getModeHeaderBlockSize(header.mode)
  const payloadBlockSize = getModePayloadBlockSize(header.mode)
  const bitsPerBlock = getModeBitsPerBlock(header.mode)
  if (!headerBlockSize || !payloadBlockSize || !bitsPerBlock) return null

  const headerBlocksX = Math.floor((header.width - 2 * MARGIN_SIZE) / headerBlockSize)
  const headerBlocksY = Math.floor((header.height - 2 * MARGIN_SIZE) / headerBlockSize)
  if (headerBlocksX * headerBlocksY < HEADER_BLOCKS) return null

  const payloadBlocksX = Math.floor((header.width - 2 * MARGIN_SIZE) / payloadBlockSize)
  const payloadBlocksY = Math.floor((header.height - 2 * MARGIN_SIZE) / payloadBlockSize)
  if (payloadBlocksX * payloadBlocksY < HEADER_BLOCKS + BITS_PER_BYTE) return null

  const headerStepX = (region.frameW / header.width) * headerBlockSize
  const headerStepY = (region.frameH / header.height) * headerBlockSize
  const headerBs = Math.min(headerStepX, headerStepY)
  const payloadScale = payloadBlockSize / headerBlockSize
  const payloadStepX = headerStepX * payloadScale
  const payloadStepY = headerStepY * payloadScale
  const payloadBs = headerBs * payloadScale
  const minStep = headerBlockSize === 4 ? 3 : headerBlockSize === 8 ? 6 : 12
  const maxStep = headerBlockSize === 4 ? 6 : headerBlockSize === 8 ? 10 : 20
  if (headerStepX < minStep || headerStepX > maxStep || headerStepY < minStep || headerStepY > maxStep) return null

  const yOffsets = [0, -1, 1, -2, 2]
  let bestResult = null
  let bestScore = -1

  for (let xAdjust = -2; xAdjust <= 2; xAdjust++) {
    for (const yAdjust of yOffsets) {
      const refinedRx = rx + xAdjust
      const refinedRy = ry + yAdjust

      const refinedHeader = probeHeaderBinary(
        imageData,
        width,
        region,
        refinedRx,
        refinedRy,
        headerStepX,
        headerStepY,
        headerBs,
        headerBlocksX,
        headerBlocksY
      )
      if (!refinedHeader) continue

      const payloadBlocks = getUsablePayloadBlocks(refinedHeader.mode, payloadBlocksX, payloadBlocksY)
      const payloadCapacity = isDenseBinaryMode(refinedHeader.mode)
        ? getPayloadCapacity(refinedHeader.width, refinedHeader.height, refinedHeader.mode)
        : Math.floor((payloadBlocks * bitsPerBlock) / BITS_PER_BYTE)
      if (payloadCapacity < refinedHeader.payloadLength) continue

      const result = readPayloadAt(
        imageData,
        width,
        region,
        refinedRx,
        refinedRy,
        payloadStepX,
        payloadStepY,
        payloadBs,
        payloadBlocksX,
        refinedHeader,
        payloadBlocksY,
        {
          rx: refinedRx,
          ry: refinedRy,
          stepX: headerStepX,
          stepY: headerStepY,
          bs: headerBs,
          blocksX: headerBlocksX,
          blocksY: headerBlocksY
        },
        options
      )
      const innerDiag = result._diag
      result._diag = {
        dataBs: payloadBs,
        headerBs,
        dataBlockSize: payloadBlockSize,
        headerBlockSize,
        payloadBlockSize,
        bitsPerBlock,
        stepX: payloadStepX,
        stepY: payloadStepY,
        headerStepX,
        headerStepY,
        blocksX: payloadBlocksX,
        blocksY: payloadBlocksY,
        headerBlocksX,
        headerBlocksY,
        frameMode: refinedHeader.mode,
        xOff: refinedRx - region.x,
        yOff: refinedRy - region.y,
        refined: true,
        hypothesis,
        payloadCapacity,
        scaleX: region.frameW / refinedHeader.width,
        scaleY: region.frameH / refinedHeader.height,
        blackLevel: result.levels?.blackLevel,
        whiteLevel: result.levels?.whiteLevel,
        blackLevels: result.levels?.blackLevels,
        whiteLevels: result.levels?.whiteLevels,
        score: scoreCandidate(result),
        ...getHeaderSpanMetrics(refinedHeader, region)
      }
      if (isDenseBinaryMode(refinedHeader.mode) && innerDiag) {
        result._diag = {
          ...result._diag,
          blocksX: innerDiag.blocksX,
          blocksY: innerDiag.blocksY,
          headerBlocksX: innerDiag.headerBlocksX,
          headerBlocksY: innerDiag.headerBlocksY,
          blackLevel: innerDiag.blackLevel,
          whiteLevel: innerDiag.whiteLevel,
          payloadEdgeGuardCells: innerDiag.payloadEdgeGuardCells,
          payloadPhaseX: innerDiag.payloadPhaseX,
          lumaLevels: innerDiag.lumaLevels,
          lumaDebug: innerDiag.lumaDebug,
          sweepTried: innerDiag.sweepTried,
          sweepBudgetHit: innerDiag.sweepBudgetHit,
          stripRows: innerDiag.stripRows
        }
      }

      if (result.crcValid) return result

      const score = scoreCandidate(result)
      if (score > bestScore) {
        bestScore = score
        bestResult = result
      }
    }
  }

  return bestResult
}

function classifyHeaderGeometry(header, region) {
  const tooSmall =
    header.width < region.frameW * 0.75 ||
    header.height < region.frameH * 0.75
  const tooLarge =
    header.width > region.frameW * 1.5 ||
    header.height > region.frameH * 1.5

  if (tooSmall && !tooLarge) return 'small'
  if (tooLarge && !tooSmall) return 'large'
  return 'normal'
}

function getHeaderRefinementHypotheses(header, region) {
  const hypotheses = []
  const geometry = classifyHeaderGeometry(header, region)

  if (
    header.width * 2 <= 8000 &&
    header.height * 2 <= 8000 &&
    (header.width < region.frameW * 0.75 || header.height < region.frameH * 0.75)
  ) {
    hypotheses.push({
      name: 'double',
      header: {
        ...header,
        width: header.width * 2,
        height: header.height * 2,
        fps: Math.min(header.fps * 2, 255),
        symbolId: header.symbolId * 2,
        payloadLength: header.payloadLength * 2
      }
    })
  }

  if (
    header.width >= 200 &&
    header.height >= 200 &&
    (header.width > region.frameW * 1.5 || header.height > region.frameH * 1.5)
  ) {
    hypotheses.push({
      name: 'half',
      header: {
        ...header,
        width: Math.floor(header.width / 2),
        height: Math.floor(header.height / 2),
        fps: Math.max(1, Math.floor(header.fps / 2)),
        symbolId: Math.floor(header.symbolId / 2),
        payloadLength: Math.floor(header.payloadLength / 2)
      }
    })
  }

  if (geometry === 'large') {
    hypotheses.sort((a, b) => (a.name === 'half' ? -1 : 0) - (b.name === 'half' ? -1 : 0))
  } else if (geometry === 'small') {
    hypotheses.sort((a, b) => (a.name === 'double' ? -1 : 0) - (b.name === 'double' ? -1 : 0))
  }

  hypotheses.push({ header, name: 'base' })
  return hypotheses
}

function tryPreferredExperimentalLayoutDecode(imageData, width, region, layout, options = {}) {
  if (!layout) return null

  const frameMode = layout.frameMode
  const headerBlockSize = getModeHeaderBlockSize(frameMode)
  const payloadBlockSize = getModePayloadBlockSize(frameMode)
  const bitsPerBlock = getModeBitsPerBlock(frameMode)
  const blocksX = layout.blocksX
  const blocksY = layout.blocksY ?? Math.floor(region.h / layout.stepY)
  const headerBlocksX = layout.headerBlocksX ?? blocksX
  const headerStepX = layout.headerStepX ?? layout.stepX
  const headerStepY = layout.headerStepY ?? layout.stepY
  const headerBs = layout.headerBs ?? layout.dataBs
  const headerBlocksY = layout.headerBlocksY ?? Math.floor(region.h / headerStepY)
  const precomputedOffsets = getRegionSafePrecomputedOffsets(layout, region, layout.precomputedOffsets || null)
  if (!headerBlockSize || !payloadBlockSize || !bitsPerBlock || !blocksX || !blocksY || !headerBlocksX || !headerBlocksY) return null

  const xAdjustments = [0, -1, 1, -2, 2]
  const yAdjustments = [0, -1, 1, -2, 2]
  let bestResult = null
  let bestScore = -1

  for (const xAdjust of xAdjustments) {
    for (const yAdjust of yAdjustments) {
      const rx = region.x + (layout.xOff || 0) + xAdjust
      const ry = region.y + (layout.yOff || 0) + yAdjust
      const header = probeHeaderBinary(
        imageData,
        width,
        region,
        rx,
        ry,
        headerStepX,
        headerStepY,
        headerBs,
        headerBlocksX,
        headerBlocksY
      )
      if (!header) continue
      if (header.mode !== frameMode) continue

      const payloadBitsPerBlock = getModeBitsPerBlock(header.mode) || bitsPerBlock
      const payloadBlocks = getUsablePayloadBlocks(header.mode, blocksX, blocksY)
      const payloadCapacity = isDenseBinaryMode(header.mode)
        ? getPayloadCapacity(header.width, header.height, header.mode)
        : Math.floor((payloadBlocks * payloadBitsPerBlock) / BITS_PER_BYTE)
      if (payloadCapacity < header.payloadLength) continue

      const result = readPayloadAt(
        imageData, width, region, rx, ry,
        layout.stepX, layout.stepY, layout.dataBs, blocksX, header, blocksY,
        {
          rx,
          ry,
          stepX: headerStepX,
          stepY: headerStepY,
          bs: headerBs,
          blocksX: headerBlocksX,
          blocksY: headerBlocksY
        },
        options,
        precomputedOffsets
      )
      const innerDiag = result._diag
      result._diag = {
        ...layout,
        modeProbe: frameMode,
        probeDataBlockSize: headerBlockSize,
        dataBlockSize: payloadBlockSize,
        headerBlockSize,
        payloadBlockSize,
        headerBs,
        bitsPerBlock: payloadBitsPerBlock,
        payloadCapacity,
        xOff: (layout.xOff || 0) + xAdjust,
        yOff: (layout.yOff || 0) + yAdjust,
        preferred: true,
        refined: false,
        hypothesis: 'preferred',
        score: scoreCandidate(result),
        ...getHeaderSpanMetrics(header, region)
      }
      if (isDenseBinaryMode(header.mode) && innerDiag) {
        result._diag = {
          ...result._diag,
          blocksX: innerDiag.blocksX,
          blocksY: innerDiag.blocksY,
          headerBlocksX: innerDiag.headerBlocksX,
          headerBlocksY: innerDiag.headerBlocksY,
          blackLevel: innerDiag.blackLevel,
          whiteLevel: innerDiag.whiteLevel,
          payloadEdgeGuardCells: innerDiag.payloadEdgeGuardCells,
          payloadPhaseX: innerDiag.payloadPhaseX,
          lumaLevels: innerDiag.lumaLevels,
          lumaDebug: innerDiag.lumaDebug,
          sweepTried: innerDiag.sweepTried,
          sweepBudgetHit: innerDiag.sweepBudgetHit,
          stripRows: innerDiag.stripRows
        }
      }
      attachDecisionTrace(result, {
        winner: {
          hypothesis: 'preferred',
          refined: false,
          score: result._diag.score,
          crcValid: !!result.crcValid
        },
        reason: 'preferred_layout',
        candidates: [summarizeDecisionCandidate(result, region)]
      }, region)

      if (result.crcValid) return result

      const score = scoreCandidate(result)
      if (score > bestScore) {
        bestScore = score
        bestResult = result
      }
    }
  }

  return bestResult
}

// Decode data blocks from a data region using binary modulation.
// Search the declared compat data modes so the payload grid size can differ from
// the 4×4 anchor grid without prior header knowledge.
export function decodeDataRegion(imageData, width, region, options = {}) {
  const baseBs = region.blockSize || BLOCK_SIZE
  const yOffsets = [0, -1, 1, -2, 2, -3, 3, -4, 4]
  const bsAdjustments = [0, 0.1, -0.1, 0.2, -0.2, 0.3, -0.3, 0.5, -0.5]
  const candidateHeaderBlockSizes = [4, 8]

  let bestResult = null
  let bestScore = -1

  const preferredResult = tryPreferredExperimentalLayoutDecode(imageData, width, region, region.preferredLayout, options)
  if (preferredResult) return preferredResult

  for (const headerBlockSize of candidateHeaderBlockSizes) {
    const headerScale = headerBlockSize / BLOCK_SIZE
    const baseStepX = (region.stepX || baseBs) * headerScale
    const baseStepY = (region.stepY || baseBs) * headerScale
    const baseHeaderBs = baseBs * headerScale
    const baseDataStep = Math.max(1, Math.round(baseStepX))
    const offsets = []
    for (let coarse = -2; coarse <= 2; coarse++) {
      for (let fine = -2; fine <= 2; fine++) {
        offsets.push(coarse * baseDataStep + fine)
      }
    }

    for (const bsAdj of bsAdjustments) {
      const anchorBs = baseBs + bsAdj
      if (anchorBs < 2 || anchorBs > 6) continue

      const scale = anchorBs / baseBs
      const stepX = baseStepX * scale
      const stepY = baseStepY * scale
      const headerBs = baseHeaderBs * scale

      const headerBlocksX = Math.floor(region.w / stepX)
      const headerBlocksY = Math.floor(region.h / stepY)
      if (headerBlocksX * headerBlocksY < HEADER_BLOCKS) continue

      for (const xOff of offsets) {
        for (const yOff of yOffsets) {
          const rx = region.x + xOff
          const ry = region.y + yOff

          const header = probeHeaderBinary(imageData, width, region, rx, ry, stepX, stepY, headerBs, headerBlocksX)
          if (!header) continue

          const resolvedHeaderBlockSize = getModeHeaderBlockSize(header.mode)
          const payloadBlockSize = getModePayloadBlockSize(header.mode)
          const payloadBitsPerBlock = getModeBitsPerBlock(header.mode)
          if (!resolvedHeaderBlockSize || !payloadBlockSize || !payloadBitsPerBlock) continue
          if (resolvedHeaderBlockSize !== headerBlockSize) continue

          const payloadScale = payloadBlockSize / resolvedHeaderBlockSize
          const payloadStepX = stepX * payloadScale
          const payloadStepY = stepY * payloadScale
          const payloadBs = headerBs * payloadScale
          const payloadBlocksX = Math.floor(region.w / payloadStepX)
          const payloadBlocksY = Math.floor(region.h / payloadStepY)
          if (payloadBlocksX * payloadBlocksY < HEADER_BLOCKS + BITS_PER_BYTE) continue

          const payloadBlocks = getUsablePayloadBlocks(header.mode, payloadBlocksX, payloadBlocksY)
          const payloadCapacity = isDenseBinaryMode(header.mode)
            ? getPayloadCapacity(header.width, header.height, header.mode)
            : Math.floor((payloadBlocks * payloadBitsPerBlock) / BITS_PER_BYTE)
          if (payloadCapacity < header.payloadLength) continue

          const headerLayout = {
            rx,
            ry,
            stepX,
            stepY,
            bs: headerBs,
            blocksX: headerBlocksX,
            blocksY: headerBlocksY
          }
          const baseResult = readPayloadAt(
            imageData,
            width,
            region,
            rx,
            ry,
            payloadStepX,
            payloadStepY,
            payloadBs,
            payloadBlocksX,
            header,
            payloadBlocksY,
            headerLayout,
            options
          )
          const innerDiag = baseResult._diag
          baseResult._diag = {
            modeProbe: header.mode,
            probeDataBlockSize: headerBlockSize,
            dataBlockSize: payloadBlockSize,
            headerBlockSize,
            payloadBlockSize,
            bitsPerBlock: payloadBitsPerBlock,
            dataBs: payloadBs,
            headerBs,
            stepX: payloadStepX,
            stepY: payloadStepY,
            headerStepX: stepX,
            headerStepY: stepY,
            blocksX: payloadBlocksX,
            blocksY: payloadBlocksY,
            headerBlocksX,
            headerBlocksY,
            frameMode: header.mode,
            xOff,
            yOff,
            bsAdj,
            payloadCapacity,
            blackLevel: baseResult.levels?.blackLevel,
            whiteLevel: baseResult.levels?.whiteLevel,
            blackLevels: baseResult.levels?.blackLevels,
            whiteLevels: baseResult.levels?.whiteLevels,
            hypothesis: 'base',
            refined: false,
            score: scoreCandidate(baseResult),
            ...getHeaderSpanMetrics(header, region)
          }
          if (isDenseBinaryMode(header.mode) && innerDiag) {
            baseResult._diag = {
              ...baseResult._diag,
              blocksX: innerDiag.blocksX,
              blocksY: innerDiag.blocksY,
              headerBlocksX: innerDiag.headerBlocksX,
              headerBlocksY: innerDiag.headerBlocksY,
              blackLevel: innerDiag.blackLevel,
              whiteLevel: innerDiag.whiteLevel,
              payloadEdgeGuardCells: innerDiag.payloadEdgeGuardCells,
              payloadPhaseX: innerDiag.payloadPhaseX,
              lumaLevels: innerDiag.lumaLevels,
              lumaDebug: innerDiag.lumaDebug,
              sweepTried: innerDiag.sweepTried,
              sweepBudgetHit: innerDiag.sweepBudgetHit,
              stripRows: innerDiag.stripRows
            }
          }
          let result = baseResult

          const refinements = getHeaderRefinementHypotheses(header, region)
            .map(({ header: hypothesisHeader, name }) =>
              refineCandidateFromHeader(imageData, width, region, hypothesisHeader, rx, ry, name, options)
            )
            .filter(Boolean)

          let decisionReason = refinements.length > 0 ? 'base_kept' : 'base_only'

          if (refinements.length > 0) {
            let bestRefined = refinements[0]
            let bestRefinedScore = scoreCandidate(bestRefined)
            for (let i = 1; i < refinements.length; i++) {
              const candidate = refinements[i]
              const candidateScore = scoreCandidate(candidate)
              if (candidate.crcValid || candidateScore > bestRefinedScore) {
                bestRefined = candidate
                bestRefinedScore = candidateScore
              }
            }

            const baseScore = scoreCandidate(result)
            const geometry = classifyHeaderGeometry(header, region)
            const refinedHypothesis = bestRefined._diag?.hypothesis
            const shouldPreferRefined =
              bestRefined.crcValid ||
              bestRefinedScore > baseScore ||
              (
                geometry !== 'normal' &&
                refinedHypothesis &&
                refinedHypothesis !== 'base' &&
                bestRefinedScore >= baseScore
              )

            if (shouldPreferRefined) {
              if (bestRefined.crcValid) {
                decisionReason = 'refined_crc'
              } else if (bestRefinedScore > baseScore) {
                decisionReason = 'refined_score'
              } else {
                decisionReason = 'geometry_override'
              }
              result = bestRefined
            }
          }

          const decision = {
            winner: {
              hypothesis: result._diag?.hypothesis || 'base',
              refined: !!result._diag?.refined,
              score: result._diag?.score ?? scoreCandidate(result),
              crcValid: !!result.crcValid
            },
            reason: decisionReason,
            candidates: [
              summarizeDecisionCandidate(baseResult, region),
              ...refinements.map((candidate) => summarizeDecisionCandidate(candidate, region))
            ].filter(Boolean)
          }
          attachDecisionTrace(result, decision, region)

          const score = scoreCandidate(result)

          if (!region._logged) {
            region._logged = true
            console.log(`[HDMI-RX] Header: probeBs=${headerBlockSize} mode=${header.mode} dataBs=${payloadBs.toFixed(2)} step=${payloadStepX.toFixed(2)}/${payloadStepY.toFixed(2)} step-class=${classifyStep(payloadStepX, payloadStepY)} grid=${payloadBlocksX}x${payloadBlocksY} len=${header.payloadLength} cap=${payloadCapacity} off=(${xOff},${yOff}) crc=${result.crcValid}`)
          }

          if (result.crcValid) return result

          if (score > bestScore) {
            bestScore = score
            bestResult = result
          }
        }
      }
    }
  }

  return bestResult
}

// Exposed for hdmi-uvc-frame.tests.js only — not part of the runtime API.
export const _internals = {
  getDenseBinaryHeaderBandRows,
  buildDenseBinaryFrame,
  readDenseBinaryPayloadLocked,
  verifyAnchorAt,
  BITS_PER_BYTE,
  DENSE_BINARY_HEADER_BLOCK_SIZE
}
