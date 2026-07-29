// Test functions for hdmi-uvc-frame.js, extracted from the production module
// so the codec ships without its test suite. Registered via src/test-suite.js
// (?test). Module privates used by these tests are exposed through the
// codec's `_internals` export.
import {
  buildHeader,
  parseHeader,
  buildFrame,
  renderAnchor,
  getDataRegion,
  getPayloadCapacity,
  detectAnchors,
  dataRegionFromAnchors,
  readPayloadWithLayout,
  decodeDataRegion,
  precomputeDenseBinarySampleOffsets,
  classifyStep,
  decodeLuma2,
  buildNativeGeometryGuidance,
  isNative1080pGeometry,
  hasEffectiveOneToOnePresentation,
  setLuma1SenderMidLevels,
  getLuma1SenderLevels,
  getLuma1CalibrationPayload,
  isLuma1CalibrationPayload,
  setLuma1SweepTimeBudgetMs,
  setLuma1DebugCapture,
  setLuma1SharpenCorrection,
  getLuma1SharpenCorrection,
  getLuma1SharpenRailHeadroom,
  sweepLuma1SharpenCorrection,
  _internals
} from './hdmi-uvc-frame.js'
import {
  FRAME_MAGIC,
  HDMI_MODE,
  HDMI_MODE_NAMES,
  getModeBitsPerBlock,
  getModeDataBlockSize,
  getModeHeaderBlockSize,
  getModePayloadBlockSize
} from './hdmi-uvc-constants.js'
import { crc32WithFallback as crc32 } from './hdmi-uvc-wasm.js'

const {
  getDenseBinaryHeaderBandRows,
  buildDenseBinaryFrame,
  readDenseBinaryPayloadLocked,
  verifyAnchorAt,
  BITS_PER_BYTE,
  DENSE_BINARY_HEADER_BLOCK_SIZE
} = _internals

export function testHeaderRoundtrip() {
  const header = buildHeader(HDMI_MODE.COMPAT_4, 1920, 1080, 30, 42, 1000000, 0xDEADBEEF)
  const parsed = parseHeader(header)
  const pass = parsed !== null &&
    parsed.magic === FRAME_MAGIC &&
    parsed.mode === HDMI_MODE.COMPAT_4 &&
    parsed.width === 1920 && parsed.height === 1080 &&
    parsed.fps === 30 && parsed.symbolId === 42 &&
    parsed.payloadLength === 1000000 && parsed.payloadCrc === 0xDEADBEEF
  console.log('Header roundtrip test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testAnchorRoundtrip() {
  const width = 640, height = 480
  const imageData = new Uint8ClampedArray(width * height * 4)
  for (let i = 3; i < imageData.length; i += 4) imageData[i] = 255

  // Render one anchor at (0, 0)
  renderAnchor(imageData, width, 0, 0)

  // Verify it (verifyAnchorAt returns block size > 0 on match)
  const bs = verifyAnchorAt(imageData, width, height, 0, 0)
  const pass = bs > 0
  console.log('Anchor roundtrip test:', pass ? `PASS (bs=${bs})` : 'FAIL')
  return pass
}

export function testFrameRoundtrip() {
  const payload = new Uint8Array(400)
  for (let i = 0; i < payload.length; i++) payload[i] = i % 256

  const width = 640, height = 407
  const frame = buildFrame(payload, HDMI_MODE.COMPAT_4, width, height, 30, 42)

  // Detect anchors
  const anchors = detectAnchors(frame, width, height)
  if (anchors.length < 2) {
    console.log('Frame roundtrip test: FAIL (found', anchors.length, 'anchors)')
    return false
  }

  // Derive data region and decode
  const region = dataRegionFromAnchors(anchors)
  if (!region) {
    console.log('Frame roundtrip test: FAIL (no data region)')
    return false
  }

  const result = decodeDataRegion(frame, width, region)
  const pass = result !== null &&
    result.crcValid &&
    result.header.symbolId === 42 &&
    result.payload.length === payload.length &&
    result.payload.every((v, i) => v === payload[i])

  console.log('Frame roundtrip test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testModeCapacityOrdering() {
  const width = 640
  const height = 480
  const cap4 = getPayloadCapacity(width, height, HDMI_MODE.COMPAT_4)
  const luma2Cap = getPayloadCapacity(width, height, HDMI_MODE.LUMA_2)
  const removedCap16 = getPayloadCapacity(width, height, 4)
  const pass = cap4 > 0 && luma2Cap > cap4 && removedCap16 === 0
  console.log(
    'Mode capacity ordering test:',
    pass ? `PASS (${cap4}; Luma2=${luma2Cap}; legacy 16x16 disabled)` : 'FAIL'
  )
  return pass
}

export function testHeaderAndPayloadBlockSizesMatchForExistingModes() {
  const modes = [
    HDMI_MODE.COMPAT_4,
    HDMI_MODE.RAW_GRAY,
    HDMI_MODE.RAW_RGB,
    HDMI_MODE.LUMA_2,
    HDMI_MODE.CODEBOOK_3,
    HDMI_MODE.GLYPH_5
  ]
  const fail = modes.find((mode) =>
    getModeHeaderBlockSize(mode) !== getModeDataBlockSize(mode) ||
    getModePayloadBlockSize(mode) !== getModeDataBlockSize(mode)
  )
  const pass = !fail
  console.log('Header/payload block size accessors test:', pass ? 'PASS' : `FAIL on mode ${fail}`)
  return pass
}

export function testBinary3ConstantsRegistered() {
  const pass = HDMI_MODE.BINARY_3 === 8 &&
    HDMI_MODE_NAMES[HDMI_MODE.BINARY_3] === '3x3' &&
    getModeHeaderBlockSize(HDMI_MODE.BINARY_3) === 4 &&
    getModePayloadBlockSize(HDMI_MODE.BINARY_3) === 3 &&
    getModeBitsPerBlock(HDMI_MODE.BINARY_3) === 1
  console.log('BINARY_3 constants test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testBinary2ConstantsRegistered() {
  const pass = HDMI_MODE.BINARY_2 === 9 &&
    HDMI_MODE_NAMES[HDMI_MODE.BINARY_2] === '2x2' &&
    getModeHeaderBlockSize(HDMI_MODE.BINARY_2) === 4 &&
    getModePayloadBlockSize(HDMI_MODE.BINARY_2) === 2 &&
    getModeBitsPerBlock(HDMI_MODE.BINARY_2) === 1
  console.log('BINARY_2 constants test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testBinary1ConstantsRegistered() {
  const pass = HDMI_MODE.BINARY_1 === 10 &&
    HDMI_MODE_NAMES[HDMI_MODE.BINARY_1] === '1x1' &&
    getModeHeaderBlockSize(HDMI_MODE.BINARY_1) === 4 &&
    getModePayloadBlockSize(HDMI_MODE.BINARY_1) === 1 &&
    getModeBitsPerBlock(HDMI_MODE.BINARY_1) === 1
  console.log('BINARY_1 constants test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testLuma1ConstantsRegistered() {
  const binary1Cap = getPayloadCapacity(640, 407, HDMI_MODE.BINARY_1)
  const luma1Cap = getPayloadCapacity(640, 407, HDMI_MODE.LUMA_1)
  const pass = HDMI_MODE.LUMA_1 === 11 &&
    HDMI_MODE_NAMES[HDMI_MODE.LUMA_1] === '1x1 Luma4' &&
    getModeHeaderBlockSize(HDMI_MODE.LUMA_1) === 4 &&
    getModePayloadBlockSize(HDMI_MODE.LUMA_1) === 1 &&
    getModeBitsPerBlock(HDMI_MODE.LUMA_1) === 2 &&
    luma1Cap > binary1Cap &&
    luma1Cap < binary1Cap * 2
  console.log('LUMA_1 constants/capacity test:', pass ? 'PASS' : 'FAIL', { binary1Cap, luma1Cap })
  return pass
}

export function testHdmiModesExcludeRemovedMode7() {
  const values = Object.values(HDMI_MODE)
  const pass = !values.includes(7) &&
    HDMI_MODE_NAMES[7] === undefined
  console.log('HDMI modes exclude removed mode 7 test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testBinary2FrameRoundtrip() {
  try {
    const width = 640
    const height = 407
    const cap = getPayloadCapacity(width, height, HDMI_MODE.BINARY_2)
    const payload = new Uint8Array(Math.min(cap, 1500))
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff

    const frame = buildFrame(payload, HDMI_MODE.BINARY_2, width, height, 30, 42)
    const anchors = detectAnchors(frame, width, height)
    if (anchors.length < 2) {
      console.log('BINARY_2 roundtrip test: FAIL (anchors)')
      return false
    }
    const region = dataRegionFromAnchors(anchors)
    if (!region) {
      console.log('BINARY_2 roundtrip test: FAIL (region)')
      return false
    }
    const result = decodeDataRegion(frame, width, region)
    const pass = result && result.crcValid &&
      result.header.mode === HDMI_MODE.BINARY_2 &&
      result.payload.length === payload.length &&
      result.payload.every((v, i) => v === payload[i])
    console.log('BINARY_2 roundtrip test:', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('BINARY_2 roundtrip test: FAIL', err?.message || err)
    return false
  }
}

export function testBinary1FrameRoundtrip() {
  try {
    const width = 640
    const height = 407
    const cap = getPayloadCapacity(width, height, HDMI_MODE.BINARY_1)
    const payload = new Uint8Array(Math.min(cap, 1500))
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 17) & 0xff

    const frame = buildFrame(payload, HDMI_MODE.BINARY_1, width, height, 30, 43)
    const anchors = detectAnchors(frame, width, height)
    if (anchors.length < 2) {
      console.log('BINARY_1 roundtrip test: FAIL (anchors)')
      return false
    }
    const region = dataRegionFromAnchors(anchors)
    if (!region) {
      console.log('BINARY_1 roundtrip test: FAIL (region)')
      return false
    }
    const result = decodeDataRegion(frame, width, region)
    const pass = result && result.crcValid &&
      result.header.mode === HDMI_MODE.BINARY_1 &&
      result.payload.length === payload.length &&
      result.payload.every((v, i) => v === payload[i])
    console.log('BINARY_1 roundtrip test:', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('BINARY_1 roundtrip test: FAIL', err?.message || err)
    return false
  }
}

export function testLuma1FrameRoundtrip() {
  try {
    const width = 640
    const height = 407
    const cap = getPayloadCapacity(width, height, HDMI_MODE.LUMA_1)
    const payload = new Uint8Array(Math.min(cap, 1500))
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 73 + 11) & 0xff

    const frame = buildFrame(payload, HDMI_MODE.LUMA_1, width, height, 30, 47)
    const anchors = detectAnchors(frame, width, height)
    if (anchors.length < 2) {
      console.log('LUMA_1 roundtrip test: FAIL (anchors)')
      return false
    }
    const region = dataRegionFromAnchors(anchors)
    if (!region) {
      console.log('LUMA_1 roundtrip test: FAIL (region)')
      return false
    }
    const result = decodeDataRegion(frame, width, region)
    const pass = result && result.crcValid &&
      result.header.mode === HDMI_MODE.LUMA_1 &&
      result.payload.length === payload.length &&
      result.payload.every((v, i) => v === payload[i])
    console.log('LUMA_1 roundtrip test:', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('LUMA_1 roundtrip test: FAIL', err?.message || err)
    return false
  }
}

function warpLuma1IntermediateLevels(imageData) {
  const warped = new Uint8ClampedArray(imageData)
  for (let i = 0; i < warped.length; i += 4) {
    const value = warped[i]
    let mapped = value
    if (value >= 80 && value <= 105) mapped = 136
    else if (value >= 150 && value <= 175) mapped = 178
    if (mapped !== value) {
      warped[i] = mapped
      warped[i + 1] = mapped
      warped[i + 2] = mapped
    }
  }
  return warped
}

function blurLuma1PayloadBand(imageData, width, height) {
  const blurred = new Uint8ClampedArray(imageData)
  const dr = getDataRegion(width, height)
  const headerCellsX = Math.floor(dr.w / DENSE_BINARY_HEADER_BLOCK_SIZE)
  const headerBandRows = getDenseBinaryHeaderBandRows(headerCellsX)
  const y0 = dr.y + headerBandRows * DENSE_BINARY_HEADER_BLOCK_SIZE
  const y1 = dr.y + dr.h

  for (let y = y0; y < y1; y++) {
    for (let x = dr.x + 1; x < dr.x + dr.w - 1; x++) {
      const i = (y * width + x) * 4
      const value = Math.round(
        imageData[i - 4] * 0.35 +
        imageData[i] * 0.30 +
        imageData[i + 4] * 0.35
      )
      blurred[i] = value
      blurred[i + 1] = value
      blurred[i + 2] = value
    }
  }

  return blurred
}

export function testLuma1WarpedIntermediateLevelsDecode() {
  try {
    const width = 640
    const height = 407
    const payload = new Uint8Array(1500)
    payload.fill(0x55)

    const frame = warpLuma1IntermediateLevels(
      buildFrame(payload, HDMI_MODE.LUMA_1, width, height, 30, 49)
    )
    const anchors = detectAnchors(frame, width, height)
    if (anchors.length < 2) {
      console.log('LUMA_1 warped intermediate decode test: FAIL (anchors)')
      return false
    }
    const region = dataRegionFromAnchors(anchors)
    if (!region) {
      console.log('LUMA_1 warped intermediate decode test: FAIL (region)')
      return false
    }
    const result = decodeDataRegion(frame, width, region)
    const pass = result && result.crcValid &&
      result.header.mode === HDMI_MODE.LUMA_1 &&
      result.payload.length === payload.length &&
      result.payload.every((v, i) => v === payload[i])
    console.log('LUMA_1 warped intermediate decode test:', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('LUMA_1 warped intermediate decode test: FAIL', err?.message || err)
    return false
  }
}

export function testLuma1BlurredPayloadBandDecode() {
  try {
    const width = 640
    const height = 407
    const payload = new Uint8Array(1500)
    payload.fill(0x55)

    const frame = blurLuma1PayloadBand(
      buildFrame(payload, HDMI_MODE.LUMA_1, width, height, 30, 51),
      width,
      height
    )
    const anchors = detectAnchors(frame, width, height)
    if (anchors.length < 2) {
      console.log('LUMA_1 blurred payload band decode test: FAIL (anchors)')
      return false
    }
    const region = dataRegionFromAnchors(anchors)
    if (!region) {
      console.log('LUMA_1 blurred payload band decode test: FAIL (region)')
      return false
    }
    const result = decodeDataRegion(frame, width, region)
    const pass = result && result.crcValid &&
      result.header.mode === HDMI_MODE.LUMA_1 &&
      result.payload.length === payload.length &&
      result.payload.every((v, i) => v === payload[i])
    console.log('LUMA_1 blurred payload band decode test:', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('LUMA_1 blurred payload band decode test: FAIL', err?.message || err)
    return false
  }
}

export function testLuma1LegacyNoGuardDecode() {
  try {
    const width = 640
    const height = 407
    const payload = new Uint8Array(1500)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 73 + 19) & 0xff

    const frame = buildDenseBinaryFrame(payload, HDMI_MODE.LUMA_1, width, height, 30, 53, null, 0)
    const anchors = detectAnchors(frame, width, height)
    if (anchors.length < 2) {
      console.log('LUMA_1 legacy no-guard decode test: FAIL (anchors)')
      return false
    }
    const region = dataRegionFromAnchors(anchors)
    if (!region) {
      console.log('LUMA_1 legacy no-guard decode test: FAIL (region)')
      return false
    }
    const result = decodeDataRegion(frame, width, region)
    const pass = result && result.crcValid &&
      result.header.mode === HDMI_MODE.LUMA_1 &&
      result._diag?.payloadEdgeGuardCells === 0 &&
      result.payload.length === payload.length &&
      result.payload.every((v, i) => v === payload[i])
    console.log('LUMA_1 legacy no-guard decode test:', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('LUMA_1 legacy no-guard decode test: FAIL', err?.message || err)
    return false
  }
}

// Mild full-frame horizontal blur (5% side taps) approximating MJPEG capture
// smear. Gentle enough that 1px payload cells survive with correct centroids,
// harsh enough that a one-pixel-misaligned strip read yields broken levels.
function blurLuma1FrameMild(imageData, width, height) {
  const blurred = new Uint8ClampedArray(imageData)
  for (let y = 0; y < height; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * 4
      const value = Math.round(
        imageData[i - 4] * 0.05 +
        imageData[i] * 0.90 +
        imageData[i + 4] * 0.05
      )
      blurred[i] = value
      blurred[i + 1] = value
      blurred[i + 2] = value
    }
  }
  return blurred
}

// Live regression: the header probe routinely settles one pixel left of the
// true grid (xOff=-1) and the payload phase search corrects it with
// payloadPhaseX=+1. The ramp strips must follow that phase correction —
// reading them unphased yields garbage centroids, and under a warped+blurred
// channel that misclassifies mid-level cells.
export function testLuma1OffsetLayoutSamplesStripsWithPhase() {
  try {
    const width = 640
    const height = 407
    const payload = new Uint8Array(1500)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 73 + 5) & 0xff

    const frame = blurLuma1FrameMild(
      warpLuma1IntermediateLevels(
        buildFrame(payload, HDMI_MODE.LUMA_1, width, height, 30, 59)
      ),
      width,
      height
    )
    const anchors = detectAnchors(frame, width, height)
    const region = dataRegionFromAnchors(anchors)
    const baseline = region ? decodeDataRegion(frame, width, region) : null
    if (!baseline?.crcValid) {
      console.log('LUMA_1 offset-layout strip phase test: FAIL (baseline decode)')
      return false
    }

    const layout = {
      ...baseline._diag,
      xOff: (baseline._diag.xOff || 0) - 1,
      payloadPhaseX: (baseline._diag.payloadPhaseX || 0) + 1
    }
    const got = readPayloadWithLayout(frame, width, region, layout, payload.length, null)
    const pass = got?.length === payload.length &&
      got.every((v, i) => v === payload[i])
    console.log('LUMA_1 offset-layout strip phase test:', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('LUMA_1 offset-layout strip phase test: FAIL', err?.message || err)
    return false
  }
}

// A fully CRC-failed LUMA_1 decode must carry the channel evidence needed for
// remote diagnosis: per-phase raw strip readouts and a payload luma histogram.
export function testLuma1FailedDecodeAttachesDebug() {
  try {
    const width = 640
    const height = 407
    const payload = new Uint8Array(1500)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 73 + 29) & 0xff

    const frame = buildFrame(payload, HDMI_MODE.LUMA_1, width, height, 30, 61)
    // Corrupt a horizontal band of the payload area (strips stay intact) so
    // every phase/guard attempt fails CRC.
    const dr = getDataRegion(width, height)
    for (let y = dr.y + 12; y < dr.y + 40; y++) {
      for (let x = dr.x + 8; x < dr.x + dr.w - 8; x++) {
        const i = (y * width + x) * 4
        frame[i] = frame[i + 1] = frame[i + 2] = 200
      }
    }

    const anchors = detectAnchors(frame, width, height)
    const region = dataRegionFromAnchors(anchors)
    const result = region ? decodeDataRegion(frame, width, region) : null
    const dbg = result?._diag?.lumaDebug
    const histSum = dbg?.hist?.reduce((sum, n) => sum + n, 0) ?? 0
    const pass = result && !result.crcValid &&
      result.header?.mode === HDMI_MODE.LUMA_1 &&
      Array.isArray(dbg?.strips) && dbg.strips.length === 5 &&
      dbg.strips.every((s) => Array.isArray(s.rows) && s.rows.length >= 1 &&
        s.rows.every((r) => r.raw.length === 4)) &&
      dbg.sampled > 0 && histSum === dbg.sampled &&
      Array.isArray(dbg.peaks) && dbg.peaks.length >= 2 &&
      // synthetic frame: margin->header edge is a hard vertical step. Indices
      // 0-2 are margin rows, 3-6 the first (white-selected) header row; index
      // 7 falls into the next header row whose bit varies, so skip it.
      Array.isArray(dbg.vEdge) && dbg.vEdge.length === 8 &&
      dbg.vEdgeColumns > 0 && dbg.vEdge[0] <= 40 && dbg.vEdge[2] <= 40 &&
      dbg.vEdge[3] >= 200 && dbg.vEdge[6] >= 200 &&
      Array.isArray(dbg.purityRows) && dbg.purityRows.length === 7 &&
      dbg.purityRows.some((e) => e.k === 5 && e.pct.length === 5) &&
      Array.isArray(dbg.purityCols) && dbg.purityCols.length === 7
    console.log('LUMA_1 failed-decode debug test:', pass ? 'PASS' : 'FAIL', pass ? '' : JSON.stringify({ crc: result?.crcValid, strips: dbg?.strips?.length, sampled: dbg?.sampled, peaks: dbg?.peaks, vEdge: dbg?.vEdge, vEdgeColumns: dbg?.vEdgeColumns }))
    return pass
  } catch (err) {
    console.log('LUMA_1 failed-decode debug test: FAIL', err?.message || err)
    return false
  }
}

// Calibration-frame detection must accept the exact pattern (in a plain copy,
// as the decoder produces) and reject any corruption. A CRC-valid frame that
// matches is link-validation success, not packet data.
export function testLuma1CalibrationPayloadDetection() {
  const cal = getLuma1CalibrationPayload(4096)
  const copy = new Uint8Array(cal)
  const corrupted = new Uint8Array(cal)
  corrupted[1000] ^= 1
  const pass = isLuma1CalibrationPayload(copy) === true &&
    isLuma1CalibrationPayload(corrupted) === false &&
    isLuma1CalibrationPayload(new Uint8Array(0)) === false &&
    isLuma1CalibrationPayload(null) === false
  console.log('LUMA_1 calibration payload detection test:', pass ? 'PASS' : 'FAIL')
  return pass
}

// The sweep time budget caps a failing blind sweep's main-thread cost (the
// receiver arms ~120ms; each candidate is a full-frame read), and the
// failed-sweep evidence block only builds when capture is enabled. A clean
// frame must still decode with the budget armed — the true phase is tried
// first, and the budget check runs after the CRC test.
export function testLuma1SweepBudgetAndDebugGate() {
  try {
    const width = 640
    const height = 407
    const payload = new Uint8Array(1500)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 73 + 29) & 0xff

    const cleanFrame = buildFrame(payload, HDMI_MODE.LUMA_1, width, height, 30, 62)
    const corrupt = new Uint8ClampedArray(cleanFrame)
    const dr = getDataRegion(width, height)
    for (let y = dr.y + 12; y < dr.y + 40; y++) {
      for (let x = dr.x + 8; x < dr.x + dr.w - 8; x++) {
        const i = (y * width + x) * 4
        corrupt[i] = corrupt[i + 1] = corrupt[i + 2] = 200
      }
    }
    const anchors = detectAnchors(corrupt, width, height)
    const region = dataRegionFromAnchors(anchors)
    if (!region) throw new Error('no region')

    // Unlimited budget, debug capture off: full sweep, no evidence block.
    setLuma1DebugCapture(false)
    const full = decodeDataRegion(corrupt, width, region)
    // Tiny budget, capture on: one candidate, evidence still attached.
    setLuma1SweepTimeBudgetMs(0.0001)
    setLuma1DebugCapture(true)
    const truncated = decodeDataRegion(corrupt, width, region)
    // Budget still armed: a clean frame decodes on the first candidate.
    const cleanResult = decodeDataRegion(cleanFrame, width, region)

    const pass = full && !full.crcValid &&
      full._diag?.sweepTried === 10 &&
      full._diag?.sweepBudgetHit === false &&
      full._diag?.lumaDebug === undefined &&
      truncated && !truncated.crcValid &&
      // performance.now() is coarsened in browsers, so the first elapsed
      // check can read 0 and admit an extra candidate or two.
      truncated._diag?.sweepTried <= 3 &&
      truncated._diag?.sweepBudgetHit === true &&
      !!truncated._diag?.lumaDebug &&
      cleanResult?.crcValid === true
    console.log('LUMA_1 sweep budget + debug gate test:', pass ? 'PASS' : 'FAIL', pass ? '' : JSON.stringify({
      fullTried: full?._diag?.sweepTried,
      fullBudgetHit: full?._diag?.sweepBudgetHit,
      fullDebug: !!full?._diag?.lumaDebug,
      truncTried: truncated?._diag?.sweepTried,
      truncBudgetHit: truncated?._diag?.sweepBudgetHit,
      truncDebug: !!truncated?._diag?.lumaDebug,
      cleanCrc: cleanResult?.crcValid
    }))
    return pass
  } catch (err) {
    console.log('LUMA_1 sweep budget + debug gate test: FAIL', err?.message || err)
    return false
  } finally {
    setLuma1SweepTimeBudgetMs(null)
    setLuma1DebugCapture(true)
  }
}

// The calibration analysis must auto-detect a calibration frame and measure
// an injected vertical mix fraction. Mixes every row with 30% of the row
// below: CRC fails, but the per-band f-below regression should read ~0.3
// while f-above stays near zero.
export function testLuma1CalibrationFrameAnalysis() {
  try {
    const width = 640
    const height = 407
    const cap = getPayloadCapacity(width, height, HDMI_MODE.LUMA_1)
    const payload = getLuma1CalibrationPayload(cap)
    const frame = buildFrame(payload, HDMI_MODE.LUMA_1, width, height, 30, 71)

    const mixed = new Uint8ClampedArray(frame)
    for (let y = 0; y < height - 1; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        const j = ((y + 1) * width + x) * 4
        const v = Math.round(0.7 * frame[i] + 0.3 * frame[j])
        mixed[i] = mixed[i + 1] = mixed[i + 2] = v
      }
    }

    const anchors = detectAnchors(mixed, width, height)
    const region = dataRegionFromAnchors(anchors)
    const result = region ? decodeDataRegion(mixed, width, region) : null
    const cal = result?._diag?.lumaDebug?.cal
    const fBelow = (cal?.fBelowBands || []).filter((v) => v !== null)
    const fAbove = (cal?.fAboveBands || []).filter((v) => v !== null)
    const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN)
    const fBelowMean = mean(fBelow)
    const fAboveMean = mean(fAbove)
    const pass = result && !result.crcValid &&
      cal && cal.match > 45 &&
      fBelow.length >= 8 &&
      fBelowMean > 0.2 && fBelowMean < 0.4 &&
      Math.abs(fAboveMean) < 0.1
    console.log('LUMA_1 calibration frame analysis test:', pass ? 'PASS' : 'FAIL', { match: cal?.match, fBelowMean: Number.isFinite(fBelowMean) ? fBelowMean.toFixed(3) : null, fAboveMean: Number.isFinite(fAboveMean) ? fAboveMean.toFixed(3) : null })
    return pass
  } catch (err) {
    console.log('LUMA_1 calibration frame analysis test: FAIL', err?.message || err)
    return false
  }
}

// Applying a synthetic unsharp mask (the suspected dongle ISP behavior) to a
// calibration frame: the sharpen fit must recover the injected strength and
// the unsharp correction must remove most classification errors.
export function testLuma1CalibrationSharpenFit() {
  try {
    const width = 640
    const height = 407
    const lambda = 0.4
    const cap = getPayloadCapacity(width, height, HDMI_MODE.LUMA_1)
    const payload = getLuma1CalibrationPayload(cap)
    const frame = buildFrame(payload, HDMI_MODE.LUMA_1, width, height, 30, 73)

    const sharpened = new Uint8ClampedArray(frame)
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = (y * width + x) * 4
        const own = frame[i]
        const avg4 = (frame[i - 4] + frame[i + 4] + frame[i - width * 4] + frame[i + width * 4]) / 4
        const v = Math.round(own + lambda * (own - avg4))
        sharpened[i] = sharpened[i + 1] = sharpened[i + 2] = v
      }
    }

    const anchors = detectAnchors(sharpened, width, height)
    const region = dataRegionFromAnchors(anchors)
    const result = region ? decodeDataRegion(sharpened, width, region) : null
    // v = own + λ·(own − avg4) decomposes as d = (λ/2)·ph + (λ/2)·pv, so the
    // fit should recover λh ≈ λv ≈ λ/2 (clamping at the rails blurs it some).
    const s = result?._diag?.lumaDebug?.cal?.sharpen
    const pass = result && !result.crcValid && s &&
      Math.abs(s.lh - lambda / 2) < 0.1 &&
      Math.abs(s.lv - lambda / 2) < 0.1 &&
      s.r2 > 0.5 &&
      s.errAfter < s.errBefore / 2
    console.log('LUMA_1 calibration sharpen fit test:', pass ? 'PASS' : 'FAIL', s || '(no sharpen fit)')
    return pass
  } catch (err) {
    console.log('LUMA_1 calibration sharpen fit test: FAIL', err?.message || err)
    return false
  }
}

// End-to-end fix validation: a frame distorted by the measured horizontal
// peaking (λ=0.45, with rail clamping) must fail without correction and
// decode perfectly — generic and locked readers — once the correction is
// armed with the same λ.
export function testLuma1SharpenCorrectionRoundtrip() {
  // Rail pinning is only sound while the top mid's peaking overshoot stays
  // inside the rails (headroom > 0) — render at the default levels, which
  // satisfy that like the live captured levels do. In the browser the sender
  // module's init shifts the module-wide mids to the gamma-precompensated
  // 103/182, whose overshoot clamps at white (headroom < 0) and is
  // indistinguishable from true white — out of the model's reach by design
  // (the receiver warns on thin live headroom instead).
  const priorLevels = getLuma1SenderLevels()
  try {
    const width = 640
    const height = 407
    const lambda = 0.45
    setLuma1SenderMidLevels(85, 170)
    const headroomOk = getLuma1SharpenRailHeadroom([0, 85, 170, 255], lambda) > 0 &&
      getLuma1SharpenRailHeadroom([0, 103, 182, 255], lambda) < 0
    const cap = getPayloadCapacity(width, height, HDMI_MODE.LUMA_1)
    const payload = new Uint8Array(cap)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 73 + 41) & 0xff
    const frame = buildFrame(payload, HDMI_MODE.LUMA_1, width, height, 30, 79)

    const sharpened = new Uint8ClampedArray(frame)
    for (let y = 0; y < height; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = (y * width + x) * 4
        const v = Math.round(frame[i] + lambda * (frame[i] - (frame[i - 4] + frame[i + 4]) / 2))
        sharpened[i] = sharpened[i + 1] = sharpened[i + 2] = v
      }
    }

    const anchors = detectAnchors(sharpened, width, height)
    const region = dataRegionFromAnchors(anchors)
    const uncorrected = region ? decodeDataRegion(sharpened, width, region) : null

    setLuma1SharpenCorrection(lambda)
    const corrected = region ? decodeDataRegion(sharpened, width, region) : null
    let lockedOk = false
    if (corrected?.crcValid) {
      const precomputed = precomputeDenseBinarySampleOffsets(corrected._diag, region)
      const locked = readDenseBinaryPayloadLocked(
        sharpened, width, region,
        { ...corrected._diag, precomputedOffsets: precomputed.offsets, precomputedRegion: precomputed.region },
        payload.length, precomputed.offsets, {}
      )
      lockedOk = locked?.length === payload.length && locked.every((v, i) => v === payload[i])
    }
    setLuma1SharpenCorrection(null)

    const pass = uncorrected && !uncorrected.crcValid &&
      corrected && corrected.crcValid &&
      corrected.payload.length === payload.length &&
      corrected.payload.every((v, i) => v === payload[i]) &&
      lockedOk && headroomOk
    console.log('LUMA_1 sharpen correction roundtrip test:', pass ? 'PASS' : 'FAIL', { uncorrectedCrc: uncorrected?.crcValid, correctedCrc: corrected?.crcValid, lockedOk, headroomOk })
    return pass
  } catch (err) {
    setLuma1SharpenCorrection(null)
    console.log('LUMA_1 sharpen correction roundtrip test: FAIL', err?.message || err)
    return false
  } finally {
    setLuma1SenderMidLevels(priorLevels[1], priorLevels[2])
  }
}

// The correction is worthless if nothing can arm it. With the sender's
// calibration path gone, a receiver holding no stored λ must recover one from
// an ordinary failed frame, or a peaked channel fails every frame forever.
export function testLuma1SharpenBlindSweepArmsCorrection() {
  const priorLevels = getLuma1SenderLevels()
  try {
    const width = 640
    const height = 407
    const lambda = 0.45
    setLuma1SenderMidLevels(85, 170)
    setLuma1SharpenCorrection(null)
    const cap = getPayloadCapacity(width, height, HDMI_MODE.LUMA_1)
    const payload = new Uint8Array(cap)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff
    const frame = buildFrame(payload, HDMI_MODE.LUMA_1, width, height, 30, 83)

    // Same forward channel the dongle applies: 1D horizontal unsharp mask.
    const sharpened = new Uint8ClampedArray(frame)
    for (let y = 0; y < height; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = (y * width + x) * 4
        const v = Math.round(frame[i] + lambda * (frame[i] - (frame[i - 4] + frame[i + 4]) / 2))
        sharpened[i] = sharpened[i + 1] = sharpened[i + 2] = v
      }
    }

    const region = dataRegionFromAnchors(detectAnchors(sharpened, width, height))
    const uncorrected = region ? decodeDataRegion(sharpened, width, region) : null

    const swept = region ? sweepLuma1SharpenCorrection(sharpened, width, region) : null
    const armed = getLuma1SharpenCorrection()
    const payloadOk = !!(swept?.result?.payload &&
      swept.result.payload.length === payload.length &&
      swept.result.payload.every((v, i) => v === payload[i]))

    // A clean (unpeaked) frame must leave the sweep unarmed rather than
    // latching a bogus λ onto hardware that does no peaking at all.
    setLuma1SharpenCorrection(null)
    const cleanRegion = dataRegionFromAnchors(detectAnchors(frame, width, height))
    const cleanSwept = cleanRegion
      ? sweepLuma1SharpenCorrection(frame, width, cleanRegion, { ladder: [0.45] })
      : null
    // The clean frame already decodes, so the sweep is never reached live; if
    // it is run anyway it must not leave a wrong λ armed on failure.
    const cleanLambda = getLuma1SharpenCorrection()
    const cleanOk = cleanSwept === null ? cleanLambda === null : cleanSwept.lambda === 0.45
    setLuma1SharpenCorrection(null)

    const pass = !!(uncorrected && !uncorrected.crcValid &&
      swept && swept.result.crcValid && armed === swept.lambda &&
      Number.isFinite(armed) && payloadOk && cleanOk)
    console.log('LUMA_1 sharpen blind sweep test:', pass ? 'PASS' : 'FAIL', {
      uncorrectedCrc: uncorrected?.crcValid, sweptLambda: swept?.lambda, armed, payloadOk, cleanOk
    })
    return pass
  } catch (err) {
    setLuma1SharpenCorrection(null)
    console.log('LUMA_1 sharpen blind sweep test: FAIL', err?.message || err)
    return false
  } finally {
    setLuma1SenderMidLevels(priorLevels[1], priorLevels[2])
  }
}

export function testBinary3FrameRoundtrip() {
  try {
    const width = 640
    const height = 407
    const cap = getPayloadCapacity(width, height, HDMI_MODE.BINARY_3)
    const payload = new Uint8Array(Math.min(cap, 1500))
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 23) & 0xff

    const frame = buildFrame(payload, HDMI_MODE.BINARY_3, width, height, 30, 42)
    const anchors = detectAnchors(frame, width, height)
    if (anchors.length < 2) {
      console.log('BINARY_3 roundtrip test: FAIL (anchors)')
      return false
    }
    const region = dataRegionFromAnchors(anchors)
    if (!region) {
      console.log('BINARY_3 roundtrip test: FAIL (region)')
      return false
    }
    const result = decodeDataRegion(frame, width, region)
    const pass = result && result.crcValid &&
      result.header.mode === HDMI_MODE.BINARY_3 &&
      result.payload.length === payload.length &&
      result.payload.every((v, i) => v === payload[i])
    console.log('BINARY_3 roundtrip test:', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('BINARY_3 roundtrip test: FAIL', err?.message || err)
    return false
  }
}

export function testDecodeDataRegionPropagatesDenseBinaryLevels() {
  try {
    const width = 1920
    const height = 1080
    const cap = getPayloadCapacity(width, height, HDMI_MODE.BINARY_3)
    const payload = new Uint8Array(Math.min(cap, 4096))
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 47) & 0xff
    const frame = buildFrame(payload, HDMI_MODE.BINARY_3, width, height, 30, 11)
    const anchors = detectAnchors(frame, width, height)
    const region = dataRegionFromAnchors(anchors)
    const result = region ? decodeDataRegion(frame, width, region) : null
    const pass = result?.crcValid &&
      typeof result._diag?.blackLevel === 'number' &&
      typeof result._diag?.whiteLevel === 'number'
    console.log('decodeDataRegion dense-binary levels propagation test:', pass ? 'PASS' : `FAIL diag=${JSON.stringify(result?._diag)}`)
    return pass
  } catch (err) {
    console.log('decodeDataRegion dense-binary levels propagation test: FAIL', err?.message || err)
    return false
  }
}

export function testDenseBinaryLockedLayoutMatchesBlindSweep() {
  try {
    const width = 640
    const height = 407
    const cap = getPayloadCapacity(width, height, HDMI_MODE.BINARY_3)
    const payload = new Uint8Array(Math.min(cap, 1500))
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 37) & 0xff
    const frame = buildFrame(payload, HDMI_MODE.BINARY_3, width, height, 30, 7)
    const anchors = detectAnchors(frame, width, height)
    const region = dataRegionFromAnchors(anchors)
    const blind = region ? decodeDataRegion(frame, width, region) : null
    if (!blind?.crcValid) {
      console.log('DenseBinary locked-layout test: FAIL (blind decode)')
      return false
    }

    const diag = blind._diag
    const lockedLayout = {
      blocksX: diag.blocksX,
      blocksY: diag.blocksY,
      frameMode: HDMI_MODE.BINARY_3,
      bitsPerBlock: 1,
      stepX: diag.stepX,
      stepY: diag.stepY,
      dataBs: diag.dataBs,
      xOff: diag.xOff,
      yOff: diag.yOff,
      blackLevel: diag.blackLevel,
      whiteLevel: diag.whiteLevel
    }
    const fast = readPayloadWithLayout(frame, width, region, lockedLayout, payload.length)
    const pass = fast && fast.length === payload.length && fast.every((v, i) => v === payload[i])
    console.log('DenseBinary locked-layout test:', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('DenseBinary locked-layout test: FAIL', err?.message || err)
    return false
  }
}

export function testDenseBinaryPrecomputedOffsetsMatchUncached() {
  try {
    const width = 640
    const height = 407
    const cap = getPayloadCapacity(width, height, HDMI_MODE.BINARY_3)
    const payload = new Uint8Array(Math.min(cap, 1500))
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 41) & 0xff
    const frame = buildFrame(payload, HDMI_MODE.BINARY_3, width, height, 30, 7)
    const anchors = detectAnchors(frame, width, height)
    const region = dataRegionFromAnchors(anchors)
    const initial = region ? decodeDataRegion(frame, width, region) : null
    if (!initial?.crcValid) {
      console.log('DenseBinary precomputed offsets match test: FAIL (initial decode)')
      return false
    }
    const diag = initial._diag
    const layout = {
      blocksX: diag.blocksX,
      blocksY: diag.blocksY,
      frameMode: HDMI_MODE.BINARY_3,
      bitsPerBlock: 1,
      stepX: diag.stepX,
      stepY: diag.stepY,
      dataBs: diag.dataBs,
      xOff: diag.xOff,
      yOff: diag.yOff,
      blackLevel: diag.blackLevel,
      whiteLevel: diag.whiteLevel
    }
    const uncached = readPayloadWithLayout(frame, width, region, layout, payload.length, null)
    const { offsets } = precomputeDenseBinarySampleOffsets(layout, region)
    const cached = readPayloadWithLayout(frame, width, region, layout, payload.length, offsets)
    const pass = uncached && cached &&
      uncached.length === cached.length &&
      cached.every((v, i) => v === uncached[i]) &&
      cached.every((v, i) => v === payload[i])
    console.log('DenseBinary precomputed offsets match test:', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('DenseBinary precomputed offsets match test: FAIL', err?.message || err)
    return false
  }
}

export function testBinary2LockedPayloadReaderMatchesGeneric() {
  try {
    const width = 640
    const height = 407
    const payload = new Uint8Array(1500)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 53 + 7) & 0xff

    const frame = buildFrame(payload, HDMI_MODE.BINARY_2, width, height, 30, 17)
    const anchors = detectAnchors(frame, width, height)
    const region = dataRegionFromAnchors(anchors)
    const initial = region ? decodeDataRegion(frame, width, region) : null
    if (!initial?.crcValid) {
      console.log('BINARY_2 locked payload reader test: FAIL (initial decode)')
      return false
    }

    const genericLayout = { ...initial._diag }
    const precomputed = precomputeDenseBinarySampleOffsets(initial._diag, region)
    const lockedLayout = {
      ...initial._diag,
      precomputedOffsets: precomputed.offsets,
      precomputedRegion: precomputed.region
    }
    const generic = readPayloadWithLayout(frame, width, region, genericLayout, payload.length, null)
    const locked = readDenseBinaryPayloadLocked(frame, width, region, lockedLayout, payload.length, precomputed.offsets)
    const pass = generic?.length === payload.length &&
      locked?.length === payload.length &&
      generic.every((v, i) => v === payload[i]) &&
      locked.every((v, i) => v === payload[i])
    console.log('BINARY_2 locked payload reader test:', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('BINARY_2 locked payload reader test: FAIL', err?.message || err)
    return false
  }
}

export function testBinary1LockedPayloadReaderMatchesGeneric() {
  try {
    const width = 640
    const height = 407
    const payload = new Uint8Array(1500)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 67 + 23) & 0xff

    const frame = buildFrame(payload, HDMI_MODE.BINARY_1, width, height, 30, 23)
    const anchors = detectAnchors(frame, width, height)
    const region = dataRegionFromAnchors(anchors)
    const initial = region ? decodeDataRegion(frame, width, region) : null
    if (!initial?.crcValid) {
      console.log('BINARY_1 locked payload reader test: FAIL (initial decode)')
      return false
    }

    const genericLayout = { ...initial._diag }
    const precomputed = precomputeDenseBinarySampleOffsets(initial._diag, region)
    const lockedLayout = {
      ...initial._diag,
      precomputedOffsets: precomputed.offsets,
      precomputedRegion: precomputed.region
    }
    const generic = readPayloadWithLayout(frame, width, region, genericLayout, payload.length, null)
    const locked = readDenseBinaryPayloadLocked(frame, width, region, lockedLayout, payload.length, precomputed.offsets)
    const pass = generic?.length === payload.length &&
      locked?.length === payload.length &&
      generic.every((v, i) => v === payload[i]) &&
      locked.every((v, i) => v === payload[i])
    console.log('BINARY_1 locked payload reader test:', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('BINARY_1 locked payload reader test: FAIL', err?.message || err)
    return false
  }
}

export function testBinary1LockedPayloadReaderUsesBytePacker() {
  try {
    const width = 640
    const height = 407
    const payload = new Uint8Array(1500)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 71 + 29) & 0xff

    const frame = buildFrame(payload, HDMI_MODE.BINARY_1, width, height, 30, 31)
    const anchors = detectAnchors(frame, width, height)
    const region = dataRegionFromAnchors(anchors)
    const initial = region ? decodeDataRegion(frame, width, region) : null
    if (!initial?.crcValid) {
      console.log('BINARY_1 byte-packer locked payload reader test: FAIL (initial decode)')
      return false
    }

    const precomputed = precomputeDenseBinarySampleOffsets(initial._diag, region)
    const lockedLayout = {
      ...initial._diag,
      precomputedOffsets: precomputed.offsets,
      precomputedRegion: precomputed.region
    }
    const stats = {}
    const locked = readDenseBinaryPayloadLocked(frame, width, region, lockedLayout, payload.length, precomputed.offsets, { stats })
    const pass = locked?.length === payload.length &&
      locked.every((v, i) => v === payload[i]) &&
      (stats.reader === 'binary1-bytepack' || stats.reader === 'binary1-wasm')
    console.log('BINARY_1 byte-packer locked payload reader test:', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('BINARY_1 byte-packer locked payload reader test: FAIL', err?.message || err)
    return false
  }
}

export function testLuma1LockedPayloadReaderMatchesGeneric() {
  try {
    const width = 640
    const height = 407
    const payload = new Uint8Array(1500)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 79 + 31) & 0xff

    const frame = buildFrame(payload, HDMI_MODE.LUMA_1, width, height, 30, 37)
    const anchors = detectAnchors(frame, width, height)
    const region = dataRegionFromAnchors(anchors)
    const initial = region ? decodeDataRegion(frame, width, region) : null
    if (!initial?.crcValid) {
      console.log('LUMA_1 locked payload reader test: FAIL (initial decode)')
      return false
    }

    const genericLayout = { ...initial._diag }
    const precomputed = precomputeDenseBinarySampleOffsets(initial._diag, region)
    const lockedLayout = {
      ...initial._diag,
      precomputedOffsets: precomputed.offsets,
      precomputedRegion: precomputed.region
    }
    const generic = readPayloadWithLayout(frame, width, region, genericLayout, payload.length, null)
    const stats = {}
    const locked = readDenseBinaryPayloadLocked(frame, width, region, lockedLayout, payload.length, precomputed.offsets, { stats })
    const pass = generic?.length === payload.length &&
      locked?.length === payload.length &&
      generic.every((v, i) => v === payload[i]) &&
      locked.every((v, i) => v === payload[i]) &&
      (stats.reader === 'luma1-bytepack' || stats.reader === 'luma1-wasm')
    console.log('LUMA_1 locked payload reader test:', pass ? 'PASS' : 'FAIL', { reader: stats.reader })
    return pass
  } catch (err) {
    console.log('LUMA_1 locked payload reader test: FAIL', err?.message || err)
    return false
  }
}

export function testBinary2LockedPayloadReaderTranslatesCroppedOffsets() {
  try {
    const width = 640
    const height = 407
    const payload = new Uint8Array(1500)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 59 + 11) & 0xff

    const frame = buildFrame(payload, HDMI_MODE.BINARY_2, width, height, 30, 19)
    const anchors = detectAnchors(frame, width, height)
    const region = dataRegionFromAnchors(anchors)
    const initial = region ? decodeDataRegion(frame, width, region) : null
    if (!initial?.crcValid) {
      console.log('BINARY_2 cropped locked payload reader test: FAIL (initial decode)')
      return false
    }

    const precomputed = precomputeDenseBinarySampleOffsets(initial._diag, region)
    const layout = {
      ...initial._diag,
      precomputedOffsets: precomputed.offsets,
      precomputedRegion: precomputed.region
    }
    const crop = {
      x: Math.max(0, region.x - 4),
      y: Math.max(0, region.y - 4),
      w: Math.min(width - Math.max(0, region.x - 4), region.w + 8),
      h: Math.min(height - Math.max(0, region.y - 4), region.h + 8)
    }
    const croppedRegion = {
      ...region,
      x: region.x - crop.x,
      y: region.y - crop.y
    }
    const croppedFrame = cropFrameForTest(frame, width, crop)
    const locked = readDenseBinaryPayloadLocked(croppedFrame, crop.w, croppedRegion, layout, payload.length, precomputed.offsets)
    const pass = locked?.length === payload.length &&
      locked.every((v, i) => v === payload[i])
    console.log('BINARY_2 cropped locked payload reader test:', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('BINARY_2 cropped locked payload reader test: FAIL', err?.message || err)
    return false
  }
}

export function testBinary2SinglePixelLockedPayloadReader() {
  try {
    const width = 1920
    const height = 1080
    const payload = new Uint8Array(1500)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 97 + 13) & 0xff
    const frame = buildFrame(payload, HDMI_MODE.BINARY_2, width, height, 60, 7)
    const anchors = detectAnchors(frame, width, height)
    const region = dataRegionFromAnchors(anchors)
    const initial = region ? decodeDataRegion(frame, width, region) : null
    if (!initial?.crcValid || initial._diag?.frameMode !== HDMI_MODE.BINARY_2) {
      console.log('BINARY_2 single-pixel locked reader test: FAIL (initial decode)')
      return false
    }
    const precomputed = precomputeDenseBinarySampleOffsets(initial._diag, region)
    const layout = {
      ...initial._diag,
      precomputedOffsets: precomputed.offsets,
      precomputedRegion: precomputed.region
    }

    const damaged = new Uint8ClampedArray(frame)
    const offsets = precomputed.offsets
    const cells = Math.floor(offsets.length / 2)
    for (let i = 0; i < cells; i++) {
      const px = offsets[i * 2]
      const py = offsets[i * 2 + 1]
      const base = ((py * width) + px) * 4
      const rowStride = width * 4
      const inverted = damaged[base] > 127 ? 0 : 255
      damaged[base + 4] = inverted
      damaged[base + rowStride] = inverted
      damaged[base + rowStride + 4] = inverted
    }

    const robust = readPayloadWithLayout(damaged, width, region, layout, payload.length, precomputed.offsets, {
      binary2SampleMode: 'average'
    })
    const single = readPayloadWithLayout(damaged, width, region, layout, payload.length, precomputed.offsets, {
      binary2SampleMode: 'single'
    })
    const pass = robust?.some((v, i) => v !== payload[i]) &&
      single?.length === payload.length &&
      single.every((v, i) => v === payload[i])
    console.log('BINARY_2 single-pixel locked reader test:', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('BINARY_2 single-pixel locked reader test: FAIL', err?.message || err)
    return false
  }
}

function cropFrameForTest(frame, width, rect) {
  const cropped = new Uint8ClampedArray(rect.w * rect.h * 4)
  const rowBytes = rect.w * 4
  for (let y = 0; y < rect.h; y++) {
    const srcStart = ((rect.y + y) * width + rect.x) * 4
    cropped.set(frame.subarray(srcStart, srcStart + rowBytes), y * rowBytes)
  }
  return cropped
}

export function testDenseBinaryPrecomputedOffsetsIgnoreMismatchedCrop() {
  try {
    const width = 640
    const height = 407
    const payload = new Uint8Array(1200)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 47) & 0xff
    const frame = buildFrame(payload, HDMI_MODE.BINARY_2, width, height, 30, 12)
    const anchors = detectAnchors(frame, width, height)
    const region = dataRegionFromAnchors(anchors)
    const initial = region ? decodeDataRegion(frame, width, region) : null
    if (!initial?.crcValid) {
      console.log('Dense binary crop-offset test: FAIL (initial decode)')
      return false
    }

    const precomputed = precomputeDenseBinarySampleOffsets(initial._diag, region)
    const layout = {
      ...initial._diag,
      precomputedRegion: { x: region.x, y: region.y, w: region.w, h: region.h }
    }
    const crop = {
      x: Math.max(0, region.x - 4),
      y: Math.max(0, region.y - 4),
      w: Math.min(width - Math.max(0, region.x - 4), region.w + 8),
      h: Math.min(height - Math.max(0, region.y - 4), region.h + 8)
    }
    const croppedRegion = {
      ...region,
      x: region.x - crop.x,
      y: region.y - crop.y
    }
    const croppedFrame = cropFrameForTest(frame, width, crop)
    const fastPayload = readPayloadWithLayout(
      croppedFrame,
      crop.w,
      croppedRegion,
      layout,
      payload.length,
      precomputed.offsets
    )
    const pass = fastPayload?.length === payload.length &&
      fastPayload.every((v, i) => v === payload[i])
    console.log('Dense binary crop-offset test:', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('Dense binary crop-offset test: FAIL', err?.message || err)
    return false
  }
}

export function testReadPayloadWithLayoutAcceptsImageDataWrapper() {
  const width = 640
  const height = 407
  const payload = new Uint8Array(1200)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 9) & 0xff

  const frame = buildFrame(payload, HDMI_MODE.BINARY_2, width, height, 30, 14)
  const anchors = detectAnchors(frame, width, height)
  const region = dataRegionFromAnchors(anchors)
  const initial = region ? decodeDataRegion(frame, width, region) : null
  if (!initial?.crcValid) {
    console.log('ImageData-wrapper layout read test: FAIL (initial decode)')
    return false
  }

  const reread = readPayloadWithLayout(
    { data: frame },
    width,
    region,
    initial._diag,
    payload.length
  )
  const pass = !!reread &&
    reread.length === payload.length &&
    reread.every((value, index) => value === payload[index])
  console.log('ImageData-wrapper layout read test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testDenseBinaryLayoutReadSkipsUnusedConfidenceBuffer() {
  const RealUint8Array = globalThis.Uint8Array
  try {
    const width = 640
    const height = 407
    const payload = new RealUint8Array(1200)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 43) & 0xff
    const frame = buildFrame(payload, HDMI_MODE.BINARY_2, width, height, 30, 11)
    const anchors = detectAnchors(frame, width, height)
    const region = dataRegionFromAnchors(anchors)
    const decoded = region ? decodeDataRegion(frame, width, region) : null
    if (!decoded?.crcValid) {
      console.log('Dense binary layout read confidence-allocation test: FAIL (initial decode)')
      return false
    }

    const allocationSizes = []
    function CountingUint8Array(...args) {
      if (typeof args[0] === 'number') allocationSizes.push(args[0])
      return new RealUint8Array(...args)
    }
    Object.setPrototypeOf(CountingUint8Array, RealUint8Array)
    CountingUint8Array.prototype = RealUint8Array.prototype

    globalThis.Uint8Array = CountingUint8Array
    const fastPayload = readPayloadWithLayout(frame, width, region, decoded._diag, payload.length)
    globalThis.Uint8Array = RealUint8Array

    const confidenceLength = payload.length * BITS_PER_BYTE
    const pass = fastPayload?.length === payload.length &&
      fastPayload.every((v, i) => v === payload[i]) &&
      !allocationSizes.includes(confidenceLength)
    console.log('Dense binary layout read confidence-allocation test:', pass ? 'PASS' : 'FAIL', {
      allocations: allocationSizes,
      confidenceLength
    })
    return pass
  } catch (err) {
    globalThis.Uint8Array = RealUint8Array
    console.log('Dense binary layout read confidence-allocation test: FAIL', err?.message || err)
    return false
  } finally {
    globalThis.Uint8Array = RealUint8Array
  }
}

export function testDecodeDataRegionConfidence() {
  try {
    const payload = new Uint8Array(50)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 19) & 0xff
    const width = 640
    const height = 407
    const frame = buildFrame(payload, HDMI_MODE.BINARY_3, width, height, 30, 42)
    const anchors = detectAnchors(frame, width, height)
    const region = dataRegionFromAnchors(anchors)
    const result = region ? decodeDataRegion(frame, width, region, { collectConfidence: true }) : null
    const pass = result?.crcValid &&
      result.confidence instanceof Uint8Array &&
      result.confidence.length === payload.length * 8 &&
      result.confidence.every((c) => c >= 0 && c <= 128)
    console.log('decode confidence test:', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('decode confidence test: FAIL', err?.message || err)
    return false
  }
}

export function testDecodeDataRegionConfidenceCompat4() {
  try {
    const payload = new Uint8Array(50)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 11) & 0xff
    const width = 640
    const height = 407
    const frame = buildFrame(payload, HDMI_MODE.COMPAT_4, width, height, 30, 42)
    const anchors = detectAnchors(frame, width, height)
    const region = dataRegionFromAnchors(anchors)
    const result = region ? decodeDataRegion(frame, width, region, { collectConfidence: true }) : null
    const pass = result?.crcValid &&
      result.confidence instanceof Uint8Array &&
      result.confidence.length === payload.length * 8
    console.log('decode confidence test (COMPAT_4):', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('decode confidence test (COMPAT_4): FAIL', err?.message || err)
    return false
  }
}

function frameRefactorChecksum(mode, payloadLength, multiplier) {
  const payload = new Uint8Array(payloadLength)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * multiplier) & 0xFF

  const width = 640
  const height = 480
  const frame = buildFrame(payload, mode, width, height, 30, 42)
  const view = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength)
  return crc32(view)
}

function testPinnedFrameBytes(label, mode, payloadLength, multiplier, expected) {
  const checksum = frameRefactorChecksum(mode, payloadLength, multiplier)
  const pass = checksum === expected
  console.log(`${label} frame refactor byte-equality test: ${pass ? 'PASS' : 'FAIL'} (crc=${checksum.toString(16)}, expected=${expected.toString(16)})`)
  return pass
}

export function testFrameRefactorPreservesCompat4Bytes() {
  return testPinnedFrameBytes('Compat4', HDMI_MODE.COMPAT_4, 400, 73, 0x29e01f8b)
}

export function testFrameRefactorPreservesRawGrayBytes() {
  return testPinnedFrameBytes('RawGray', HDMI_MODE.RAW_GRAY, 401, 37, 0x5899e33b)
}

export function testFrameRefactorPreservesRawRgbBytes() {
  return testPinnedFrameBytes('RawRgb', HDMI_MODE.RAW_RGB, 401, 53, 0xdd629520)
}

export function testFrameRefactorPreservesLuma2Bytes() {
  return testPinnedFrameBytes('Luma2', HDMI_MODE.LUMA_2, 401, 31, 0xe338dccd)
}

export function testFrameRefactorPreservesCodebook3Bytes() {
  return testPinnedFrameBytes('Tile3', HDMI_MODE.CODEBOOK_3, 401, 29, 0xd862dd50)
}

export function testFrameRefactorPreservesGlyph5Bytes() {
  return testPinnedFrameBytes('Glyph5', HDMI_MODE.GLYPH_5, 402, 41, 0x1fc74de1)
}

export function testDecodeDataRegionRoundtripsAllModes() {
  const modes = [
    HDMI_MODE.COMPAT_4,
    HDMI_MODE.RAW_GRAY,
    HDMI_MODE.RAW_RGB,
    HDMI_MODE.LUMA_2,
    HDMI_MODE.CODEBOOK_3,
    HDMI_MODE.GLYPH_5
  ]
  const width = 640
  const height = 407
  const failures = []

  for (const mode of modes) {
    const payload = new Uint8Array(getPayloadCapacity(width, height, mode))
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 17 + mode) & 0xFF

    const frame = buildFrame(payload, mode, width, height, 30, 42)
    const anchors = detectAnchors(frame, width, height)
    if (anchors.length < 2) {
      failures.push(`${mode}: anchors`)
      continue
    }
    const region = dataRegionFromAnchors(anchors)
    if (!region) {
      failures.push(`${mode}: region`)
      continue
    }
    const result = decodeDataRegion(frame, width, region)
    if (!result || !result.crcValid) {
      failures.push(`${mode}: crc`)
      continue
    }
    if (result.payload.length !== payload.length) {
      failures.push(`${mode}: len`)
      continue
    }
    if (!result.payload.every((v, i) => v === payload[i])) {
      failures.push(`${mode}: bytes`)
      continue
    }
  }

  const pass = failures.length === 0
  console.log('decodeDataRegion all-modes roundtrip test:', pass ? 'PASS' : `FAIL ${failures.join(', ')}`)
  return pass
}

export function testNativeGeometryGuidance() {
  const text = buildNativeGeometryGuidance().toLowerCase()
  const required = [
    '1920x1080',
    '@ 60',
    'browser fullscreen',
    'canvas internal',
    'canvas css',
    'browser zoom',
    'display scaling',
    'css transform',
    'pixelated'
  ]
  const missing = required.filter((token) => !text.includes(token.toLowerCase()))
  const pass = missing.length === 0
  console.log('Native geometry guidance test:', pass ? 'PASS' : `FAIL (missing: ${missing.join(', ')})`)
  return pass
}

export function testNative1080pGeometryCheck() {
  const ok = {
    renderPresetId: '1080p',
    width: 1920,
    height: 1080,
    displayWidth: 1920,
    displayHeight: 1080,
    displayScale: 1,
    displayX: 0,
    displayY: 0,
    fullscreenActive: true
  }
  const viewport = { ...ok, renderPresetId: 'viewport' }
  const scaled = { ...ok, displayWidth: 1728, displayHeight: 972, displayScale: 0.9 }
  const hidpiExternal = {
    ...ok,
    displayWidth: 1652,
    displayHeight: 929,
    displayScale: 0.86,
    devicePixelRatio: 1080 / 929,
    physicalDisplayWidth: 1920,
    physicalDisplayHeight: 1080,
    effectiveDisplayScale: 1
  }
  const notFullscreen = { ...ok, fullscreenActive: false }
  const pass = isNative1080pGeometry(ok) &&
    isNative1080pGeometry(hidpiExternal) &&
    !isNative1080pGeometry(viewport) &&
    !isNative1080pGeometry(scaled) &&
    !isNative1080pGeometry(notFullscreen)
  console.log('Native 1080p geometry check test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testEffectiveOneToOnePresentationCheck() {
  const cssScaledButPhysicalNative = {
    width: 1920,
    height: 1080,
    displayWidth: 1652,
    displayHeight: 929,
    displayScale: 0.86,
    devicePixelRatio: 1080 / 929,
    physicalDisplayWidth: 1920,
    physicalDisplayHeight: 1080,
    effectiveDisplayScale: 1
  }
  const physicallyScaled = {
    ...cssScaledButPhysicalNative,
    physicalDisplayWidth: 1652,
    physicalDisplayHeight: 929,
    effectiveDisplayScale: 0.86
  }
  const pass = hasEffectiveOneToOnePresentation(cssScaledButPhysicalNative) &&
    !hasEffectiveOneToOnePresentation(physicallyScaled)
  console.log('Effective one-to-one presentation check test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testClassifyStep() {
  const cases = [
    { sx: 3.00, sy: 3.00, expected: 'integer' },
    { sx: 3.02, sy: 3.01, expected: 'integer' },
    { sx: 3.20, sy: 3.20, expected: 'fractional' },
    { sx: 3.00, sy: 3.20, expected: 'skewed' },
    { sx: 4.00, sy: 4.00, expected: 'integer' }
  ]
  const fail = cases.find(({ sx, sy, expected }) => classifyStep(sx, sy) !== expected)
  const pass = !fail
  console.log('classifyStep test:', pass ? 'PASS' : `FAIL on ${JSON.stringify(fail)}`)
  return pass
}

export function testGray2FrameRoundtrip() {
  const payload = new Uint8Array(400)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 37) & 0xFF

  const width = 640
  const height = 480
  const frame = buildFrame(payload, HDMI_MODE.RAW_GRAY, width, height, 30, 42)
  const anchors = detectAnchors(frame, width, height)
  if (anchors.length < 2) {
    console.log('Gray2 frame roundtrip test: FAIL (anchors)')
    return false
  }

  const region = dataRegionFromAnchors(anchors)
  if (!region) {
    console.log('Gray2 frame roundtrip test: FAIL (no region)')
    return false
  }

  const result = decodeDataRegion(frame, width, region)
  const pass = result !== null &&
    result.crcValid &&
    result.header.mode === HDMI_MODE.RAW_GRAY &&
    result.payload.length === payload.length &&
    result.payload.every((v, i) => v === payload[i])

  console.log('Gray2 frame roundtrip test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testRgb3FrameRoundtrip() {
  const payload = new Uint8Array(401)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 53) & 0xFF

  const width = 640
  const height = 480
  const frame = buildFrame(payload, HDMI_MODE.RAW_RGB, width, height, 30, 42)
  const anchors = detectAnchors(frame, width, height)
  if (anchors.length < 2) {
    console.log('RGB3 frame roundtrip test: FAIL (anchors)')
    return false
  }

  const region = dataRegionFromAnchors(anchors)
  if (!region) {
    console.log('RGB3 frame roundtrip test: FAIL (no region)')
    return false
  }

  const result = decodeDataRegion(frame, width, region)
  const pass = result !== null &&
    result.crcValid &&
    result.header.mode === HDMI_MODE.RAW_RGB &&
    result.payload.length === payload.length &&
    result.payload.every((v, i) => v === payload[i])

  console.log('RGB3 frame roundtrip test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testLuma2FrameRoundtrip() {
  const payload = new Uint8Array(401)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xFF

  const width = 640
  const height = 480
  const frame = buildFrame(payload, HDMI_MODE.LUMA_2, width, height, 30, 42)
  const anchors = detectAnchors(frame, width, height)
  if (anchors.length < 2) {
    console.log('Luma2 frame roundtrip test: FAIL (anchors)')
    return false
  }

  const region = dataRegionFromAnchors(anchors)
  if (!region) {
    console.log('Luma2 frame roundtrip test: FAIL (no region)')
    return false
  }

  const result = decodeDataRegion(frame, width, region)
  const pass = result !== null &&
    result.crcValid &&
    result.header.mode === HDMI_MODE.LUMA_2 &&
    result.payload.length === payload.length &&
    result.payload.every((v, i) => v === payload[i])

  console.log('Luma2 frame roundtrip test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testLuma2Classifier() {
  const cases = [
    { samples: [230, 220, 20, 30], expected: 0 },
    { samples: [20, 30, 220, 230], expected: 1 },
    { samples: [225, 25, 235, 35], expected: 2 },
    { samples: [30, 230, 40, 220], expected: 3 }
  ]

  const pass = cases.every(({ samples, expected }) => decodeLuma2(samples, 0, 255) === expected)
  console.log('Luma2 classifier test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testCodebook3FrameRoundtrip() {
  const payload = new Uint8Array(401)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 29) & 0xFF

  const width = 640
  const height = 480
  const frame = buildFrame(payload, HDMI_MODE.CODEBOOK_3, width, height, 30, 42)
  const anchors = detectAnchors(frame, width, height)
  if (anchors.length < 2) {
    console.log('Tile3 frame roundtrip test: FAIL (anchors)')
    return false
  }

  const region = dataRegionFromAnchors(anchors)
  if (!region) {
    console.log('Tile3 frame roundtrip test: FAIL (no region)')
    return false
  }

  const result = decodeDataRegion(frame, width, region)
  const pass = result !== null &&
    result.crcValid &&
    result.header.mode === HDMI_MODE.CODEBOOK_3 &&
    result.payload.length === payload.length &&
    result.payload.every((v, i) => v === payload[i])

  console.log('Tile3 frame roundtrip test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testGlyph5FrameRoundtrip() {
  const payload = new Uint8Array(402)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 41) & 0xFF

  const width = 640
  const height = 480
  const frame = buildFrame(payload, HDMI_MODE.GLYPH_5, width, height, 30, 42)
  const anchors = detectAnchors(frame, width, height)
  if (anchors.length < 2) {
    console.log('Glyph5 frame roundtrip test: FAIL (anchors)')
    return false
  }

  const region = dataRegionFromAnchors(anchors)
  if (!region) {
    console.log('Glyph5 frame roundtrip test: FAIL (no region)')
    return false
  }

  const result = decodeDataRegion(frame, width, region)
  const pass = result !== null &&
    result.crcValid &&
    result.header.mode === HDMI_MODE.GLYPH_5 &&
    result.payload.length === payload.length &&
    result.payload.every((v, i) => v === payload[i])

  console.log('Glyph5 frame roundtrip test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testAnchorDetectionWithOffset() {
  // Build a frame at 400×300, embed it at offset (22, 20) in a 460×350 canvas
  // Simulates HDMI capture with small black borders (realistic scenario)
  const innerW = 400, innerH = 300
  const outerW = 460, outerH = 350
  const offsetX = 22, offsetY = 20

  const payload = new Uint8Array(100)
  for (let i = 0; i < payload.length; i++) payload[i] = i

  // Build inner frame
  const innerFrame = buildFrame(payload, HDMI_MODE.COMPAT_4, innerW, innerH, 30, 7)

  // Create outer canvas (black)
  const outer = new Uint8ClampedArray(outerW * outerH * 4)
  for (let i = 3; i < outer.length; i += 4) outer[i] = 255

  // Copy inner frame to offset position
  for (let y = 0; y < innerH; y++) {
    for (let x = 0; x < innerW; x++) {
      const srcIdx = (y * innerW + x) * 4
      const dstIdx = ((y + offsetY) * outerW + (x + offsetX)) * 4
      outer[dstIdx] = innerFrame[srcIdx]
      outer[dstIdx + 1] = innerFrame[srcIdx + 1]
      outer[dstIdx + 2] = innerFrame[srcIdx + 2]
    }
  }

  // Detect anchors in outer canvas
  const anchors = detectAnchors(outer, outerW, outerH)
  if (anchors.length < 2) {
    console.log('Anchor offset test: FAIL (found', anchors.length, 'anchors)')
    return false
  }

  const region = dataRegionFromAnchors(anchors)
  if (!region) {
    console.log('Anchor offset test: FAIL (no data region)')
    return false
  }
  const result = decodeDataRegion(outer, outerW, region)
  const pass = result !== null && result.crcValid && result.header.symbolId === 7

  console.log('Anchor offset test:', pass ? 'PASS' : 'FAIL')
  return pass
}
