// HDMI-UVC Receiver module - captures from UVC device and decodes frames

import { createDecoder } from '../decoder.js'
import { PACKET_HEADER_SIZE, parsePacket, isMetadataFlag, packetModeFromFlags } from '../packet.js'
import { formatBytes, formatTime } from '../format.js'
import { playBeep, announce, copyWithButtonFeedback } from '../feedback.js'
import { confirmDialog } from '../confirm-dialog.js'
import { isRepairIdleMetadataPayload } from '../metadata.js'
import { ArqReceiverController, getArqBeaconLogAction } from '../arq/arq-receiver.js'
import { ARQ_HELPER_STATUS, getArqHelperStatusView, shouldAutoConnectArqHelper } from '../arq/helper-status.js'
import { getTransport } from '../arq/backchannel.js'
import { getSelectedArqTransportName } from '../arq/default-transports.js'
import { initArqTransportSelect } from '../arq/arq-transport-ui.js'
import {
  BLOCK_SIZE,
  DEVICE_STORAGE_KEY,
  HDMI_MODE,
  HDMI_MODE_NAMES,
  HEADER_SIZE,
  getModeHeaderBlockSize
} from './hdmi-uvc-constants.js'
import {
  detectAnchors,
  dataRegionFromAnchors,
  decodeDataRegion,
  readPayloadWithLayout,
  resetClassifierPerfAccumulator,
  setLuma1SweepBudgetFast,
  setLuma1SweepTimeBudgetMs,
  setLuma1DebugCapture,
  setLuma1SharpenCorrection,
  getLuma1SharpenCorrection,
  sweepLuma1SharpenCorrection,
  isLuma1CalibrationPayload,
  getClassifierPerfAccumulator,
  setWasmClassifierEnabled
} from './hdmi-uvc-frame.js'
import ReceiverWorker from './hdmi-uvc-receiver-worker.js?worker&inline'
import ReadWorker from './hdmi-uvc-read-worker.js?worker&inline'
import {
  detectCaptureCapabilities,
  chooseCaptureMethod,
  getWorkerTrackTransferFallback,
  getReceiverExpectedPacketSize,
  shouldStartReceiverTransferClock,
  shouldScheduleMainCaptureAfterWorkerStart,
  computeLockedCaptureRect,
  getWorkerCaptureCopyRect,
  shouldUseLockedCaptureRegion,
  shouldRecordReceiverHotPerfFrame,
  shouldRebenchmarkReceiverRoiCapture,
  shouldStartReceiverRoiWarmupBenchmark,
  shouldLogReceiverCapturePathChange
} from './hdmi-uvc-receiver-capture.js'
import { loadHdmiUvcWasm, acquireWasmFrameView, isHdmiUvcWasmLoaded } from './hdmi-uvc-wasm.js'
import {
  getCaptureMethod as getCaptureMethodSetting,
  getReadPoolEnabledAtInit,
  getReadPoolWorkersAtInit,
  getWasmCaptureEnabledAtInit,
  getWasmClassifierEnabled
} from './hdmi-uvc-diagnostics.js'
import { renderDiagnosticSettings } from './hdmi-uvc-diagnostics-ui.js'
import {
  clearDenseBinaryLockState,
  lockDenseBinaryLayoutFromDecodeResult,
  lockDenseBinaryLayoutState,
  noteDenseBinaryUnrecoveredCrcFailure
} from './hdmi-uvc-dense-binary-lock.js'
import {
  probeFramePackets
} from './hdmi-uvc-packet-probe.js'
import { initDiagnosticsPanelToggle } from './hdmi-uvc-debug-log.js'
import {
  PERF_MODE,
  debugLog,
  debugCurrent,
  debugLogBuffer,
  flushDebugLogRender,
  setReceiverDiagPanelVisible,
  isReceiverDiagPanelVisible
} from './hdmi-uvc-receiver-debug.js'
import {
  buildReceiverPacketFrameSignature,
  buildReceiverPreIngestedFrameSignature,
  classifyReceiverFrameSignature,
  clearReceiverPerfSamples,
  createReceiverPerfState,
  getLockedFastStageSummary,
  getReceiverFrameSignatureSummary,
  getReceiverFrameUseSummary,
  getReceiverPacketYieldSummary,
  updateFrameAcceptSignals
} from './hdmi-uvc-receiver-perf.js'
import { averagePerfWindow, recordPerfSample } from './hdmi-uvc-perf-window.js'
import {
  state,
  createCaptureTuningState,
  CAPTURE_BENCHMARK_SAMPLES_PER_METHOD
} from './hdmi-uvc-receiver-state.js'
import { triggerBlobDownload } from '../shared/download.js'
import { listVideoInputs, populateCameraSelect } from '../shared/camera.js'
import {
  applyArqReceiverHelperStatus,
  autoConnectArqHelper,
  connectArqHelper,
  identifyMacKeyboard,
  noteArqParsedPackets,
  requestArqFullRepair,
  resetArqReceiverSession,
  sendArqCompleteIfReady,
  setArqReceiverHooks
} from './hdmi-uvc-receiver-arq.js'

// Kick off WASM instantiation on the main thread so the ?capture=main fallback
// path (which runs decodeDataRegion on the main thread) uses the WASM CRC32
// from the first decoded frame. Swallowed errors fall back to JS crc32.
loadHdmiUvcWasm().catch(() => {})

// Interval/pipeline knobs derived from PERF_MODE (see receiver-debug module);
// captured at init time because each is baked in for the session.
const RX_PERF_LOG_INTERVAL_FRAMES = PERF_MODE ? 240 : 60
const RX_PROGRESS_LOG_INTERVAL_FRAMES = PERF_MODE ? 40 : 10
const RECEIVER_UI_UPDATE_INTERVAL_MS = PERF_MODE ? 500 : 120
const LOCKED_LAYOUT_RECOVERY_PROBE_INTERVAL_FRAMES = 8
const LOCKED_BINARY3_INVALIDATE_AFTER_FAILS = 5
const BINARY3_CONFIDENCE_LOG_INTERVAL_FRAMES = PERF_MODE ? 120 : 30
const CAPTURE_BENCH_ONLY = typeof location !== 'undefined' &&
  new URLSearchParams(location.search).has('captureBench')
const ANCHOR_SCAN_DIAGNOSTICS = typeof location !== 'undefined' &&
  new URLSearchParams(location.search).has('anchorDiag')
// Capture pipeline: 'main' (drawImage/getImageData on main thread), 'worker'
// (MediaStreamTrackProcessor + VideoFrame.copyTo in worker), 'offscreen'
// (createImageBitmap + OffscreenCanvas transferred to worker). 'main' is the
// safe fallback at every branch. Diagnostic setting 'auto' → feature-detect.
const CAPTURE_CAPABILITIES = detectCaptureCapabilities()
const CAPTURE_METHOD = (() => {
  const setting = getCaptureMethodSetting()
  const preferred = setting === 'auto' ? null : setting
  return chooseCaptureMethod(CAPTURE_CAPABILITIES, preferred)
})()
function recoverFromHashMismatch() {
  // Without a dispatched ARQ full-repair NACK there is no repair path;
  // discarding the decoder would strand the receiver at 0% forever.
  if (!requestArqFullRepair('hash-mismatch')) return false
  state.completedFile = null
  state.completionStarted = false
  state.isScanning = true
  state.progressSamples = []
  state.lastReceivingUiUpdateMs = 0
  if (receiverWorkerDecoderState) {
    state.workerCompletionSuppressed = true
    receiverWorkerDecoderState.completionHandled = true
  }
  if (state.decoder && typeof state.decoder.reset === 'function') {
    state.decoder.reset()
    if (receiverWorkerDecoderState) receiverWorkerDecoderState.completionHandled = true
  } else {
    state.decoder = null
  }
  showReceivingStatus()
  scheduleNextFrame()
  return true
}

function shouldUpdateReceiverUi(lastUpdateMs, nowMs, force = false) {
  if (force) return true
  if (!Number.isFinite(lastUpdateMs) || lastUpdateMs <= 0) return true
  return (nowMs - lastUpdateMs) >= RECEIVER_UI_UPDATE_INTERVAL_MS
}

// Worker client for the capture pipeline. Constructed via Vite's
// ?worker&inline so all module imports inside the worker (frame.js, decoder,
// etc.) bundle into a single inline Blob and survive vite-plugin-singlefile.
// The worker silently disables itself on construction error so the receiver
// keeps working on the main thread.
// Give the ARQ session module its two receiver-side effects (error banner,
// worker state mirror) without a circular import.
setArqReceiverHooks({
  showError: (msg) => showError(msg),
  postArqStateToWorker: () => postArqStateToWorker()
})

let receiverWorker = null
let receiverWorkerReady = false
let receiverWorkerNextId = 1
let receiverWorkerFailed = false
const receiverWorkerPending = new Map()
// Shadow state mirror for the worker's decoder during worker-driven capture.
// The main thread reads from this object like it used to read from the
// in-process decoder; the worker ships back deltas on every ingest/reset.
let receiverWorkerDecoderState = null
// Pending reconstruct requests keyed by id → { resolve, reject }.
const receiverWorkerReconstructPending = new Map()

function initReceiverWorker() {
  // The worker exists for the worker-side capture path
  // (CAPTURE_METHOD='worker'/'offscreen'); the main-thread path needs none.
  const captureNeedsWorker = CAPTURE_METHOD === 'worker' || CAPTURE_METHOD === 'offscreen'
  if (!captureNeedsWorker) return false
  if (receiverWorker) return true
  if (receiverWorkerFailed) return false
  try {
    receiverWorker = new ReceiverWorker()
    receiverWorker.onmessage = handleReceiverWorkerMessage
    receiverWorker.onerror = (event) => {
      debugLog(`Worker error: ${event.message || 'unknown'} — falling back to main thread`)
      teardownReceiverWorker(true)
    }
    receiverWorker.onmessageerror = () => {
      debugLog('Worker message deserialization failed — falling back to main thread')
      teardownReceiverWorker(true)
    }
    // Resolve the WASM URL on the main thread (document.baseURI) and hand it
    // to the worker. The inline worker's own self.location is a blob:/data:
    // URL that URL resolution rejects as a base, so without this the worker
    // silently falls back to the JS crc32/scanBrightRuns implementations.
    try {
      const wasmUrl = new URL('hdmi-uvc/hdmi_uvc.wasm', document.baseURI).href
      receiverWorker.postMessage({ type: 'configureWasm', url: wasmUrl })
    } catch (err) {
      debugLog(`Failed to post WASM URL to worker: ${err?.message || err}`)
    }
    debugLog(`Worker capture client started (${CAPTURE_METHOD})`)
    return true
  } catch (err) {
    debugLog(`Worker construction failed: ${(err && err.message) || err} — falling back to main thread`)
    teardownReceiverWorker(true)
    return false
  }
}

function teardownReceiverWorker(markFailed = false) {
  if (receiverWorker) {
    try { receiverWorker.terminate() } catch (_) { /* ignore */ }
    receiverWorker = null
  }
  receiverWorkerReady = false
  // If worker-driven capture was active when the worker died, clear the
  // flags so scheduleNextFrame falls back to the main-thread processFrame
  // path instead of silently dropping frames.
  const wasWorkerCapturing = state.workerCaptureActive ||
    state.workerCapturePending ||
    state.offscreenCaptureActive
  state.workerCaptureActive = false
  state.workerCapturePending = false
  state.offscreenCaptureActive = false
  state.workerCaptureStartPendingAfterStop = false
  state.workerCaptureStopRequested = false
  receiverWorkerPending.clear()
  if (wasWorkerCapturing && state.isScanning) {
    // Kick the main-thread loop so the user doesn't freeze on a dead worker.
    scheduleNextFrame()
  }
  // Reject any pending reconstruct requests so callers don't hang forever.
  for (const { reject } of receiverWorkerReconstructPending.values()) {
    try { reject(new Error('Worker terminated')) } catch (_) { /* ignore */ }
  }
  receiverWorkerReconstructPending.clear()
  if (markFailed) receiverWorkerFailed = true
}

// === Phase 3.4: worker-side capture orchestration ============================
// When CAPTURE_METHOD === 'worker', the main thread hands a MediaStreamTrack
// clone to the worker and stops scheduling its own processFrame loop. The
// worker self-acquires anchors and pumps captureFrame messages back; the
// main thread updates the shadow decoder + UI from those deltas.

// Arm a short safety timeout: if the worker never posts captureStarted
// (silent crash, handler exception before the ack), clear the pending flag
// and fall back to the main-thread loop instead of wedging scanning.
const WORKER_CAPTURE_START_TIMEOUT_MS = 2000
function armWorkerCaptureStartTimeout() {
  if (state.workerCaptureStartDeadlineId) {
    clearTimeout(state.workerCaptureStartDeadlineId)
  }
  state.workerCaptureStartDeadlineId = setTimeout(() => {
    state.workerCaptureStartDeadlineId = null
    if (state.workerCaptureActive) return
    if (!state.workerCapturePending) return
    debugLog(
      `Worker capture startup timed out after ${WORKER_CAPTURE_START_TIMEOUT_MS}ms — ` +
      `falling back to main-thread processFrame`
    )
    fallBackFromWorkerCapture()
  }, WORKER_CAPTURE_START_TIMEOUT_MS)
}

function clearWorkerCaptureStartTimeout() {
  if (state.workerCaptureStartDeadlineId) {
    clearTimeout(state.workerCaptureStartDeadlineId)
    state.workerCaptureStartDeadlineId = null
  }
}

function fallBackFromWorkerCapture() {
  clearWorkerCaptureStartTimeout()
  const wasActive = state.workerCaptureActive || state.offscreenCaptureActive || state.workerCapturePending
  state.workerCapturePending = false
  state.workerCaptureActive = false
  state.offscreenCaptureActive = false
  state.workerCaptureSourceRect = null
  state.offscreenBitmapInFlightAt = null
  // If a restart was deferred behind a stopCapture ack, fall-back means
  // we're abandoning worker mode for this session — drop the pending start
  // so captureStopped doesn't try to resume into it.
  state.workerCaptureStartPendingAfterStop = false
  // startWorkerCapture / startOffscreenCapture create a worker-backed shadow
  // decoder before the worker ack arrives. On fallback, the shadow's
  // receiveParsed() returns false synchronously and only queues async
  // ingestBatch work — breaking the main-thread acceptPackets path. Clear it
  // so ensureDecoder() rebuilds a fresh native decoder.
  state.decoder = null
  receiverWorkerDecoderState = null
  // Tell the worker to halt its pump if it got far enough to start one.
  // Set stopRequested so the captureStopped response doesn't trigger a
  // nested fallback (we're already falling back).
  if (wasActive && !state.workerCaptureStopRequested) {
    state.workerCaptureStopRequested = true
    postToWorker({ type: 'stopCapture' })
  }
  if (state.isScanning) scheduleNextFrame()
}

function startWorkerCapture() {
  if (CAPTURE_METHOD !== 'worker') return false
  if (!state.stream) return false
  if (state.workerCaptureActive) return true
  if (!receiverWorker) {
    if (!initReceiverWorker()) return false
  }
  // A stopCapture posted earlier in the same tick (resetReceiver +
  // handleReceiveAnother, etc.) hasn't been ack'd yet. The worker's track
  // pump is still draining, so starting now would race against the "already
  // active" check and trigger a spurious fallback. Defer until the
  // captureStopped message arrives.
  if (state.workerCaptureStopRequested) {
    state.workerCaptureStartPendingAfterStop = true
    return false
  }
  if (!receiverWorkerReady) {
    // Defer until the worker posts 'ready' — the ready handler fires this
    // again when the pending flag is set.
    state.workerCapturePending = true
    return false
  }

  const track = state.stream.getVideoTracks()[0]
  if (!track) return false

  // Clone the track so the main thread's <video> element keeps a live
  // source; transferring the original would end it on the main realm.
  let workerTrack
  try {
    workerTrack = track.clone()
  } catch (err) {
    debugLog(`Worker capture: track.clone() failed (${err?.message || err}) — falling back`)
    return false
  }

  // Shadow decoder creation is deferred to the captureStarted handler so a
  // startup timeout or error never leaves state.decoder pointing at a
  // worker-backed shadow that the main-thread fallback path can't use
  // synchronously. See ensureWorkerCaptureShadowDecoder().
  // Pending until we receive captureStarted from the worker; only then flip
  // workerCaptureActive. scheduleNextFrame gates on either flag, so the main
  // loop stays suppressed during startup.
  state.workerCapturePending = true
  const ok = postToWorker({
    type: 'startCaptureWithTrack',
    track: workerTrack,
    region: null,
    expectedPacketSize: getExpectedPacketSize() || null,
    labFrameTapEnabled: state.labFrameTapEnabled
  }, [workerTrack], { teardownOnError: false })
  if (!ok) {
    state.workerCapturePending = false
    try { workerTrack.stop() } catch (_) { /* ignore */ }
    const fallback = getWorkerTrackTransferFallback(CAPTURE_CAPABILITIES)
    if (fallback === 'offscreen') {
      debugLog('Worker track transfer unsupported — trying offscreen worker capture')
      return startOffscreenCapture({ force: true })
    }
    debugLog('Worker track transfer unsupported — falling back to main-thread capture')
    return false
  }
  armWorkerCaptureStartTimeout()
  debugLog('Worker capture requested (awaiting captureStarted)')
  return true
}

function stopWorkerCapture() {
  if (
    !state.workerCaptureActive &&
    !state.workerCapturePending &&
    !state.offscreenCaptureActive
  ) return
  clearWorkerCaptureStartTimeout()
  state.workerCapturePending = false
  state.workerCaptureActive = false
  state.offscreenCaptureActive = false
  state.workerCaptureSourceRect = null
  state.offscreenBitmapInFlightAt = null
  // Mark this as an expected stop so the captureStopped response handler
  // treats it as a normal teardown rather than an unexpected worker exit.
  state.workerCaptureStopRequested = true
  postToWorker({ type: 'stopCapture' })
}

// Phase 3.5: offscreen mode keeps the main-thread frame loop but replaces
// drawImage/getImageData with createImageBitmap + transferable postMessage.
// The worker does the readback locally.
function startOffscreenCapture({ force = false } = {}) {
  if (CAPTURE_METHOD !== 'offscreen' && !force) return false
  if (!state.stream) return false
  if (state.offscreenCaptureActive) return true
  if (!receiverWorker) {
    if (!initReceiverWorker()) return false
  }
  if (state.workerCaptureStopRequested) {
    // Symmetry with startWorkerCapture: if a stopCapture is in flight,
    // wait for its ack before starting a new session.
    state.workerCaptureStartPendingAfterStop = true
    return false
  }
  if (!receiverWorkerReady) {
    state.workerCapturePending = true
    return false
  }
  // As with the track path: defer shadow creation until captureStarted so
  // a start failure doesn't leave a stale shadow around.
  // Offscreen mode has the same ack semantics as the track mode. Mark
  // pending and activate only when captureStarted arrives; worker errors
  // from the start handler will trip the fallback path.
  state.workerCapturePending = true
  const ok = postToWorker({
    type: 'startCaptureWithOffscreen',
    region: null,
    expectedPacketSize: getExpectedPacketSize() || null,
    labFrameTapEnabled: state.labFrameTapEnabled
  })
  if (!ok) {
    state.workerCapturePending = false
    return false
  }
  armWorkerCaptureStartTimeout()
  debugLog('Worker capture requested (offscreen/createImageBitmap, awaiting captureStarted)')
  return true
}

function processFrameForOffscreen() {
  if (!state.isScanning || !state.stream || !state.offscreenCaptureActive) return
  // Don't bump state.frameCount here — backpressure-dropped frames would
  // inflate the counter, and worker-driven frames are already counted in
  // handleWorkerCaptureFrame when the worker reports the captureFrame.
  // Keeping a single source of truth aligns offscreen and track modes so
  // diagnostics keyed off frameCount stay comparable.
  const video = elements.video
  if (!video.videoWidth || !video.videoHeight) {
    scheduleNextFrame()
    return
  }

  // Backpressure: if a bitmap is already in flight to the worker, drop this
  // frame and let rVFC/rAF fire again. Under load the worker can lag behind
  // the main thread, and queuing bitmaps just wastes memory and latency.
  // The 1-second cap lets us recover if captureFrame never arrives (worker
  // stall or missed ack).
  const nowMs = performance.now()
  if (state.offscreenBitmapInFlightAt != null &&
      (nowMs - state.offscreenBitmapInFlightAt) < 1000) {
    scheduleNextFrame()
    return
  }

  // Narrow to the locked ROI once the worker has reported it, except while
  // the lab needs full-frame taps so anchors remain measurable.
  const roi = state.workerCaptureSourceRect
  const vw = video.videoWidth
  const vh = video.videoHeight
  const copyRect = getWorkerCaptureCopyRect(roi ? { sourceRect: roi } : null, vw, vh, state.labFrameTapEnabled)
  const usesFullFrame = copyRect.x === 0 &&
    copyRect.y === 0 &&
    copyRect.width === vw &&
    copyRect.height === vh
  const bitmapPromise = !usesFullFrame &&
    copyRect.x >= 0 && copyRect.y >= 0 &&
    copyRect.width > 0 && copyRect.height > 0 &&
    (copyRect.x + copyRect.width) <= vw &&
    (copyRect.y + copyRect.height) <= vh
    ? createImageBitmap(video, copyRect.x, copyRect.y, copyRect.width, copyRect.height)
    : createImageBitmap(video)

  state.offscreenBitmapInFlightAt = nowMs
  bitmapPromise
    .then((bitmap) => {
      if (!state.offscreenCaptureActive) {
        state.offscreenBitmapInFlightAt = null
        try { bitmap.close() } catch (_) { /* ignore */ }
        return
      }
      const ok = postToWorker({
        type: 'captureBitmap',
        bitmap,
        expectedPacketSize: getExpectedPacketSize() || null
      }, [bitmap])
      if (!ok) {
        state.offscreenBitmapInFlightAt = null
        try { bitmap.close() } catch (_) { /* ignore */ }
      }
    })
    .catch((err) => {
      state.offscreenBitmapInFlightAt = null
      debugLog(`createImageBitmap failed: ${err?.message || err}`)
    })
  scheduleNextFrame()
}

function postToWorker(msg, transfer, options = {}) {
  if (!receiverWorker) return false
  try {
    if (transfer && transfer.length) receiverWorker.postMessage(msg, transfer)
    else receiverWorker.postMessage(msg)
    return true
  } catch (err) {
    debugLog(`Worker postMessage failed: ${(err && err.message) || err}`)
    if (options.teardownOnError !== false) {
      teardownReceiverWorker(options.markFailedOnError !== false)
    }
    return false
  }
}

function postLabFrameTapStateToWorker() {
  if (!receiverWorker || !receiverWorkerReady) return
  postToWorker({ type: 'setLabFrameTap', enabled: state.labFrameTapEnabled })
}

function postArqStateToWorker() {
  if (!receiverWorker || !receiverWorkerReady) return
  postToWorker(
    { type: 'setArqEnabled', enabled: !!state.arqConnected },
    null,
    { teardownOnError: false }
  )
}

// The worker decodes with its own frame.js module instance, so the LUMA_1
// peaking correction has to be pushed across explicitly — see the read pool's
// equivalent in ensureReadPoolConfig(). Sent on worker-ready and again
// whenever the lambda changes.
function postSharpenLambdaToWorker() {
  if (!receiverWorker || !receiverWorkerReady) return
  postToWorker(
    { type: 'setSharpenLambda', lambda: getLuma1SharpenCorrection() },
    null,
    { teardownOnError: false }
  )
}

export function setHdmiUvcLabFrameTapEnabled(enabled) {
  state.labFrameTapEnabled = !!enabled
  if (state.labFrameTapEnabled) {
    state.lastImageData = null
    state.lastImageDataSeq = 0
    state.lastImageDataCapturedAtMs = 0
  }
  postLabFrameTapStateToWorker()
}

// Worker → main message dispatch. One named handler per message type; unknown
// types are ignored (forward compatibility with newer worker builds).
const WORKER_MESSAGE_HANDLERS = {
  ready: handleWorkerReady,
  wasmReady: handleWorkerWasmReady,
  decoderDelta: handleWorkerDecoderDelta,
  ingestBatchResult: handleWorkerIngestBatchResult,
  reconstructResult: handleWorkerReconstructResult,
  captureStarted: handleWorkerCaptureStarted,
  captureAnchorsLocked: handleWorkerCaptureAnchorsLocked,
  captureFrame: handleWorkerCaptureFrame,
  captureStopped: handleWorkerCaptureStopped,
  error: handleWorkerError
}

function handleReceiverWorkerMessage(event) {
  const msg = event.data
  if (!msg || typeof msg !== 'object') return
  const handler = WORKER_MESSAGE_HANDLERS[msg.type]
  if (handler) handler(msg)
}

function handleWorkerReady(msg) {
  receiverWorkerReady = true
  debugLog(`Worker ready (protocol v${msg.protocolVersion})`)
  postLabFrameTapStateToWorker()
  postArqStateToWorker()
  postSharpenLambdaToWorker()
  if (state.workerCapturePending) {
    let started = false
    if (CAPTURE_METHOD === 'worker') started = startWorkerCapture()
    else if (CAPTURE_METHOD === 'offscreen') started = startOffscreenCapture()
    if (shouldScheduleMainCaptureAfterWorkerStart({
      isScanning: state.isScanning,
      started,
      workerCapturePending: state.workerCapturePending,
      workerCaptureActive: state.workerCaptureActive,
      offscreenCaptureActive: state.offscreenCaptureActive,
      workerCaptureStartPendingAfterStop: state.workerCaptureStartPendingAfterStop
    })) {
      scheduleNextFrame()
    }
  }
}

function handleWorkerWasmReady() {
  debugLog('Worker WASM kernels loaded')
}

function handleWorkerIngestBatchResult(msg) {
  const pending = receiverWorkerPending.get(msg.id)
  receiverWorkerPending.delete(msg.id)
  // Update the shadow with the delta fields in the same tick as the
  // caller resolves its promise, so the main thread gets the
  // authoritative innovations count from the worker instead of guessing.
  handleWorkerDecoderDelta(msg)
  if (pending && pending.resolve) pending.resolve(msg)
}

function handleWorkerReconstructResult(msg) {
  const pending = receiverWorkerReconstructPending.get(msg.id)
  receiverWorkerReconstructPending.delete(msg.id)
  if (pending && pending.resolve) {
    pending.resolve({
      data: msg.data ? new Uint8Array(msg.data) : null,
      error: msg.error || null
    })
  }
}

function handleWorkerCaptureStarted(msg) {
  // Ack of startCaptureWithTrack / startCaptureWithOffscreen. Only now
  // is it safe to declare the worker the authoritative capture owner.
  clearWorkerCaptureStartTimeout()
  state.workerCapturePending = false
  if (msg.method === 'track') state.workerCaptureActive = true
  else if (msg.method === 'offscreen') state.offscreenCaptureActive = true
  // Create the shadow decoder now — not at post time — so a start
  // failure never leaves state.decoder pointing at a worker-backed
  // shadow that the main-thread fallback path can't drive via
  // synchronous receiveParsed().
  if (!state.decoder) {
    state.decoder = createWorkerDecoderShadow()
    debugLog(`Decoder created (worker capture shadow, ${msg.method || 'unknown'})`)
  }
  debugLog(`Worker capture started (${msg.method || 'unknown'})`)
  // Offscreen mode is main-thread-driven; kick the loop now that the
  // worker is ready to receive bitmaps.
  if (msg.method === 'offscreen' && state.isScanning) scheduleNextFrame()
}

function handleWorkerCaptureAnchorsLocked(msg) {
  // The worker has a cached data region and an ROI crop rect. Stash the
  // rect so processFrameForOffscreen can narrow createImageBitmap to
  // just the ROI — that's the main win of Finding 1.
  if (msg.sourceRect && typeof msg.sourceRect.x === 'number') {
    state.workerCaptureSourceRect = msg.sourceRect
    debugLog(
      `Worker anchors locked — ROI ` +
      `(${msg.sourceRect.x},${msg.sourceRect.y}) ` +
      `${msg.sourceRect.w}x${msg.sourceRect.h}`
    )
  } else {
    state.workerCaptureSourceRect = null
    debugLog('Worker anchors locked (no ROI rect provided)')
  }
}

function handleWorkerCaptureStopped() {
  const wasRequested = state.workerCaptureStopRequested
  state.workerCaptureStopRequested = false
  if (wasRequested) {
    // Clean teardown (stopWorkerCapture / fallBackFromWorkerCapture /
    // resetReceiver). The initiator already cleared the relevant flags
    // before posting stopCapture.
    state.workerCaptureActive = false
    state.offscreenCaptureActive = false
    debugLog('Worker capture stopped (expected)')
    // If a restart was requested during the stop window, fire it now
    // that the worker has confirmed teardown — this is what keeps
    // Reset / Receive-another from silently downgrading a healthy
    // worker-capture session to the main-thread path.
    if (state.workerCaptureStartPendingAfterStop) {
      state.workerCaptureStartPendingAfterStop = false
      if (state.isScanning) {
        if (CAPTURE_METHOD === 'worker') startWorkerCapture()
        else if (CAPTURE_METHOD === 'offscreen') startOffscreenCapture()
        scheduleNextFrame()
      }
    }
    return
  }
  // Unexpected: worker pump exited without our asking — track ended,
  // reader drained, VideoFrame allocation failed, etc. If we only
  // cleared workerCaptureActive here the main thread would stay
  // suppressed by scheduleNextFrame's gate and scanning would go idle.
  // Route through the fallback path so processFrame picks up.
  debugLog('Worker capture stopped unexpectedly — falling back to main-thread processFrame')
  fallBackFromWorkerCapture()
}

function handleWorkerError(msg) {
  debugLog(`Worker error message: ${msg.message}`)
  // Capture-side errors come without an id and prefix the failed handler
  // name — map those to a clean fallback so a browser/worker feature
  // mismatch doesn't freeze scanning.
  const text = typeof msg.message === 'string' ? msg.message : ''
  const captureStartFailed =
    text.startsWith('startCaptureWithTrack:') ||
    text.startsWith('startCaptureWithOffscreen:')
  const captureLoopFailed =
    text.startsWith('capture loop:') ||
    text.startsWith('captureBitmap:')
  if (captureStartFailed) {
    debugLog('Worker capture startup failed — falling back to main-thread processFrame')
    fallBackFromWorkerCapture()
  } else if (captureLoopFailed) {
    // Runtime pump error — worker may have already posted captureStopped;
    // if it didn't, we still want a clean fallback next tick.
    fallBackFromWorkerCapture()
  }
  if (msg.id && receiverWorkerPending.has(msg.id)) {
    const p = receiverWorkerPending.get(msg.id)
    receiverWorkerPending.delete(msg.id)
    if (p && p.reject) p.reject(new Error(msg.message))
  }
  if (msg.id && receiverWorkerReconstructPending.has(msg.id)) {
    const p = receiverWorkerReconstructPending.get(msg.id)
    receiverWorkerReconstructPending.delete(msg.id)
    if (p && p.reject) p.reject(new Error(msg.message))
  }
}

function handleWorkerDecoderDelta(msg) {
  const s = receiverWorkerDecoderState
  if (!s) return
  if (typeof msg.solved === 'number') s.solved = msg.solved
  if (typeof msg.solvedTotal === 'number') s.solvedTotal = msg.solvedTotal
  if (Array.isArray(msg.solvedSourceIds)) s.solvedSourceIds = msg.solvedSourceIds
  if ('fileId' in msg) s.fileId = typeof msg.fileId === 'number' ? msg.fileId : null
  if (typeof msg.K === 'number') s.K = msg.K
  if (typeof msg.K_prime === 'number') s.K_prime = msg.K_prime
  if (typeof msg.blockSize === 'number') s.blockSize = msg.blockSize
  if (typeof msg.progress === 'number') s.progress = msg.progress
  if (typeof msg.uniqueSymbols === 'number') s.uniqueSymbols = msg.uniqueSymbols
  if (typeof msg.pendingSymbolCount === 'number') s.pendingSymbolCount = msg.pendingSymbolCount
  if (typeof msg.unresolvedSourceCount === 'number') s.unresolvedSourceCount = msg.unresolvedSourceCount
  if (msg.metadata !== undefined) s.metadata = msg.metadata
  if (msg.telemetry) s.telemetry = msg.telemetry
  if (typeof msg.isComplete === 'boolean') s.isComplete = msg.isComplete
  if (msg.symbolBreakdown) s.symbolBreakdown = msg.symbolBreakdown
  if (state.workerCompletionSuppressed && msg.isComplete === false) {
    state.workerCompletionSuppressed = false
    s.completionHandled = false
  }
  if (msg.newSessionEvent || msg.newSession) {
    // Worker detected a new session (sender restart / config change) and
    // already reset its decoder. Mirror the companion state reset that
    // main-thread acceptPackets() does on the 'new_session' return.
    debugLog('New session detected (worker); resetting receiver companion state')
    state.validFrames = 0
    state.startTime = Date.now()
    state.completedFile = null
    state.completionStarted = false
    state.progressSamples = []
    state.expectedPacketCount = 0
    state.fixedLayout = null
    state.preferredLayout = null
    state.lastReceiverFrameSignature = null
    resetArqReceiverSession()
    state.workerCompletionSuppressed = false
    clearDenseBinaryLock()
    state.lockedLayoutFastPathMisses = 0
    state.decodeFailCount = 0
    s.completionHandled = false
  }
  if (msg.completionEvent && state.workerCompletionSuppressed) {
    return
  }
  if (msg.completionEvent && !s.completionHandled) {
    s.completionHandled = true
    // The worker signals completion asynchronously; bubble it into the
    // existing completion path. handleComplete guards against re-entry.
    if (!state.completedFile && typeof handleComplete === 'function') {
      debugLog('=== TRANSFER COMPLETE (via worker decoder) ===')
      void handleComplete()
    }
  }
}

// Worker capture pump posts one captureFrame per video frame. The worker has
// already done capture, decode, and decoder-ingest; this handler just updates
// the main-thread UI and validFrames bookkeeping that acceptPackets would have
// handled in the main-thread path.
function handleWorkerCaptureFrame(msg) {
  if (msg.labFrame?.buffer && msg.labFrame.width > 0 && msg.labFrame.height > 0) {
    rememberCapturedFrame({
      data: new Uint8ClampedArray(msg.labFrame.buffer),
      width: msg.labFrame.width,
      height: msg.labFrame.height
    })
  }
  // Release the offscreen backpressure slot — one bitmap round-trip is done,
  // the main thread can create the next.
  state.offscreenBitmapInFlightAt = null
  state.frameCount++
  // Apply decoder deltas first so completion / newSession are handled by the
  // existing delta path (which already owns those transitions).
  handleWorkerDecoderDelta(msg)

  if (msg.scanning) {
    // Worker hasn't locked anchors yet — nothing more to do; UI stays in
    // "Connected - scanning..." state.
    return
  }

  if (Array.isArray(msg.arqPackets) && msg.arqPackets.length > 0) {
    noteArqParsedPackets(msg.arqPackets)
  }

  if (msg.accepted > 0) {
    if (shouldStartReceiverTransferClock(state.startTime, msg.accepted)) {
      state.startTime = Date.now()
      showReceivingStatus()
    }
    state.validFrames++
    state.decodeFailCount = 0
    state.frameAcceptedThisFrame = true
    if (msg.innovations > 0) state.frameInnovatedThisFrame = true
    if (msg.salvaged > 0) noteReceiverRecovery('salvage', msg.salvaged)
    recordProgressSample()
  } else {
    state.decodeFailCount++
  }

  const nowMs = performance.now()
  const shadow = state.decoder
  const isComplete = shadow && typeof shadow.isComplete === 'function' && shadow.isComplete()
  const forceUiUpdate = isComplete || state.validFrames <= 1
  const shouldRefreshUi = shouldUpdateReceiverUi(state.lastReceivingUiUpdateMs, nowMs, forceUiUpdate)

  if (msg.accepted > 0 && shouldRefreshUi) {
    elements.statFrames.textContent = state.validFrames + ' valid frames'
  }

  if (msg.accepted > 0 && state.validFrames > 0 && state.validFrames % RX_PROGRESS_LOG_INTERVAL_FRAMES === 0) {
    const breakdown = msg.symbolBreakdown || {}
    const throughput = getThroughputStats()
    const rateSuffix = throughput
      ? ` rate=${formatBytes(throughput.average)}/s recent=${formatBytes(throughput.recent ?? throughput.average)}/s`
      : ''
    debugLog(
      `Progress: ${getDisplayProgressPercent(shadow)}% ` +
      `solved=${msg.solved ?? shadow?.solved ?? 0}/${msg.K ?? shadow?.K ?? '?'} ` +
      `unique=${shadow?.uniqueSymbols ?? 0} ` +
      `src=${breakdown.sourceCount ?? '?'} ` +
      `par=${breakdown.parityCount ?? '?'} ` +
      `fou=${breakdown.fountainCount ?? '?'} ` +
      `meta=${breakdown.metadataCount ?? '?'} ` +
      `pending=${shadow?.pendingSymbolCount ?? '?'} ` +
      `missing=${shadow?.unresolvedSourceCount ?? '?'} ` +
      `pkts=${msg.accepted} ` +
      `salvaged=${msg.salvaged || 0}` +
      rateSuffix
    )
  }

  if (shouldRefreshUi) {
    updateProgress()
    state.lastReceivingUiUpdateMs = nowMs
  }

  // Stall counter — the delta handler doesn't know about frame boundaries;
  // drive it from here so the GF(2) tail solver can still fire.
  if (state.frameAcceptedThisFrame && shadow && typeof shadow.noteFrameBoundary === 'function') {
    shadow.noteFrameBoundary()
  }
  state.frameAcceptedThisFrame = false
  state.frameInnovatedThisFrame = false
}

// Create a shadow decoder object that looks like the real createDecoder()
// return value but forwards ingest/reset/reconstruct to the worker. The
// shadow state is updated from worker deltas.
function freshShadowSymbolBreakdown() {
  return {
    unique: 0,
    duplicate: 0,
    sourceCount: 0,
    parityCount: 0,
    fountainCount: 0,
    metadataCount: 0
  }
}

function freshShadowTelemetry() {
  return {
    stallFramesSinceLastSolve: 0,
    paritySweepComplete: 0,
    parityNoProgressSweeps: 0,
    tailSolveTriggerCount: 0,
    pendingSymbolCount: 0
  }
}

// Default block size mirrors decoder.js initialization (`let blockSize = 200`)
// so getExpectedPacketSize() returns a sane value on frame 1 before any delta
// has arrived. Without this, the first frame would probe 15-byte slots and
// skip all packets, delaying the first ingest by another frame.
const WORKER_SHADOW_DEFAULT_BLOCK_SIZE = 200

function createWorkerDecoderShadow() {
  const s = {
    solved: 0,
    solvedTotal: 0,
    solvedSourceIds: [],
    fileId: null,
    K: null,
    K_prime: null,
    blockSize: WORKER_SHADOW_DEFAULT_BLOCK_SIZE,
    metadata: null,
    progress: 0,
    uniqueSymbols: 0,
    pendingSymbolCount: 0,
    unresolvedSourceCount: null,
    isComplete: false,
    completionHandled: false,
    symbolBreakdown: freshShadowSymbolBreakdown(),
    telemetry: freshShadowTelemetry()
  }
  receiverWorkerDecoderState = s
  postToWorker({ type: 'initDecoder' })
  return {
    get metadata() { return s.metadata },
    get fileId() { return s.fileId },
    get solved() { return s.solved },
    get solvedTotal() { return s.solvedTotal },
    get solvedSourceIds() { return s.solvedSourceIds },
    get K() { return s.K },
    get K_prime() { return s.K_prime },
    get blockSize() { return s.blockSize || 0 },
    get progress() { return s.progress },
    get uniqueSymbols() { return s.uniqueSymbols },
    get pendingSymbolCount() { return s.pendingSymbolCount },
    get unresolvedSourceCount() { return s.unresolvedSourceCount },
    get symbolBreakdown() { return s.symbolBreakdown },
    get telemetry() { return s.telemetry },
    isComplete() { return s.isComplete },
    // Async batch-ingest used by acceptPackets(). Returns a Promise with the
    // authoritative { innovations, newSession, isComplete, ... } snapshot.
    // Innovation count is computed in the worker, so main-thread telemetry
    // no longer over-counts on duplicate-only frames.
    ingestBatch(parsedList) {
      if (!parsedList || parsedList.length === 0) {
        return Promise.resolve({
          innovations: 0,
          accepted: 0,
          newSession: false,
          completionEvent: false,
          isComplete: s.isComplete
        })
      }
      const id = receiverWorkerNextId++
      return new Promise((resolve) => {
        receiverWorkerPending.set(id, {
          resolve: (msg) => resolve(msg),
          reject: (_err) => resolve({
            innovations: 0,
            accepted: 0,
            newSession: false,
            completionEvent: false,
            isComplete: s.isComplete,
            error: 'worker-unavailable'
          })
        })
        const wireList = parsedList.map(serializeParsedPacket)
        const ok = postToWorker({
          type: 'ingestBatch',
          id,
          parsedList: wireList
        })
        if (!ok) {
          receiverWorkerPending.delete(id)
          resolve({
            innovations: 0,
            accepted: 0,
            newSession: false,
            completionEvent: false,
            isComplete: s.isComplete,
            error: 'worker-post-failed'
          })
        }
      })
    },
    // Kept for backwards compatibility with the main-thread decoder interface.
    // In worker mode, acceptPackets uses ingestBatch() and should not call
    // receiveParsed — but if something does, fall back to posting a
    // single-packet batch and return false so it doesn't inflate innovation.
    receiveParsed(parsed) {
      if (!parsed) return false
      void this.ingestBatch([parsed])
      return false
    },
    reset() {
      s.solved = 0
      s.solvedTotal = 0
      s.solvedSourceIds = []
      s.fileId = null
      s.K = null
      s.K_prime = null
      s.blockSize = WORKER_SHADOW_DEFAULT_BLOCK_SIZE
      s.metadata = null
      s.progress = 0
      s.uniqueSymbols = 0
      s.pendingSymbolCount = 0
      s.unresolvedSourceCount = null
      s.isComplete = false
      s.completionHandled = false
      s.symbolBreakdown = freshShadowSymbolBreakdown()
      s.telemetry = freshShadowTelemetry()
      postToWorker({ type: 'resetDecoder' })
    },
    noteFrameBoundary() {
      postToWorker({ type: 'noteFrameBoundary' })
    },
    reconstruct() {
      const id = receiverWorkerNextId++
      return new Promise((resolve, reject) => {
        receiverWorkerReconstructPending.set(id, {
          resolve: (res) => {
            if (res && res.error) reject(new Error(res.error))
            else if (res && res.data) resolve(res.data)
            else reject(new Error('Worker reconstruct returned no data'))
          },
          reject
        })
        if (!postToWorker({ type: 'reconstruct', id })) {
          receiverWorkerReconstructPending.delete(id)
          reject(new Error('Worker unavailable'))
        }
      })
    }
  }
}

function serializeParsedPacket(parsed) {
  // parsePacket returns a flat object with fileId/symbolId/etc. plus a
  // zero-copy payload subarray. Copy the payload so the worker gets an
  // owned buffer and the main thread's capture buffer stays reusable.
  const payload = parsed.payload
    ? new Uint8Array(parsed.payload.buffer, parsed.payload.byteOffset, parsed.payload.byteLength).slice()
    : null
  return {
    fileId: parsed.fileId,
    k: parsed.k,
    symbolId: parsed.symbolId,
    blockSize: parsed.blockSize,
    isMetadata: parsed.isMetadata,
    mode: parsed.mode,
    payloadCrc: parsed.payloadCrc,
    payload
  }
}

function resetReceiverPerfState() {
  state.rxPerf = createReceiverPerfState()
}

const CAPTURE_REBENCH_INTERVAL_FRAMES = 2000


// Periodically invalidate the previous capture-method decision so the receiver
// adapts when GPU load shifts mid-session. The initial benchmark runs under
// whatever load was present at start; if the user later launches a game or
// closes one, the old winner may stop being the faster path.
function maybeRebenchmarkCaptureMethod() {
  const tuning = state.captureTuning
  if (!tuning || !tuning.canUseVideoFrame) return
  tuning.totalFramesSeen++
  if (tuning.totalFramesSeen % CAPTURE_REBENCH_INTERVAL_FRAMES !== 0) return
  tuning.preferredMethod = null
  tuning.benchmarkRemaining = CAPTURE_BENCHMARK_SAMPLES_PER_METHOD * 2
  tuning.videoSampleCount = 0
  tuning.videoSampleTotalMs = 0
  tuning.videoFrameSampleCount = 0
  tuning.videoFrameSampleTotalMs = 0
  tuning.roiPreferredMethod = 'video'
  tuning.roiBenchmarkRemaining = 0
  tuning.roiVideoSampleCount = 0
  tuning.roiVideoSampleTotalMs = 0
  tuning.roiVideoFrameSampleCount = 0
  tuning.roiVideoFrameSampleTotalMs = 0
  tuning.roiSlowRebenchDone = false
  debugLog('Capture-method benchmark re-entered (periodic)')
}

function resetCaptureTuningState() {
  state.captureTuning = createCaptureTuningState()
}

function shouldLogAnchorScanDiagnostics({
  anchorLocked = false,
  frameCount = 0,
  verbose = ANCHOR_SCAN_DIAGNOSTICS
} = {}) {
  if (anchorLocked || !verbose) return false
  return frameCount <= 5 || frameCount % 30 === 0
}

function noteCaptureTuningSample(method, durationMs, isRoi = false) {
  const tuning = state.captureTuning
  if (!tuning || !Number.isFinite(durationMs)) return
  if (method !== 'video' && method !== 'VideoFrame') return
  const preferredKey = isRoi ? 'roiPreferredMethod' : 'preferredMethod'
  if (tuning[preferredKey]) return

  const videoCountKey = isRoi ? 'roiVideoSampleCount' : 'videoSampleCount'
  const videoTotalKey = isRoi ? 'roiVideoSampleTotalMs' : 'videoSampleTotalMs'
  const videoFrameCountKey = isRoi ? 'roiVideoFrameSampleCount' : 'videoFrameSampleCount'
  const videoFrameTotalKey = isRoi ? 'roiVideoFrameSampleTotalMs' : 'videoFrameSampleTotalMs'
  const benchmarkRemainingKey = isRoi ? 'roiBenchmarkRemaining' : 'benchmarkRemaining'

  if (method === 'video') {
    tuning[videoCountKey]++
    tuning[videoTotalKey] += durationMs
  } else {
    tuning[videoFrameCountKey]++
    tuning[videoFrameTotalKey] += durationMs
  }
  if (tuning[benchmarkRemainingKey] > 0) tuning[benchmarkRemainingKey]--

  const haveEnoughVideo = tuning[videoCountKey] >= CAPTURE_BENCHMARK_SAMPLES_PER_METHOD
  const haveEnoughVideoFrame = tuning[videoFrameCountKey] >= CAPTURE_BENCHMARK_SAMPLES_PER_METHOD
  if (!haveEnoughVideo || !haveEnoughVideoFrame) return

  const avgVideoMs = tuning[videoTotalKey] / tuning[videoCountKey]
  const avgVideoFrameMs = tuning[videoFrameTotalKey] / tuning[videoFrameCountKey]
  tuning[preferredKey] = avgVideoMs <= avgVideoFrameMs ? 'video' : 'VideoFrame'
  debugLog(
    `Capture tuning: prefer ${tuning[preferredKey]}${isRoi ? ' ROI' : ''} ` +
    `(video=${avgVideoMs.toFixed(2)}ms, VideoFrame=${avgVideoFrameMs.toFixed(2)}ms)`
  )
}

function maybeRebenchmarkSlowRoiCapture() {
  const tuning = state.captureTuning
  const perf = state.rxPerf
  if (!tuning || !perf) return
  if (state.completedFile) return
  const avgHotCaptureMs = averagePerfWindow(perf.hotCaptureMs)
  if (!shouldRebenchmarkReceiverRoiCapture({
    canUseVideoFrame: tuning.canUseVideoFrame,
    roiPreferredMethod: tuning.roiPreferredMethod,
    roiBenchmarkRemaining: tuning.roiBenchmarkRemaining,
    roiSlowRebenchDone: tuning.roiSlowRebenchDone,
    transferActive: !!state.startTime && !state.completedFile,
    hotCaptureSampleCount: perf.hotCaptureMs.count,
    hotCaptureAvgMs: avgHotCaptureMs
  })) {
    return
  }

  tuning.roiPreferredMethod = null
  tuning.roiBenchmarkRemaining = CAPTURE_BENCHMARK_SAMPLES_PER_METHOD * 2
  tuning.roiVideoSampleCount = 0
  tuning.roiVideoSampleTotalMs = 0
  tuning.roiVideoFrameSampleCount = 0
  tuning.roiVideoFrameSampleTotalMs = 0
  tuning.roiSlowRebenchDone = true
  debugLog(`Capture tuning: slow video ROI (${avgHotCaptureMs.toFixed(2)}ms) - rebenchmarking ROI path`)
}

function startRoiCaptureBenchmark(reason) {
  const tuning = state.captureTuning
  if (!tuning) return false
  tuning.roiPreferredMethod = null
  tuning.roiBenchmarkRemaining = CAPTURE_BENCHMARK_SAMPLES_PER_METHOD * 2
  tuning.roiVideoSampleCount = 0
  tuning.roiVideoSampleTotalMs = 0
  tuning.roiVideoFrameSampleCount = 0
  tuning.roiVideoFrameSampleTotalMs = 0
  tuning.roiSlowRebenchDone = true
  debugLog(`Capture tuning: ${reason} - benchmarking ROI path`)
  return true
}

function maybeStartRoiWarmupBenchmark({
  headerOnlyFrame = false,
  roiCaptureAvailable = false,
  reason = 'ROI warmup'
} = {}) {
  const tuning = state.captureTuning
  if (!tuning) return false
  if (!shouldStartReceiverRoiWarmupBenchmark({
    canUseVideoFrame: tuning.canUseVideoFrame,
    roiPreferredMethod: tuning.roiPreferredMethod,
    roiBenchmarkRemaining: tuning.roiBenchmarkRemaining,
    roiSlowRebenchDone: tuning.roiSlowRebenchDone,
    transferActive: !!state.startTime && !state.completedFile,
    headerOnlyFrame,
    roiCaptureAvailable
  })) {
    return false
  }
  return startRoiCaptureBenchmark(reason)
}

// innovationCount counts packets that delivered a new symbol to the decoder
// (receiveParsed returned true). Duplicate-only frames contribute 0 here so
// `pkts=` in the RX perf log reflects useful decoder throughput rather than
// raw parse count, which would otherwise overstate progress under replay.
function noteReceiverAcceptPerf(durationMs, innovationCount, accepted) {
  const perf = state.rxPerf
  if (!perf) return

  recordPerfSample(perf.acceptMs, durationMs)
  perf.acceptCalls++
  if (accepted) perf.acceptedPackets += innovationCount
}

function noteReceiverCrcFailFrame() {
  const perf = state.rxPerf
  if (!perf) return
  perf.crcFailFrames++
}

function noteReceiverRecovery(kind, packetCount) {
  const perf = state.rxPerf
  if (!perf) return

  switch (kind) {
    case 'salvage':
      perf.salvagedFrames++
      perf.salvagedPackets += packetCount
      break
    case 'phase':
      perf.phaseRecoveredFrames++
      perf.phaseRecoveredPackets += packetCount
      break
    case 'fixed':
      perf.fixedRecoveredFrames++
      perf.fixedRecoveredPackets += packetCount
      break
    case 'headerless':
      perf.headerlessRecoveredFrames++
      perf.headerlessRecoveredPackets += packetCount
      break
  }
}

function noteLockedLayoutFastPath(kind, packetCount = 0) {
  const perf = state.rxPerf
  if (!perf) return

  switch (kind) {
    case 'exactHit':
      perf.lockedFastExactHits++
      perf.lockedFastExactPackets += packetCount
      break
    case 'exactMiss':
      perf.lockedFastExactMisses++
      break
    case 'recoveryProbe':
      perf.lockedFastRecoveryProbes++
      break
    case 'recoveryHit':
      perf.lockedFastRecoveryHits++
      perf.lockedFastRecoveryPackets += packetCount
      break
  }
}

function noteLockedFastStagePerf(kind, durationMs) {
  const perf = state.rxPerf
  if (!perf || !Number.isFinite(durationMs)) return

  switch (kind) {
    case 'read':
      recordPerfSample(perf.lockedFastExactReadMs, durationMs)
      break
    case 'probe':
      recordPerfSample(perf.lockedFastExactProbeMs, durationMs)
      break
  }
}

function noteLockedFastReaderKind(reader) {
  const perf = state.rxPerf
  if (!perf || !reader) return
  if (!perf.lockedFastReaderCounts) perf.lockedFastReaderCounts = {}
  perf.lockedFastReaderCounts[reader] = (perf.lockedFastReaderCounts[reader] || 0) + 1
}

function noteReceiverFrameUse(accepted, innovated) {
  const perf = state.rxPerf
  if (!perf) return
  if (accepted) perf.acceptedFrames++
  else perf.emptyFrames++
  if (innovated) perf.innovatingFrames++
  else if (accepted) perf.duplicateAcceptedFrames++
}

function noteReceiverFrameSignature(signature, accepted, innovated) {
  const perf = state.rxPerf
  if (!perf) return

  const classified = classifyReceiverFrameSignature(state.lastReceiverFrameSignature, {
    signature,
    accepted,
    innovated
  })
  state.lastReceiverFrameSignature = classified.nextSignature
  switch (classified.kind) {
    case 'repeat':
      perf.repeatedAcceptedFrames++
      break
    case 'changedDuplicate':
      perf.changedDuplicateFrames++
      break
    case 'changedInnovating':
      perf.changedInnovatingFrames++
      break
    case 'unknown':
      perf.unknownAcceptedFrames++
      break
  }
}

function shouldUseHeaderOnlyFrameForLock(result) {
  return !!result?.crcValid &&
    result.header?.payloadLength === 0 &&
    (
      result.header?.mode === HDMI_MODE.BINARY_1 ||
      result.header?.mode === HDMI_MODE.LUMA_1 ||
      result.header?.mode === HDMI_MODE.BINARY_2 ||
      result.header?.mode === HDMI_MODE.BINARY_3
    )
}

function noteReceiverFramePerf(frameStartMs, captureMethod, captureMs, anchorMs, fastPathMs, decodeMs, classifierMs = 0, isHotFrame = false) {
  const perf = state.rxPerf
  if (!perf) return

  if (perf.lastFrameStartMs > 0) {
    recordPerfSample(perf.intervalMs, frameStartMs - perf.lastFrameStartMs)
  }
  perf.lastFrameStartMs = frameStartMs

  recordPerfSample(perf.captureMs, captureMs)
  recordPerfSample(perf.anchorMs, anchorMs)
  recordPerfSample(perf.fastPathMs, fastPathMs)
  recordPerfSample(perf.decodeMs, decodeMs)
  recordPerfSample(perf.classifierMs, classifierMs)
  recordPerfSample(perf.totalMs, performance.now() - frameStartMs)
  perf.framesSinceLog++
  perf.lastCaptureMethod = captureMethod || perf.lastCaptureMethod

  if (isHotFrame) {
    if (perf.lastHotFrameStartMs > 0) {
      recordPerfSample(perf.hotIntervalMs, frameStartMs - perf.lastHotFrameStartMs)
    }
    perf.lastHotFrameStartMs = frameStartMs
    recordPerfSample(perf.hotCaptureMs, captureMs)
    recordPerfSample(perf.hotAnchorMs, anchorMs)
    recordPerfSample(perf.hotFastPathMs, fastPathMs)
    recordPerfSample(perf.hotDecodeMs, decodeMs)
    recordPerfSample(perf.hotClassifierMs, classifierMs)
    recordPerfSample(perf.hotTotalMs, performance.now() - frameStartMs)
    perf.hotFramesSinceLog++
    perf.lastHotCaptureMethod = captureMethod || perf.lastHotCaptureMethod
    maybeRebenchmarkSlowRoiCapture()
  }

  maybeRebenchmarkCaptureMethod()

  if (perf.framesSinceLog < RX_PERF_LOG_INTERVAL_FRAMES) return

  const avgIntervalMs = averagePerfWindow(perf.intervalMs)
  const processedFps = avgIntervalMs > 0 ? 1000 / avgIntervalMs : 0
  const avgAcceptCalls = perf.framesSinceLog > 0 ? perf.acceptCalls / perf.framesSinceLog : 0
  const avgAcceptedPackets = perf.framesSinceLog > 0 ? perf.acceptedPackets / perf.framesSinceLog : 0
  const frameBase = perf.framesSinceLog > 0 ? perf.framesSinceLog : 1
  const hotAvgIntervalMs = averagePerfWindow(perf.hotIntervalMs)
  const hotFps = hotAvgIntervalMs > 0 ? 1000 / hotAvgIntervalMs : 0
  const hotSummary = perf.hotFramesSinceLog > 0
    ? `hot=${perf.hotFramesSinceLog}/${perf.framesSinceLog} ` +
      `hotFps=${hotFps.toFixed(1)} ` +
      `hotCapture=${averagePerfWindow(perf.hotCaptureMs).toFixed(2)}ms ` +
      `hotFast=${averagePerfWindow(perf.hotFastPathMs).toFixed(2)}ms ` +
      `hotDecode=${averagePerfWindow(perf.hotDecodeMs).toFixed(2)}ms ` +
      `hotTotal=${averagePerfWindow(perf.hotTotalMs).toFixed(2)}ms ` +
      `hotMethod=${perf.lastHotCaptureMethod || 'n/a'}`
    : `hot=0/${perf.framesSinceLog}`
  const recoverySummary =
    `crcFail=${perf.crcFailFrames}/${perf.framesSinceLog} ` +
    `recover=s${(perf.salvagedFrames / frameBase).toFixed(2)}/${(perf.salvagedPackets / frameBase).toFixed(2)} ` +
    `p${(perf.phaseRecoveredFrames / frameBase).toFixed(2)}/${(perf.phaseRecoveredPackets / frameBase).toFixed(2)} ` +
    `f${(perf.fixedRecoveredFrames / frameBase).toFixed(2)}/${(perf.fixedRecoveredPackets / frameBase).toFixed(2)} ` +
    `h${(perf.headerlessRecoveredFrames / frameBase).toFixed(2)}/${(perf.headerlessRecoveredPackets / frameBase).toFixed(2)}`
  const lockedFastSummary =
    `lockedFast=x${perf.lockedFastExactHits}/${perf.lockedFastExactMisses}` +
    `:${(perf.lockedFastExactPackets / frameBase).toFixed(2)} ` +
    `r${perf.lockedFastRecoveryHits}/${perf.lockedFastRecoveryProbes}` +
    `:${(perf.lockedFastRecoveryPackets / frameBase).toFixed(2)}`
  const lockedFastStageSummary = getLockedFastStageSummary(perf)
  const frameUseSummary = getReceiverFrameUseSummary(perf)
  const frameSignatureSummary = getReceiverFrameSignatureSummary(perf)
  const packetYieldSummary = getReceiverPacketYieldSummary(perf, state.expectedPacketCount)

  const t = state.decoder?.telemetry
  const telemetrySummary = t
    ? `stall=${t.stallFramesSinceLastSolve} paritySeen=${t.paritySweepComplete} pNoProg=${t.parityNoProgressSweeps} tailTrig=${t.tailSolveTriggerCount}`
    : 'stall=n/a paritySeen=n/a pNoProg=n/a tailTrig=n/a'

  debugLog(
    `RX perf: fps=${processedFps.toFixed(1)} ` +
    `capture=${averagePerfWindow(perf.captureMs).toFixed(2)}ms ` +
    `anchor=${averagePerfWindow(perf.anchorMs).toFixed(2)}ms ` +
    `fast=${averagePerfWindow(perf.fastPathMs).toFixed(2)}ms ` +
    `decode=${averagePerfWindow(perf.decodeMs).toFixed(2)}ms ` +
    `cls=${averagePerfWindow(perf.classifierMs).toFixed(2)}ms ` +
    `acceptCall=${averagePerfWindow(perf.acceptMs).toFixed(2)}ms ` +
    `total=${averagePerfWindow(perf.totalMs).toFixed(2)}ms ` +
    `${hotSummary} ` +
    `acceptCalls=${avgAcceptCalls.toFixed(2)}/frame pkts=${avgAcceptedPackets.toFixed(2)}/frame ${packetYieldSummary} ` +
    `${recoverySummary} ${lockedFastSummary} ${lockedFastStageSummary} ${frameUseSummary} ${frameSignatureSummary} method=${perf.lastCaptureMethod || 'n/a'} ` +
    `${telemetrySummary}${getReadPoolSummary()}`
  )

  clearReceiverPerfSamples(perf)
}

let captureBenchFrames = 0

function noteCaptureBenchFrame(method, width, height) {
  captureBenchFrames++
  if (captureBenchFrames < RX_PERF_LOG_INTERVAL_FRAMES) return

  const perf = state.rxPerf
  if (!perf) return

  const avgIntervalMs = averagePerfWindow(perf.intervalMs)
  const processedFps = avgIntervalMs > 0 ? 1000 / avgIntervalMs : 0
  const captureAvgMs = averagePerfWindow(perf.captureMs)

  debugLog(
    `captureBench: method=${method} roi=${width}x${height} ` +
    `capture=${captureAvgMs.toFixed(2)}ms fps=${processedFps.toFixed(1)}`
  )

  captureBenchFrames = 0
}

function formatMaybeNumber(value, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'n/a'
}

function formatMaybeInt(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value)) : 'n/a'
}

function formatDecisionCandidate(candidate) {
  if (!candidate) return 'n/a'
  const name = `${candidate.hypothesis}${candidate.refined ? '*' : ''}`
  return (
    `${name}(score=${formatMaybeInt(candidate.score)} crc=${candidate.crcValid ? 1 : 0} ` +
    `${candidate.width}x${candidate.height}@${candidate.fps} len=${candidate.payloadLength} ` +
    `off=(${formatMaybeInt(candidate.xOff)},${formatMaybeInt(candidate.yOff)}) ` +
    `step=${formatMaybeNumber(candidate.stepX)}/${formatMaybeNumber(candidate.stepY)} ` +
    `grid=${formatMaybeInt(candidate.blocksX)}x${formatMaybeInt(candidate.blocksY)})`
  )
}

function formatDecisionScale(diag) {
  if (!diag) return null
  return (
    `Scale: measured=${formatMaybeInt(diag.measuredFrameW)}x${formatMaybeInt(diag.measuredFrameH)} ` +
    `decoded=${formatMaybeInt(diag.decodedFrameW)}x${formatMaybeInt(diag.decodedFrameH)} ` +
    `ratio=${formatMaybeNumber(diag.decodedToMeasuredX)}/${formatMaybeNumber(diag.decodedToMeasuredY)} ` +
    `geom=${diag.geometryClass || 'n/a'} winner=${diag.decision?.winner?.hypothesis || diag.hypothesis || 'base'}${diag.decision?.winner?.refined ? '*' : ''} ` +
    `score=${formatMaybeInt(diag.decision?.winner?.score ?? diag.score)} ` +
    `reason=${diag.decision?.reason || 'n/a'}`
  )
}

function formatDecisionCandidates(diag) {
  const candidates = diag?.decision?.candidates || []
  if (candidates.length === 0) return null
  return `Tried: ${candidates.map(formatDecisionCandidate).join('; ')}`
}

function formatRecoveryState(expectedPacketSize, totalFramePackets, salvagedCount, fixedCount, salvageStrategy = null, salvagePacketSize = null) {
  return (
    `Recovery: expectedPkt=${formatMaybeInt(expectedPacketSize)} ` +
    `slots=${formatMaybeInt(totalFramePackets)} salvage=${formatMaybeInt(salvagedCount)} ` +
    `fixed=${formatMaybeInt(fixedCount)} expectedSlots=${formatMaybeInt(state.expectedPacketCount)} ` +
    `salvageMode=${salvageStrategy || 'n/a'}@${formatMaybeInt(salvagePacketSize)}`
  )
}

function getDisplayProgressPercent(decoder = state.decoder) {
  if (!decoder) return 0
  const raw = Math.floor((decoder.progress || 0) * 100)
  if (decoder.isComplete()) return 100
  return Math.max(0, Math.min(99, raw))
}

function getProgressBytes() {
  if (!state.decoder?.metadata) return null
  return state.decoder.progress * state.decoder.metadata.fileSize
}

function recordProgressSample() {
  const bytes = getProgressBytes()
  if (bytes === null) return

  const now = Date.now()
  state.progressSamples.push({ time: now, bytes })

  const cutoff = now - 10000
  while (state.progressSamples.length > 0 && state.progressSamples[0].time < cutoff) {
    state.progressSamples.shift()
  }
}

function getThroughputStats() {
  const bytes = getProgressBytes()
  if (bytes === null || !state.startTime) return null

  const now = Date.now()
  const elapsed = (now - state.startTime) / 1000
  const average = elapsed > 0 ? bytes / elapsed : 0

  let recent = null
  if (state.progressSamples.length >= 2) {
    const first = state.progressSamples[0]
    const last = state.progressSamples[state.progressSamples.length - 1]
    const recentElapsed = (last.time - first.time) / 1000
    if (recentElapsed > 0) {
      recent = (last.bytes - first.bytes) / recentElapsed
    }
  }

  return { average, recent }
}

function isBetterPacketProbe(candidate, best) {
  if (!candidate) return false
  if (!best) return true

  const candidatePackets = candidate.probe?.packets?.length || 0
  const bestPackets = best.probe?.packets?.length || 0
  if (candidatePackets !== bestPackets) return candidatePackets > bestPackets

  const candidatePacketSize = candidate.probe?.packetSize || 0
  const bestPacketSize = best.probe?.packetSize || 0
  const candidateBytes = candidatePackets * candidatePacketSize
  const bestBytes = bestPackets * bestPacketSize
  if (candidateBytes !== bestBytes) return candidateBytes > bestBytes

  const candidateDistance = Math.abs(candidate.xAdjust) + Math.abs(candidate.yAdjust)
  const bestDistance = Math.abs(best.xAdjust) + Math.abs(best.yAdjust)
  return candidateDistance < bestDistance
}

function probeLayoutPackets(imageData, width, region, layout, payloadLength, expectedPacketSize = null, options = {}) {
  if (!layout || !payloadLength || payloadLength <= 0) return null

  const {
    includeScaleSearch = false,
    offsets: customOffsets = null,
    scales: customScales = null
  } = options

  const offsets = customOffsets || [0, -1, 1, -2, 2]
  const scales = customScales || (includeScaleSearch ? [1, 0.995, 1.005] : [1])

  let best = null

  for (const scale of scales) {
    for (const xAdjust of offsets) {
      for (const yAdjust of offsets) {
        const candidateLayout = {
          ...layout,
          xOff: (layout.xOff || 0) + xAdjust,
          yOff: (layout.yOff || 0) + yAdjust,
          stepX: layout.stepX * scale,
          stepY: layout.stepY * scale,
          dataBs: layout.dataBs * scale,
          headerStepX: layout.headerStepX ? layout.headerStepX * scale : undefined,
          headerStepY: layout.headerStepY ? layout.headerStepY * scale : undefined,
          headerBs: layout.headerBs ? layout.headerBs * scale : undefined
        }
        const payload = readPayloadWithLayout(imageData, width, region, candidateLayout, payloadLength)
        if (!payload) continue

        const probe = probeFramePackets(payload, expectedPacketSize)
        const candidate = { payload, probe, layout: candidateLayout, xAdjust, yAdjust }
        if (isBetterPacketProbe(candidate, best)) best = candidate
      }
    }
  }

  return best
}

function getLayoutProbeOptions(layout) {
  if (!layout) return {}

  switch (layout.frameMode) {
    case HDMI_MODE.CODEBOOK_3:
      return {
        includeScaleSearch: true,
        offsets: [0, -1, 1, -2, 2, -3, 3],
        scales: [1, 0.995, 1.005]
      }
    case HDMI_MODE.LUMA_2:
      return {
        offsets: [0, -1, 1, -2, 2]
      }
    case HDMI_MODE.BINARY_3:
    case HDMI_MODE.BINARY_2:
    case HDMI_MODE.BINARY_1:
    case HDMI_MODE.LUMA_1:
      return {
        offsets: [0, -1, 1]
      }
    default:
      return {}
  }
}

function getLockedLayoutProbeOptions(layout) {
  if (!layout) return {}

  switch (layout.frameMode) {
    case HDMI_MODE.COMPAT_4:
    case HDMI_MODE.RAW_GRAY:
    case HDMI_MODE.RAW_RGB:
    case HDMI_MODE.LUMA_2:
    case HDMI_MODE.BINARY_3:
    case HDMI_MODE.BINARY_2:
    case HDMI_MODE.BINARY_1:
    case HDMI_MODE.LUMA_1:
      return {
        offsets: [0, -1, 1]
      }
    case HDMI_MODE.CODEBOOK_3:
      return {
        offsets: [0, -1, 1, -2, 2],
        scales: [1, 0.995, 1.005]
      }
    default:
      return {}
  }
}

function isDenseBinaryLayout(layout) {
  return layout?.frameMode === HDMI_MODE.BINARY_3 ||
    layout?.frameMode === HDMI_MODE.BINARY_2 ||
    layout?.frameMode === HDMI_MODE.BINARY_1 ||
    layout?.frameMode === HDMI_MODE.LUMA_1
}

function getDenseBinaryLayoutOffsets(layout) {
  return isDenseBinaryLayout(layout)
    ? (layout.precomputedOffsets || state.lockedDenseBinaryOffsets || null)
    : null
}

function shouldRetryBinary2AverageRead(layout, probe) {
  if (layout?.frameMode !== HDMI_MODE.BINARY_2) return false
  const packets = probe?.packets?.length || 0
  const slots = probe?.slotCount || 0
  if (packets === 0) return true
  return slots > 0 && packets < slots
}

function readLayoutPayloadOnly(imageData, width, region, layout, payloadLength, options = {}) {
  const payload = readPayloadWithLayout(
    imageData,
    width,
    region,
    layout,
    payloadLength,
    getDenseBinaryLayoutOffsets(layout),
    options
  )
  return payload || null
}

function readLayoutPacketsExact(imageData, width, region, layout, payloadLength, expectedPacketSize = null) {
  if (!layout || !payloadLength || payloadLength <= 0) return null

  let readMs = 0
  let probeMs = 0
  const attemptRead = (options = {}) => {
    const stats = {}
    const readStartMs = performance.now()
    const payload = readLayoutPayloadOnly(imageData, width, region, layout, payloadLength, { ...options, stats })
    readMs += performance.now() - readStartMs
    if (!payload) return null

    const probeStartMs = performance.now()
    const probe = probeFramePackets(payload, expectedPacketSize)
    probeMs += performance.now() - probeStartMs
    return { payload, probe, layout, reader: stats.reader || 'fallback' }
  }

  let best = attemptRead(layout.frameMode === HDMI_MODE.BINARY_2 ? { binary2SampleMode: 'single' } : {})
  if (shouldRetryBinary2AverageRead(layout, best?.probe)) {
    const robust = attemptRead({ binary2SampleMode: 'average' })
    if (isBetterPacketProbe(robust, best)) best = robust
  }
  noteLockedFastStagePerf('read', readMs)
  if (!best?.payload) return null

  noteLockedFastReaderKind(best.reader)
  noteLockedFastStagePerf('probe', probeMs)

  return best
}

function ensureDecoder() {
  if (!state.decoder) {
    state.decoder = createDecoder()
    debugLog('Decoder created')
    state.startTime = Date.now()
    showReceivingStatus()
  }
}

function noteSignalDetected(mode, resolution = null) {
  if (mode === null || mode === undefined) return

  const firstDetection = state.detectedMode === null
  if (state.detectedMode === null) {
    state.detectedMode = mode
  }

  if (resolution?.width && resolution?.height) {
    state.detectedResolution = { width: resolution.width, height: resolution.height }
    elements.signalStatus.textContent = `Detected: ${resolution.width}×${resolution.height}`
  } else if (firstDetection) {
    elements.signalStatus.textContent = `Detected: ${HDMI_MODE_NAMES[mode]}`
  }

  if (firstDetection) {
    debugLog(`=== SIGNAL DETECTED ===`)
    debugLog(
      resolution?.width && resolution?.height
        ? `Mode: ${HDMI_MODE_NAMES[mode]}, ${resolution.width}x${resolution.height}`
        : `Mode: ${HDMI_MODE_NAMES[mode]}`
    )
  }
}

function getExpectedPacketSize() {
  return getReceiverExpectedPacketSize(state.decoder, PACKET_HEADER_SIZE)
}

function getReceiverPacketSession() {
  const decoder = state.decoder
  if (!decoder) return null
  const fileId = decoder.fileId
  const k = decoder.K_prime
  if (fileId == null && k == null) return null
  return { fileId, k }
}

function getPacketProbeOptions(result) {
  if (result?.header?.mode !== HDMI_MODE.BINARY_3 || !(result.confidence instanceof Uint8Array)) {
    return {}
  }
  return {
    confidence: result.confidence,
    session: getReceiverPacketSession()
  }
}

function tryFixedLayoutPackets(imageData, width, region) {
  const expectedPacketSize = getExpectedPacketSize()
  if (!expectedPacketSize || !state.fixedLayout || state.expectedPacketCount < 1) return []

  const payloadLength = expectedPacketSize * state.expectedPacketCount
  const best = probeLayoutPackets(
    imageData,
    width,
    region,
    state.fixedLayout,
    payloadLength,
    expectedPacketSize,
    getLayoutProbeOptions(state.fixedLayout)
  )
  if (!best) return []
  if (best.layout) state.fixedLayout = { ...best.layout }
  return best.probe?.packets || []
}

async function tryLockedLayoutFastPath(imageData, width, region) {
  const activeMode = state.detectedMode ?? state.fixedLayout?.frameMode ?? state.preferredLayout?.frameMode
  if (
    activeMode !== HDMI_MODE.COMPAT_4 &&
    activeMode !== HDMI_MODE.RAW_GRAY &&
    activeMode !== HDMI_MODE.RAW_RGB &&
    activeMode !== HDMI_MODE.LUMA_2 &&
    activeMode !== HDMI_MODE.CODEBOOK_3 &&
    activeMode !== HDMI_MODE.BINARY_3 &&
    activeMode !== HDMI_MODE.BINARY_2 &&
    activeMode !== HDMI_MODE.BINARY_1 &&
    activeMode !== HDMI_MODE.LUMA_1
  ) {
    return false
  }
  const lockedLayout = state.fixedLayout || state.preferredLayout
  if (!lockedLayout || state.expectedPacketCount < 1) return false

  const expectedPacketSize = getExpectedPacketSize()
  if (!expectedPacketSize) return false

  const payloadLength = expectedPacketSize * state.expectedPacketCount
  const exact = readLayoutPacketsExact(
    imageData,
    width,
    region,
    lockedLayout,
    payloadLength,
    expectedPacketSize
  )
  const exactPackets = exact?.probe?.packets || []
  if (exactPackets.length > 0) {
    if (await acceptPackets(exactPackets, state.frameCount, true, state.expectedPacketCount, null, {
      salvaged: exact.probe?.salvaged || 0,
      parsedPackets: exact.probe?.parsedPackets || null
    })) {
      noteLockedLayoutFastPath('exactHit', exactPackets.length)
      state.lockedLayoutFastPathMisses = 0
      if (exact.layout) {
        state.fixedLayout = { ...exact.layout }
        state.preferredLayout = { ...exact.layout }
      }
      if (state.decoder?.isComplete()) return true
      scheduleNextFrame()
      return true
    }
  }

  noteLockedLayoutFastPath('exactMiss')
  state.lockedLayoutFastPathMisses++
  const shouldRunRecoveryProbe =
    state.lockedLayoutFastPathMisses === 1 ||
    (state.lockedLayoutFastPathMisses % LOCKED_LAYOUT_RECOVERY_PROBE_INTERVAL_FRAMES) === 0
  if (!shouldRunRecoveryProbe) return false

  noteLockedLayoutFastPath('recoveryProbe')
  const best = probeLayoutPackets(
    imageData,
    width,
    region,
    lockedLayout,
    payloadLength,
    expectedPacketSize,
    getLockedLayoutProbeOptions(lockedLayout)
  )
  if (!best) return false

  const packets = best.probe?.packets || []
  if (packets.length === 0) return false
  if (best.layout) {
    state.fixedLayout = { ...best.layout }
    state.preferredLayout = { ...best.layout }
  }

  if (await acceptPackets(packets, state.frameCount, true, state.expectedPacketCount, null, {
    salvaged: best.probe?.salvaged || 0,
    parsedPackets: best.probe?.parsedPackets || null
  })) {
    noteLockedLayoutFastPath('recoveryHit', packets.length)
    state.lockedLayoutFastPathMisses = 0
    if (state.decoder?.isComplete()) return true
    scheduleNextFrame()
    return true
  }

  return false
}

async function acceptPackets(
  packets,
  fallbackSymbolId,
  countAsValidFrame = true,
  expectedFramePacketCount = packets.length,
  preIngestedResult = null,
  packetStats = null
) {
  const acceptStartMs = performance.now()
  let accepted = false
  let innovationCount = 0
  const softSalvagedPacketCount = (packetStats?.salvaged || preIngestedResult?.salvaged || 0)
  let frameSignature = null

  try {
    if (!preIngestedResult && packets.length === 0) return false

    ensureDecoder()
    const decoder = state.decoder

    let lastParsed = null
    const parsedList = []
    const suppliedParsedPackets = Array.isArray(packetStats?.parsedPackets)
      ? packetStats.parsedPackets
      : null
    if (suppliedParsedPackets && suppliedParsedPackets.length > 0) {
      for (const parsed of suppliedParsedPackets) {
        if (!parsed) continue
        lastParsed = parsed
        parsedList.push(parsed)
      }
    }
    // Count of packets the ingest stage actually accepted this frame. For the
    // non-worker path this is parsedList.length (pre-dedup); for the worker
    // path we trust the worker's reported `accepted`. Drives progress/UI
    // displays and the "did we make real progress" guard.
    let acceptedPacketCount = 0
    if (preIngestedResult) {
      // The capture-pump worker already decoded and ingested this frame's
      // packets in a single round trip. If the decode came
      // back CRC-valid but zero inner packets parsed, treat the same as an
      // empty-packets frame on the non-worker path — no progress, don't
      // count as valid, don't clear decodeFailCount. Otherwise relock
      // heuristics stall while the receiver happily counts useless frames.
      acceptedPacketCount = preIngestedResult.accepted || 0
      if (acceptedPacketCount === 0) return false
      innovationCount = preIngestedResult.innovations || 0
      if (preIngestedResult.header) {
        lastParsed = { symbolId: preIngestedResult.header.symbolId }
      } else {
        lastParsed = { symbolId: fallbackSymbolId }
      }
      frameSignature = buildReceiverPreIngestedFrameSignature(
        preIngestedResult,
        fallbackSymbolId,
        acceptedPacketCount
      )
    } else {
      if (!suppliedParsedPackets || suppliedParsedPackets.length === 0) {
        for (const packet of packets) {
          const parsed = parsePacket(packet)
          if (!parsed) continue
          lastParsed = parsed
          parsedList.push(parsed)
        }
      }
      if (!lastParsed) return false
      acceptedPacketCount = parsedList.length
      frameSignature = buildReceiverPacketFrameSignature(parsedList, fallbackSymbolId, acceptedPacketCount)
    }

    if (preIngestedResult) {
      // Worker already did the ingest — nothing more to do here. Fall
      // through to the bookkeeping block below.
    } else {
      for (const parsed of parsedList) {
        let result = decoder.receiveParsed(parsed)
        // Sender restarted — reset in-flight session state and re-ingest the packet.
        if (result === 'new_session') {
          debugLog('New session detected (sender restart / config change); resetting decoder state')
          decoder.reset()
          state.validFrames = 0
          // Reseed the rate clock — ensureDecoder() only runs when state.decoder
          // is null, so it won't fire again for the reused decoder object.
          state.startTime = Date.now()
          state.completedFile = null
          state.completionStarted = false
          state.progressSamples = []
          state.expectedPacketCount = 0
          state.fixedLayout = null
          state.preferredLayout = null
          state.lastReceiverFrameSignature = null
          resetArqReceiverSession()
          state.workerCompletionSuppressed = false
          clearDenseBinaryLock()
          state.lockedLayoutFastPathMisses = 0
          state.decodeFailCount = 0
          result = decoder.receiveParsed(parsed)
        }
        // receiveParsed returns true for new symbols, false for duplicates
        // (dedup at decoder.js:190). Only `true` counts as innovation.
        if (result === true) innovationCount++
      }
    }
    if (parsedList.length > 0) noteArqParsedPackets(parsedList)
    const anyInnovation = innovationCount > 0
    noteReceiverFrameSignature(frameSignature, true, anyInnovation)

    if (countAsValidFrame) {
      state.validFrames++
      state.decodeFailCount = 0
    }

    state.expectedPacketCount = Math.max(acceptedPacketCount, expectedFramePacketCount || 0)
    recordProgressSample()

    const nowMs = performance.now()
    const forceUiUpdate = decoder.isComplete() || state.validFrames <= 1
    const shouldRefreshUi = shouldUpdateReceiverUi(state.lastReceivingUiUpdateMs, nowMs, forceUiUpdate)

    if (countAsValidFrame && shouldRefreshUi) {
      elements.statFrames.textContent = state.validFrames + ' valid frames'
    }

    if (state.validFrames % RX_PROGRESS_LOG_INTERVAL_FRAMES === 0) {
      const throughput = getThroughputStats()
      const symbolBreakdown = decoder.symbolBreakdown || {}
      const rateSuffix = throughput
        ? ` rate=${formatBytes(throughput.average)}/s recent=${formatBytes(throughput.recent ?? throughput.average)}/s`
        : ''
      debugLog(
        `Progress: ${getDisplayProgressPercent(decoder)}% ` +
        `solved=${decoder.solved}/${decoder.K || '?'} ` +
        `unique=${decoder.uniqueSymbols} ` +
        `src=${symbolBreakdown.sourceCount ?? '?'} ` +
        `par=${symbolBreakdown.parityCount ?? '?'} ` +
        `fou=${symbolBreakdown.fountainCount ?? '?'} ` +
        `meta=${symbolBreakdown.metadataCount ?? '?'} ` +
        `pending=${decoder.pendingSymbolCount ?? '?'} ` +
        `missing=${decoder.unresolvedSourceCount ?? '?'} ` +
        `sym=${lastParsed.symbolId ?? fallbackSymbolId} pkts=${acceptedPacketCount} ` +
        `salvaged=${softSalvagedPacketCount}` +
        rateSuffix
      )
    }

    if (shouldRefreshUi) {
      debugCurrent(
        `#${state.validFrames} sym=${lastParsed.symbolId ?? fallbackSymbolId} ` +
        `${getDisplayProgressPercent(decoder)}% x${acceptedPacketCount}`
      )
      updateProgress()
      state.lastReceivingUiUpdateMs = nowMs
    }

    // completionStarted (set synchronously inside handleComplete) also
    // dedupes this block: with the read pool, results still in flight when
    // the decoder completes each land here and would re-log otherwise.
    if (decoder.isComplete() && !state.completionStarted) {
      if (!shouldRefreshUi) {
        updateProgress()
        state.lastReceivingUiUpdateMs = nowMs
      }
      debugLog('=== TRANSFER COMPLETE ===')
      handleComplete()
    }

    // Signal this frame was accepted. The stall counter (noteFrameBoundary) must
    // tick on *every* accepted frame, including duplicate-only frames, so the
    // tail solver fires in the replay-heavy endgame. Innovation is tracked
    // separately for telemetry only. Delegates to updateFrameAcceptSignals so
    // the rule stays in sync with testReceiverFrameAcceptSignals.
    const nextSignals = updateFrameAcceptSignals(state, {
      acceptedAnyPacket: true,
      innovationCount
    })
    state.frameAcceptedThisFrame = nextSignals.frameAcceptedThisFrame
    state.frameInnovatedThisFrame = nextSignals.frameInnovatedThisFrame
    accepted = true
    return true
  } finally {
    noteReceiverAcceptPerf(performance.now() - acceptStartMs, innovationCount, accepted)
  }
}

const TENTATIVE_ANCHOR_MAX_FAILS = 10


// Check if requestVideoFrameCallback is available (better sync than requestAnimationFrame)
const hasVideoFrameCallback = typeof HTMLVideoElement !== 'undefined' &&
  'requestVideoFrameCallback' in HTMLVideoElement.prototype

// Check if VideoFrame API is available (direct frame access)
const hasVideoFrame = typeof VideoFrame !== 'undefined'

// Check if ImageCapture API is available (better for UVC devices)
const hasImageCapture = typeof ImageCapture !== 'undefined'

let elements = null
let imageCapture = null
let showError = (msg) => console.error(msg)

function saveDevicePreference(deviceId) {
  try {
    localStorage.setItem(DEVICE_STORAGE_KEY, deviceId)
  } catch (e) {
    // Ignore storage errors
  }
}

function loadDevicePreference() {
  try {
    return localStorage.getItem(DEVICE_STORAGE_KEY)
  } catch (e) {
    return null
  }
}

async function enumerateDevices() {
  const videoDevices = await listVideoInputs()

  populateCameraSelect(elements.deviceDropdown, videoDevices, {
    selectedId: loadDevicePreference(),
    decorateLabel: (label, device) =>
      device.label && /capture|hdmi|uvc|cam link/i.test(device.label)
        ? `${label} (Capture)`
        : label
  })

  return videoDevices
}

async function startCapture(deviceId) {
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop())
  }

  try {
    debugLog(`Starting capture, deviceId: ${deviceId || '(default)'}`)
    if (PERF_MODE) {
      debugLog(
        `Perf mode on: rxPerfLog=${RX_PERF_LOG_INTERVAL_FRAMES}f ` +
        `progressLog=${RX_PROGRESS_LOG_INTERVAL_FRAMES}f ` +
        `uiUpdate=${RECEIVER_UI_UPDATE_INTERVAL_MS}ms`
      )
    }

    const constraints = {
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60 }
      }
    }

    state.stream = await navigator.mediaDevices.getUserMedia(constraints)
    resetReceiverPerfState()
    elements.video.srcObject = state.stream

    await new Promise(resolve => {
      elements.video.onloadedmetadata = resolve
    })

    // Log actual video track settings
    const track = state.stream.getVideoTracks()[0]
    if (track) {
      const settings = track.getSettings()
      debugLog(`Track: ${track.label}`)
      debugLog(`Actual: ${settings.width}x${settings.height} @ ${settings.frameRate || '?'}fps`)
    }

    // Log frame callback method
    debugLog(`Frame capture method: ${hasVideoFrameCallback ? 'requestVideoFrameCallback' : 'requestAnimationFrame'}`)

    // Set up ImageCapture if available
    if (hasImageCapture && track) {
      try {
        imageCapture = new ImageCapture(track)
        debugLog('ImageCapture API: initialized')
      } catch (e) {
        debugLog(`ImageCapture API: failed to initialize (${e.message})`)
        imageCapture = null
      }
    } else {
      debugLog('ImageCapture API: not available')
    }

    state.canvas = document.createElement('canvas')
    state.ctx = state.canvas.getContext('2d', {
      willReadFrequently: true,
      alpha: false,  // Might help with consistent color handling
      colorSpace: 'srgb'
    })

    saveDevicePreference(deviceId)

    elements.signalStatus.textContent = 'Connected — scanning…'
    elements.signalStatus.classList.add('connected')

    return true

  } catch (err) {
    console.error('Camera error:', err)
    debugLog(`ERROR: ${err.message}`)
    showError('Failed to access capture device: ' + err.message)
    return false
  }
}

function scheduleNextFrame() {
  if (!state.isScanning || !state.stream) return
  // Full-handoff worker capture mode pumps frames inside the worker via
  // MediaStreamTrackProcessor — main thread must not schedule its own
  // processFrame, since that would re-enable the drawImage/getImageData
  // path we just moved off.
  if (state.workerCaptureActive || state.workerCapturePending) return
  // During a reset→restart in worker mode, we've posted stopCapture and are
  // waiting for the ack before reissuing startCaptureWithTrack. Don't let
  // the main-thread loop quietly take over that window — scanning resumes
  // via the deferred start once captureStopped arrives.
  if (state.workerCaptureStartPendingAfterStop) return

  const video = elements.video
  const callback = state.offscreenCaptureActive ? processFrameForOffscreen : processFrame

  if (hasVideoFrameCallback) {
    // Use requestVideoFrameCallback for accurate frame timing
    state.callbackId = video.requestVideoFrameCallback(callback)
  } else {
    // Fallback to requestAnimationFrame
    state.animationId = requestAnimationFrame(callback)
  }
}

function ensureCaptureCanvas(canvas, width, height) {
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
}

function captureImageDataToCanvas(source, canvas, ctx, width, height, sourceRect = null) {
  ensureCaptureCanvas(canvas, width, height)
  if (sourceRect) {
    ctx.drawImage(
      source,
      sourceRect.x,
      sourceRect.y,
      sourceRect.w,
      sourceRect.h,
      0,
      0,
      width,
      height
    )
  } else {
    ctx.drawImage(source, 0, 0, width, height)
  }
  return ctx.getImageData(0, 0, width, height)
}

function rememberCapturedFrame(imageData) {
  if (!imageData) return
  state.lastImageData = imageData
  state.lastImageDataSeq++
  state.lastImageDataCapturedAtMs = performance.now()
}

// --- Capture directly into WASM linear memory ------------------------------
// VideoFrame.copyTo can convert to RGBA and write straight into a view over
// WASM memory: no canvas, no per-frame getImageData allocation (~7.8MB of GC
// churn at 1080p), and the decode kernels then read the pixels in place
// instead of copying them into scratch. Only used on the steady-state
// locked-ROI path, where the rect is pixel-exact (computeLockedCaptureRect
// never scales) — exactly the geometry copyTo can reproduce. Any failure
// falls back to the canvas paths for that frame and latches the wasm path
// off after repeated failures — that latch is the only kill switch; the
// diagnostics registry locks the setting to the live baseline.
const WASM_CAPTURE_URL_DISABLED = !getWasmCaptureEnabledAtInit()
const WASM_CAPTURE_FAIL_LATCH = 2
let wasmCaptureFailCount = 0

function wasmCaptureEligible(lockedCapture) {
  if (WASM_CAPTURE_URL_DISABLED) return false
  if (wasmCaptureFailCount >= WASM_CAPTURE_FAIL_LATCH) return false
  if (!hasVideoFrame || !isHdmiUvcWasmLoaded()) return false
  const sr = lockedCapture?.sourceRect
  if (!sr) return false
  // copyTo cannot scale.
  if (sr.w !== lockedCapture.width || sr.h !== lockedCapture.height) return false
  // 4:2:0 camera frames need sample-aligned crop rects.
  if ((sr.x & 1) || (sr.y & 1) || (sr.w & 1) || (sr.h & 1)) return false
  return true
}

// Capture one frame from `source` (the video element, or any
// CanvasImageSource in tests) into the pinned WASM frame region. Returns an
// ImageData-shaped POJO whose .data aliases WASM memory — valid until the
// next capture overwrites the region.
async function captureFrameIntoWasm(source, lockedCapture, timestampUs) {
  const sr = lockedCapture.sourceRect
  const view = acquireWasmFrameView(sr.w * sr.h * 4)
  if (!view) return null
  const frame = new VideoFrame(source, { timestamp: timestampUs || 0 })
  try {
    await frame.copyTo(view, {
      rect: { x: sr.x, y: sr.y, width: sr.w, height: sr.h },
      format: 'RGBA'
    })
  } finally {
    frame.close()
  }
  return { data: view, width: sr.w, height: sr.h }
}

function noteWasmCaptureFailure(err) {
  wasmCaptureFailCount++
  if (wasmCaptureFailCount === 1) {
    debugLog(`[HDMI-RX] wasm capture failed (${err?.name || ''} ${err?.message || err}) - falling back to canvas capture`)
  }
  if (wasmCaptureFailCount === WASM_CAPTURE_FAIL_LATCH) {
    debugLog('[HDMI-RX] wasm capture disabled for this session after repeated failures')
  }
}

// --- Parallel read pool -----------------------------------------------------
// The locked Luma4 payload read costs ~20ms+ on slower machines — far past
// the ~16.7ms/frame budget of a 60fps stream — so a single thread caps the
// decode rate around half the sent frames and the fountain tail pays for the
// rest. The pool moves that read off the main thread: capture copies the
// locked ROI into a recycled transferable buffer, an idle read worker runs
// the kernel pass and packet probe, and the packets come back to the normal
// main-thread acceptPackets (ingest is cheap there). Frames are independent
// until ingest and fountain symbols are order-independent, so out-of-order
// results are fine. The pool only handles the happy path: any read failure
// yields frames back to the synchronous path so the existing miss/recovery/
// invalidation logic runs unchanged. LUMA_1 only; pool size comes from the
// diagnostics registry, locked to 3 workers — the measured knee on the
// reference rig (UGREEN 1080p60): w2=10.5, w3=16.9, w4=17.2 MB/s — the 4th
// worker plateaus because capture already sustains 60fps and the systematic
// phase sits at ~84% of the wire rate. The pool self-disables after repeated
// worker failures, so there is no manual kill switch.
const READ_POOL_URL_DISABLED = !getReadPoolEnabledAtInit()
const READ_POOL_SIZE = getReadPoolWorkersAtInit()
const READ_POOL_DISABLE_AFTER_FAILS = 10

let readPool = null

function initReadPool() {
  if (readPool) return readPool
  const pool = {
    workers: [],
    buffers: [],
    bufferBytes: 0,
    configVersion: 0,
    cfgKey: '',
    yieldToSync: false,
    consecutiveFailures: 0,
    disabled: false,
    seq: 0,
    stats: { dispatched: 0, results: 0, failed: 0, skippedBusy: 0, readMsTotal: 0 }
  }
  try {
    for (let i = 0; i < READ_POOL_SIZE; i++) {
      const worker = new ReadWorker()
      const slot = { worker, busy: false, ready: false }
      worker.onmessage = (event) => onReadPoolMessage(slot, event.data)
      worker.onerror = (event) => {
        debugLog(`[HDMI-RX] read worker error: ${event.message || 'unknown'} - pool disabled, sync path takes over`)
        disableReadPool()
      }
      try {
        const wasmUrl = new URL('hdmi-uvc/hdmi_uvc.wasm', document.baseURI).href
        worker.postMessage({ type: 'configureWasm', url: wasmUrl })
      } catch (_) { /* worker falls back to JS kernels */ }
      pool.workers.push(slot)
    }
    debugLog(`[HDMI-RX] read pool ready: ${READ_POOL_SIZE} worker(s)`)
  } catch (err) {
    debugLog(`[HDMI-RX] read pool construction failed: ${err?.message || err} - sync path only`)
    pool.disabled = true
  }
  readPool = pool
  return pool
}

function disableReadPool() {
  if (!readPool) return
  readPool.disabled = true
  for (const slot of readPool.workers) {
    try { slot.worker.terminate() } catch (_) { /* ignore */ }
  }
  readPool.workers = []
  readPool.buffers = []
}

function resetReadPoolForNewTransfer() {
  if (!readPool) return
  readPool.yieldToSync = false
  readPool.consecutiveFailures = 0
  readPool.cfgKey = '' // force a config re-push for the next lock
  readPool.stats = { dispatched: 0, results: 0, failed: 0, skippedBusy: 0, readMsTotal: 0 }
}

// Push layout/lambda/packet-size config to every worker when any of them
// change. The layout is sent WITHOUT its precomputed offsets (~15MB at
// 1080p); workers precompute their own copy once per config version.
function ensureReadPoolConfig(region) {
  const layout = state.lockedDenseBinaryLayout
  const expectedPacketSize = getExpectedPacketSize()
  const payloadLength = expectedPacketSize * state.expectedPacketCount
  const lambda = getLuma1SharpenCorrection()
  if (!region) return false
  const cfgKey = `${layout.blocksX}x${layout.blocksY}:${layout.xOff},${layout.yOff},${layout.payloadPhaseX},${layout.payloadEdgeGuardCells}` +
    `:${region.x},${region.y},${region.w},${region.h}:${expectedPacketSize}x${state.expectedPacketCount}:${lambda ?? 'off'}`
  if (cfgKey === readPool.cfgKey) return true
  const strippedLayout = { ...layout }
  delete strippedLayout.precomputedOffsets
  delete strippedLayout.precomputedRegion
  readPool.configVersion++
  readPool.cfgKey = cfgKey
  const cfg = {
    configVersion: readPool.configVersion,
    layout: strippedLayout,
    region: { x: region.x, y: region.y, w: region.w, h: region.h },
    payloadLength,
    expectedPacketSize,
    sharpenLambda: lambda
  }
  for (const slot of readPool.workers) {
    slot.worker.postMessage({ type: 'config', cfg })
  }
  return true
}

function readPoolFrameEligible(lockedCapture) {
  if (READ_POOL_URL_DISABLED || !hasVideoFrame) return false
  if (state.detectedMode !== HDMI_MODE.LUMA_1) return false
  if (!state.lockedDenseBinaryLayout || state.expectedPacketCount < 1) return false
  if (!getExpectedPacketSize()) return false
  const sr = lockedCapture?.sourceRect
  if (!sr) return false
  if (sr.w !== lockedCapture.width || sr.h !== lockedCapture.height) return false
  if ((sr.x & 1) || (sr.y & 1) || (sr.w & 1) || (sr.h & 1)) return false
  const pool = initReadPool()
  if (pool.disabled) return false
  if (pool.yieldToSync) {
    // The sync path took over after a failure; hand frames back to the pool
    // once it has re-proven the lock (a sync accept resets decodeFailCount).
    if (state.decodeFailCount === 0 && state.lockedDenseBinaryLayout) {
      pool.yieldToSync = false
    } else {
      return false
    }
  }
  // Workers precompute their offsets against the CURRENT decode region — the
  // ROI-relative one matching the buffers we send them — not the lock-time
  // region (those differ once ROI capture engages; the sync path handles the
  // same delta via offset translation).
  return ensureReadPoolConfig(lockedCapture.region)
}

function popPoolBuffer(byteLen) {
  if (readPool.bufferBytes !== byteLen) {
    // ROI size changed (relock) — drop the old pool, sizes no longer match.
    readPool.buffers = []
    readPool.bufferBytes = byteLen
  }
  return readPool.buffers.pop() || new ArrayBuffer(byteLen)
}

function recyclePoolBuffer(buffer) {
  if (!buffer || buffer.byteLength === 0) return // transferred-away or detached
  if (buffer.byteLength !== readPool.bufferBytes) return
  if (readPool.buffers.length < READ_POOL_SIZE + 2) readPool.buffers.push(buffer)
}

function pickIdleReadWorker() {
  for (const slot of readPool.workers) {
    if (slot.ready && !slot.busy) return slot
  }
  return null
}

// Capture the locked ROI into a pool buffer and hand it to `slot`.
async function capturePoolFrameAndDispatch(source, lockedCapture, timestampUs, slot) {
  const sr = lockedCapture.sourceRect
  const byteLen = sr.w * sr.h * 4
  const buffer = popPoolBuffer(byteLen)
  try {
    const view = new Uint8ClampedArray(buffer, 0, byteLen)
    const frame = new VideoFrame(source, { timestamp: timestampUs || 0 })
    try {
      await frame.copyTo(view, {
        rect: { x: sr.x, y: sr.y, width: sr.w, height: sr.h },
        format: 'RGBA'
      })
    } finally {
      frame.close()
    }
    slot.busy = true
    readPool.seq++
    slot.worker.postMessage({
      type: 'read',
      seq: readPool.seq,
      configVersion: readPool.configVersion,
      buffer,
      width: sr.w,
      height: sr.h
    }, [buffer])
    readPool.stats.dispatched++
    return true
  } catch (err) {
    recyclePoolBuffer(buffer)
    noteWasmCaptureFailure(err)
    return false
  }
}

async function onReadPoolMessage(slot, msg) {
  if (!msg || typeof msg !== 'object' || !readPool) return
  if (msg.type === 'ready') {
    slot.ready = true
    return
  }
  if (msg.type === 'error') {
    debugLog(`[HDMI-RX] read worker reported: ${msg.message}`)
    return
  }
  if (msg.type !== 'result') return

  slot.busy = false
  recyclePoolBuffer(msg.frameBuffer)
  if (msg.configVersion !== readPool.configVersion) return // stale lock; not a failure
  if (state.decoder?.isComplete()) return // late result after completion; nothing to ingest

  if (!msg.ok || !msg.payloadBuffer || !msg.records || msg.records.length === 0) {
    readPool.stats.failed++
    readPool.consecutiveFailures++
    readPool.yieldToSync = true // let the sync path run its recovery/invalidations
    if (readPool.consecutiveFailures >= READ_POOL_DISABLE_AFTER_FAILS) {
      debugLog(`[HDMI-RX] read pool disabled after ${READ_POOL_DISABLE_AFTER_FAILS} consecutive failures`)
      disableReadPool()
    }
    return
  }

  readPool.stats.results++
  readPool.stats.readMsTotal += msg.readMs || 0
  const expectedPacketSize = getExpectedPacketSize()
  const payload = new Uint8Array(msg.payloadBuffer)
  const records = msg.records
  const packets = []
  const parsedPackets = []
  for (let i = 0; i * 6 < records.length; i++) {
    const base = i * 6
    const offset = records[base] * expectedPacketSize
    if (offset < 0 || offset + expectedPacketSize > payload.length) continue
    const packet = payload.subarray(offset, offset + expectedPacketSize)
    const versionAndFlags = records[base + 4]
    packets.push(packet)
    parsedPackets.push({
      fileId: records[base + 1],
      k: records[base + 2],
      symbolId: records[base + 3],
      blockSize: expectedPacketSize - PACKET_HEADER_SIZE,
      isMetadata: isMetadataFlag(versionAndFlags),
      mode: packetModeFromFlags(versionAndFlags),
      payloadCrc: records[base + 5],
      payload: packet.subarray(PACKET_HEADER_SIZE)
    })
  }

  const frameAccepted = await acceptPackets(
    packets,
    state.frameCount,
    true,
    state.expectedPacketCount,
    null,
    { salvaged: msg.salvaged || 0, parsedPackets }
  )
  if (frameAccepted) {
    readPool.consecutiveFailures = 0
    readPool.yieldToSync = false
    state.lockedLayoutFastPathMisses = 0
  } else {
    readPool.stats.failed++
    readPool.consecutiveFailures++
    readPool.yieldToSync = true
  }
}

function getReadPoolSummary() {
  if (!readPool || readPool.disabled) return ''
  const s = readPool.stats
  if (!s.dispatched) return ''
  const avgRead = s.results > 0 ? (s.readMsTotal / s.results).toFixed(1) : 'n/a'
  return ` pool=w${readPool.workers.length} d${s.dispatched} r${s.results} f${s.failed} skip${s.skippedBusy} read=${avgRead}ms`
}

export function getLastCapturedFrame() {
  // WASM-backed frames alias the pinned capture region, which the next frame
  // overwrites (and memory growth can detach the view) — hand diagnostics a
  // stable copy instead. The wasm path produces a POJO, not an ImageData.
  const wasmBacked = !!state.lastImageData &&
    typeof ImageData !== 'undefined' &&
    !(state.lastImageData instanceof ImageData)
  return state.lastImageData
    ? {
        data: wasmBacked ? state.lastImageData.data.slice() : state.lastImageData.data,
        width: state.lastImageData.width,
        height: state.lastImageData.height,
        seq: state.lastImageDataSeq,
        capturedAtMs: state.lastImageDataCapturedAtMs
      }
    : null
}

function getLockedCaptureRegion(region, sourceWidth, sourceHeight) {
  const base = computeLockedCaptureRect(region, sourceWidth, sourceHeight, BLOCK_SIZE)
  if (!base) return null
  // Main-thread callers also read sourceWidth / sourceHeight off the result
  // (see processFrame's ROI freshness check) — tack them on here without
  // polluting the shared pure helper.
  return {
    ...base,
    sourceWidth,
    sourceHeight
  }
}

function lockAnchorRegion(region, sourceWidth, sourceHeight, anchors = null) {
  if (!region) return

  state.anchorBounds = region
  state.lockedCaptureRegion = getLockedCaptureRegion(region, sourceWidth, sourceHeight)
  state.tentativeAnchorBounds = null
  state.tentativeLockedCaptureRegion = null
  state.tentativeAnchors = null

  if (anchors?.length) {
    const pos = anchors.map(a => `${a.corner}(${a.x},${a.y} bs=${a.blockSize.toFixed(1)})`).join(' ')
    debugLog(`*** ANCHORS LOCKED: ${anchors.length} found, region (${region.x},${region.y}) ${region.w}x${region.h} step=${region.stepX.toFixed(1)}/${region.stepY.toFixed(1)} ***`)
    debugLog(`  Anchors: ${pos}`)
    if (state.lockedCaptureRegion) {
      const { sourceRect } = state.lockedCaptureRegion
      debugLog(`  Capture ROI: (${sourceRect.x},${sourceRect.y}) ${sourceRect.w}x${sourceRect.h}`)
    }
  }
}

function clearDenseBinaryLock() {
  clearDenseBinaryLockState(state)
}

function applyDenseBinaryLock(result, currentRegion) {
  const outcome = lockDenseBinaryLayoutFromDecodeResult(state, result, currentRegion)
  logDenseBinaryLockOutcome(outcome)
}

function applyDenseBinaryRecoveredLayout(layout, header, currentRegion) {
  const outcome = lockDenseBinaryLayoutState(state, layout, currentRegion, header)
  logDenseBinaryLockOutcome(outcome)
}

// LUMA_1 blind sweeps cost hundreds of ms each; when they fail repeatedly the
// main thread saturates and the page stops responding to clicks. After a few
// consecutive failures, rate-limit further sweep attempts — capture keeps
// running and any CRC-valid decode lifts the throttle immediately.
const LUMA1_SWEEP_BACKOFF_AFTER_FAILS = 3
const LUMA1_SWEEP_BACKOFF_MS = 400

function noteLuma1SweepOutcome(result) {
  if (result?.crcValid) {
    state.luma1SweepFailStreak = 0
    state.luma1InvalidationCount = 0
    setLuma1SweepBudgetFast(false)
    return
  }
  if (result?.header?.mode !== HDMI_MODE.LUMA_1) return
  state.luma1CalPassCount = 0
  state.luma1SweepFailStreak = (state.luma1SweepFailStreak || 0) + 1
  // Escalate once the layout has been invalidated repeatedly: the channel is
  // persistently broken, so trade scan latency for an interactive page.
  const backoffMs = (state.luma1InvalidationCount || 0) >= 2 ? 1500 : LUMA1_SWEEP_BACKOFF_MS
  state.luma1NextSweepAtMs = performance.now() + backoffMs
  if (state.luma1SweepFailStreak === LUMA1_SWEEP_BACKOFF_AFTER_FAILS) {
    setLuma1SweepBudgetFast(true)
    debugLog(`[HDMI-RX] Luma4 sweep backoff engaged after ${LUMA1_SWEEP_BACKOFF_AFTER_FAILS} consecutive CRC fails - fast sweeps at most every ${backoffMs}ms until a frame passes`)
  }
}

function shouldSkipLuma1SweepForBackoff(now = performance.now()) {
  if ((state.luma1SweepFailStreak || 0) < LUMA1_SWEEP_BACKOFF_AFTER_FAILS) return false
  return now < (state.luma1NextSweepAtMs || 0)
}

// Calibration frames pass CRC but carry the fixed cal pattern instead of
// packets, so the packet pipeline would score them as "empty CRC-valid"
// failures and tear the lock down. Treat them as link-validation success:
// keep the lock, reset failure counters, and throttle further decodes — one
// confirmation per second is plenty for a static pattern and keeps the page
// responsive. The throttle self-clears the moment real data arrives (the
// next decoded frame parses packets and never re-arms the hold).
const LUMA1_CAL_DECODE_HOLD_MS = 1000
const LUMA1_CAL_LOG_INTERVAL_MS = 5000

function shouldSkipDecodeForLuma1CalHold(now = performance.now()) {
  return now < (state.luma1CalHoldUntilMs || 0)
}

function noteLuma1CalibrationPass(result, region, frameWidth, frameHeight, candidateRegion, candidateAnchors) {
  state.decodeFailCount = 0
  state.luma1CalPassCount = (state.luma1CalPassCount || 0) + 1
  const now = performance.now()
  state.luma1CalHoldUntilMs = now + LUMA1_CAL_DECODE_HOLD_MS
  if (!state.anchorBounds && (candidateRegion || state.tentativeAnchorBounds)) {
    lockAnchorRegion(
      candidateRegion || state.tentativeAnchorBounds,
      frameWidth,
      frameHeight,
      candidateAnchors || state.tentativeAnchors
    )
  }
  if (result._diag) state.fixedLayout = { ...result._diag }
  if (result._diag) state.preferredLayout = { ...result._diag }
  applyDenseBinaryLock(result, region)
  if (
    state.luma1CalPassCount <= 3 ||
    now - (state.luma1CalLastLogMs || 0) > LUMA1_CAL_LOG_INTERVAL_MS
  ) {
    state.luma1CalLastLogMs = now
    const lambda = getLuma1SharpenCorrection()
    const levels = Array.isArray(result._diag?.lumaLevels) ? ` levels=[${result._diag.lumaLevels.join('/')}]` : ''
    debugLog(
      `[HDMI-RX] Luma4 CAL frame CRC OK #${state.luma1CalPassCount} ` +
      `(sharpen lambda=${lambda ?? 'off'}${levels}) - link validated, ` +
      `uncheck Cal pattern on the sender to transfer real data`
    )
  }
  debugCurrent(`#${state.frameCount} CAL OK`)
}

function noteDenseBinaryLockFailure(result) {
  const outcome = noteDenseBinaryUnrecoveredCrcFailure(
    state,
    result,
    LOCKED_BINARY3_INVALIDATE_AFTER_FAILS
  )
  if (outcome.invalidated) {
    if (result?._diag?.frameMode === HDMI_MODE.LUMA_1) {
      state.luma1InvalidationCount = (state.luma1InvalidationCount || 0) + 1
    }
    const modeName = HDMI_MODE_NAMES[result?._diag?.frameMode] || 'dense binary'
    const diag = result?._diag || {}
    const detail = diag.frameMode === HDMI_MODE.LUMA_1
      ? ` guard=${diag.payloadEdgeGuardCells ?? 'n/a'} phase=${diag.payloadPhaseX ?? 'n/a'} grid=${diag.blocksX || '?'}x${diag.blocksY || '?'} len=${result?.header?.payloadLength ?? '?'} levels=[${Array.isArray(diag.lumaLevels) ? diag.lumaLevels.join('/') : 'n/a'}] bw=${Math.round(diag.blackLevel ?? -1)}/${Math.round(diag.whiteLevel ?? -1)} swept=${diag.sweepTried ?? 'n/a'}${diag.sweepBudgetHit ? '(budget)' : ''}`
      : ''
    debugLog(`[HDMI-RX] ${modeName} layout invalidated after ${LOCKED_BINARY3_INVALIDATE_AFTER_FAILS} unrecovered CRC fails${detail} - re-sweeping next frame`)
    logLuma1DecodeDebug(diag.lumaDebug)
  }
}

// Channel evidence from a fully-failed LUMA_1 decode (built in frame.js):
// raw ramp-strip readouts per probe phase ('!' = unusable, fell back to
// linear defaults) and a sparse payload-band luma histogram with detected
// peaks. Four clean peaks near even spacing => geometry bug; squeezed or
// merged peaks => fix the sender ?luma-mids; a smear => modulation below
// the channel noise floor.
function logLuma1DecodeDebug(lumaDebug) {
  if (!lumaDebug) return
  for (const strip of lumaDebug.strips || []) {
    const sign = strip.phase >= 0 ? `+${strip.phase}` : `${strip.phase}`
    const rows = strip.rows
      .map((row) => `r${row.row}=[${row.raw.join('/')}]${row.usable ? '' : '!'}`)
      .join(' ')
    debugLog(`[HDMI-RX] Luma4 strips p${sign}: ${rows}`)
  }
  const bins = (lumaDebug.hist || [])
    .map((count, bin) => (count ? `${bin * 4}:${count}` : null))
    .filter(Boolean)
    .join(' ')
  debugLog(`[HDMI-RX] Luma4 payload hist (binW=4, n=${lumaDebug.sampled}): ${bins}`)
  const peaks = (lumaDebug.peaks || []).map((peak) => `${peak.v}(${peak.n})`).join(' ')
  debugLog(`[HDMI-RX] Luma4 payload peaks: ${peaks || 'none'}`)
  if (lumaDebug.vEdge) {
    debugLog(`[HDMI-RX] Luma4 vertical edge margin->header rows[-3..+4]: [${lumaDebug.vEdge.join('/')}] over ${lumaDebug.vEdgeColumns} column(s) (hard 0->255 step = vertically sharp; intermediate row value = vertical blend weight)`)
  }
  if (lumaDebug.purityRows) {
    const fmt = (entries) => entries.map((e) => `k${e.k}=[${e.pct.join('/')}]`).join(' ')
    debugLog(`[HDMI-RX] Luma4 purity by row class (% of samples on a strip level, phase ${lumaDebug.purityPhase}): ${fmt(lumaDebug.purityRows)}`)
    debugLog(`[HDMI-RX] Luma4 purity by col class: ${fmt(lumaDebug.purityCols)}`)
  }
  const cal = lumaDebug.cal
  if (cal) {
    const fmtMod = cal.errRowMod.map((e) => `k${e.k}=[${e.pct.join('/')}]`).join(' ')
    debugLog(`[HDMI-RX] Luma4 CAL detected: symbol match=${cal.match}% (n=${cal.total}) err% by row mod: ${fmtMod}`)
    debugLog(`[HDMI-RX] Luma4 CAL err% by row band (top->bottom, 16): [${cal.errRowBands.join('/')}]`)
    debugLog(`[HDMI-RX] Luma4 CAL mix fraction by row band: f-below=[${cal.fBelowBands.map((v) => v ?? 'x').join('/')}] f-above=[${cal.fAboveBands.map((v) => v ?? 'x').join('/')}] (0=clean, +=blended toward that neighbor)`)
    debugLog(`[HDMI-RX] Luma4 CAL f-below histogram (f=-0.2..1.2 step 0.1): [${cal.fHist.join('/')}]`)
    if (cal.sharpen) {
      const s = cal.sharpen
      const solveDetail = s.solve ? ` rowSolve err ${s.solve.raw}% -> ${s.solve.solved}% (n=${s.solve.n})` : ''
      debugLog(`[HDMI-RX] Luma4 CAL sharpen fit: lambdaH=${s.lh} lambdaV=${s.lv} R2=${s.r2} err ${s.errBefore}% -> ${s.errAfter}% after unsharp correction (n=${s.n})${solveDetail}`)
      if (Number.isFinite(s.railHeadroom) && s.railHeadroom < 6) {
        // Rail pinning needs the top mid's peaking overshoot to stay below
        // white-6; past that, clamped mids become indistinguishable from
        // true white and the deconvolution degrades. Lower the upper
        // ?luma-mids value on the sender to buy headroom back.
        debugLog(`[HDMI-RX] Luma4 WARNING: sharpen overshoot headroom is ${s.railHeadroom} gray (top mid level too close to white for lambda=${s.lh}) - lower the second ?luma-mids value on the sender`)
      }
      maybeArmLuma1SharpenCorrection(s)
    }
  }
}

// Auto-arm the deconvolution from a confident calibration fit: future LUMA_1
// decodes (generic and locked) invert the measured horizontal peaking before
// classification. Persisted so a real transfer after a reload still benefits.
const LUMA1_SHARPEN_STORAGE_KEY = 'hdmi-uvc-luma-sharpen'

function maybeArmLuma1SharpenCorrection(sharpenFit) {
  if (!sharpenFit || sharpenFit.r2 < 0.8 || sharpenFit.lh < 0.05) return
  const current = getLuma1SharpenCorrection()
  if (current !== null && Math.abs(current - sharpenFit.lh) < 0.03) return
  const armed = setLuma1SharpenCorrection(sharpenFit.lh)
  if (armed === null) return
  try {
    localStorage.setItem(LUMA1_SHARPEN_STORAGE_KEY, String(armed))
  } catch (_) { /* private mode */ }
  postSharpenLambdaToWorker()
  debugLog(`[HDMI-RX] Luma4 sharpen correction ARMED: lambda=${armed} (from cal fit, persisted; clear with ?luma-sharpen=0)`)
}

// Frames of consecutive LUMA_1 CRC failure before the blind λ sweep runs.
// High enough that a momentary glitch never pays for the extra decodes, low
// enough that a receiver with no stored λ recovers within a second.
const LUMA1_SHARPEN_SWEEP_AFTER_FAILS = 4

// Recover the peaking correction from an ordinary failed frame. Without this
// a receiver that has never stored a λ — a fresh profile, a cleared origin, a
// different dev-server port — cannot decode a peaked channel at all, because
// the calibration frame that used to supply λ no longer has a sender-side
// producer. Runs at most once per relock cycle: the decodes are only worth
// spending while genuinely unlocked.
function maybeSweepLuma1Sharpen(result, imageBytes, frameWidth, region) {
  if (!result || result.crcValid) return null
  if (result._diag?.frameMode !== HDMI_MODE.LUMA_1) return null
  if (getLuma1SharpenCorrection() !== null) return null
  if (state.luma1SharpenSweepTried) return null
  if ((state.decodeFailCount || 0) < LUMA1_SHARPEN_SWEEP_AFTER_FAILS) return null
  state.luma1SharpenSweepTried = true
  const startMs = performance.now()
  const swept = sweepLuma1SharpenCorrection(imageBytes, frameWidth, region)
  const elapsed = Math.round(performance.now() - startMs)
  if (!swept) {
    debugLog(
      `[HDMI-RX] Luma4 sharpen blind sweep found no lambda in ${elapsed}ms - ` +
      'channel problem is not horizontal peaking'
    )
    return null
  }
  try {
    localStorage.setItem(LUMA1_SHARPEN_STORAGE_KEY, String(swept.lambda))
  } catch (_) { /* private mode */ }
  postSharpenLambdaToWorker()
  debugLog(
    `[HDMI-RX] Luma4 sharpen correction ARMED: lambda=${swept.lambda} ` +
    `(blind sweep of a failed frame, ${elapsed}ms, persisted; clear with ?luma-sharpen=0)`
  )
  return swept.result
}

function restoreLuma1SharpenCorrection() {
  let urlValue = null
  try {
    urlValue = new URLSearchParams(location.search).get('luma-sharpen')
  } catch (_) { /* no location */ }
  if (urlValue !== null) {
    const parsed = Number.parseFloat(urlValue)
    if (parsed === 0) {
      setLuma1SharpenCorrection(null)
      try { localStorage.removeItem(LUMA1_SHARPEN_STORAGE_KEY) } catch (_) { /* ignore */ }
      debugLog('[HDMI-RX] Luma4 sharpen correction cleared via URL')
      return
    }
    const armed = setLuma1SharpenCorrection(parsed)
    if (armed !== null) {
      debugLog(`[HDMI-RX] Luma4 sharpen correction set from URL: lambda=${armed}`)
      return
    }
  }
  let stored = null
  try {
    stored = localStorage.getItem(LUMA1_SHARPEN_STORAGE_KEY)
  } catch (_) { /* private mode */ }
  if (stored !== null) {
    const armed = setLuma1SharpenCorrection(Number.parseFloat(stored))
    if (armed !== null) {
      debugLog(`[HDMI-RX] Luma4 sharpen correction restored: lambda=${armed} (saved from a previous cal run)`)
    }
  }
}

function logDenseBinaryLockOutcome(outcome) {
  if (!outcome?.locked || outcome.wasLocked) return
  const layout = outcome.layout
  const modeName = HDMI_MODE_NAMES[layout.frameMode] || 'dense binary'
  debugLog(
    `[HDMI-RX] ${modeName} layout locked: ` +
    `step=${layout.stepX.toFixed(2)}/${layout.stepY.toFixed(2)} ` +
    `grid=${layout.blocksX}x${layout.blocksY}`
  )
}

function logDenseBinaryConfidence(result) {
  if (result?.header?.mode !== HDMI_MODE.BINARY_3 || !(result.confidence instanceof Uint8Array)) return
  if (
    state.lastDenseBinaryConfidenceLogFrame > 0 &&
    state.frameCount - state.lastDenseBinaryConfidenceLogFrame < BINARY3_CONFIDENCE_LOG_INTERVAL_FRAMES
  ) {
    return
  }
  state.lastDenseBinaryConfidenceLogFrame = state.frameCount

  const values = Array.from(result.confidence).sort((a, b) => a - b)
  if (values.length === 0) return
  const pick = (p) => values[Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * p)))]
  let sum = 0
  for (const value of values) sum += value
  const mean = sum / values.length
  debugLog(`[HDMI-RX] BINARY_3 confidence: p10=${pick(0.10)} p50=${pick(0.50)} p90=${pick(0.90)} mean=${mean.toFixed(1)}`)
}

function setTentativeAnchorRegion(region, sourceWidth, sourceHeight, anchors = null) {
  if (!region || state.anchorBounds) return

  state.tentativeAnchorBounds = region
  state.tentativeLockedCaptureRegion = getLockedCaptureRegion(region, sourceWidth, sourceHeight)
  state.tentativeAnchors = anchors || null
}

function clearTentativeAnchorRegion() {
  state.tentativeAnchorBounds = null
  state.tentativeLockedCaptureRegion = null
  state.tentativeAnchors = null
}

// Pre-lock diagnostic dump: locate canvas bounds and probable anchor pixels
// in a captured frame and log raw strips around them. Debug-only (isDiagFrame
// gates the call); no effect on decode state.
function logPreLockFrameDiagnostics(imageData, frameWidth, frameHeight) {
  const p = imageData.data

  // Step 1: Find chrome bottom (transition from bright to dark at center x)
  const midX = Math.floor(frameWidth / 2)
  let chromeBottom = 0
  for (let y = 0; y < Math.min(200, frameHeight - 1); y++) {
    if (p[(y * frameWidth + midX) * 4] > 100 && p[((y + 1) * frameWidth + midX) * 4] < 30) {
      chromeBottom = y + 1
      break
    }
  }

  // Step 2: Find canvas left edge — scan right from x=0 at chromeBottom+16
  // (skip MJPEG ringing zone, probe mid-margin area)
  const probeY = chromeBottom + 16
  let canvasLeft = 0
  // The canvas margin is black (≤5). Find where values go from HDMI-black to canvas-black.
  // They look the same, so instead scan for first pixel >20 (data region)
  // then subtract margin width to estimate canvas left.
  let firstData = -1
  for (let x = 0; x < frameWidth; x++) {
    if (p[(probeY * frameWidth + x) * 4] > 20) { firstData = x; break }
  }

  debugLog(`Chrome bottom: ${chromeBottom}, probeY: ${probeY}, firstData@probeY: ${firstData}`)

  // Step 3: Scan for ANY bright pixel below chrome, skipping the chrome area
  // Search in top-left quadrant below chrome
  let tlX = -1, tlY = -1
  outer_tl:
  for (let y = chromeBottom; y < Math.min(chromeBottom + 200, frameHeight); y++) {
    for (let x = 0; x < Math.min(300, frameWidth); x++) {
      if (p[(y * frameWidth + x) * 4] > 150) { tlX = x; tlY = y; break outer_tl }
    }
  }
  debugLog(`TL first bright(>150) below chrome: (${tlX},${tlY})`)

  if (tlX >= 0 && tlY >= 0) {
    // Dump horizontal and vertical strips around the find
    const hstrip = []
    for (let x = Math.max(0, tlX - 5); x < Math.min(frameWidth, tlX + 45); x++) {
      hstrip.push(p[(tlY * frameWidth + x) * 4])
    }
    debugLog(`  Row${tlY} R[${Math.max(0,tlX-5)}..+50]: ${hstrip.join(',')}`)

    const vstrip = []
    for (let y = Math.max(0, tlY - 5); y < Math.min(frameHeight, tlY + 40); y++) {
      vstrip.push(p[(y * frameWidth + tlX) * 4])
    }
    debugLog(`  Col${tlX} R[${Math.max(0,tlY-5)}..+45]: ${vstrip.join(',')}`)
  } else {
    // No bright pixel found! Dump raw values in the expected anchor zone
    debugLog(`NO bright pixel found below chrome! Dumping rows ${chromeBottom}..${chromeBottom+5} x=0..60:`)
    for (let y = chromeBottom; y < Math.min(chromeBottom + 6, frameHeight); y++) {
      const row = []
      for (let x = 0; x < Math.min(60, frameWidth); x++) row.push(p[(y * frameWidth + x) * 4])
      debugLog(`  Row${y}: ${row.join(',')}`)
    }
  }

  // Bottom-right scan (skip last few rows which might be chrome/dock)
  let brX = -1, brY = -1
  outer_br:
  for (let y = frameHeight - 1; y >= Math.max(0, frameHeight - 200); y--) {
    for (let x = frameWidth - 1; x >= Math.max(0, frameWidth - 300); x--) {
      if (p[(y * frameWidth + x) * 4] > 150) { brX = x; brY = y; break outer_br }
    }
  }
  debugLog(`BR last bright(>150): (${brX},${brY})`)
  if (brX >= 0) {
    const hstrip = []
    for (let x = Math.max(0, brX - 40); x < Math.min(frameWidth, brX + 10); x++) {
      hstrip.push(p[(brY * frameWidth + x) * 4])
    }
    debugLog(`  Row${brY} R[${Math.max(0,brX-40)}..+50]: ${hstrip.join(',')}`)
  }

  // Center
  const cx = Math.floor(frameWidth / 2), cy = Math.floor(frameHeight / 2)
  const center = []
  for (let x = cx - 5; x <= cx + 5; x++) center.push(p[(cy * frameWidth + x) * 4])
  debugLog(`Center[${cx},${cy}]: ${center.join(',')}`)
}

// Frame-acquisition phase of processFrame: refresh the locked ROI, then try
// the capture strategies in speed order — read-pool dispatch (frame leaves the
// main thread entirely), capture-into-WASM, ImageCapture (pre-lock only),
// VideoFrame vs direct-video (benchmarked), canvas draw as the fallback.
// Returns { status, imageData, imageWidth, imageHeight, decodeRegion,
// captureMethod, captureMs }; status is 'ok' when imageData is ready,
// 'pool-dispatched' / 'pool-busy' when the frame was consumed (or skipped) by
// the read pool and the caller should just finalize perf and reschedule.
async function acquireFrameImage(video, width, height, metadata) {
  const captureStartMs = performance.now()
  let imageData = null
  let imageWidth = width
  let imageHeight = height
  let decodeRegion = null
  let captureMethod = 'video'

  // ImageCapture is useful for initial acquisition, but it is noticeably
  // slower than drawing the video element directly. Once we have HDMI anchor
  // lock, prioritize raw video frames.
  const useImageCapture = imageCapture &&
    !state.anchorBounds &&
    !state.tentativeAnchorBounds
  let lockedCapture = null
  const anchorRegionForCapture = state.anchorBounds || state.tentativeAnchorBounds
  if (shouldUseLockedCaptureRegion(anchorRegionForCapture, state.labFrameTapEnabled)) {
    const needsLockedCaptureRefresh =
      state.anchorBounds
        ? (
            !state.lockedCaptureRegion ||
            state.lockedCaptureRegion.sourceWidth !== width ||
            state.lockedCaptureRegion.sourceHeight !== height
          )
        : (
            !state.tentativeLockedCaptureRegion ||
            state.tentativeLockedCaptureRegion.sourceWidth !== width ||
            state.tentativeLockedCaptureRegion.sourceHeight !== height
          )
    if (needsLockedCaptureRefresh) {
      const refreshedCaptureRegion = getLockedCaptureRegion(anchorRegionForCapture, width, height)
      if (state.anchorBounds) {
        state.lockedCaptureRegion = refreshedCaptureRegion
      } else {
        state.tentativeLockedCaptureRegion = refreshedCaptureRegion
      }
      if (refreshedCaptureRegion) {
        const { sourceRect } = refreshedCaptureRegion
        debugLog(
          `Capture ROI ${state.anchorBounds ? 'locked' : 'candidate'}: src=(${sourceRect.x},${sourceRect.y}) ` +
          `${sourceRect.w}x${sourceRect.h}`
        )
      }
    }
    lockedCapture = state.anchorBounds
      ? state.lockedCaptureRegion
      : state.tentativeLockedCaptureRegion
    maybeStartRoiWarmupBenchmark({
      roiCaptureAvailable: !!lockedCapture,
      reason: 'pre-signal ROI'
    })
  }

  // Try ImageCapture API first while scanning for initial lock
  if (useImageCapture) {
    try {
      const bitmap = await imageCapture.grabFrame()
      imageData = captureImageDataToCanvas(bitmap, state.canvas, state.ctx, width, height)
      bitmap.close()
      captureMethod = 'ImageCapture'
    } catch (e) {
      // Fall through to other methods
    }
  }

  // Parallel read pool: capture the locked ROI into a transferable buffer,
  // hand it to an idle read worker, and skip ALL main-thread decode for this
  // frame — packets return asynchronously between frames and feed the same
  // acceptPackets path. Falls through to the normal paths on any failure.
  if (!imageData && lockedCapture && metadata && readPoolFrameEligible(lockedCapture)) {
    const slot = pickIdleReadWorker()
    if (!slot) {
      // Every worker busy: this frame would be dropped by the sync path
      // anyway — skip it cheaply instead of blocking capture with a 20ms+
      // synchronous decode.
      readPool.stats.skippedBusy++
      return {
        status: 'pool-busy',
        captureMethod,
        captureMs: performance.now() - captureStartMs
      }
    }
    const dispatched = await capturePoolFrameAndDispatch(
      video, lockedCapture, metadata.mediaTime * 1000000 || 0, slot
    )
    if (dispatched) {
      state.frameCount++
      if (state.activeCaptureMethod !== 'wasm ROI pool') {
        state.activeCaptureMethod = 'wasm ROI pool'
        debugLog('Capture path: wasm ROI pool')
      }
      return {
        status: 'pool-dispatched',
        captureMethod: 'wasm ROI pool',
        captureMs: performance.now() - captureStartMs
      }
    }
  }

  // Steady-state fast path: capture the locked ROI straight into WASM memory
  // (zero-allocation, zero-copy decode). Falls through to the canvas paths
  // below on any failure.
  if (!imageData && lockedCapture && metadata && wasmCaptureEligible(lockedCapture)) {
    try {
      const wasmFrame = await captureFrameIntoWasm(video, lockedCapture, metadata.mediaTime * 1000000 || 0)
      if (wasmFrame) {
        imageData = wasmFrame
        imageWidth = lockedCapture.width
        imageHeight = lockedCapture.height
        decodeRegion = lockedCapture.region
        captureMethod = 'wasm ROI'
      }
    } catch (e) {
      noteWasmCaptureFailure(e)
    }
  }

  // For the steady-state HDMI path, benchmark VideoFrame against direct video
  // capture and keep whichever is faster for the session.
  if (!imageData) {
    const tuning = state.captureTuning
    const roiCapture = !!lockedCapture
    const preferredMethod = roiCapture ? tuning?.roiPreferredMethod : tuning?.preferredMethod
    const videoFrameSampleCount = roiCapture ? tuning?.roiVideoFrameSampleCount : tuning?.videoFrameSampleCount
    const videoSampleCount = roiCapture ? tuning?.roiVideoSampleCount : tuning?.videoSampleCount
    const useVideoFrameCapture = hasVideoFrame && metadata && (
      preferredMethod === 'VideoFrame' ||
      (!preferredMethod && videoFrameSampleCount <= videoSampleCount)
    )

    if (useVideoFrameCapture) {
      try {
        const frame = new VideoFrame(video, { timestamp: metadata.mediaTime * 1000000 || 0 })
        if (lockedCapture) {
          imageData = captureImageDataToCanvas(
            frame,
            state.canvas,
            state.ctx,
            lockedCapture.width,
            lockedCapture.height,
            lockedCapture.sourceRect
          )
          imageWidth = lockedCapture.width
          imageHeight = lockedCapture.height
          decodeRegion = lockedCapture.region
          captureMethod = 'VideoFrame ROI'
        } else {
          imageData = captureImageDataToCanvas(frame, state.canvas, state.ctx, width, height)
          captureMethod = 'VideoFrame'
        }
        frame.close()
      } catch (e) {
        // Fall through to direct video capture
      }
    }
  }

  // Default steady-state path: draw video directly to canvas.
  if (!imageData) {
    if (lockedCapture) {
      imageData = captureImageDataToCanvas(
        video,
        state.canvas,
        state.ctx,
        lockedCapture.width,
        lockedCapture.height,
        lockedCapture.sourceRect
      )
      imageWidth = lockedCapture.width
      imageHeight = lockedCapture.height
      decodeRegion = lockedCapture.region
      captureMethod = 'video ROI'
    } else {
      imageData = captureImageDataToCanvas(video, state.canvas, state.ctx, width, height)
      captureMethod = 'video'
    }
  }

  return {
    status: 'ok',
    imageData,
    imageWidth,
    imageHeight,
    decodeRegion,
    captureMethod,
    captureMs: performance.now() - captureStartMs
  }
}

async function processFrame(now, metadata) {
  if (!state.isScanning || !state.stream) return

  const video = elements.video
  if (video.videoWidth === 0) {
    scheduleNextFrame()
    return
  }

  const width = video.videoWidth
  const height = video.videoHeight

  let imageData
  let imageWidth = width
  let imageHeight = height
  let decodeRegion = state.anchorBounds || state.tentativeAnchorBounds
  let captureMethod = 'video'
  const frameStartMs = performance.now()
  let captureMs = 0
  let anchorMs = 0
  let fastPathMs = 0
  let decodeMs = 0
  let classifierMs = 0
  let framePerfFinalized = false
  let fastPathAcceptedThisFrame = false
  // Reset per-frame accept signals. frameAcceptedThisFrame drives
  // noteFrameBoundary; frameInnovatedThisFrame drives innovation stats only.
  state.frameAcceptedThisFrame = false
  state.frameInnovatedThisFrame = false
  const finalizeFramePerf = () => {
    if (framePerfFinalized) return
    framePerfFinalized = true
    const isHotFrame = shouldRecordReceiverHotPerfFrame({
      anchorLocked: !!state.anchorBounds,
      fixedLayout: state.fixedLayout,
      expectedPacketCount: state.expectedPacketCount,
      roiPreferredMethod: state.captureTuning?.roiPreferredMethod,
      fastPathAccepted: fastPathAcceptedThisFrame
    })
    noteReceiverFrameUse(state.frameAcceptedThisFrame, state.frameInnovatedThisFrame)
    noteReceiverFramePerf(
      frameStartMs,
      captureMethod,
      captureMs,
      anchorMs,
      fastPathMs,
      decodeMs,
      classifierMs,
      isHotFrame
    )
    if (state.frameAcceptedThisFrame &&
        typeof state.decoder?.noteFrameBoundary === 'function') {
      state.decoder.noteFrameBoundary()
      // If the tail solver just closed the file, surface completion now
      // rather than on the next frame — acceptPackets already checked
      // isComplete() before noteFrameBoundary ran.
      if (state.decoder.isComplete() && !state.completedFile) {
        debugLog('=== TRANSFER COMPLETE (via tail solver) ===')
        handleComplete()
      }
    }
  }
  const acquired = await acquireFrameImage(video, width, height, metadata)
  captureMs = acquired.captureMs
  captureMethod = acquired.captureMethod
  if (acquired.status !== 'ok') {
    // 'pool-busy': every read worker occupied — frame skipped cheaply.
    // 'pool-dispatched': frame handed to a read worker; packets return async.
    finalizeFramePerf()
    if (state.isScanning) scheduleNextFrame()
    return
  }
  imageData = acquired.imageData
  imageWidth = acquired.imageWidth
  imageHeight = acquired.imageHeight
  if (acquired.decodeRegion) decodeRegion = acquired.decodeRegion
  rememberCapturedFrame(imageData)
  const tunableCaptureMethod = captureMethod.startsWith('VideoFrame') || captureMethod.startsWith('video')
  const roiCaptureMethod = captureMethod.endsWith('ROI')
  const benchmarkActive = tunableCaptureMethod && state.captureTuning
    ? !(roiCaptureMethod ? state.captureTuning.roiPreferredMethod : state.captureTuning.preferredMethod)
    : false
  noteCaptureTuningSample(
    captureMethod.startsWith('VideoFrame') ? 'VideoFrame' : captureMethod.startsWith('video') ? 'video' : captureMethod,
    captureMs,
    roiCaptureMethod
  )
  // Capture-only benchmark mode: once anchors are locked (so lockedCapture
  // drove the ROI capture this frame), skip all decode work and just record
  // capture timing. Pre-lock frames fall through to anchor detection — we
  // need the lock to measure the locked-ROI path the feedback asks for.
  if (CAPTURE_BENCH_ONLY && state.anchorBounds) {
    noteCaptureBenchFrame(captureMethod, imageWidth, imageHeight)
    finalizeFramePerf()
    if (state.isScanning) scheduleNextFrame()
    return
  }

  const frameWidth = imageWidth
  const frameHeight = imageHeight

  if (shouldLogReceiverCapturePathChange({
    previousMethod: state.activeCaptureMethod,
    nextMethod: captureMethod,
    benchmarkActive
  })) {
    state.activeCaptureMethod = captureMethod
    debugLog(`Capture path: ${captureMethod}`)
  }

  state.frameCount++
  const isDiagFrame = shouldLogAnchorScanDiagnostics({
    anchorLocked: !!state.anchorBounds,
    frameCount: state.frameCount
  })

  // Diagnostic: find canvas bounds and scan for anchors (debug-only)
  if (!state.anchorBounds && isDiagFrame) {
    logPreLockFrameDiagnostics(imageData, frameWidth, frameHeight)
  }

  // === ANCHOR DETECTION ===
  let region = decodeRegion
  let candidateRegion = null
  let candidateAnchors = null

  if (!region) {
    const anchorStartMs = performance.now()
    const anchors = detectAnchors(imageData.data, frameWidth, frameHeight)
    anchorMs += performance.now() - anchorStartMs
    if (anchors.length >= 2) {
      if (!candidateRegion) candidateRegion = dataRegionFromAnchors(anchors)
      if (candidateRegion) {
        setTentativeAnchorRegion(candidateRegion, frameWidth, frameHeight, anchors)
        region = candidateRegion
        candidateAnchors = anchors
      } else if (isDiagFrame) {
        // Anchors found but region invalid (e.g. all at same y = false positives)
        const pos = anchors.map(a => `(${a.x},${a.y} ${a.corner})`).join(' ')
        debugLog(`Frame ${state.frameCount}: ${anchors.length} anchors but invalid region: ${pos}`)
        debugCurrent(`#${state.frameCount} bad anchors`)
      }
    } else if (isDiagFrame) {
      debugLog(`Frame ${state.frameCount}: ${anchors.length} anchors found (need ≥2)`)
      debugCurrent(`#${state.frameCount} scanning...`)
    }
  }

  if (!region) {
    scheduleNextFrame()
    finalizeFramePerf()
    return
  }

  const fastPathStartMs = performance.now()
  const fastPathAccepted = await tryLockedLayoutFastPath(imageData, frameWidth, region)
  fastPathMs += performance.now() - fastPathStartMs
  if (fastPathAccepted) {
    fastPathAcceptedThisFrame = true
    finalizeFramePerf()
    return
  }

  // === DECODE DATA REGION ===
  if (shouldSkipLuma1SweepForBackoff() || shouldSkipDecodeForLuma1CalHold()) {
    scheduleNextFrame()
    finalizeFramePerf()
    return
  }

  region.preferredLayout = state.lockedDenseBinaryLayout || state.preferredLayout
  let result = null

  if (!result) {
    resetClassifierPerfAccumulator()
    // The failed-sweep evidence block costs ~100ms to build but is only
    // printed when the lock invalidates — capture it just for the sweep
    // whose failure will push the streak over the invalidation threshold.
    setLuma1DebugCapture(
      (state.denseBinaryLockFailStreak || 0) >= LOCKED_BINARY3_INVALIDATE_AFTER_FAILS - 1
    )
    const decodeStartMs = performance.now()
    result = decodeDataRegion(imageData.data, frameWidth, region)
    decodeMs += performance.now() - decodeStartMs
    classifierMs += getClassifierPerfAccumulator()
    const swept = maybeSweepLuma1Sharpen(result, imageData.data, frameWidth, region)
    if (swept) result = swept
  }
  noteLuma1SweepOutcome(result)
  logDenseBinaryConfidence(result)

  if (result && result.crcValid) {
    noteSignalDetected(result.header.mode, {
      width: result.header.width,
      height: result.header.height
    })

    // Calibration frames are link-validation success, not packet carriers —
    // divert them before the packet pipeline scores them as empty failures.
    // (Worker decode ships payload=null on CRC-valid frames, so this check
    // only engages on main-thread decodes; worker mode is off by default.)
    if (
      result.header.mode === HDMI_MODE.LUMA_1 &&
      result.payload &&
      isLuma1CalibrationPayload(result.payload)
    ) {
      noteLuma1CalibrationPass(result, region, frameWidth, frameHeight, candidateRegion, candidateAnchors)
      scheduleNextFrame()
      finalizeFramePerf()
      return
    }

    let frameAccepted = false
    let softSalvagedPacketCount = 0
    {
      const expectedPacketSize = getExpectedPacketSize()
      const packetProbe = probeFramePackets(result.payload, expectedPacketSize, getPacketProbeOptions(result))
      const totalFramePackets = packetProbe.slotCount
      const packets = packetProbe.packets
      softSalvagedPacketCount = packetProbe.salvaged || 0
      frameAccepted = await acceptPackets(
        packets,
        result.header.symbolId,
        true,
        totalFramePackets,
        null,
        {
          salvaged: packetProbe.salvaged || 0,
          parsedPackets: packetProbe.parsedPackets || null
        }
      )
    }

    if (frameAccepted) {
      if (softSalvagedPacketCount > 0) noteReceiverRecovery('salvage', softSalvagedPacketCount)
      if (!state.anchorBounds && (candidateRegion || state.tentativeAnchorBounds)) {
        lockAnchorRegion(
          candidateRegion || state.tentativeAnchorBounds,
          frameWidth,
          frameHeight,
          candidateAnchors || state.tentativeAnchors
        )
      }
      if (result._diag) state.fixedLayout = { ...result._diag }
      if (result._diag) state.preferredLayout = { ...result._diag }
      applyDenseBinaryLock(result, region)
      if (state.decoder?.isComplete()) {
        finalizeFramePerf()
        return
      }
    } else if (shouldUseHeaderOnlyFrameForLock(result)) {
      if (!state.anchorBounds && (candidateRegion || state.tentativeAnchorBounds)) {
        lockAnchorRegion(
          candidateRegion || state.tentativeAnchorBounds,
          frameWidth,
          frameHeight,
          candidateAnchors || state.tentativeAnchors
        )
      }
      if (result._diag) state.fixedLayout = { ...result._diag }
      if (result._diag) state.preferredLayout = { ...result._diag }
      applyDenseBinaryLock(result, region)
      maybeStartRoiWarmupBenchmark({
        headerOnlyFrame: true,
        reason: 'sync header'
      })
      debugCurrent(`#${state.frameCount} sync header`)
    } else {
      // CRC-valid outer frame but zero inner packets accepted (wrong block
      // size, CRC-loss on every slot, worker transport failure, etc.). Drive
      // the same relock path the CRC-fail branches use so repeated bad
      // frames don't silently keep the lock and starve progress.
      state.decodeFailCount++
      if (isDiagFrame) {
        const expectedPacketSize = getExpectedPacketSize()
        debugLog(
          `Frame ${state.frameCount}: CRC-valid outer but 0 packets ingested ` +
          `(expectedPkt=${formatMaybeInt(expectedPacketSize)})`
        )
      }
      debugCurrent(`#${state.frameCount} empty CRC-valid`)
    }
  } else if (result && !result.crcValid) {
    noteReceiverCrcFailFrame()
    if (result._diag) state.preferredLayout = { ...result._diag }
    const expectedPacketSize = getExpectedPacketSize()
    const salvageProbe = probeFramePackets(result.payload, expectedPacketSize, getPacketProbeOptions(result))
    const totalFramePackets = salvageProbe.slotCount
    const salvagedPackets = salvageProbe.packets
    const fixedPackets = tryFixedLayoutPackets(imageData.data, frameWidth, region)
    const phasePayloadLength =
      expectedPacketSize && state.expectedPacketCount > 0
        ? expectedPacketSize * state.expectedPacketCount
        : result.header.payloadLength
    const phaseProbe = probeLayoutPackets(
      imageData.data,
      frameWidth,
      region,
      result._diag || state.fixedLayout || state.preferredLayout,
      phasePayloadLength,
      expectedPacketSize,
      getLayoutProbeOptions(result._diag || state.fixedLayout || state.preferredLayout)
    )
    const phasePackets = phaseProbe?.probe?.packets || []
    if (await acceptPackets(
      salvagedPackets,
      result.header.symbolId,
      true,
      totalFramePackets,
      null,
      { salvaged: salvageProbe.salvaged || 0 }
    )) {
      noteSignalDetected(result.header.mode)
      noteReceiverRecovery('salvage', salvagedPackets.length)
      if (!state.anchorBounds && (candidateRegion || state.tentativeAnchorBounds)) {
        lockAnchorRegion(
          candidateRegion || state.tentativeAnchorBounds,
          frameWidth,
          frameHeight,
          candidateAnchors || state.tentativeAnchors
        )
      }
      if (result._diag) state.fixedLayout = { ...result._diag }
      if (result._diag) state.preferredLayout = { ...result._diag }
      applyDenseBinaryLock(result, region)
      if (isDiagFrame) {
        debugLog(
          `Frame ${state.frameCount}: salvaged ${salvagedPackets.length} packet(s) ` +
          `from CRC-fail frame (soft=${salvageProbe.salvaged || 0})`
        )
      }
      if (state.decoder?.isComplete()) {
        finalizeFramePerf()
        return
      }
      scheduleNextFrame()
      finalizeFramePerf()
      return
    }
    if (await acceptPackets(phasePackets, result.header.symbolId, true, phaseProbe?.probe?.slotCount || totalFramePackets)) {
      noteSignalDetected(phaseProbe?.layout?.frameMode ?? result.header.mode)
      noteReceiverRecovery('phase', phasePackets.length)
      if (!state.anchorBounds && (candidateRegion || state.tentativeAnchorBounds)) {
        lockAnchorRegion(
          candidateRegion || state.tentativeAnchorBounds,
          frameWidth,
          frameHeight,
          candidateAnchors || state.tentativeAnchors
        )
      }
      if (phaseProbe?.layout) state.fixedLayout = { ...phaseProbe.layout }
      if (phaseProbe?.layout) state.preferredLayout = { ...phaseProbe.layout }
      if (phaseProbe?.layout) applyDenseBinaryRecoveredLayout(phaseProbe.layout, result.header, region)
      if (isDiagFrame) {
        debugLog(`Frame ${state.frameCount}: phase-recovered ${phasePackets.length} packet(s) from CRC-fail frame`)
      }
      if (state.decoder?.isComplete()) {
        finalizeFramePerf()
        return
      }
      scheduleNextFrame()
      finalizeFramePerf()
      return
    }
    if (await acceptPackets(fixedPackets, result.header.symbolId, true, state.expectedPacketCount)) {
      noteSignalDetected(state.fixedLayout?.frameMode ?? result.header.mode)
      noteReceiverRecovery('fixed', fixedPackets.length)
      if (!state.anchorBounds && (candidateRegion || state.tentativeAnchorBounds)) {
        lockAnchorRegion(
          candidateRegion || state.tentativeAnchorBounds,
          frameWidth,
          frameHeight,
          candidateAnchors || state.tentativeAnchors
        )
      }
      if (isDiagFrame) {
        debugLog(`Frame ${state.frameCount}: recovered ${fixedPackets.length} packet(s) via fixed layout`)
      }
      if (isDenseBinaryLayout(state.fixedLayout)) {
        applyDenseBinaryRecoveredLayout(state.fixedLayout, result.header, region)
      }
      if (state.decoder?.isComplete()) {
        finalizeFramePerf()
        return
      }
      scheduleNextFrame()
      finalizeFramePerf()
      return
    }

    state.decodeFailCount++
    noteDenseBinaryLockFailure(result)
    if (isDiagFrame) {
      // Dump full header for diagnosis
      const h = result.header
      const hBytes = `magic=${h.magic.toString(16)} mode=${h.mode} ${h.width}x${h.height} fps=${h.fps} sym=${h.symbolId} len=${h.payloadLength} crc=${h.payloadCrc.toString(16)}`
      const diag = result._diag || {}
      debugLog(`Frame ${state.frameCount}: CRC fail — ${hBytes}`)
      const scaleLine = formatDecisionScale(diag)
      if (scaleLine) debugLog(`  ${scaleLine}`)
      const triedLine = formatDecisionCandidates(diag)
      if (triedLine) debugLog(`  ${triedLine}`)
      debugLog(`  ${formatRecoveryState(expectedPacketSize, totalFramePackets, salvagedPackets.length + phasePackets.length, fixedPackets.length, salvageProbe.strategy, salvageProbe.packetSize)}`)
    }
    debugCurrent(`#${state.frameCount} CRC fail`)
  } else {
    const fixedPackets = tryFixedLayoutPackets(imageData.data, frameWidth, region)
    if (await acceptPackets(fixedPackets, state.frameCount, true, state.expectedPacketCount)) {
      noteReceiverRecovery('headerless', fixedPackets.length)
      if (!state.anchorBounds && (candidateRegion || state.tentativeAnchorBounds)) {
        lockAnchorRegion(
          candidateRegion || state.tentativeAnchorBounds,
          frameWidth,
          frameHeight,
          candidateAnchors || state.tentativeAnchors
        )
      }
      if (isDiagFrame) {
        debugLog(`Frame ${state.frameCount}: recovered ${fixedPackets.length} packet(s) without outer header`)
      }
      if (state.decoder?.isComplete()) {
        finalizeFramePerf()
        return
      }
      scheduleNextFrame()
      finalizeFramePerf()
      return
    }

    state.decodeFailCount++
    if (isDiagFrame) {
      debugLog(`Frame ${state.frameCount}: decode failed`)
      debugLog(
        `  Recovery: expectedPkt=${formatMaybeInt(getExpectedPacketSize())} ` +
        `fixedLayout=${state.fixedLayout ? 'yes' : 'no'} ` +
        `expectedSlots=${formatMaybeInt(state.expectedPacketCount)} fixed=${fixedPackets.length}`
      )
      // Sample first header block values for diagnosis using the actual mode's
      // header block size instead of assuming a fixed anchor-to-data ratio.
      const anchorBs = region.blockSize || BLOCK_SIZE
      const modeBlockSize = getModeHeaderBlockSize(state.detectedMode ?? HDMI_MODE.COMPAT_4) || 4
      const dataScale = modeBlockSize / BLOCK_SIZE
      const bs = anchorBs * dataScale
      const stepX = (region.stepX || anchorBs) * dataScale
      const rx = region.x
      const ry = region.y
      const blocksX = Math.floor(region.w / stepX)
      const probeCount = Math.min(176, blocksX) // 22 bytes × 8 bits
      const rawValues = []
      for (let i = 0; i < Math.min(24, probeCount); i++) {
        const px = rx + Math.round(i * stepX)
        const py = ry
        if (px >= 0 && px < width && py >= 0 && py < height) {
          const cx = Math.round(px + bs / 2) - 1
          const cy = Math.round(py + bs / 2) - 1
          let sum = 0
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              sum += imageData.data[((cy + dy) * width + (cx + dx)) * 4]
            }
          }
          rawValues.push(Math.round(sum / 4))
        }
      }
      debugLog(`First 24 block values: [${rawValues.join(',')}]`)
      // Decode as binary: show what bytes they produce
      const decodedBytes = []
      for (let b = 0; b < Math.min(3, Math.floor(rawValues.length / 8)); b++) {
        let byte = 0
        for (let bit = 0; bit < 8; bit++) {
          if (rawValues[b * 8 + bit] > 128) byte |= (1 << (7 - bit))
        }
        decodedBytes.push(byte)
      }
      debugLog(`Decoded bytes: [${decodedBytes.join(',')}] (expect magic: 255,0,255,0)`)
    }
    debugCurrent(`#${state.frameCount} no data`)
  }

  // Relock anchors after too many consecutive failures (CRC or decode)
  if (!state.anchorBounds && state.tentativeAnchorBounds && state.decodeFailCount >= TENTATIVE_ANCHOR_MAX_FAILS) {
    debugLog(`Tentative anchor cleared after ${state.decodeFailCount} consecutive failures`)
    clearTentativeAnchorRegion()
  }
  if (state.decodeFailCount > 30) {
    debugLog(`Relock: ${state.decodeFailCount} consecutive failures`)
    state.anchorBounds = null
    state.lockedCaptureRegion = null
    clearTentativeAnchorRegion()
    state.fixedLayout = null
    state.preferredLayout = null
    clearDenseBinaryLock()
    state.expectedPacketCount = 0
    state.lockedLayoutFastPathMisses = 0
    state.decodeFailCount = 0
    // A relock is a fresh look at the channel — let the λ sweep run again if
    // it is still unarmed (a no-op once a lambda is armed or persisted).
    state.luma1SharpenSweepTried = false
  }

  // Update debug canvas (skip the copy entirely while the panel is hidden)
  if (isDiagFrame && isReceiverDiagPanelVisible()) {
    const debugCanvas = document.getElementById('hdmi-uvc-receiver-debug-canvas')
    if (debugCanvas) {
      debugCanvas.width = Math.min(width, 640)
      debugCanvas.height = Math.min(height, 360)
      debugCanvas.getContext('2d').drawImage(state.canvas, 0, 0, debugCanvas.width, debugCanvas.height)
    }
  }

  scheduleNextFrame()
  finalizeFramePerf()
}

function showReceivingStatus() {
  elements.statusScanning.classList.add('hidden')
  elements.statusReceiving.classList.remove('hidden')
  elements.statusComplete.classList.add('hidden')
}

function showCompleteStatus() {
  elements.statusScanning.classList.add('hidden')
  elements.statusReceiving.classList.add('hidden')
  elements.statusComplete.classList.remove('hidden')
}

function updateProgress() {
  if (!state.decoder || !state.decoder.metadata) return

  const meta = state.decoder.metadata
  const progress = state.decoder.progress

  elements.fileName.textContent = meta.filename
  if (elements.yoloBadge) {
    elements.yoloBadge.classList.toggle('hidden', meta.noRedundancy !== true)
  }
  const pct = getDisplayProgressPercent(state.decoder)
  elements.statProgress.textContent = pct + '%'
  elements.progressFill.style.width = pct + '%'
  elements.progressFill.parentElement.setAttribute('aria-valuenow', String(pct))

  const elapsed = (Date.now() - state.startTime) / 1000
  if (elapsed > 0) {
    const bytesReceived = progress * meta.fileSize
    const rate = bytesReceived / elapsed
    elements.statRate.textContent = formatBytes(rate) + '/s'
  }
}

async function handleComplete() {
  // Synchronous re-entry guard. `state.completedFile` is only set after the
  // awaited hash, so two same-tick callers (acceptPackets + finalizeFramePerf
  // when the tail solver closes the file) can both see it unset and race.
  if (state.completionStarted) return
  state.completionStarted = true

  state.isScanning = false

  cancelNextFrame()

  const decoder = state.decoder
  const meta = decoder.metadata

  // In worker mode reconstruct() returns a Promise; awaiting a non-Promise
  // value is a no-op, so this handles both the main-thread and worker paths.
  const fileData = await decoder.reconstruct()
  if (!fileData) {
    state.completionStarted = false
    state.isScanning = true
    scheduleNextFrame()
    return
  }

  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', fileData))
  const hashMatch = hash.every((b, i) => b === meta.hash[i])

  if (!hashMatch) {
    showError('File hash mismatch — transfer may be corrupted')
    debugLog('Complete rejected: SHA-256 mismatch')
    // With an ARQ back-channel a full repair is dispatched and we keep
    // receiving; without one, fall through and deliver the file with the
    // warning rather than destroying the decoded blocks.
    if (recoverFromHashMismatch()) return
  }

  const elapsed = (Date.now() - state.startTime) / 1000
  const rate = fileData.byteLength / elapsed

  state.completedFile = {
    data: fileData,
    name: meta.filename,
    type: meta.mimeType || 'application/octet-stream'
  }
  state.fileDownloaded = false
  sendArqCompleteIfReady()

  elements.completeName.textContent = meta.filename + ' (' + formatBytes(fileData.byteLength) + ') in ' + formatTime(elapsed * 1000)
  elements.completeRate.textContent = formatBytes(rate) + '/s'
  debugLog(`Complete: ${formatBytes(fileData.byteLength)} in ${elapsed.toFixed(1)}s (${formatBytes(rate)}/s)`)

  showCompleteStatus()
  playBeep()
  announce('Transfer complete: ' + meta.filename)
}

function downloadFile() {
  if (!state.completedFile) return

  const blob = new Blob([state.completedFile.data], { type: state.completedFile.type })
  triggerBlobDownload(blob, state.completedFile.name)
  state.fileDownloaded = true
}

// True while a fully received file is still only in memory. Navigation away
// resets the module and would silently discard it.
export function hasPendingDownload() {
  return !!state.completedFile && !state.fileDownloaded
}

function cancelNextFrame() {
  if (state.animationId) {
    cancelAnimationFrame(state.animationId)
    state.animationId = null
  }
  if (state.callbackId && hasVideoFrameCallback && elements.video) {
    elements.video.cancelVideoFrameCallback(state.callbackId)
    state.callbackId = null
  }
}

function resetReceiver() {
  state.isScanning = false
  stopWorkerCapture()

  cancelNextFrame()

  state.decoder = null
  state.frameCount = 0
  state.validFrames = 0
  state.startTime = null
  state.detectedMode = null
  state.detectedResolution = null
  state.completedFile = null
  state.completionStarted = false
  state.anchorBounds = null
  state.lockedCaptureRegion = null
  clearTentativeAnchorRegion()
  state.decodeFailCount = 0
  state.activeCaptureMethod = null
  state.fixedLayout = null
  state.preferredLayout = null
  state.lastReceiverFrameSignature = null
  clearDenseBinaryLock()
  state.lockedLayoutFastPathMisses = 0
  state.luma1CalPassCount = 0
  state.luma1CalHoldUntilMs = 0
  state.luma1CalLastLogMs = 0
  resetReadPoolForNewTransfer()
  state.expectedPacketCount = 0
  state.progressSamples = []
  state.lastReceivingUiUpdateMs = 0
  resetArqReceiverSession()
  state.workerCompletionSuppressed = false
  state.lastImageData = null
  state.lastImageDataSeq = 0
  state.lastImageDataCapturedAtMs = 0
  resetReceiverPerfState()
  resetCaptureTuningState()
  // Keep the worker alive across transfers. Pending requests from a prior
  // transfer are dropped (their responses will be ignored because the id is
  // gone from the pending map).
  receiverWorkerPending.clear()

  elements.statFrames.textContent = '0 frames'
  elements.statusScanning.classList.remove('hidden')
  elements.statusReceiving.classList.add('hidden')
  elements.statusComplete.classList.add('hidden')
  elements.progressFill.style.width = '0'
  elements.progressFill.parentElement.setAttribute('aria-valuenow', '0')

  if (state.stream) {
    elements.signalStatus.textContent = 'Connected — scanning…'
  }
}

function startScanning() {
  state.isScanning = true
  initReceiverWorker()
  // Worker-capture modes take over (or intercept) the frame pump. Attempt
  // the handoff here; if the worker isn't ready yet, the start function
  // sets state.workerCapturePending and the 'ready' handler retries.
  // scheduleNextFrame is still called so the appropriate callback kicks in
  // (worker-full mode no-ops, offscreen uses processFrameForOffscreen, main
  // falls through to the existing processFrame path).
  if (CAPTURE_METHOD === 'worker') startWorkerCapture()
  else if (CAPTURE_METHOD === 'offscreen') startOffscreenCapture()
  scheduleNextFrame()
}

async function handleDeviceChange() {
  const deviceId = elements.deviceDropdown.value
  resetReceiver()

  if (await startCapture(deviceId)) {
    startScanning()
  }
}

// Reset and "Receive Another" destroy the in-memory file just like leaving
// the screen does; ask first.
async function confirmDiscardPending() {
  return !hasPendingDownload() ||
    confirmDialog('The received file has not been downloaded yet. Discard it and scan again?')
}

async function handleReceiveAnother() {
  if (!(await confirmDiscardPending())) return
  resetReceiver()
  startScanning()
}

export async function autoStartHdmiUvcReceiver() {
  autoConnectArqHelper()
  await enumerateDevices()

  const savedDevice = loadDevicePreference()
  const deviceId = savedDevice || elements.deviceDropdown.value

  if (await startCapture(deviceId)) {
    startScanning()
  }
}

export function resetHdmiUvcReceiver() {
  resetReceiver()
  state.arqTransport?.close()
  state.arqTransport = null
  state.arqConnected = false
  state.arqHelperConnecting = false
  state.arqHelperAutoAttempted = false
  postArqStateToWorker()
  applyArqReceiverHelperStatus(ARQ_HELPER_STATUS.OFFLINE)

  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop())
    state.stream = null
  }

  imageCapture = null
  teardownReceiverWorker()

  elements.signalStatus.textContent = 'Waiting for signal…'
  elements.signalStatus.classList.remove('connected')
}

// True while a transfer is underway (metadata seen, file not yet complete);
// used by the beforeunload guard.
export function isReceiving() {
  return state.isScanning && !!(state.decoder && state.decoder.metadata) && !state.completedFile
}

export function initHdmiUvcReceiver(errorHandler) {
  showError = errorHandler

  // Push the diagnostics setting into the codec (see setWasmClassifierEnabled
  // in hdmi-uvc-frame.js — the codec no longer reads the diagnostics store).
  setWasmClassifierEnabled(getWasmClassifierEnabled())

  elements = {
    video: document.getElementById('hdmi-uvc-video'),
    signalStatus: document.getElementById('hdmi-uvc-signal-status'),
    deviceDropdown: document.getElementById('hdmi-uvc-device-dropdown'),
    statusScanning: document.getElementById('hdmi-uvc-status-scanning'),
    statusReceiving: document.getElementById('hdmi-uvc-status-receiving'),
    statusComplete: document.getElementById('hdmi-uvc-status-complete'),
    statFrames: document.getElementById('hdmi-uvc-stat-frames'),
    fileName: document.getElementById('hdmi-uvc-file-name'),
    yoloBadge: document.getElementById('hdmi-uvc-yolo-badge'),
    statProgress: document.getElementById('hdmi-uvc-stat-progress'),
    statRate: document.getElementById('hdmi-uvc-stat-rate'),
    progressFill: document.getElementById('hdmi-uvc-progress-fill'),
    completeName: document.getElementById('hdmi-uvc-complete-name'),
    completeRate: document.getElementById('hdmi-uvc-complete-rate'),
    btnReset: document.getElementById('btn-hdmi-uvc-reset'),
    btnDownload: document.getElementById('btn-hdmi-uvc-download'),
    btnAnother: document.getElementById('btn-hdmi-uvc-another'),
    btnHelperConnect: document.getElementById('btn-hdmi-uvc-helper-connect'),
    helperStatus: document.getElementById('hdmi-uvc-helper-status')
  }

  elements.deviceDropdown.onchange = handleDeviceChange
  elements.btnReset.onclick = async () => {
    if (!(await confirmDiscardPending())) return
    resetReceiver()
    startScanning()
  }
  elements.btnDownload.onclick = downloadFile
  elements.btnAnother.onclick = handleReceiveAnother
  if (elements.btnHelperConnect) elements.btnHelperConnect.onclick = () => connectArqHelper()
  // The macOS Keyboard Setup Assistant only exists for the keyboard dongle
  // transport, so the answer button is hidden for BLE-GATT.
  const btnKbdIdentify = document.getElementById('btn-hdmi-uvc-kbd-identify')
  const syncKbdIdentifyVisibility = (name) => {
    if (btnKbdIdentify) btnKbdIdentify.classList.toggle('hidden', name !== 'keyboard')
  }
  if (btnKbdIdentify) btnKbdIdentify.onclick = () => identifyMacKeyboard()
  // Switching transport drops any live helper connection so the next connect
  // uses the new one. Both ends must be set to the same transport to talk.
  initArqTransportSelect(document.getElementById('hdmi-uvc-helper-transport'), {
    onChange: (name) => {
      state.arqTransport?.close()
      state.arqTransport = null
      state.arqConnected = false
      applyArqReceiverHelperStatus(ARQ_HELPER_STATUS.OFFLINE)
      syncKbdIdentifyVisibility(name)
    }
  })
  syncKbdIdentifyVisibility(getSelectedArqTransportName())
  applyArqReceiverHelperStatus(state.arqConnected ? ARQ_HELPER_STATUS.CONNECTED : ARQ_HELPER_STATUS.OFFLINE)

  // Diagnostics panel: hidden by default, toggle persisted across sessions.
  initDiagnosticsPanelToggle({
    button: document.getElementById('btn-hdmi-uvc-receiver-diag-toggle'),
    panel: document.getElementById('hdmi-uvc-receiver-debug'),
    storageKey: 'hdmi-uvc-diag-visible-receiver',
    onChange: (visible) => {
      setReceiverDiagPanelVisible(visible)
      if (visible) flushDebugLogRender()
    }
  })
  // Settings that used to be URL-only flags, plus a badge that stays visible
  // even with the panel closed so non-default config is never silent.
  renderDiagnosticSettings(document.getElementById('hdmi-uvc-diag-settings'), {
    modifiedBadge: document.getElementById('hdmi-uvc-receiver-diag-modified')
  })

  // Debug panel buttons
  const copyBtn = document.getElementById('btn-hdmi-uvc-receiver-copy-log')
  if (copyBtn) {
    const copyLog = () => copyWithButtonFeedback(copyBtn, debugLogBuffer.getCopyText())
    copyBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault()
      copyLog()
    })
    copyBtn.onclick = (event) => {
      if (event.detail === 0) copyLog()
    }
  }
  const clearBtn = document.getElementById('btn-hdmi-uvc-receiver-clear-log')
  if (clearBtn) {
    clearBtn.onclick = () => {
      debugLogBuffer.clear()
      flushDebugLogRender()
      debugLog('=== LOG CLEARED ===')
      debugLog(`Frame count at clear: ${state.frameCount}`)
    }
  }
  debugLog('HDMI-UVC Receiver initialized')
  restoreLuma1SharpenCorrection()
  // One blind-sweep call may not block the main thread longer than this —
  // the strips order the true phase first, so real frames still lock on the
  // first candidate; only doomed sweeps get truncated.
  setLuma1SweepTimeBudgetMs(120)
  debugLog(
    `Capture method chosen: ${CAPTURE_METHOD} ` +
    `(capabilities=${JSON.stringify(CAPTURE_CAPABILITIES)})`
  )
  debugLog(`Perf logging: ${PERF_MODE ? 'on' : 'off'}`)
}

export function testDenseBinaryLockedLayoutOffsetsCoverBinary2() {
  const oldOffsets = state.lockedDenseBinaryOffsets
  const fallbackOffsets = new Int32Array([7, 11])
  const layoutOffsets = new Int32Array([13, 17])
  try {
    state.lockedDenseBinaryOffsets = fallbackOffsets
    const binary2WithLayoutOffsets = getDenseBinaryLayoutOffsets({
      frameMode: HDMI_MODE.BINARY_2,
      precomputedOffsets: layoutOffsets
    })
    const binary2FallbackOffsets = getDenseBinaryLayoutOffsets({
      frameMode: HDMI_MODE.BINARY_2
    })
    const denseBinaryFallbackOffsets = getDenseBinaryLayoutOffsets({
      frameMode: HDMI_MODE.BINARY_3
    })
    const compatOffsets = getDenseBinaryLayoutOffsets({
      frameMode: HDMI_MODE.COMPAT_4
    })
    const pass = binary2WithLayoutOffsets === layoutOffsets &&
      binary2FallbackOffsets === fallbackOffsets &&
      denseBinaryFallbackOffsets === fallbackOffsets &&
      compatOffsets === null
    console.log('Dense binary locked-layout offsets test:', pass ? 'PASS' : 'FAIL', {
      binary2WithLayoutOffsets: binary2WithLayoutOffsets?.length || 0,
      binary2FallbackOffsets: binary2FallbackOffsets?.length || 0,
      denseBinaryFallbackOffsets: denseBinaryFallbackOffsets?.length || 0,
      compatOffsets: compatOffsets?.length || 0
    })
    return pass
  } finally {
    state.lockedDenseBinaryOffsets = oldOffsets
  }
}

export function testLockedFastPerfBreakdownSummary() {
  const oldPerf = state.rxPerf
  try {
    state.rxPerf = createReceiverPerfState()
    noteLockedFastStagePerf('read', 2)
    noteLockedFastStagePerf('probe', 3)
    noteLockedFastReaderKind('binary1-bytepack')
    const summary = getLockedFastStageSummary(state.rxPerf)
    const pass = summary.includes('read=2.00ms') &&
      summary.includes('probe=3.00ms') &&
      summary.includes('reader=binary1-bytepack:1')
    console.log('Locked fast perf breakdown summary test:', pass ? 'PASS' : `FAIL ${summary}`)
    return pass
  } finally {
    state.rxPerf = oldPerf
  }
}

export function testReceiverFrameUseSummary() {
  const oldPerf = state.rxPerf
  try {
    state.rxPerf = createReceiverPerfState()
    noteReceiverFrameUse(true, true)
    noteReceiverFrameUse(true, false)
    noteReceiverFrameUse(false, false)
    const summary = getReceiverFrameUseSummary(state.rxPerf)
    const pass = summary.includes('frameUse=acc2/3') &&
      summary.includes('innov1/3') &&
      summary.includes('dup1/3') &&
      summary.includes('empty1/3')
    console.log('Receiver frame-use summary test:', pass ? 'PASS' : `FAIL ${summary}`)
    return pass
  } finally {
    state.rxPerf = oldPerf
  }
}

export function testReceiverFrameSignatureSummary() {
  const oldPerf = state.rxPerf
  const oldSignature = state.lastReceiverFrameSignature
  try {
    state.rxPerf = createReceiverPerfState()
    state.lastReceiverFrameSignature = null
    noteReceiverFrameUse(true, true)
    noteReceiverFrameSignature('a', true, true)
    noteReceiverFrameUse(true, false)
    noteReceiverFrameSignature('a', true, false)
    noteReceiverFrameUse(true, false)
    noteReceiverFrameSignature('b', true, false)
    const summary = getReceiverFrameSignatureSummary(state.rxPerf)
    const classified = classifyReceiverFrameSignature('b', {
      signature: 'b',
      accepted: true,
      innovated: false
    })
    const pass = summary.includes('frameSig=same1/3') &&
      summary.includes('newDup1/3') &&
      summary.includes('newInnov1/3') &&
      classified.kind === 'repeat'
    console.log('Receiver frame-signature summary test:', pass ? 'PASS' : `FAIL ${summary}`)
    return pass
  } finally {
    state.rxPerf = oldPerf
    state.lastReceiverFrameSignature = oldSignature
  }
}

// End-to-end read-pool worker test: a real ReadWorker instance must decode a
// synthetic sharpened Luma4 frame whose payload is genuine packets, returning
// records that rebuild into the exact packets the sync path would produce.
// Exercises the full protocol: config (offsets precomputed worker-side),
// transferable frame buffer in, payload + records + buffer back.
export async function testReadWorkerDecodesSyntheticFrame() {
  const frameLib = await import('./hdmi-uvc-frame.js')
  const { createPacket } = await import('../packet.js')
  const priorLevels = frameLib.getLuma1SenderLevels()
  let worker = null
  try {
    const width = 640
    const height = 407
    const lambda = 0.45
    frameLib.setLuma1SenderMidLevels(85, 170)
    const cap = frameLib.getPayloadCapacity(width, height, HDMI_MODE.LUMA_1)
    // Fill the frame payload with real packet slots: 10 packets that consume
    // the exact capacity.
    const slots = 10
    const packetSize = Math.floor(cap / slots)
    const blockSize = packetSize - PACKET_HEADER_SIZE
    const payload = new Uint8Array(cap)
    const sentPackets = []
    for (let s = 0; s < slots; s++) {
      const body = new Uint8Array(blockSize)
      for (let i = 0; i < blockSize; i++) body[i] = (i * 31 + s * 7 + 3) & 0xff
      const pkt = createPacket(0xBEEF0001, 1200, s + 1, body, false, blockSize, 0)
      payload.set(pkt, s * packetSize)
      sentPackets.push(pkt)
    }
    const frame = frameLib.buildFrame(payload.subarray(0, slots * packetSize), HDMI_MODE.LUMA_1, width, height, 30, 91)
    const sharpened = new Uint8ClampedArray(frame)
    for (let y = 0; y < height; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = (y * width + x) * 4
        sharpened[i] = sharpened[i + 1] = sharpened[i + 2] =
          Math.round(frame[i] + lambda * (frame[i] - (frame[i - 4] + frame[i + 4]) / 2))
      }
    }
    const anchors = detectAnchors(sharpened, width, height)
    const region = dataRegionFromAnchors(anchors)
    frameLib.setLuma1SharpenCorrection(lambda)
    const blind = region ? decodeDataRegion(sharpened, width, region) : null
    frameLib.setLuma1SharpenCorrection(null)
    if (!blind?.crcValid) {
      console.log('Read worker synthetic decode test: FAIL (setup decode)', { crc: blind?.crcValid })
      return false
    }
    const strippedLayout = { ...blind._diag }
    delete strippedLayout.precomputedOffsets
    delete strippedLayout.precomputedRegion
    delete strippedLayout.lumaDebug

    worker = new ReadWorker()
    const waitFor = (predicate, timeoutMs = 15000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker timeout')), timeoutMs)
      const prev = worker.onmessage
      worker.onmessage = (event) => {
        if (predicate(event.data)) {
          clearTimeout(timer)
          worker.onmessage = prev
          resolve(event.data)
        }
      }
    })
    const ready = waitFor((m) => m?.type === 'ready')
    await ready
    try {
      worker.postMessage({ type: 'configureWasm', url: new URL('hdmi-uvc/hdmi_uvc.wasm', document.baseURI).href })
    } catch (_) { /* JS fallback in worker still valid */ }
    const configured = waitFor((m) => m?.type === 'configured')
    worker.postMessage({
      type: 'config',
      cfg: {
        configVersion: 1,
        layout: strippedLayout,
        region: { x: region.x, y: region.y, w: region.w, h: region.h },
        payloadLength: slots * packetSize,
        expectedPacketSize: packetSize,
        sharpenLambda: lambda
      }
    })
    await configured
    const resultPromise = waitFor((m) => m?.type === 'result')
    const frameCopy = sharpened.slice()
    worker.postMessage({ type: 'read', seq: 1, configVersion: 1, buffer: frameCopy.buffer, width, height }, [frameCopy.buffer])
    const result = await resultPromise

    if (!result.ok || !result.payloadBuffer || result.records.length !== slots * 6) {
      console.log('Read worker synthetic decode test: FAIL (result)', { ok: result.ok, records: result.records?.length, slotCount: result.slotCount, error: result.error })
      return false
    }
    const gotPayload = new Uint8Array(result.payloadBuffer)
    let packetsExact = true
    for (let s = 0; s < slots; s++) {
      const slotIdx = result.records[s * 6]
      const symbolId = result.records[s * 6 + 3]
      const got = gotPayload.subarray(slotIdx * packetSize, (slotIdx + 1) * packetSize)
      const want = sentPackets[slotIdx]
      if (symbolId !== slotIdx + 1 || got.length !== want.length || !got.every((v, i) => v === want[i])) {
        packetsExact = false
        break
      }
    }
    const pass = packetsExact && result.slotCount === slots && result.frameBuffer?.byteLength === sharpened.length
    console.log('Read worker synthetic decode test:', pass ? 'PASS' : 'FAIL', { packetsExact, slotCount: result.slotCount, readMs: Math.round(result.readMs * 10) / 10 })
    return pass
  } catch (err) {
    console.log('Read worker synthetic decode test: FAIL', err?.message || err)
    return false
  } finally {
    frameLib.setLuma1SharpenCorrection(null)
    frameLib.setLuma1SenderMidLevels(priorLevels[1], priorLevels[2])
    if (worker) { try { worker.terminate() } catch (_) { /* ignore */ } }
  }
}

// The wasm-capture path must reproduce the canvas path's pixels: draw a known
// pattern, capture a ROI of it via VideoFrame.copyTo into WASM memory, and
// compare against getImageData of the same rect. Small per-channel tolerance
// because a UA may round-trip the VideoFrame through a different pixel
// format; decode only needs self-consistency, but large deviations would
// invalidate the strip-calibrated levels.
export async function testReceiverWasmCaptureRoundtrip() {
  try {
    await loadHdmiUvcWasm()
  } catch (err) {
    console.log('Receiver wasm-capture roundtrip test: FAIL (wasm load)', err?.message || err)
    return false
  }
  try {
    if (typeof VideoFrame === 'undefined') {
      console.log('Receiver wasm-capture roundtrip test: SKIP (no VideoFrame)')
      return true
    }
    const W = 128
    const H = 64
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const src = ctx.createImageData(W, H)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        const v = (x * 7 + y * 13) & 0xff
        src.data[i] = src.data[i + 1] = src.data[i + 2] = v
        src.data[i + 3] = 255
      }
    }
    ctx.putImageData(src, 0, 0)

    const lockedCapture = {
      sourceRect: { x: 16, y: 8, w: 96, h: 48 },
      width: 96,
      height: 48,
      region: { x: 0, y: 0, w: 96, h: 48 }
    }
    const eligible = wasmCaptureEligible(lockedCapture)
    const oddRect = wasmCaptureEligible({ sourceRect: { x: 15, y: 8, w: 96, h: 48 }, width: 96, height: 48 })
    const scaled = wasmCaptureEligible({ sourceRect: { x: 16, y: 8, w: 96, h: 48 }, width: 48, height: 24 })

    const captured = await captureFrameIntoWasm(canvas, lockedCapture, 0)
    const expected = ctx.getImageData(16, 8, 96, 48)
    if (!captured || captured.width !== 96 || captured.height !== 48) {
      console.log('Receiver wasm-capture roundtrip test: FAIL (capture)', { captured: !!captured })
      return false
    }
    let maxDiff = 0
    for (let i = 0; i < expected.data.length; i++) {
      if ((i & 3) === 3) continue // alpha
      const d = Math.abs(captured.data[i] - expected.data[i])
      if (d > maxDiff) maxDiff = d
    }
    const pass = eligible === true && oddRect === false && scaled === false && maxDiff <= 2
    console.log('Receiver wasm-capture roundtrip test:', pass ? 'PASS' : 'FAIL', { maxDiff, eligible, oddRect, scaled })
    return pass
  } catch (err) {
    console.log('Receiver wasm-capture roundtrip test: FAIL', err?.name || '', err?.message || err)
    return false
  }
}

export function testReceiverHeaderOnlyFrameCanLock() {
  const pass = shouldUseHeaderOnlyFrameForLock({
    crcValid: true,
    header: { mode: HDMI_MODE.BINARY_1, payloadLength: 0 },
    _diag: { frameMode: HDMI_MODE.BINARY_1 }
  }) === true &&
    shouldUseHeaderOnlyFrameForLock({
      crcValid: true,
      header: { mode: HDMI_MODE.BINARY_1, payloadLength: 16 },
      _diag: { frameMode: HDMI_MODE.BINARY_1 }
    }) === false &&
    shouldUseHeaderOnlyFrameForLock({
      crcValid: false,
      header: { mode: HDMI_MODE.BINARY_1, payloadLength: 0 },
      _diag: { frameMode: HDMI_MODE.BINARY_1 }
    }) === false
  console.log('Receiver header-only lock frame test:', pass ? 'PASS' : 'FAIL')
  return pass
}

// A CRC-valid calibration frame must count as success: failure counters
// reset, layout locks, and further decodes throttle — instead of the packet
// pipeline scoring it "empty CRC-valid" and tearing the lock down (the
// relock thrash observed live once the sharpen correction started passing
// cal frames).
export function testReceiverLuma1CalFrameTreatedAsSuccess() {
  const saved = {
    decodeFailCount: state.decodeFailCount,
    luma1CalPassCount: state.luma1CalPassCount,
    luma1CalHoldUntilMs: state.luma1CalHoldUntilMs,
    luma1CalLastLogMs: state.luma1CalLastLogMs,
    luma1SweepFailStreak: state.luma1SweepFailStreak,
    luma1NextSweepAtMs: state.luma1NextSweepAtMs,
    luma1InvalidationCount: state.luma1InvalidationCount,
    anchorBounds: state.anchorBounds,
    fixedLayout: state.fixedLayout,
    preferredLayout: state.preferredLayout,
    lockedDenseBinaryLayout: state.lockedDenseBinaryLayout,
    lockedDenseBinaryOffsets: state.lockedDenseBinaryOffsets,
    denseBinaryLockFailStreak: state.denseBinaryLockFailStreak
  }
  try {
    const layout = {
      frameMode: HDMI_MODE.LUMA_1,
      blocksX: 16,
      blocksY: 8,
      headerBlocksX: 16,
      headerBlocksY: 2,
      bitsPerBlock: 2,
      stepX: 1,
      stepY: 1,
      dataBs: 1,
      headerStepX: 4,
      headerStepY: 4,
      headerBs: 4,
      xOff: 0,
      yOff: 0,
      payloadPhaseX: 1,
      payloadEdgeGuardCells: 1,
      blackLevel: 2,
      whiteLevel: 252,
      lumaLevels: [0, 91, 169, 255]
    }
    const result = {
      crcValid: true,
      header: { mode: HDMI_MODE.LUMA_1, width: 1920, height: 1080, fps: 60, payloadLength: 64 },
      _diag: layout
    }
    const region = { x: 24, y: 24, w: 64, h: 40 }

    state.decodeFailCount = 7
    state.denseBinaryLockFailStreak = 4
    state.luma1CalPassCount = 0
    state.luma1CalHoldUntilMs = 0
    state.luma1CalLastLogMs = 0
    state.anchorBounds = { x: 0, y: 0, w: 64, h: 40 } // already locked: skip lockAnchorRegion
    state.lockedDenseBinaryLayout = null

    noteLuma1CalibrationPass(result, region, 1920, 1080, null, null)

    const afterPass = state.decodeFailCount === 0 &&
      state.luma1CalPassCount === 1 &&
      state.denseBinaryLockFailStreak === 0 &&
      state.lockedDenseBinaryLayout?.frameMode === HDMI_MODE.LUMA_1 &&
      shouldSkipDecodeForLuma1CalHold() === true &&
      shouldSkipDecodeForLuma1CalHold(performance.now() + 2000) === false

    // A later LUMA_1 CRC failure breaks the consecutive-pass count.
    noteLuma1SweepOutcome({ crcValid: false, header: { mode: HDMI_MODE.LUMA_1 } })
    const afterFail = state.luma1CalPassCount === 0

    const pass = afterPass && afterFail
    console.log('Receiver Luma4 cal-frame success test:', pass ? 'PASS' : 'FAIL', pass ? '' : JSON.stringify({
      decodeFailCount: state.decodeFailCount,
      calPassCount: state.luma1CalPassCount,
      lockMode: state.lockedDenseBinaryLayout?.frameMode,
      lockStreak: state.denseBinaryLockFailStreak,
      afterFail
    }))
    return pass
  } catch (err) {
    console.log('Receiver Luma4 cal-frame success test: FAIL', err?.message || err)
    return false
  } finally {
    Object.assign(state, saved)
  }
}

export function testReceiverAnchorDiagnosticsQuietByDefault() {
  const pass =
    shouldLogAnchorScanDiagnostics({ anchorLocked: false, frameCount: 1, verbose: false }) === false &&
    shouldLogAnchorScanDiagnostics({ anchorLocked: false, frameCount: 30, verbose: false }) === false &&
    shouldLogAnchorScanDiagnostics({ anchorLocked: true, frameCount: 30, verbose: true }) === false &&
    shouldLogAnchorScanDiagnostics({ anchorLocked: false, frameCount: 30, verbose: true }) === true
  console.log('Receiver anchor diagnostics quiet default test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export async function testStallCounterTicksOnDuplicateFrames() {
  const { createDecoder } = await import('../decoder.js')
  const { createEncoder } = await import('../encoder.js')

  const fileSize = 6000
  const data = new Uint8Array(fileSize)
  for (let i = 0; i < fileSize; i++) data[i] = (i * 7 + 3) & 0xff
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  const enc = createEncoder(data.buffer, 's.bin', 'application/octet-stream', hash)
  const dec = createDecoder()

  dec.receive(enc.generateSymbol(0))          // metadata
  for (let id = 1; id <= enc.K - 2; id++) {   // feed all but the last two source blocks
    dec.receive(enc.generateSymbol(id))
  }
  // At this point the decoder should be stuck with 2 missing source blocks.
  const missingBefore = dec.unresolvedSourceCount
  if (missingBefore < 2) { console.log('FAIL setup: missing=', missingBefore); return false }

  // Now send 60 "frames" that are all duplicates of symbol 1 (already received).
  // The decoder must see noteFrameBoundary() ticks so stallFramesSinceLastSolve
  // climbs past 30 and triggers the GF(2) tail solver.
  const dupSym = enc.generateSymbol(1)
  for (let f = 0; f < 60; f++) {
    dec.receive(dupSym)
    dec.noteFrameBoundary()
  }
  const tel = dec.telemetry
  const pass = tel.stallFramesSinceLastSolve >= 60 && tel.tailSolveTriggerCount >= 1
  console.log('Duplicate-frame stall test:', pass ? 'PASS' : 'FAIL', tel)
  return pass
}
