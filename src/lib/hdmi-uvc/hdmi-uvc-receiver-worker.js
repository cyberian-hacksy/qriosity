// HDMI-UVC receiver worker — capture pipeline that runs frame capture,
// anchor lock, decode, and decoder ingest off the main thread, plus the
// shadow-decoder services (ingest/reset/reconstruct) the main thread uses
// while worker capture owns the decoder. Constructed from the receiver via
// Vite's ?worker&inline so all imports below bundle into a single inline
// blob and survive vite-plugin-singlefile.
//
// Protocol (main → worker):
//   { type: 'ping', id }
//   { type: 'initDecoder' }
//   { type: 'ingestBatch', id, parsedList }
//   { type: 'resetDecoder' }
//   { type: 'noteFrameBoundary', id? }
//   { type: 'reconstruct', id }
//   { type: 'startCaptureWithTrack', track, region, expectedPacketSize }
//   { type: 'startCaptureWithOffscreen', region, expectedPacketSize }
//   { type: 'captureBitmap', bitmap, expectedPacketSize }
//   { type: 'updateCaptureRegion', region, expectedPacketSize }
//   { type: 'setLabFrameTap', enabled }
//   { type: 'stopCapture' }
//
// Protocol (worker → main):
//   { type: 'ready', protocolVersion }
//   { type: 'pong', id }
//   { type: 'decoderDelta', ... }   // emitted on every ingest/reset
//   { type: 'reconstructResult', id, data?, error? }
//   { type: 'captureStarted', method: 'track'|'offscreen' }
//   { type: 'captureFrame', decodeResult, innovations, accepted, newSession,
//     completionEvent, solved, K, K_prime, symbolBreakdown, ... }
//   { type: 'captureStopped' }
//   { type: 'error', id?, message }

import {
  detectAnchors,
  dataRegionFromAnchors,
  decodeDataRegion,
  setLuma1SharpenCorrection
} from './hdmi-uvc-frame.js'
import { createDecoder } from '../decoder.js'
import { ingestCapturedFrame } from './hdmi-uvc-capture-pump.js'
import { buildArqPacketObservations } from './hdmi-uvc-arq-observation.js'
import { computeLockedCaptureRect, getWorkerCaptureCopyRect } from './hdmi-uvc-receiver-capture.js'
import { loadHdmiUvcWasm, setHdmiUvcWasmUrl } from './hdmi-uvc-wasm.js'
import { extractParsedFramePackets as extractValidPacketsFromPayload } from './hdmi-uvc-packet-probe.js'

// WASM loading is driven by the main thread rather than at module boot:
// Vite's ?worker&inline bootstraps the worker from a blob: (dev) or data:
// (single-file prod) URL, and the URL spec rejects both as a base for relative
// resolution. The main thread computes an absolute URL from document.baseURI
// and posts `{ type: 'configureWasm', url }`; the handler below calls
// setHdmiUvcWasmUrl() + loadHdmiUvcWasm() and errors are surfaced back.

const WORKER_PROTOCOL_VERSION = 2

// Keep the shadow decoder singleton so initDecoder can be called multiple
// times in a session (e.g., receive-another flow) without leaking state.
let decoder = null

function serializeRegion(region) {
  if (!region) return null
  // Shallow copy — fields are all primitives / small arrays.
  return { ...region }
}

function ensureDecoder() {
  if (!decoder) decoder = createDecoder()
  return decoder
}

function currentSymbolBreakdown() {
  if (!decoder) {
    return {
      unique: 0,
      duplicate: 0,
      sourceCount: 0,
      parityCount: 0,
      fountainCount: 0,
      metadataCount: 0
    }
  }
  try {
    // The decoder exposes `symbolBreakdown` as a getter (decoder.js:492) —
    // calling that delegates to its internal incremental counters.
    return decoder.symbolBreakdown || null
  } catch (_) {
    return null
  }
}

function decoderDelta(extra = {}) {
  const d = decoder
  if (!d) return { type: 'decoderDelta' }
  return {
    type: 'decoderDelta',
    solved: d.solved,
    solvedTotal: d.solvedTotal,
    // O(K) array; only shipped while the ARQ back-channel needs it for
    // seeding the receiver controller's received-set.
    solvedSourceIds: arqObservationsEnabled ? (d.solvedSourceIds ?? null) : null,
    fileId: d.fileId ?? null,
    K: d.K ?? null,
    K_prime: d.K_prime ?? null,
    blockSize: d.blockSize ?? 0,
    progress: d.progress ?? 0,
    uniqueSymbols: d.uniqueSymbols ?? 0,
    pendingSymbolCount: d.pendingSymbolCount ?? 0,
    unresolvedSourceCount: d.unresolvedSourceCount ?? null,
    metadata: d.metadata ?? null,
    telemetry: d.telemetry ?? null,
    isComplete: typeof d.isComplete === 'function' ? d.isComplete() : false,
    symbolBreakdown: currentSymbolBreakdown(),
    ...extra
  }
}

function handleInitDecoder() {
  decoder = createDecoder()
  return decoderDelta()
}

function serializeDecodeHeader(header) {
  if (!header) return null
  // Structured clone handles nested plain objects / typed arrays natively,
  // so we mostly just forward the shape. _diag may carry non-structurable
  // refs; strip via JSON round-trip only if it causes a serialization issue
  // in practice — today the receiver's _diag consumers accept any shape.
  return {
    magic: header.magic,
    mode: header.mode,
    width: header.width,
    height: header.height,
    fps: header.fps,
    symbolId: header.symbolId,
    payloadLength: header.payloadLength,
    payloadCrc: header.payloadCrc
  }
}

function decoderPacketSession(d = decoder) {
  if (!d) return null
  const fileId = d.fileId
  const k = d.K_prime
  if (fileId == null && k == null) return null
  return { fileId, k }
}

function handleIngestBatch(msg) {
  const d = ensureDecoder()
  const parsedList = msg.parsedList || []
  let innovations = 0
  let newSession = false
  for (const parsed of parsedList) {
    if (!parsed) continue
    let result = typeof d.receiveParsed === 'function' ? d.receiveParsed(parsed) : false
    if (result === 'new_session') {
      newSession = true
      if (typeof d.reset === 'function') d.reset()
      result = d.receiveParsed(parsed)
    }
    if (result === true) innovations++
  }
  const isComplete = typeof d.isComplete === 'function' ? d.isComplete() : false
  return {
    type: 'ingestBatchResult',
    id: msg.id,
    innovations,
    accepted: parsedList.length,
    newSession,
    completionEvent: isComplete,
    // No arqPackets here: the ingestBatch caller (main-thread capture) feeds
    // noteArqParsedPackets from its own parsedList and ignores the field.
    // Snapshot of decoder state so the main thread can update the shadow in
    // the same tick as innovation accounting — no dual-channel staleness.
    solved: d.solved,
    solvedTotal: d.solvedTotal,
    // O(K) array; only shipped while the ARQ back-channel needs it for
    // seeding the receiver controller's received-set.
    solvedSourceIds: arqObservationsEnabled ? (d.solvedSourceIds ?? null) : null,
    fileId: d.fileId ?? null,
    K: d.K ?? null,
    K_prime: d.K_prime ?? null,
    blockSize: d.blockSize ?? 0,
    progress: d.progress ?? 0,
    uniqueSymbols: d.uniqueSymbols ?? 0,
    pendingSymbolCount: d.pendingSymbolCount ?? 0,
    unresolvedSourceCount: d.unresolvedSourceCount ?? null,
    metadata: d.metadata ?? null,
    telemetry: d.telemetry ?? null,
    isComplete,
    symbolBreakdown: currentSymbolBreakdown()
  }
}

function handleResetDecoder() {
  if (decoder && typeof decoder.reset === 'function') decoder.reset()
  return decoderDelta()
}

function handleNoteFrameBoundary(msg) {
  let recovered = 0
  if (decoder && typeof decoder.noteFrameBoundary === 'function') {
    const r = decoder.noteFrameBoundary()
    if (typeof r === 'number') recovered = r
  }
  // noteFrameBoundary can trigger the tail solver which may close the file;
  // always emit a fresh delta so the main thread sees the new state.
  const reply = decoderDelta({
    completionEvent:
      decoder && typeof decoder.isComplete === 'function' && decoder.isComplete(),
    frameBoundaryRecovered: recovered
  })
  if (msg && msg.id) reply.id = msg.id
  return reply
}

function handleReconstruct(msg) {
  try {
    const d = ensureDecoder()
    const data = typeof d.reconstruct === 'function' ? d.reconstruct() : null
    if (!data) {
      return {
        type: 'reconstructResult',
        id: msg.id,
        error: 'Worker decoder has no reconstruct() or returned null'
      }
    }
    // Transfer the backing buffer so the main thread gets it zero-copy.
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    return {
      reply: { type: 'reconstructResult', id: msg.id, data: buf },
      transfer: [buf]
    }
  } catch (err) {
    return {
      type: 'reconstructResult',
      id: msg.id,
      error: (err && err.message) ? err.message : String(err)
    }
  }
}

// === Phase 3.3: worker-side capture pump =====================================
// captureState holds the reader + config for the active pump loop. Exactly one
// pump may run at a time; stopCapture sets `stopped` so the loop exits on its
// next iteration.
let captureState = null
let labFrameTapEnabled = false
let arqObservationsEnabled = false

function postCaptureStopped() {
  self.postMessage({ type: 'captureStopped' })
}

function postCaptureFrameMessage(message, pixelBuffer, width, height) {
  if (captureState?.labFrameTapEnabled && pixelBuffer && width > 0 && height > 0) {
    const copy = new Uint8ClampedArray(pixelBuffer)
    message.labFrame = {
      buffer: copy.buffer,
      width,
      height
    }
    self.postMessage(message, [copy.buffer])
    return
  }
  self.postMessage(message)
}

function buildCaptureFrameMessage(result) {
  const d = decoder
  const isComplete = d && typeof d.isComplete === 'function' ? d.isComplete() : false
  const dr = result.decodeResult
  return {
    type: 'captureFrame',
    decodeResult: dr ? {
      crcValid: !!dr.crcValid,
      header: serializeDecodeHeader(dr.header),
      payloadLength: dr.payload ? dr.payload.length : 0,
      _diag: dr._diag || null
    } : null,
    innovations: result.innovations,
    accepted: result.accepted,
    newSession: result.newSession,
    arqPackets: arqObservationsEnabled ? (result.arqPackets || []) : [],
    completionEvent: isComplete,
    solved: d ? d.solved : 0,
    solvedTotal: d ? d.solvedTotal : 0,
    fileId: d ? (d.fileId ?? null) : null,
    K: d ? (d.K ?? null) : null,
    K_prime: d ? (d.K_prime ?? null) : null,
    blockSize: d ? (d.blockSize ?? 0) : 0,
    progress: d ? (d.progress ?? 0) : 0,
    uniqueSymbols: d ? (d.uniqueSymbols ?? 0) : 0,
    pendingSymbolCount: d ? (d.pendingSymbolCount ?? 0) : 0,
    unresolvedSourceCount: d ? (d.unresolvedSourceCount ?? null) : null,
    metadata: d ? (d.metadata ?? null) : null,
    telemetry: d ? (d.telemetry ?? null) : null,
    isComplete,
    symbolBreakdown: currentSymbolBreakdown(),
    salvaged: result.salvaged || 0
  }
}

function ensurePumpPixelBuffer(pixelCount) {
  const required = pixelCount * 4
  if (!captureState.pixelBuffer || captureState.pixelBuffer.length !== required) {
    captureState.pixelBuffer = new Uint8ClampedArray(required)
  }
  return captureState.pixelBuffer
}

async function captureLoopWithTrack(reader) {
  try {
    while (!captureState.stopped) {
      const { value: frame, done } = await reader.read()
      if (done) break
      if (!frame) continue
      try {
        await processCapturedVideoFrame(frame)
      } catch (err) {
        self.postMessage({
          type: 'error',
          message: 'capture loop: ' + ((err && err.message) ? err.message : String(err))
        })
      } finally {
        frame.close()
      }
    }
  } finally {
    try { reader.cancel() } catch (_) { /* ignore */ }
    captureState = null
    postCaptureStopped()
  }
}

// Single-frame processing path. Owns anchor acquisition so the worker does
// not depend on the main thread to discover a locked ROI first — that closes
// Finding 2 of the 2026-04-21 review: the stated Phase 3 goal is "anchor
// detection + decode entirely off-main-thread."
//
// Strategy: full-frame copy every frame until dataRegionFromAnchors succeeds,
// then cache the region in captureState.region and reuse it for subsequent
// frames. The cached region is cleared by `stopCapture` or by the main thread
// posting `updateCaptureRegion` with { region: null }.
// Pump logic for a single pixel buffer. Supports two incoming shapes:
//   * pre-lock: pixelBuffer is the full frame (width/height match the full
//     frame). runCapturePumpOnBuffer detects anchors, caches the narrowed
//     sourceRect + translated region for subsequent frames, and decodes the
//     current frame against the *un*translated region so the first frame
//     post-lock isn't wasted.
//   * post-lock: pixelBuffer is the ROI crop (width/height match
//     captureState.region.sourceRect). The translated region is used
//     directly; no anchor detection.
//
// fullFrameWidth/fullFrameHeight are needed for ROI computation (clamping
// sourceRect against the true source dimensions). When the caller can't
// distinguish (offscreen path), they fall back to width/height.
function runCapturePumpOnBuffer(pixelBuffer, width, height, fullFrameWidth, fullFrameHeight) {
  const cached = captureState.region
  let decodeRegion = null
  let newlyLocked = false

  if (cached && cached.region) {
    // Post-lock. Pick the right region based on whether the buffer we got is
    // the cropped ROI (track path steady state) or still full-frame (a
    // captureBitmap that was in flight before the main thread received
    // captureAnchorsLocked).
    if (
      cached.sourceRect &&
      width === cached.sourceRect.w &&
      height === cached.sourceRect.h
    ) {
      decodeRegion = cached.region
    } else {
      decodeRegion = cached.regionFull || cached.region
    }
  } else {
    const anchors = detectAnchors(pixelBuffer, width, height)
    if (anchors && anchors.length >= 2) {
      const candidate = dataRegionFromAnchors(anchors)
      if (candidate) {
        // Decode this frame against the full-frame candidate (coords match
        // pixelBuffer). Cache the narrowed ROI + translated region so
        // subsequent frames can stay on the hot path.
        decodeRegion = candidate
        const srcW = fullFrameWidth || width
        const srcH = fullFrameHeight || height
        const locked = computeLockedCaptureRect(candidate, srcW, srcH)
        captureState.region = locked
          ? {
              sourceRect: locked.sourceRect,
              region: locked.region,
              regionFull: candidate
            }
          : { sourceRect: null, region: candidate, regionFull: candidate }
        newlyLocked = true
      }
    }
  }

  if (!decodeRegion) {
    postCaptureFrameMessage({
      type: 'captureFrame',
      scanning: true,
      decodeResult: null,
      innovations: 0,
      accepted: 0,
      newSession: false,
      completionEvent: false,
      symbolBreakdown: currentSymbolBreakdown()
    }, pixelBuffer, width, height)
    return
  }

  if (newlyLocked) {
    self.postMessage({
      type: 'captureAnchorsLocked',
      region: serializeRegion(captureState.region.region),
      sourceRect: captureState.region.sourceRect || null
    })
  }

  const result = ingestCapturedFrame({
    pixelBuffer,
    width,
    region: decodeRegion,
    expectedPacketSize: captureState.expectedPacketSize,
    decoder: ensureDecoder(),
    decodeDataRegionFn: decodeDataRegion,
    extractFn: extractValidPacketsFromPayload,
    arqEnabled: arqObservationsEnabled
  })

  postCaptureFrameMessage(buildCaptureFrameMessage(result), pixelBuffer, width, height)
}

async function processCapturedVideoFrame(frame) {
  const frameWidth = frame.displayWidth || frame.codedWidth
  const frameHeight = frame.displayHeight || frame.codedHeight
  if (!frameWidth || !frameHeight) return

  const cached = captureState.region
  const copyRect = getWorkerCaptureCopyRect(cached, frameWidth, frameHeight, captureState.labFrameTapEnabled)

  const bufWidth = copyRect.width
  const bufHeight = copyRect.height
  const pixelBuffer = ensurePumpPixelBuffer(bufWidth * bufHeight)

  await frame.copyTo(pixelBuffer, {
    rect: copyRect,
    format: 'RGBA',
    colorSpace: 'srgb'
  })

  runCapturePumpOnBuffer(pixelBuffer, bufWidth, bufHeight, frameWidth, frameHeight)
}

// Phase 3.5 offscreen fallback: the main thread ships an ImageBitmap (via
// createImageBitmap(video), transferable) and the worker does the getImageData
// + anchor + decode locally. Slower than the track path (one extra copy +
// readback) but portable — MediaStreamTrackProcessor isn't available on every
// platform, while createImageBitmap + OffscreenCanvas is near-universal.
let offscreenPumpCanvas = null
let offscreenPumpCtx = null
function ensureOffscreenPumpCanvas(width, height) {
  if (!offscreenPumpCanvas) {
    offscreenPumpCanvas = new OffscreenCanvas(width, height)
    offscreenPumpCtx = offscreenPumpCanvas.getContext('2d', {
      willReadFrequently: true,
      alpha: false,
      colorSpace: 'srgb'
    })
  } else if (offscreenPumpCanvas.width !== width || offscreenPumpCanvas.height !== height) {
    offscreenPumpCanvas.width = width
    offscreenPumpCanvas.height = height
  }
  return offscreenPumpCtx
}

function handleCaptureBitmap(msg) {
  const bitmap = msg && msg.bitmap
  if (!bitmap) return
  if (!captureState || captureState.method !== 'offscreen') {
    try { bitmap.close() } catch (_) { /* ignore */ }
    return
  }
  if (captureState.stopped) {
    try { bitmap.close() } catch (_) { /* ignore */ }
    return
  }
  if (msg.expectedPacketSize != null) {
    captureState.expectedPacketSize = msg.expectedPacketSize
  }
  try {
    const ctx = ensureOffscreenPumpCanvas(bitmap.width, bitmap.height)
    if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable')
    ctx.drawImage(bitmap, 0, 0)
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    // For the offscreen path the main thread may have already narrowed the
    // bitmap to the ROI (once it's received sourceRect via
    // captureAnchorsLocked). Either way, width/height always match the
    // incoming bitmap; runCapturePumpOnBuffer handles both cases.
    runCapturePumpOnBuffer(imageData.data, bitmap.width, bitmap.height, bitmap.width, bitmap.height)
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: 'captureBitmap: ' + ((err && err.message) ? err.message : String(err))
    })
  } finally {
    try { bitmap.close() } catch (_) { /* ignore */ }
  }
}

function handleStartCaptureWithTrack(msg) {
  if (captureState) {
    self.postMessage({
      type: 'error',
      message: 'startCaptureWithTrack: capture already active'
    })
    return
  }
  if (typeof MediaStreamTrackProcessor === 'undefined') {
    self.postMessage({
      type: 'error',
      message: 'startCaptureWithTrack: MediaStreamTrackProcessor unavailable in worker'
    })
    return
  }
  if (!msg.track) {
    self.postMessage({
      type: 'error',
      message: 'startCaptureWithTrack: missing track'
    })
    return
  }
  let processor
  try {
    processor = new MediaStreamTrackProcessor({ track: msg.track })
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: 'startCaptureWithTrack: ' + ((err && err.message) ? err.message : String(err))
    })
    return
  }
  const reader = processor.readable.getReader()
  captureState = {
    method: 'track',
    reader,
    region: msg.region || null,
    expectedPacketSize: msg.expectedPacketSize || null,
    labFrameTapEnabled: !!msg.labFrameTapEnabled || labFrameTapEnabled,
    stopped: false,
    pixelBuffer: null
  }
  self.postMessage({ type: 'captureStarted', method: 'track' })
  // Run the loop detached; errors post via the error channel.
  void captureLoopWithTrack(reader)
}

function handleStartCaptureWithOffscreen(msg) {
  // Phase 3.5: main thread drives frames via createImageBitmap and pushes
  // captureBitmap messages; worker reads, detects anchors, and pumps.
  if (captureState) {
    self.postMessage({
      type: 'error',
      message: 'startCaptureWithOffscreen: capture already active'
    })
    return
  }
  captureState = {
    method: 'offscreen',
    region: msg.region || null,
    expectedPacketSize: msg.expectedPacketSize || null,
    labFrameTapEnabled: !!msg.labFrameTapEnabled || labFrameTapEnabled,
    stopped: false,
    pixelBuffer: null
  }
  self.postMessage({ type: 'captureStarted', method: 'offscreen' })
}

function handleUpdateCaptureRegion(msg) {
  if (!captureState) return
  // Explicit null/false clears the cached region — main thread uses this to
  // force worker re-acquisition (e.g., after a decode-failure streak or a
  // receive-another reset). Undefined leaves the cache alone.
  if ('region' in msg) captureState.region = msg.region || null
  if (msg.expectedPacketSize != null) captureState.expectedPacketSize = msg.expectedPacketSize
}

function handleSetLabFrameTap(msg) {
  labFrameTapEnabled = !!msg.enabled
  if (captureState) captureState.labFrameTapEnabled = labFrameTapEnabled
}

function handleSetArqEnabled(msg) {
  arqObservationsEnabled = !!msg.enabled
}

function handleStopCapture() {
  if (!captureState) {
    postCaptureStopped()
    return
  }
  captureState.stopped = true
  // For the offscreen stub there's no loop to exit; emit the done signal now.
  if (captureState.method === 'offscreen') {
    captureState = null
    postCaptureStopped()
  }
  // For the track pump the loop's finally block posts captureStopped.
}

self.onmessage = (event) => {
  const msg = event.data
  if (!msg || typeof msg !== 'object') return
  try {
    let reply = null
    let transfer = null
    switch (msg.type) {
      case 'ping':
        reply = { type: 'pong', id: msg.id }
        break
      case 'configureWasm':
        // Main thread hands us an absolute URL derived from document.baseURI.
        // Without this the inline worker's blob:/data: self.location is
        // unusable as a base and WASM silently falls back to JS.
        if (typeof msg.url === 'string' && msg.url.length > 0) {
          setHdmiUvcWasmUrl(msg.url)
          loadHdmiUvcWasm()
            .then(() => self.postMessage({ type: 'wasmReady' }))
            .catch((err) => self.postMessage({
              type: 'error', message: 'wasm load: ' + (err?.message || err)
            }))
        }
        break
      case 'setSharpenLambda':
        // frame.js keeps the LUMA_1 peaking correction in a module-level
        // global, and this worker holds its own module instance — without
        // this push it would decode every LUMA_1 frame uncorrected while the
        // main thread and the read pool decode with the correction armed.
        setLuma1SharpenCorrection(
          Number.isFinite(msg.lambda) && msg.lambda > 0 ? msg.lambda : null
        )
        break
      case 'initDecoder':
        reply = handleInitDecoder()
        break
      case 'ingestBatch':
        reply = handleIngestBatch(msg)
        break
      case 'resetDecoder':
        reply = handleResetDecoder()
        break
      case 'noteFrameBoundary':
        reply = handleNoteFrameBoundary(msg)
        break
      case 'reconstruct': {
        const res = handleReconstruct(msg)
        if (res.reply) { reply = res.reply; transfer = res.transfer }
        else reply = res
        break
      }
      case 'startCaptureWithTrack':
        handleStartCaptureWithTrack(msg)
        break
      case 'startCaptureWithOffscreen':
        handleStartCaptureWithOffscreen(msg)
        break
      case 'captureBitmap':
        handleCaptureBitmap(msg)
        break
      case 'updateCaptureRegion':
        handleUpdateCaptureRegion(msg)
        break
      case 'setLabFrameTap':
        handleSetLabFrameTap(msg)
        break
      case 'setArqEnabled':
        handleSetArqEnabled(msg)
        break
      case 'stopCapture':
        handleStopCapture()
        break
      default:
        reply = {
          type: 'error',
          id: msg.id,
          message: `Unknown message type: ${msg.type}`
        }
    }
    if (reply) {
      if (transfer && transfer.length) self.postMessage(reply, transfer)
      else self.postMessage(reply)
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      id: msg && msg.id,
      message: (err && err.message) ? err.message : String(err)
    })
  }
}

self.postMessage({ type: 'ready', protocolVersion: WORKER_PROTOCOL_VERSION })
