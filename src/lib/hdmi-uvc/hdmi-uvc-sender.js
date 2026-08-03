// HDMI-UVC Sender module - handles file encoding and full-screen display

import { createEncoder } from '../encoder.js'
import { METADATA_INTERVAL } from '../constants.js'
import { PACKET_HEADER_SIZE } from '../packet.js'
import { formatBytes } from '../format.js'
import { wireDropZone } from '../shared/dropzone.js'
import { acquireWakeLock, releaseWakeLock } from '../shared/wake-lock.js'
import { maybeCompress } from '../shared/compression.js'
import { announce, flashHighlight, copyWithButtonFeedback } from '../feedback.js'
import { ArqSenderController, getArqSenderDisplayProgress } from '../arq/arq-sender.js'
import { getTransport } from '../arq/backchannel.js'
import { getSelectedArqTransportName } from '../arq/default-transports.js'
import { initArqTransportSelect } from '../arq/arq-transport-ui.js'
import { getArqSenderConnectPrompt } from '../arq/helper-status.js'
import {
  HDMI_UVC_MAX_FILE_SIZE,
  HDMI_MODE,
  HDMI_MODE_NAMES,
  FPS_PRESETS,
  DEFAULT_FPS_PRESET,
  RENDER_SIZE_PRESETS,
  DEFAULT_RENDER_SIZE_PRESET,
  isDenseBinaryMode,
  usesBinary1DenseDefaults
} from './hdmi-uvc-constants.js'
import {
  buildFrame,
  buildNativeGeometryGuidance,
  createFrameBuffer,
  getDataRegion,
  getLuma1SenderLevels,
  getPayloadCapacity,
  hasEffectiveOneToOnePresentation,
  isNative1080pGeometry,
  setLuma1SenderMidLevels
} from './hdmi-uvc-frame.js'
import { loadHdmiUvcWasm } from './hdmi-uvc-wasm.js'
import {
  getDenseBinaryPass2SweepMix,
  getDenseBinaryDegree,
  getDiagnosticDefinition,
  getPass2Variant
} from './hdmi-uvc-diagnostics.js'
import { initDiagnosticsPanelToggle } from './hdmi-uvc-debug-log.js'
import {
  debugLog,
  debugCurrent,
  renderSenderDebugLog,
  senderDebugLogBuffer,
  setSenderDiagPanelVisible
} from './hdmi-uvc-sender-debug.js'
import {
  createSenderPerfState,
  noteSenderFramePerf,
  noteSenderFrameSymbols
} from './hdmi-uvc-sender-perf.js'
import {
  state,
  getFps,
  getRenderSizePreset,
  modeRequiresNative1080p
} from './hdmi-uvc-sender-state.js'
import {
  screenLeft,
  screenTop,
  screenWidth,
  screenHeight,
  chooseExternalPresentationScreen,
  describeScreen,
  describeScreenList,
  buildPresentationWindowFeatures,
  getExternalDisplayReadiness,
  writeExternalPresentationDocument,
  requestPresentationFullscreen,
  waitForLayoutFrames,
  viewportMetricsEqual,
  fitRectWithin,
  normalizeExternalPresentationMetrics
} from './hdmi-uvc-presentation.js'
import {
  buildFramePacketBatch,
  computeMetadataIntervalFrames,
  chooseSystematicStride,
  getBatchingProfile,
  getCurrentSystematicSpan,
  getHybridScheduleDescription,
  getMetadataScheduleDescription,
  getSyncPorchFrameCount,
  selectFrameBatching,
  usesMixedSlotReplay,
  setArqSenderStatusNotifier
} from './hdmi-uvc-sender-schedule.js'

// Kick off WASM instantiation when the sender module loads so buildFrame's
// payload CRC uses the WASM kernel from the first transmitted frame. Errors
// fall through to the JS crc32 fallback in frame.js.
try {
  loadHdmiUvcWasm().catch(() => {})
} catch {
  // Non-browser test imports have no document/self origin for WASM URL resolution.
}

// Default mids pre-compensate the measured channel curve. Live strip readout
// 2026-06-10 (sent [0,53,154,255] captured as [0,34,137,255], a darkening
// gamma ~1.3): piecewise-linear inversion puts the even-thirds capture
// targets (85, 170) at sender values 103 and 182. These are the only luma
// levels the sender uses — the mode is locked to 1x1 Luma4.
const DEFAULT_LUMA1_MIDS = [103, 182]
setLuma1SenderMidLevels(DEFAULT_LUMA1_MIDS[0], DEFAULT_LUMA1_MIDS[1])

function updateArqSenderStatus(text, connected = state.arqConnected) {
  if (elements?.arqStatus) {
    elements.arqStatus.textContent = text
    elements.arqStatus.classList.toggle('connected', !!connected)
  }
  if (elements?.btnArqConnect) {
    elements.btnArqConnect.textContent = connected ? 'Reconnect back-channel' : 'Connect back-channel'
    elements.btnArqConnect.disabled = state.isSending || state.isAwaitingStart
  }
}

// The scheduler's ARQ fallback path reports into the same status row; give
// it the updater without a circular import.
setArqSenderStatusNotifier(updateArqSenderStatus)

async function completeArqSending() {
  state.arqTransport?.close()
  state.arqTransport = null
  state.arqConnected = false
  await restoreSenderReadyState()
  elements.placeholderIcon.textContent = '✓'
  elements.placeholderText.textContent = 'ARQ complete — receiver verified'
  debugLog('ARQ COMPLETE received - sender stopped')
  debugCurrent('ARQ COMPLETE')
  updateArqSenderStatus('Back-channel offline', false)
}

function handleArqBackchannelMessage(bytes) {
  if (!state.arqController) return
  // First inbound line is proof the back-channel is actually live — for the
  // keyboard transport "connected" only means the keydown listener is armed,
  // so without this a mismatched/unfocused sender looks connected but silent.
  if (!state.arqSawInbound) {
    state.arqSawInbound = true
    debugLog('ARQ back-channel: first inbound line received')
  }
  const msg = state.arqController.onMessage(bytes, performance.now())
  if (!msg) return
  if (state.arqController.mode === 'repair') {
    if (state.arqFallback) {
      state.arqFallback = false
      debugLog('ARQ back-channel resumed after fallback')
    }
    state.arqCursor = 0
    debugLog(`ARQ NACK received: ${state.arqController.workList.length} repair block(s)`)
    updateArqSenderStatus(`Repairing ${state.arqController.workList.length} block(s)`, true)
  } else if (state.arqController.mode === 'done') {
    void completeArqSending()
  }
}

async function connectArqBackchannel() {
  if (state.isSending || state.isAwaitingStart || state.arqConnecting) return
  state.arqConnecting = true
  state.arqSawInbound = false
  try {
    state.arqTransport?.close()
    const transportName = getSelectedArqTransportName()
    const impl = getTransport(transportName)
    if (!impl?.makeSender) throw new Error(`ARQ sender transport '${transportName}' is not registered`)
    state.arqTransport = impl.makeSender()
    state.arqTransport.onMessage(handleArqBackchannelMessage)
    updateArqSenderStatus(getArqSenderConnectPrompt(transportName), false)
    await state.arqTransport.init({
      onStatus: status => updateArqSenderStatus(`Back-channel ${status}`, status === 'connected'),
      onDisconnect: () => {
        state.arqConnected = false
        updateArqSenderStatus('Back-channel disconnected', false)
        syncYoloWithBackchannel('disconnected')
      }
    })
    state.arqConnected = true
    updateArqSenderStatus('Back-channel connected', true)
    debugLog('ARQ back-channel connected')
    syncYoloWithBackchannel('connected')
  } catch (err) {
    state.arqConnected = false
    updateArqSenderStatus('Back-channel unavailable', false)
    debugLog(`ARQ connect failed: ${err.message}`)
    showError('Back-channel connect failed: ' + err.message)
    syncYoloWithBackchannel('disconnected')
  } finally {
    state.arqConnecting = false
  }
}

// Send-once is the fastest configuration when repair feedback exists and a
// slower one without it, so the checkbox follows the back-channel: auto-on
// when it connects, back to the stored preference when it goes away. An
// explicit user choice made this session always wins, and the automatic
// value is never persisted.
export function resolveYoloAutoState(current, event) {
  if (event === 'connected') {
    if (!current.yolo && !current.manualThisSession) {
      return { yolo: true, autoEnabled: true }
    }
    return { yolo: current.yolo, autoEnabled: current.autoEnabled }
  }
  if (current.autoEnabled) {
    return { yolo: !!current.stored, autoEnabled: false }
  }
  return { yolo: current.yolo, autoEnabled: current.autoEnabled }
}

function readStoredYoloPreference() {
  try { return localStorage.getItem('hdmi-uvc-yolo') === '1' } catch { return false }
}

function syncYoloWithBackchannel(event) {
  // The frame scheduler reads state.yolo live and the encoder is built from
  // it at start; flipping it mid-transfer would desynchronize the stream.
  // Transfer-end paths re-sync via restoreSenderReadyState/stopSending.
  if (state.isSending || state.isAwaitingStart) return
  const next = resolveYoloAutoState({
    yolo: state.yolo,
    autoEnabled: state.yoloAutoEnabled,
    manualThisSession: state.yoloManualThisSession,
    stored: readStoredYoloPreference()
  }, event)
  if (next.yolo !== state.yolo) {
    state.yolo = next.yolo
    if (elements?.yoloToggle) elements.yoloToggle.checked = next.yolo
    // The checkbox just changed without the user touching it; say so both
    // visually (highlight) and for screen readers instead of only debug-logging.
    announce(next.yolo
      ? 'Send-once mode enabled — back-channel connected'
      : 'Send-once mode disabled — back-channel offline')
    flashHighlight(elements?.yoloLabel)
    debugLog(next.yolo
      ? 'Send-once mode auto-enabled (back-channel connected)'
      : 'Send-once mode reverted to stored preference (back-channel offline)')
  }
  state.yoloAutoEnabled = next.autoEnabled
}

function resetSenderPerfState() {
  state.txPerf = createSenderPerfState()
}

function resetHdmiFrameResources() {
  state.frameBuffer = null
  state.frameImageData = null
  state.frameBufferWidth = 0
  state.frameBufferHeight = 0
}

function ensureHdmiFrameResources(width, height) {
  if (
    state.frameBuffer &&
    state.frameImageData &&
    state.frameBufferWidth === width &&
    state.frameBufferHeight === height
  ) {
    return state.frameImageData
  }

  state.frameBuffer = createFrameBuffer(width, height)
  state.frameImageData = new ImageData(state.frameBuffer, width, height)
  state.frameBufferWidth = width
  state.frameBufferHeight = height
  return state.frameImageData
}

function logSenderSessionMetrics(phase, metrics, capacity) {
  const fps = getFps()
  debugLog(
    `${phase}: mode=${HDMI_MODE_NAMES[state.mode]} canvas=${metrics.width}x${metrics.height} ` +
    `target=${fps.fps}fps payload=${capacity} B/frame theoretical=${formatBytes(capacity * fps.fps)}/s ` +
    `source=${metrics.source} display=${metrics.displayWidth}x${metrics.displayHeight}@(${metrics.displayX},${metrics.displayY}) ` +
    `viewport=${metrics.viewportWidth}x${metrics.viewportHeight}`
  )
}

let elements = null
let showError = (msg) => console.error(msg)

function getLocalPresentationTarget() {
  return {
    external: false,
    win: window,
    doc: document,
    container: elements.container,
    canvas: elements.canvas,
    frameCount: elements.frameCount,
    progressDisplay: elements.progressDisplay
  }
}

function getPresentationTarget() {
  return state.presentation || getLocalPresentationTarget()
}

function closeExternalPresentationWindow() {
  const presentation = state.presentation
  state.presentation = null
  if (!presentation?.external) return
  try {
    if (presentation.win && presentation.win !== window && !presentation.win.closed) {
      presentation.win.close()
    }
  } catch (_) {
    // Ignore cross-window cleanup failures; the next start creates a fresh window.
  }
}

// Inline styles applied by applyFullscreenCanvasStyles / positionCanvas /
// showArmedStartPrompt. Kept as inline styles (not a CSS class) because the
// canvas may live in an external presentation window whose document does not
// share this page's stylesheet.
const CANVAS_RESET_PROPS = [
  'position', 'top', 'left', 'width', 'height', 'z-index', 'image-rendering',
  'background', 'transform', 'padding', 'box-sizing', 'max-width', 'max-height'
]
const PLACEHOLDER_RESET_PROPS = ['position', 'z-index', 'text-align', 'padding']

function resetCanvasStyles() {
  if (!elements?.canvas) return
  elements.container?.classList.remove('fullscreen')
  elements.container?.classList.remove('signal-live')
  if (elements.container) {
    elements.container.style.justifyContent = ''
    elements.container.style.alignItems = ''
  }
  document.body?.classList.remove('hdmi-uvc-signal-live')
  elements.canvas.style.display = 'none'
  for (const prop of CANVAS_RESET_PROPS) {
    elements.canvas.style.removeProperty(prop)
  }
  if (elements?.placeholder) {
    for (const prop of PLACEHOLDER_RESET_PROPS) {
      elements.placeholder.style.removeProperty(prop)
    }
  }
}

function setSignalLive(isLive) {
  const presentation = getPresentationTarget()
  const usesMainDocument = presentation.doc === document
  presentation.container?.classList.toggle('signal-live', isLive)
  if (presentation.container !== elements?.container) {
    elements?.container?.classList.toggle('signal-live', false)
  }
  document.body?.classList.toggle('hdmi-uvc-signal-live', isLive && usesMainDocument)
}

function resetPreparedSessionState() {
  state.encoder = null
  state.packetSize = 0
  state.packetsPerFrame = 1
  state.isSending = false
  state.isPaused = false
  state.isAwaitingStart = false
  state.systematicIndex = 0
  state.systematicStride = 1
  state.intermediateSystematicStride = 1
  state.paritySystematicIndex = 0
  state.paritySweepsInPass = 0
  state.paritySystematicStride = 1
  state.fountainSymbolId = 0
  state.dataPacketCount = 0
  state.systematicPass = 1
  state.tailStartFrame = 0
  state.metadataIntervalFrames = METADATA_INTERVAL * 2
  state.arqController = null
  state.arqCursor = 0
  state.arqFallback = false
  state.frameCount = 0
  state.nextFrameDueMs = 0
  state.animationId = null
  resetSenderPerfState()
}

// Shared presentation teardown: drop the fullscreen canvas back to the idle
// drop-zone layout (used when pausing, stopping, and restoring ready state).
async function teardownPresentationSurface() {
  resetCanvasStyles()
  await exitFullscreenSafely()
  closeExternalPresentationWindow()
  elements.overlay.classList.add('hidden')
  elements.placeholder.style.display = 'flex'
}

async function restoreSenderReadyState() {
  releaseWakeLock()
  resetRenderSchedule()
  resetHdmiFrameResources()
  resetPreparedSessionState()
  setSignalLive(false)
  await teardownPresentationSurface()
  if (state.fileData) {
    elements.placeholderIcon.textContent = '✓'
    elements.placeholderText.textContent = 'File ready — press Start'
  } else {
    elements.placeholderIcon.textContent = '+'
    elements.placeholderText.textContent = 'Drop file here or select one'
  }
  // A back-channel connect/disconnect during the transfer was deferred (the
  // scheduler reads state.yolo live); apply it now that the sender is idle.
  syncYoloWithBackchannel(state.arqConnected ? 'connected' : 'disconnected')
  updateActionButton()
  updateDropZoneState()
  updateEstimateSummary()
}

function applyFullscreenCanvasStyles(target = getPresentationTarget()) {
  target.container?.classList.add('fullscreen')
  target.canvas.style.display = 'block'
  target.canvas.style.position = 'absolute'
  target.canvas.style.top = '0'
  target.canvas.style.left = '0'
  target.canvas.style.zIndex = '0'
  target.canvas.style.imageRendering = 'pixelated'
  target.canvas.style.background = '#000'
  target.canvas.style.width = '100%'
  target.canvas.style.height = '100%'
}

function clearSenderCanvasToBlack() {
  const canvas = getPresentationTarget().canvas
  if (!canvas?.width || !canvas?.height) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
}

function showArmedStartPrompt() {
  elements.overlay.classList.add('hidden')
  elements.placeholder.style.display = 'flex'
  elements.placeholder.style.position = 'relative'
  elements.placeholder.style.zIndex = '1'
  elements.placeholder.style.textAlign = 'center'
  elements.placeholder.style.padding = '1.5rem'
  elements.placeholderIcon.textContent = '>'
  elements.placeholderText.textContent = 'Display ready. Once the browser’s fullscreen tip disappears, press Space/Enter or click here to start (Esc cancels).'
  debugCurrent('ARMED - press Space/Enter or click to start')
}

async function waitForStableViewport(stableFrames = 3, maxFrames = 30, target = getPresentationTarget()) {
  let last = null
  let stableCount = 0

  for (let frame = 0; frame < maxFrames; frame++) {
    await waitForLayoutFrames(1, target.win)
    const current = getCanvasViewportMetrics(target)
    if (viewportMetricsEqual(current, last)) {
      stableCount++
      if (stableCount >= stableFrames) {
        return current
      }
    } else {
      stableCount = 0
    }
    last = current
  }

  return last || getCanvasViewportMetrics(target)
}

function getCanvasViewportMetrics(target = getPresentationTarget()) {
  const targetWindow = target.win || window
  const targetDocument = target.doc || document
  const presentationEl = targetDocument.fullscreenElement || target.container || target.canvas
  const rect = presentationEl.getBoundingClientRect()
  const visual = targetWindow.visualViewport

  const rectWidth = Math.round(rect.width)
  const rectHeight = Math.round(rect.height)
  const visualWidth = visual ? Math.round(visual.width) : 0
  const visualHeight = visual ? Math.round(visual.height) : 0
  const innerWidth = Math.round(targetWindow.innerWidth)
  const innerHeight = Math.round(targetWindow.innerHeight)
  const screenWidth = Math.round(targetWindow.screen.width || 0)
  const screenHeight = Math.round(targetWindow.screen.height || 0)

  let width = rectWidth
  let height = rectHeight
  let source = targetDocument.fullscreenElement ? 'fullscreenRect' : 'containerRect'

  if (!width || !height) {
    width = visualWidth || innerWidth
    height = visualHeight || innerHeight
    source = visualWidth && visualHeight ? 'visualViewport' : 'window.inner'
  }

  return {
    width,
    height,
    source,
    rectWidth,
    rectHeight,
    visualWidth,
    visualHeight,
    innerWidth,
    innerHeight,
    screenWidth,
    screenHeight,
    devicePixelRatio: targetWindow.devicePixelRatio || 1,
    fullscreenActive: !!targetDocument.fullscreenElement
  }
}

function resolveHdmiCanvasMetrics(viewportMetrics = getCanvasViewportMetrics()) {
  const preset = getRenderSizePreset()
  const viewportWidth = Math.max(1, viewportMetrics.width)
  const viewportHeight = Math.max(1, viewportMetrics.height)
  const devicePixelRatio = viewportMetrics.devicePixelRatio || 1

  if (preset.id === 'viewport') {
    return {
      ...viewportMetrics,
      viewportWidth,
      viewportHeight,
      width: viewportWidth,
      height: viewportHeight,
      source: viewportMetrics.source,
      renderPresetId: preset.id,
      renderPresetName: preset.name,
      displayWidth: viewportWidth,
      displayHeight: viewportHeight,
      displayX: 0,
      displayY: 0,
      displayScale: 1,
      physicalDisplayWidth: Math.round(viewportWidth * devicePixelRatio),
      physicalDisplayHeight: Math.round(viewportHeight * devicePixelRatio),
      effectiveDisplayScale: 1
    }
  }

  const internalWidth = preset.width
  const internalHeight = preset.height
  const fitted = fitRectWithin(viewportWidth, viewportHeight, internalWidth, internalHeight)

  return {
    ...viewportMetrics,
    viewportWidth,
    viewportHeight,
    width: internalWidth,
    height: internalHeight,
    source: `preset:${preset.id}`,
    renderPresetId: preset.id,
    renderPresetName: preset.name,
    displayWidth: fitted.width,
    displayHeight: fitted.height,
    displayX: fitted.x,
    displayY: fitted.y,
    displayScale: fitted.scale,
    physicalDisplayWidth: Math.round(fitted.width * devicePixelRatio),
    physicalDisplayHeight: Math.round(fitted.height * devicePixelRatio),
    effectiveDisplayScale: Math.min(
      internalWidth ? Math.round(fitted.width * devicePixelRatio) / internalWidth : 0,
      internalHeight ? Math.round(fitted.height * devicePixelRatio) / internalHeight : 0
    )
  }
}

function measureAndApplyCanvasSize(viewportMetrics = getCanvasViewportMetrics(), target = getPresentationTarget()) {
  const metrics = resolveHdmiCanvasMetrics(viewportMetrics)
  if (target.external && target.screen && metrics.renderPresetId !== 'viewport') {
    const physicalWidth = screenWidth(target.screen)
    const physicalHeight = screenHeight(target.screen)
    if (physicalWidth > 0 && physicalHeight > 0) {
      metrics.physicalDisplayWidth = physicalWidth
      metrics.physicalDisplayHeight = physicalHeight
      metrics.effectiveDisplayScale = Math.min(
        metrics.width ? physicalWidth / metrics.width : 0,
        metrics.height ? physicalHeight / metrics.height : 0
      )
    }
  }
  normalizeExternalPresentationMetrics(metrics, target)

  target.canvas.width = metrics.width
  target.canvas.height = metrics.height
  target.canvas.style.setProperty('width', `${metrics.displayWidth}px`, 'important')
  target.canvas.style.setProperty('height', `${metrics.displayHeight}px`, 'important')
  target.canvas.style.left = `${metrics.displayX}px`
  target.canvas.style.top = `${metrics.displayY}px`

  const capacity = getPayloadCapacity(metrics.width, metrics.height, state.mode)
  const dataRegion = getDataRegion(metrics.width, metrics.height)
  const dataWidth = dataRegion.w
  const dataHeight = dataRegion.h
  const dataUtil = metrics.width > 0 && metrics.height > 0
    ? ((dataWidth * dataHeight) / (metrics.width * metrics.height) * 100).toFixed(1)
    : '0.0'

  debugLog(
    `Viewport: rect=${metrics.rectWidth}x${metrics.rectHeight}, ` +
    `visual=${metrics.visualWidth}x${metrics.visualHeight}, ` +
    `inner=${metrics.innerWidth}x${metrics.innerHeight}, ` +
    `screen=${metrics.screenWidth}x${metrics.screenHeight}, dpr=${metrics.devicePixelRatio}`
  )
  debugLog(
    `Canvas: internal ${metrics.width}x${metrics.height} (${metrics.source}, preset=${metrics.renderPresetName}), ` +
    `display ${metrics.displayWidth}x${metrics.displayHeight}@(${metrics.displayX},${metrics.displayY}) ` +
    `physical ${metrics.physicalDisplayWidth}x${metrics.physicalDisplayHeight} ` +
    `within viewport ${metrics.viewportWidth}x${metrics.viewportHeight}, ` +
    `scale=${metrics.displayScale.toFixed(3)}, effective=${metrics.effectiveDisplayScale.toFixed(3)}` +
    `${metrics.externalNativePresentation ? ', external-native=assumed' : ''}, ` +
    `data region ${dataWidth}x${dataHeight} (${dataUtil}% of frame)`
  )
  if (metrics.renderPresetId !== 'viewport' && Math.abs(metrics.displayScale - 1) > 0.001) {
    debugLog(
      `Render scale warning: preset ${metrics.renderPresetName} is being resampled to ` +
      `${metrics.displayWidth}x${metrics.displayHeight} (scale=${metrics.displayScale.toFixed(3)}); ` +
      'expect lower payload robustness on the active display path'
    )
  }

  return { metrics, capacity }
}

function getNativeGeometryIssue(metrics) {
  if (isNative1080pGeometry(metrics)) return null
  const width = metrics ? `${metrics.width}x${metrics.height}` : 'unknown'
  const display = metrics ? `${metrics.displayWidth}x${metrics.displayHeight}` : 'unknown'
  const physical = metrics ? `${metrics.physicalDisplayWidth || 'unknown'}x${metrics.physicalDisplayHeight || 'unknown'}` : 'unknown'
  const scale = metrics?.displayScale?.toFixed ? metrics.displayScale.toFixed(3) : 'unknown'
  const effective = metrics?.effectiveDisplayScale?.toFixed ? metrics.effectiveDisplayScale.toFixed(3) : 'unknown'
  const fullscreen = metrics?.fullscreenActive ? 'yes' : 'no'
  return (
    `Dense HDMI modes require native 1080p, but current canvas=${width}, ` +
    `display=${display}, physical=${physical}, scale=${scale}, effective=${effective}, fullscreen=${fullscreen}, ` +
    `preset=${metrics?.renderPresetName || metrics?.renderPresetId || 'unknown'}. ` +
    buildNativeGeometryGuidance()
  )
}

function getRenderScaleIssue(metrics, { requireNative1080p = false } = {}) {
  if (requireNative1080p) return getNativeGeometryIssue(metrics)
  if (!metrics || metrics.renderPresetId === 'viewport') return null
  if (hasEffectiveOneToOnePresentation(metrics)) return null
  if (Math.abs(metrics.displayScale - 1) <= 0.001) return null

  return (
    `Render preset ${metrics.renderPresetName} requires 1:1 presentation, but the active display path ` +
    `would resample it to ${metrics.displayWidth}x${metrics.displayHeight} ` +
    `(scale=${metrics.displayScale.toFixed(3)}, physical=${metrics.physicalDisplayWidth || 'unknown'}x${metrics.physicalDisplayHeight || 'unknown'}, ` +
    `effective=${metrics.effectiveDisplayScale?.toFixed ? metrics.effectiveDisplayScale.toFixed(3) : 'unknown'}). ` +
    buildNativeGeometryGuidance()
  )
}

async function openExternalPresentationTarget() {
  const readiness = getExternalDisplayReadiness(
    state.useExternalDisplay,
    !!window.getScreenDetails
  )
  if (readiness) throw new Error(readiness)

  const details = await window.getScreenDetails()
  const screen = chooseExternalPresentationScreen(details.screens, details.currentScreen)
  if (!screen) {
    throw new Error('No external display found. Connect UGREEN as an extended display, then try again.')
  }

  closeExternalPresentationWindow()
  const popup = window.open('', 'beammeup-hdmi-uvc-presentation', buildPresentationWindowFeatures(screen))
  if (!popup) {
    throw new Error('External presentation window was blocked after screen permission. Allow popups for this page and click Start again.')
  }
  popup.document.write('<!doctype html><title>Beam Me Up HDMI-UVC Display</title><body style="margin:0;background:#000"></body>')
  popup.document.close()

  const features = buildPresentationWindowFeatures(screen)
  debugLog(`External presentation features: ${features}`)

  try {
    popup.moveTo(screenLeft(screen), screenTop(screen))
    popup.resizeTo(screenWidth(screen) || 1920, screenHeight(screen) || 1080)
    popup.focus()
  } catch (_) {
    // Some browsers ignore scripted move/resize even after permission.
  }

  const target = writeExternalPresentationDocument(popup, screen)
  state.presentation = target
  debugLog(
    `External presentation window: screen=${screenWidth(screen)}x${screenHeight(screen)}@(${screenLeft(screen)},${screenTop(screen)})`
  )
  return target
}

async function prepareExternalFullscreenTarget() {
  const readiness = getExternalDisplayReadiness(
    state.useExternalDisplay,
    !!window.getScreenDetails
  )
  if (readiness) throw new Error(readiness)

  const details = await window.getScreenDetails()
  debugLog(`Screen details: current=${describeScreen(details.currentScreen)} screens=[${describeScreenList(details.screens)}]`)

  const screen = chooseExternalPresentationScreen(details.screens, details.currentScreen)
  if (!screen) {
    throw new Error('No external display found. Connect UGREEN as an extended display, then try again.')
  }

  const target = {
    ...getLocalPresentationTarget(),
    external: true,
    screen
  }
  state.presentation = target
  debugLog(`External fullscreen target: screen=${describeScreen(screen)}`)
  return target
}

async function preparePresentationTarget() {
  if (state.useExternalDisplay) {
    return prepareExternalFullscreenTarget()
  }
  state.presentation = null
  return getLocalPresentationTarget()
}

async function preparePresentationForTransmission() {
  const target = await preparePresentationTarget()
  applyFullscreenCanvasStyles(target)
  await requestPresentationFullscreen(target)
  return {
    target,
    stableMetrics: await waitForStableViewport(3, 30, target)
  }
}

function cancelScheduledRender() {
  if (state.timerId) {
    clearTimeout(state.timerId)
    state.timerId = null
  }
  if (state.animationId) {
    cancelAnimationFrame(state.animationId)
    state.animationId = null
  }
}

function resetRenderSchedule() {
  cancelScheduledRender()
  state.nextFrameDueMs = 0
}

// Locked to timer pacing: rAF pacing was tried and rejected (the txPace
// diagnostic allows only 'timer'); tests pin this policy.
function getSenderRenderPace() {
  return 'timer'
}

function scheduleNextRender() {
  if (!state.isSending || state.isPaused) return

  const fps = getFps()
  const targetIntervalMs = 1000 / fps.fps
  if (!state.nextFrameDueMs) {
    state.nextFrameDueMs = performance.now() + targetIntervalMs
  }

  const armRender = () => {
    if (!state.isSending || state.isPaused) return

    const waitMs = state.nextFrameDueMs - performance.now()
    if (waitMs > 8) {
      state.timerId = setTimeout(() => {
        state.timerId = null
        armRender()
      }, Math.max(0, waitMs - 4))
      return
    }

    state.animationId = requestAnimationFrame((now) => {
      state.animationId = null
      if (!state.isSending || state.isPaused) return

      if (now + 0.25 < state.nextFrameDueMs) {
        armRender()
        return
      }

      state.nextFrameDueMs += targetIntervalMs
      if (state.nextFrameDueMs < now) {
        state.nextFrameDueMs = now + targetIntervalMs
      }
      renderFrame()
    })
  }

  armRender()
}

function updateDropZoneState() {
  const container = elements.container
  if (!state.fileData) {
    container.classList.add('empty')
    container.classList.remove('has-file')
    container.setAttribute('tabindex', '0')
    container.setAttribute('aria-disabled', 'false')
    container.setAttribute('aria-label', 'Choose a file to send')
  } else {
    container.classList.remove('empty')
    container.classList.add('has-file')
    if (state.isAwaitingStart) {
      // Armed: the pattern area is the click/keyboard target that starts
      // the transfer, so it stays interactive with a matching label.
      container.setAttribute('tabindex', '0')
      container.setAttribute('aria-disabled', 'false')
      container.setAttribute('aria-label', 'Start transfer')
    } else {
      // The zone stops being interactive once a file is loaded.
      container.setAttribute('tabindex', '-1')
      container.setAttribute('aria-disabled', 'true')
      container.setAttribute('aria-label', 'Choose a file to send')
    }
  }
}

function updateActionButton() {
  const btn = elements.btnAction
  if (!state.fileData) {
    btn.textContent = 'Start'
    btn.disabled = true
  } else if (state.isAwaitingStart) {
    // Kept enabled: clicking it starts the transfer, same as Space/Enter.
    // A disabled button is skipped by assistive tech and unfocusable.
    btn.textContent = 'Start now (Space)'
    btn.disabled = false
  } else if (state.isSending && !state.isPaused) {
    btn.textContent = 'Pause'
    btn.disabled = false
  } else if (state.isPaused) {
    btn.textContent = 'Resume'
    btn.disabled = false
  } else {
    btn.textContent = 'Start'
    btn.disabled = false
  }
  elements.btnStop.disabled = !state.fileData
  if (elements.yoloToggle) {
    // The encoder is built at start; toggling mid-transfer would have no effect.
    elements.yoloToggle.disabled = state.isSending || state.isAwaitingStart
  }
  if (elements.btnArqConnect) {
    elements.btnArqConnect.disabled = state.isSending || state.isAwaitingStart
  }
}

function updateEstimateSummary() {
  if (!elements?.estimate) return
  const preset = getRenderSizePreset()
  elements.estimate.textContent = `Render size: ${preset.name}`
}

function renderFrame() {
  if (!state.isSending || state.isPaused) return

  if (!state.encoder) return

  const fps = getFps()
  const presentation = getPresentationTarget()
  const canvas = presentation.canvas
  const cw = canvas.width
  const ch = canvas.height

  try {
    const nextFrameNumber = state.frameCount + 1
    const frameStartMs = performance.now()
    const batch = buildFramePacketBatch(nextFrameNumber)
    noteSenderFrameSymbols(state.txPerf, batch.symbolIds, state.encoder)
    const batchReadyMs = performance.now()

    const frameImageData = ensureHdmiFrameResources(cw, ch)
    buildFrame(batch.payload, state.mode, cw, ch, fps.fps, batch.outerSymbolId, state.frameBuffer)
    const buildDoneMs = performance.now()

    const ctx = canvas.getContext('2d')
    ctx.putImageData(frameImageData, 0, 0)
    const blitDoneMs = performance.now()

    state.frameCount = nextFrameNumber
    elements.frameCount.textContent = state.frameCount
    if (presentation.frameCount && presentation.frameCount !== elements.frameCount) {
      presentation.frameCount.textContent = state.frameCount
    }

    const arqActive = state.arqController && !state.arqFallback
    const systematicSpan = Math.max(1, getCurrentSystematicSpan())
    const progress = arqActive
      ? getArqSenderDisplayProgress(state.arqController, state.arqCursor)
      : Math.min(100, Math.round((state.systematicIndex / systematicSpan) * 100))
    elements.progressDisplay.textContent = progress + '%'
    if (presentation.progressDisplay && presentation.progressDisplay !== elements.progressDisplay) {
      presentation.progressDisplay.textContent = progress + '%'
    }
    const dataSymbols = batch.symbolIds.filter(id => id !== 0)
    const firstData = dataSymbols[0]
    const lastData = dataSymbols[dataSymbols.length - 1]
    const formatSymbolRef = (id) => {
      if (id <= state.encoder.K_prime) return `${id}/${state.encoder.K_prime}`
      return `F${id - state.encoder.K_prime}`
    }
    const symbolLabel = dataSymbols.length === 0
      ? 'META'
      : firstData === lastData
        ? `sym=${formatSymbolRef(firstData)}`
        : `sym=${formatSymbolRef(firstData)}-${formatSymbolRef(lastData)}`
    if (batch.repairIdleBeacon) {
      debugCurrent(`#${state.frameCount} ARQ BEACON ${progress}%`)
    } else if (batch.syncPorch) {
      debugCurrent(`#${state.frameCount} SYNC ${progress}%`)
    } else {
      debugCurrent(
        batch.sendMetadata
          ? `#${state.frameCount} META + ${symbolLabel} ${progress}%`
          : `#${state.frameCount} ${symbolLabel} ${progress}%`
      )
    }

    noteSenderFramePerf(
      state.txPerf,
      frameStartMs,
      batchReadyMs - frameStartMs,
      buildDoneMs - batchReadyMs,
      blitDoneMs - buildDoneMs,
      blitDoneMs - frameStartMs,
      fps,
      cw,
      ch
    )

    scheduleNextRender()

  } catch (err) {
    debugLog(`ERROR: ${err.message}`)
    showError('Frame render error: ' + err.message)
  }
}

function armPreparedStart() {
  state.isAwaitingStart = true
  state.isSending = false
  state.isPaused = false
  state.nextFrameDueMs = 0
  clearSenderCanvasToBlack()
  showArmedStartPrompt()
  setSignalLive(false)

  updateActionButton()
  updateDropZoneState()
  updateEstimateSummary()
  announce('Display armed. Press Space or Enter to start the transfer.')
  debugLog('Sender armed: wait for the fullscreen tip to clear, then press Space/Enter or click the pattern area to begin transmission')
}

function beginPreparedStart() {
  if (!state.fileData) return
  if (!state.encoder) return
  // Space/Enter, the action button, and a click on the pattern area all
  // route here; only the first may start the transfer.
  if (state.isSending) return

  debugLog('=== START SENDING ===')
  state.isAwaitingStart = false
  state.isSending = true
  state.isPaused = false
  void acquireWakeLock()
  state.frameCount = 0
  state.nextFrameDueMs = performance.now() + (1000 / getFps().fps)
  resetSenderPerfState()
  elements.placeholder.style.display = 'none'
  setSignalLive(true)

  updateActionButton()
  updateDropZoneState()
  updateEstimateSummary()
  renderFrame()
}

async function cancelArmedStart(reason = 'Armed start cancelled') {
  if (!state.isAwaitingStart) return
  debugLog(reason)
  await restoreSenderReadyState()
}

async function startSending() {
  if (!state.fileData || !state.fileHash) return

  try {
    debugLog('=== ARMING FULLSCREEN START ===')
    const selectedFps = getFps()

    // Fullscreen layout can settle a frame or two after the promise resolves.
    // Measure the actual fullscreen element box instead of trusting window.inner*.
    const { target, stableMetrics } = await preparePresentationForTransmission()
    debugLog(`Sender FPS: ${selectedFps.name} (${selectedFps.interval}ms interval)`)

    const { metrics, capacity } = measureAndApplyCanvasSize(stableMetrics, target)
    const renderScaleIssue = getRenderScaleIssue(metrics, {
      requireNative1080p: modeRequiresNative1080p(state.mode)
    })
    if (renderScaleIssue) {
      throw new Error(renderScaleIssue)
    }
    logSenderSessionMetrics('Start session', metrics, capacity)
    const canvasWidth = metrics.width
    const canvasHeight = metrics.height
    const batchingProfile = getBatchingProfile(state.mode)
    const selectedBatching = selectFrameBatching({
      capacity,
      // Batching is sized for what actually goes on the wire, which is the
      // compressed byte count when gzip engaged at file selection.
      fileSize: state.fileData.byteLength,
      profile: batchingProfile
    })
    const {
      blockSize,
      packetsPerFrame: bestPacketsPerFrame,
      usedBytes: bestUsedBytes,
      frameBlockSize,
      maxBlockSize,
      maxPacketsPerFrame,
      targetFrameFill,
      maxUsedBytes
    } = selectedBatching

    debugLog(`Mode: ${HDMI_MODE_NAMES[state.mode]}`)
    debugLog(`Luma4 sender levels: [${getLuma1SenderLevels().join(', ')}]`)
    debugLog(`Pass-2 variant: ${getPass2Variant()}`)
    debugLog(`Dense pass-2 sweep mix: ${getDenseBinaryPass2SweepMix()}`)
    debugLog(`TX pacing: ${getSenderRenderPace(state.mode, selectedFps)}`)
    debugLog(`Payload capacity: ${capacity} bytes/frame (max packet payload ${frameBlockSize})`)
    debugLog(
      `Batch profile: ${batchingProfile.id ? `${batchingProfile.id}, ` : ''}` +
      `maxPackets=${maxPacketsPerFrame}, ` +
      `targetFill=${(targetFrameFill * 100).toFixed(0)}%, maxBlockSize=${maxBlockSize}, ` +
      `maxUsedBytes=${maxUsedBytes ?? 'none'}`
    )
    debugLog(`File: ${state.fileName} (${formatBytes(state.fileSize)}), blockSize: ${blockSize}`)

    state.encoder = createEncoder(
      state.fileData,
      state.fileName,
      'application/octet-stream',
      state.fileHash,
      blockSize,
      undefined,
      { noRedundancy: state.yolo, compressed: !!state.compressed, originalSize: state.fileSize }
    )
    state.packetSize = blockSize + PACKET_HEADER_SIZE
    state.packetsPerFrame = bestPacketsPerFrame
    state.metadataIntervalFrames = computeMetadataIntervalFrames()
    const batchedBytes = bestUsedBytes
    const utilization = ((batchedBytes / capacity) * 100).toFixed(1)

    debugLog(`Encoder: K=${state.encoder.K}, K'=${state.encoder.K_prime}`)
    if (state.yolo) debugLog('YOLO mode: redundancy disabled (no parity, no fountain)')
    debugLog(`Fountain degree: ${getDenseBinaryDegree()} (receiver must match)`)
    debugLog(getMetadataScheduleDescription())
    if (getSyncPorchFrameCount(state.mode) > 0) {
      debugLog(`Sync porch: ${getSyncPorchFrameCount(state.mode)} header-only frame(s) before data`)
    }
    debugLog(`Batching: ${state.packetsPerFrame} packet(s)/frame, packetSize=${state.packetSize}, used=${batchedBytes}/${capacity} bytes (${utilization}%)`)

    state.systematicIndex = 0
    state.systematicStride = chooseSystematicStride(state.encoder.K)
    state.intermediateSystematicStride = chooseSystematicStride(state.encoder.K_prime)
    state.paritySystematicIndex = 0
    state.paritySystematicStride = chooseSystematicStride(Math.max(1, state.encoder.K_prime - state.encoder.K))
    state.fountainSymbolId = state.encoder.K_prime + 1
    state.dataPacketCount = 0
    state.systematicPass = 1
    state.tailStartFrame = 0
    state.frameCount = 0
    state.arqController = state.arqConnected
      ? new ArqSenderController({ K: state.encoder.K, fileId: state.encoder.fileId, fallbackMs: 8000 })
      : null
    state.arqCursor = 0
    state.arqFallback = false
    if (state.arqController) {
      state.arqController.startPass(performance.now())
      debugLog(`ARQ mode: source pass once, repair by NACK, fallback after ${state.arqController.fallbackMs}ms silence`)
      if (state.yolo) debugLog('ARQ YOLO: user-selected no-redundancy mode preserved')
      updateArqSenderStatus(`ARQ ready (${state.encoder.K} source blocks)`, true)
    }
    resetSenderPerfState()
    if (usesMixedSlotReplay()) {
      debugLog(
        `Systematic order: source stride=${state.systematicStride}/${state.encoder.K}, ` +
        `parity stride=${state.paritySystematicStride}/${Math.max(1, state.encoder.K_prime - state.encoder.K)}`
      )
    } else {
      debugLog(
        `Systematic order: source stride=${state.systematicStride}/${state.encoder.K}, ` +
        `intermediate stride=${state.intermediateSystematicStride}/${state.encoder.K_prime}`
      )
    }
    debugLog(getHybridScheduleDescription())
    armPreparedStart()

  } catch (err) {
    console.error('HDMI-UVC start error:', err)
    await restoreSenderReadyState()
    showError('Failed to start: ' + err.message)
  }
}

async function pauseSending() {
  state.isPaused = true
  setSignalLive(false)
  cancelScheduledRender()

  await teardownPresentationSurface()
  elements.placeholderIcon.textContent = '⏸'
  elements.placeholderText.textContent = 'Transfer paused — ' + state.frameCount + ' frames sent'

  updateActionButton()
  updateEstimateSummary()
}

async function resumeSending() {
  try {
    state.isPaused = false
    void acquireWakeLock()
    elements.placeholder.style.display = 'none'

    const { target, stableMetrics } = await preparePresentationForTransmission()
    setSignalLive(true)
    const { metrics, capacity } = measureAndApplyCanvasSize(stableMetrics, target)
    const renderScaleIssue = getRenderScaleIssue(metrics, {
      requireNative1080p: modeRequiresNative1080p(state.mode)
    })
    if (renderScaleIssue) {
      throw new Error(renderScaleIssue)
    }
    logSenderSessionMetrics('Resume session', metrics, capacity)
    state.nextFrameDueMs = performance.now() + (1000 / getFps().fps)
    resetSenderPerfState()

    updateActionButton()
    updateEstimateSummary()
    renderFrame()
  } catch (err) {
    console.error('HDMI-UVC resume error:', err)
    state.isPaused = true
    await restoreSenderReadyState()
    showError('Failed to resume: ' + err.message)
  }
}

async function stopSending() {
  state.fileData = null
  state.fileName = null
  state.fileSize = 0
  state.fileHash = null
  state.compressed = false

  // With the file cleared, this resets the session, tears down the
  // presentation surface, and restores the empty drop-zone UI.
  await restoreSenderReadyState()
  elements.fileInfo.textContent = 'No file'
  elements.fileInput.value = ''
  updateArqSenderStatus(state.arqConnected ? 'Back-channel connected' : 'Back-channel offline', state.arqConnected)
}

function handleActionClick() {
  if (!state.fileData) return

  if (state.isAwaitingStart) {
    beginPreparedStart()
    return
  }

  if (state.isSending && !state.isPaused) {
    pauseSending()
  } else if (state.isPaused) {
    resumeSending()
  } else {
    startSending()
  }
}

async function processFile(file) {
  if (!file) return

  if (file.size > HDMI_UVC_MAX_FILE_SIZE) {
    showError('File too large for HDMI-UVC transfer (limit 1 GB). Split the file into smaller parts and send them one at a time.')
    return
  }

  try {
    const buffer = await file.arrayBuffer()
    // Hash the ORIGINAL bytes — the receiver verifies after decompression.
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))
    const { bytes: wireBytes, compressed } = await maybeCompress(new Uint8Array(buffer), file.type || '')

    state.fileData = wireBytes.buffer // wire bytes: gzipped when compressed
    state.fileName = file.name
    state.fileSize = file.size // original size, for display and metadata
    state.fileHash = hash
    state.compressed = compressed
    resetPreparedSessionState()
    state.isSending = false
    state.isPaused = false

    elements.fileInfo.textContent = file.name + ' (' + formatBytes(file.size) + ')'

    elements.placeholderIcon.textContent = '✓'
    elements.placeholderText.textContent = 'File ready — press Start'

    updateDropZoneState()
    updateActionButton()
    updateEstimateSummary()

  } catch (err) {
    console.error('File read error:', err)
    showError('Failed to read file: ' + err.message)
  }
}

function getFpsPresetIndexForRate(fps, fallbackIndex = DEFAULT_FPS_PRESET) {
  const index = FPS_PRESETS.findIndex(preset => preset.fps === fps)
  return String(index >= 0 ? index : fallbackIndex)
}

function getRecommendedFpsPreset(mode = state.mode) {
  return mode === HDMI_MODE.COMPAT_4 ||
    mode === HDMI_MODE.RAW_RGB ||
    mode === HDMI_MODE.LUMA_2 ||
    isDenseBinaryMode(mode)
    ? getFpsPresetIndexForRate(60)
    : String(DEFAULT_FPS_PRESET)
}

function handleKeydown(e) {
  if (state.isAwaitingStart) {
    if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      beginPreparedStart()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      void cancelArmedStart('Armed start cancelled before transmission')
      return
    }
  }

  // Escape pauses rather than stops: stopping discards all transfer progress
  // on one keypress, and Escape is also how fullscreen is exited (that path
  // pauses via handleFullscreenChange). Stop stays an explicit button press.
  if (e.key === 'Escape' && state.isSending && !state.isPaused) {
    pauseSending()
  }
}

function handleFullscreenChange() {
  if (state.isAwaitingStart && !document.fullscreenElement) {
    void cancelArmedStart('Fullscreen exited before transmission started')
    return
  }
  // If we were sending and fullscreen was exited (e.g. by pressing Escape), pause
  if (state.isSending && !state.isPaused && !document.fullscreenElement) {
    pauseSending()
  }
}

async function exitFullscreenSafely() {
  const presentationDoc = state.presentation?.doc
  if (presentationDoc?.fullscreenElement) {
    try {
      await presentationDoc.exitFullscreen()
    } catch {
      // Ignore fullscreen exit failures during cleanup.
    }
  }
  if (!document.fullscreenElement) return
  try {
    await document.exitFullscreen()
  } catch {
    // Ignore fullscreen exit failures during cleanup.
  }
}

export async function resetHdmiUvcSender() {
  state.arqTransport?.close()
  state.arqTransport = null
  state.arqConnected = false
  updateArqSenderStatus('Back-channel offline', false)
  await stopSending()
}

// True while a transfer is running, armed, or paused mid-transfer; used by
// the beforeunload guard.
export function isSenderBusy() {
  return state.isSending || state.isAwaitingStart
}

export function initHdmiUvcSender(errorHandler) {
  showError = errorHandler

  elements = {
    fileInput: document.getElementById('hdmi-uvc-file-input'),
    container: document.getElementById('hdmi-uvc-container'),
    placeholder: document.getElementById('hdmi-uvc-placeholder'),
    placeholderIcon: document.getElementById('hdmi-uvc-placeholder-icon'),
    placeholderText: document.getElementById('hdmi-uvc-placeholder-text'),
    canvas: document.getElementById('hdmi-uvc-canvas'),
    overlay: document.getElementById('hdmi-uvc-overlay'),
    frameCount: document.getElementById('hdmi-uvc-frame-count'),
    progressDisplay: document.getElementById('hdmi-uvc-progress'),
    fileInfo: document.getElementById('hdmi-uvc-file-info'),
    estimate: document.getElementById('hdmi-uvc-estimate'),
    btnAction: document.getElementById('btn-hdmi-uvc-action'),
    btnStop: document.getElementById('btn-hdmi-uvc-stop'),
    btnArqConnect: document.getElementById('btn-hdmi-uvc-arq-connect'),
    arqStatus: document.getElementById('hdmi-uvc-arq-status'),
    yoloToggle: document.getElementById('hdmi-uvc-yolo-toggle'),
    yoloLabel: document.querySelector('label[for="hdmi-uvc-yolo-toggle"]')
  }

  updateDropZoneState()
  updateActionButton()
  updateEstimateSummary()

  elements.btnAction.onclick = handleActionClick
  elements.btnStop.onclick = stopSending
  if (elements.btnArqConnect) elements.btnArqConnect.onclick = connectArqBackchannel
  // Switching transport drops any live back-channel so the next connect uses
  // the new one. Both ends must be set to the same transport to talk.
  initArqTransportSelect(document.getElementById('hdmi-uvc-arq-transport'), {
    onChange: () => {
      state.arqTransport?.close()
      state.arqTransport = null
      state.arqConnected = false
      updateArqSenderStatus('Back-channel offline', false)
    }
  })

  if (elements.yoloToggle) {
    const storedYolo = readStoredYoloPreference()
    state.yolo = storedYolo
    elements.yoloToggle.checked = storedYolo
    elements.yoloToggle.onchange = (e) => {
      state.yolo = e.target.checked
      state.yoloAutoEnabled = false
      state.yoloManualThisSession = true
      try { localStorage.setItem('hdmi-uvc-yolo', state.yolo ? '1' : '0') } catch {}
    }
  }

  wireDropZone({
    container: elements.container,
    fileInput: elements.fileInput,
    hasFile: () => !!state.fileData,
    onFile: processFile,
    // While armed, a click/tap on the (fullscreen) pattern area starts the
    // transfer — an alternative to Space/Enter for touch and mouse users.
    onClickCapture: () => {
      if (state.isAwaitingStart) {
        beginPreparedStart()
        return true
      }
      return false
    },
    // While armed, the document-level handleKeydown already starts the
    // transfer, so Enter/Space must not also open the file picker.
    canOpenViaKeyboard: () => !state.fileData && !state.isAwaitingStart
  })

  document.addEventListener('keydown', handleKeydown)
  document.addEventListener('fullscreenchange', handleFullscreenChange)


  // Diagnostics panel: hidden by default, toggle persisted across sessions.
  initDiagnosticsPanelToggle({
    button: document.getElementById('btn-hdmi-uvc-sender-diag-toggle'),
    panel: document.getElementById('hdmi-uvc-sender-debug'),
    storageKey: 'hdmi-uvc-diag-visible-sender',
    onChange: (visible) => {
      setSenderDiagPanelVisible(visible)
      if (visible) renderSenderDebugLog()
    }
  })

  // Debug panel copy button. Copy the full buffered history, not just the
  // rendered tail.
  const copyBtn = document.getElementById('btn-hdmi-uvc-sender-copy-log')
  if (copyBtn) {
    copyBtn.onclick = () => copyWithButtonFeedback(copyBtn, senderDebugLogBuffer.getCopyText())
  }
  const clearBtn = document.getElementById('btn-hdmi-uvc-sender-clear-log')
  if (clearBtn) {
    clearBtn.onclick = () => {
      senderDebugLogBuffer.clear()
      renderSenderDebugLog()
      debugLog('=== LOG CLEARED ===')
    }
  }
  debugLog('HDMI-UVC Sender initialized')
  debugLog(`Mode: ${HDMI_MODE_NAMES[state.mode]}, Luma4 levels [${getLuma1SenderLevels().join(', ')}]`)
  debugLog(`Pass-2 variant: ${getPass2Variant()}`)
  debugLog(`Dense pass-2 sweep mix: ${getDenseBinaryPass2SweepMix()}`)
  debugLog(`TX pace: ${getSenderRenderPace()}`)
}

// Exposed for hdmi-uvc-sender.tests.js only — not part of the runtime API.
export const _internals = {
  getRenderScaleIssue,
  getSenderRenderPace,
  getRecommendedFpsPreset
}
