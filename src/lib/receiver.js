// Receiver module - handles camera scanning and QR decoding
import jsQR from 'jsqr'
import QrDecodeWorker from './qr-decode-worker.js?worker&inline'
import { DecodeWorkerPool } from './shared/decode-worker-pool.js'
import { createDecoder } from './decoder.js'
import { packetModeFromFlags } from './packet.js'
import { QR_MODE } from './constants.js'
import { ColorQRDecoder } from './color-decoder.js'
import { formatBytes, formatTime } from './format.js'
import { playBeep, announce, copyWithButtonFeedback } from './feedback.js'
import { confirmDialog } from './confirm-dialog.js'
import { triggerBlobDownload } from './shared/download.js'
import { acquireWakeLock, releaseWakeLock } from './shared/wake-lock.js'
import { isMobileUA, listVideoInputs, populateCameraSelect, nextCamera } from './shared/camera.js'

// Debug mode - enabled via ?test URL parameter (exact param, not substring)
const DEBUG_MODE = typeof location !== 'undefined' && new URLSearchParams(location.search).has('test')

// Receiver state
const state = {
  decoder: null,
  stream: null,
  animationId: null,
  canvas: null,
  ctx: null,
  isScanning: false,
  symbolTimes: [],
  reconstructedBlob: null,
  fileDownloaded: false,
  startTime: null,
  cameras: [],
  currentCameraId: null,
  isMobile: false,
  hasNotifiedFirstScan: false,
  // Color mode state
  detectedMode: null,      // Auto-detected from first packet
  manualMode: null,        // User override (null = auto)
  effectiveMode: QR_MODE.BW, // What we're actually using
  channelBuffers: null,    // Reusable pixel buffers for color decode
  lastBufferSize: 0,
  // Debug counters
  frameCount: 0,
  detectCount: 0,
  // New libcimbar-based color decoder
  colorDecoder: null,
  // Set once metadata arrives so "Receiving <file>" is announced only once
  announcedReceiving: false
}

// DOM elements (initialized on setup)
let elements = null

// Error display (will be connected to global error banner)
let showError = (msg) => console.error(msg)

// Debug helpers
let lastLoggedSymIds = ''
let lastLoggedDecodePattern = ''
let lastLoggedSymCount = 0
let logEntryCount = 0

function debugStatus(text) {
  const el = document.getElementById('debug-current')
  if (el) el.textContent = text
}

function debugLog(text, forceLog = false) {
  // Skip verbose debug output unless in debug mode (?test)
  if (!DEBUG_MODE && text.startsWith('>>>')) {
    return
  }

  // Always log threshold changes and forced entries
  if (!forceLog && !text.startsWith('>>>')) {
    // Extract key info for smart deduplication
    // Format: "CMY F! 010 R64/55 G62/55 B37/55 [260] +0 #83 89%"
    const symIdMatch = text.match(/\[([^\]]+)\]/)
    const patternMatch = text.match(/[01]{3}/)
    const symCountMatch = text.match(/#(\d+)/)
    const acceptedMatch = text.match(/\+(\d+)/)

    const symIds = symIdMatch ? symIdMatch[1] : ''
    const pattern = patternMatch ? patternMatch[0] : ''
    const symCount = symCountMatch ? parseInt(symCountMatch[1]) : 0
    const accepted = acceptedMatch ? parseInt(acceptedMatch[1]) : 0

    // Skip if same symbol IDs, same pattern, same count, and nothing accepted
    if (symIds === lastLoggedSymIds &&
        pattern === lastLoggedDecodePattern &&
        symCount === lastLoggedSymCount &&
        accepted === 0) {
      return
    }

    lastLoggedSymIds = symIds
    lastLoggedDecodePattern = pattern
    lastLoggedSymCount = symCount
  }

  const el = document.getElementById('debug-log')
  if (el) {
    logEntryCount++
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    el.textContent += timestamp + ' ' + text + '\n'
    // Keep only last 200 lines
    const lines = el.textContent.split('\n')
    if (lines.length > 200) {
      el.textContent = lines.slice(-200).join('\n')
    }
    el.scrollTop = el.scrollHeight
  }
}

// ============ Color Mode Helpers ============

// Convert image to grayscale for QR detection
function toGrayscale(imageData) {
  const gray = new Uint8ClampedArray(imageData.width * imageData.height * 4)
  const pixels = imageData.data

  for (let i = 0; i < pixels.length; i += 4) {
    const g = Math.round(pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114)
    gray[i] = g
    gray[i + 1] = g
    gray[i + 2] = g
    gray[i + 3] = 255
  }

  return gray
}

function updateModeStatus() {
  if (!elements.modeStatus) return

  const effective = state.manualMode !== null ? state.manualMode : (state.detectedMode !== null ? state.detectedMode : QR_MODE.BW)
  state.effectiveMode = effective

  const modeNames = ['BW', 'CMY', 'RGB']

  if (state.manualMode !== null) {
    elements.modeStatus.textContent = 'Manual: ' + modeNames[effective]
    elements.modeStatus.className = 'mode-status manual'
  } else if (state.detectedMode !== null) {
    elements.modeStatus.textContent = 'Detected: ' + modeNames[effective]
    elements.modeStatus.className = 'mode-status detected'
  } else {
    elements.modeStatus.textContent = 'Auto-detecting…'
    elements.modeStatus.className = 'mode-status'
  }

  // Update button states
  if (elements.receiverModeButtons) {
    elements.receiverModeButtons.forEach(btn => {
      const isActive = parseInt(btn.dataset.mode) === effective
      btn.classList.toggle('active', isActive)
      btn.setAttribute('aria-pressed', String(isActive))
    })
  }
}

// Status text in the scanning row; doubles as the camera-failure notice so
// the screen never claims to be scanning while the camera is off.
function setScanningLabel(text) {
  if (elements && elements.scanningLabel) elements.scanningLabel.textContent = text
}

// Show the appropriate status section
function showStatus(which) {
  elements.statusScanning.classList.add('hidden')
  elements.statusReceiving.classList.add('hidden')
  elements.statusComplete.classList.add('hidden')

  if (which === 'scanning') {
    elements.statusScanning.classList.remove('hidden')
  } else if (which === 'receiving') {
    elements.statusReceiving.classList.remove('hidden')
  } else if (which === 'complete') {
    elements.statusComplete.classList.remove('hidden')
  }
}

// Enumerate available cameras
async function enumerateCameras() {
  try {
    // Request permission first (needed to get labels)
    const tempStream = await navigator.mediaDevices.getUserMedia({ video: true })
    tempStream.getTracks().forEach(t => t.stop())

    let cameras = await listVideoInputs()

    // Detect mobile (iOS/Android)
    state.isMobile = isMobileUA()

    if (state.isMobile) {
      // On mobile: filter to front/back only
      const front = cameras.find(c =>
        c.label.toLowerCase().includes('front') ||
        c.label.toLowerCase().includes('facetime')
      )
      const back = cameras.find(c =>
        c.label.toLowerCase().includes('back') &&
        !c.label.toLowerCase().includes('ultra') &&
        !c.label.toLowerCase().includes('wide') &&
        !c.label.toLowerCase().includes('tele') &&
        !c.label.toLowerCase().includes('macro')
      ) || cameras.find(c => c.label.toLowerCase().includes('back'))

      cameras = [back, front].filter(Boolean)

      // Mobile: show toggle button, hide dropdown
      elements.cameraPicker.classList.add('hidden')
      elements.btnCameraSwitch.classList.remove('hidden')
    } else {
      // Desktop: show dropdown directly, hide toggle button
      elements.btnCameraSwitch.classList.add('hidden')
      elements.cameraPicker.classList.remove('hidden')
      populateCameraSelect(elements.cameraDropdown, cameras)
    }

    state.cameras = cameras

    if (cameras.length === 0) {
      showError('No camera found on this device.')
      setScanningLabel('No camera found')
      return null
    }

    // Hide controls entirely if only one camera
    if (cameras.length <= 1) {
      elements.btnCameraSwitch.classList.add('hidden')
      elements.cameraPicker.classList.add('hidden')
    }

    // Return default camera ID (first one, which is back camera on mobile)
    return cameras[0].deviceId
  } catch (err) {
    console.error('Camera enumeration error:', err)
    if (err.name === 'NotAllowedError') {
      showError('Camera access denied. Allow camera for this site, then tap Reset.')
      setScanningLabel('Camera blocked — allow access, then tap Reset')
    } else {
      setScanningLabel('Camera unavailable — tap Reset to retry')
    }
    return null
  }
}

// Start scanning with specified camera
async function startScanning(deviceId) {
  if (!deviceId) {
    showError('No camera available.')
    setScanningLabel('Camera unavailable — tap Reset to retry')
    return
  }

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, facingMode: 'environment' }
    })

    state.currentCameraId = deviceId
    elements.cameraDropdown.value = deviceId

    elements.video.srcObject = state.stream
    await elements.video.play()

    // Create offscreen canvas for scanning
    state.canvas = document.createElement('canvas')
    state.ctx = state.canvas.getContext('2d', { willReadFrequently: true })

    // Reset decoder and calibration
    state.decoder = createDecoder()
    initZxingPool()
    state.symbolTimes = []
    state.reconstructedBlob = null
    state.startTime = Date.now()
    state.isScanning = true
    void acquireWakeLock()
    state.frameCount = 0
    state.detectCount = 0
    state.announcedReceiving = false

    showStatus('scanning')
    setScanningLabel('Scanning…')
    elements.statSymbols.textContent = '0 codes'

    // Cache overlay geometry now that the video has dimensions; scanFrame
    // must not read layout on every detection.
    updateOverlayGeometry()

    // Start scan loop
    scanFrame()
  } catch (err) {
    console.error('Camera start error:', err)
    showError('Failed to start camera. ' + err.message)
    setScanningLabel('Camera failed — tap Reset to retry')
  }
}

// Stop scanning
function stopScanning() {
  state.isScanning = false
  releaseWakeLock()
  teardownZxingPool()

  if (state.animationId) {
    cancelAnimationFrame(state.animationId)
  }

  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop())
  }

  elements.video.srcObject = null
  elements.qrOverlay.style.display = 'none'
}

// Switch camera
async function switchCamera(deviceId) {
  if (deviceId === state.currentCameraId) return

  // Stop current stream
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop())
  }

  // Start with new camera (preserve decoder state)
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, facingMode: 'environment' }
    })

    state.currentCameraId = deviceId
    elements.video.srcObject = state.stream
    await elements.video.play()
  } catch (err) {
    console.error('Camera switch error:', err)
    showError('Failed to switch camera. ' + err.message)
  }
}

// Toggle between front and back camera (mobile only)
async function toggleMobileCamera(e) {
  e.stopPropagation()
  const next = nextCamera(state.cameras, state.currentCameraId)
  if (!next) return

  await switchCamera(next.deviceId)
}

// Process a decoded packet
function processPacket(bytes) {
  let accepted = state.decoder.receive(bytes)

  // Handle new session (sender changed settings)
  if (accepted === 'new_session') {
    console.log('New session detected, resetting receiver')
    state.decoder.reset()
    state.symbolTimes = []
    state.startTime = Date.now()
    state.hasNotifiedFirstScan = false
    state.detectedMode = null
    state.frameCount = 0
    state.detectCount = 0
    state.announcedReceiving = false
    updateModeStatus()
    showStatus('scanning')
    elements.progressFill.style.width = '0%'
    elements.progressFill.parentElement.setAttribute('aria-valuenow', '0')
    elements.statSymbols.textContent = '0 codes'
    accepted = state.decoder.receive(bytes)
  }

  if (accepted) {
    if (!state.hasNotifiedFirstScan) {
      state.hasNotifiedFirstScan = true
      playBeep()
    }

    const now = Date.now()
    state.symbolTimes.push(now)
    state.symbolTimes = state.symbolTimes.filter(t => now - t < 5000)
  }

  // 1 QR = 1 frame for this receiver — signal frame boundary regardless of
  // accept/duplicate outcome so the stall counter and tail solver track time.
  if (typeof state.decoder.noteFrameBoundary === 'function') {
    state.decoder.noteFrameBoundary()
  }

  return accepted
}

// ============ zxing worker pool (dense-frame fast path) ============
// jsQR cannot sustain v27/v40 frames at frame rate, so BW decoding runs in
// zxing-cpp WASM workers when the module loads. 'unavailable' flips the
// receiver to the jsQR fallback for good (e.g. file:// where fetching the
// sibling .wasm is blocked); color modes always use the jsQR pipeline.
let zxingPool = null
let zxingStatus = 'unknown' // 'unknown' | 'ready' | 'unavailable'
let zxingFrameId = 0
let zxingCrop = null // latest crop geometry for the overlay in the async callback

function zxingAvailable() {
  return zxingPool !== null && zxingStatus !== 'unavailable'
}

function createZxingWorker() {
  const worker = new QrDecodeWorker()
  // The pool owns worker.onmessage; this one-shot listener only watches the
  // init reply (id -1) to learn whether the WASM actually loaded.
  const onFirst = (event) => {
    if (!event.data || event.data.id !== -1) return
    worker.removeEventListener('message', onFirst)
    if (event.data.ready) {
      zxingStatus = 'ready'
    } else if (zxingStatus !== 'ready') {
      zxingStatus = 'unavailable'
      if (zxingPool) {
        zxingPool.resize(0)
        zxingPool = null
      }
    }
  }
  worker.addEventListener('message', onFirst)
  worker.postMessage({
    type: 'init',
    wasmUrl: new URL('zxing/zxing_reader.wasm', document.baseURI).href
  })
  return worker
}

function initZxingPool() {
  if (zxingPool || zxingStatus === 'unavailable') return
  zxingPool = new DecodeWorkerPool(createZxingWorker, onZxingDecoded)
  zxingPool.resize(Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 4) - 2)))
}

function teardownZxingPool() {
  if (!zxingPool) return
  // Each worker holds a ~941 KB WASM instance — reclaim it between transfers.
  zxingPool.resize(0)
  zxingPool = null
}

function submitFrameToZxing(imageData, size, video, offsetX, offsetY) {
  zxingCrop = { video, offsetX, offsetY, size }
  // Transfers the pixel buffer; when every worker is busy the frame is simply
  // dropped — the fountain absorbs it.
  zxingPool.submit(
    { id: zxingFrameId++, buf: imageData.data.buffer, w: size, h: size },
    [imageData.data.buffer]
  )
}

// zxing's corner points, reshaped to what showQROverlay expects (jsQR names).
function zxingLocationFromPosition(position) {
  return {
    topLeftCorner: position.topLeft,
    topRightCorner: position.topRight,
    bottomRightCorner: position.bottomRight,
    bottomLeftCorner: position.bottomLeft
  }
}

function onZxingDecoded(bytes, data) {
  if (!state.isScanning || !state.decoder) return
  if (data && data.position && zxingCrop) {
    showQROverlay(
      zxingLocationFromPosition(data.position),
      zxingCrop.video, zxingCrop.offsetX, zxingCrop.offsetY, zxingCrop.size
    )
  }
  debugStatus('BW detected')
  try {
    handleBWPacketBytes(Uint8Array.from(bytes))
  } catch (err) {
    debugStatus('BW decode error')
  }
}

// Ingest one decoded BW frame's packet bytes. Shared by the zxing worker
// callback and the jsQR fallback inside scanFrame. Returns true when the
// transfer just completed (the sync caller stops scheduling frames).
function handleBWPacketBytes(bytes) {
  // Check mode from the version/flags byte (bits 1-2) for auto-detection;
  // the next scanFrame tick picks up the color pipeline from detectedMode.
  if (state.detectedMode === null && bytes.length >= 1) {
    const packetMode = packetModeFromFlags(bytes[0])
    if (packetMode !== QR_MODE.BW) {
      state.detectedMode = packetMode
      updateModeStatus()
    }
  }

  processPacket(bytes)
  updateReceiverStats()

  if (state.decoder.isComplete()) {
    onReceiveComplete()
    return true
  }
  return false
}

// Scan a single frame
function scanFrame() {
  if (!state.isScanning) return

  const video = elements.video
  const canvas = state.canvas
  const ctx = state.ctx

  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    // Crop to square (like experiments) - critical for color mode processing
    const vw = video.videoWidth
    const vh = video.videoHeight
    const size = Math.min(vw, vh)

    canvas.width = size
    canvas.height = size

    // Center crop
    const offsetX = (vw - size) / 2
    const offsetY = (vh - size) / 2
    ctx.drawImage(video, offsetX, offsetY, size, size, 0, 0, size, size)

    const imageData = ctx.getImageData(0, 0, size, size)

    // Determine effective mode
    const effectiveMode = state.manualMode !== null ? state.manualMode : (state.detectedMode !== null ? state.detectedMode : QR_MODE.BW)

    // BW fast path: hand the frame to the zxing worker pool and move on —
    // decode results (and completion) arrive via onZxingDecoded. Skips the
    // main-thread grayscale pass and jsQR call entirely.
    if (effectiveMode === QR_MODE.BW && zxingAvailable()) {
      submitFrameToZxing(imageData, size, video, offsetX, offsetY)
      state.animationId = requestAnimationFrame(scanFrame)
      return
    }

    // Convert to grayscale for QR detection (try both inversions for better detection)
    const grayData = toGrayscale(imageData)
    const grayResult = jsQR(grayData, size, size)

    if (effectiveMode === QR_MODE.BW) {
      // BW fallback: main-thread jsQR decode
      if (grayResult) {
        showQROverlay(grayResult.location, video, offsetX, offsetY, size)
        debugStatus('BW detected')

        try {
          // Raw binary QR payload — the packet bytes as transmitted.
          if (handleBWPacketBytes(Uint8Array.from(grayResult.binaryData))) {
            return // transfer complete — stop scheduling frames
          }
        } catch (err) {
          debugStatus('BW decode error')
        }
      } else {
        elements.qrOverlay.style.display = 'none'
        debugStatus('BW no QR')
      }
    } else {
      // Color mode: use new libcimbar-based decoder
      // Applies: relative colors, color correction, drift tracking, priority decoding

      state.frameCount++

      if (!grayResult) {
        // No QR detected - skip frame, show detection rate
        elements.qrOverlay.style.display = 'none'
        const rate = state.frameCount > 0 ? Math.round(100 * state.detectCount / state.frameCount) : 0
        debugStatus('no QR ' + rate + '%')
        state.animationId = requestAnimationFrame(scanFrame)
        return
      }

      state.detectCount++
      const rate = Math.round(100 * state.detectCount / state.frameCount)

      // Grayscale detection succeeded - use detected position
      const loc = grayResult.location
      showQROverlay(loc, video, offsetX, offsetY, size)

      const modeName = effectiveMode === QR_MODE.PCCC ? 'CMY' : 'RGB'

      try {
        // Initialize color decoder if needed
        if (!state.colorDecoder) {
          state.colorDecoder = new ColorQRDecoder()
        }

        // Decode using new libcimbar-based pipeline
        const decoded = state.colorDecoder.decode(imageData, loc)

        // Debug: log color decoder stats to on-screen panel
        if (state.frameCount % 10 === 1) {
          const stats = decoded.stats
          const dist = stats.colorDistribution || []
          const modSize = state.colorDecoder.detectedModuleSize?.toFixed(1) || '?'
          const corrInfo = state.colorDecoder.corrector?.getDebugInfo() || '?'
          const classType = state.colorDecoder.classifierType || '?'
          debugLog(`>>> COLOR v${state.colorDecoder.grid?.version || '?'} mod:${modSize}px ${classType} ${corrInfo}`)
          debugLog(`>>> DIST W:${dist[0]||0} C:${dist[1]||0} M:${dist[2]||0} Y:${dist[3]||0} B:${dist[4]||0} G:${dist[5]||0} R:${dist[6]||0} K:${dist[7]||0}`)

          // Sample a few module results to see actual RGB values
          const sampleResults = []
          for (const [key, result] of decoded.results) {
            if (sampleResults.length >= 3 && result.colorName !== 'white' && result.colorName !== 'black') {
              // Collect up to 3 chromatic samples
              if (result.sampledRGB && sampleResults.length < 6) {
                sampleResults.push(result)
              }
            } else if (sampleResults.length < 3 && result.sampledRGB) {
              sampleResults.push(result)
            }
            if (sampleResults.length >= 6) break
          }
          if (sampleResults.length > 0) {
            // Color name abbreviations: W=white, C=cyan, M=magenta, Y=yellow, B=blue, G=green, R=red, K=black
            const colorAbbrev = (name) => {
              if (!name) return '?'
              const n = name.toLowerCase()
              if (n.startsWith('black')) return 'K'
              if (n.startsWith('blue')) return 'B'
              return name.substring(0, 1).toUpperCase()
            }
            const samples = sampleResults.slice(0, 3).map(r => {
              const s = r.sampledRGB || [0,0,0]
              const c = r.correctedRGB || [0,0,0]
              return `${s[0]},${s[1]},${s[2]}->${c[0]?.toFixed(0)},${c[1]?.toFixed(0)},${c[2]?.toFixed(0)}=${colorAbbrev(r.colorName)}`
            })
            debugLog(`>>> RGB ${samples.join(' | ')}`)
          }

          // Check pixel mapping stats
          const decoder = state.colorDecoder.decoder
          if (decoder?.lastBuildStats) {
            const s = decoder.lastBuildStats
            const pct = (100 * s.mappedPixels / (decoded.channels.size * decoded.channels.size)).toFixed(0)
            debugLog(`>>> MAP mapped:${s.mappedPixels} (${pct}%) fixed:${s.fixedPixels} data:${s.dataPixels}`)
          }
        }

        // Decode each channel with jsQR
        const channelResults = [
          jsQR(decoded.channels.ch0, decoded.channels.size, decoded.channels.size),
          jsQR(decoded.channels.ch1, decoded.channels.size, decoded.channels.size),
          jsQR(decoded.channels.ch2, decoded.channels.size, decoded.channels.size)
        ]

        // Track which channels decoded successfully
        const channelBits = channelResults.map(r => r ? 1 : 0)
        let acceptedCount = 0

        // Process any successful channel decodes
        const symIds = []
        for (let i = 0; i < channelResults.length; i++) {
          const chResult = channelResults[i]
          if (chResult) {
            try {
              // Raw binary QR payload — the packet bytes as transmitted.
              const bytes = Uint8Array.from(chResult.binaryData)

              // Extract symbol ID from header (bytes 8-10, 24-bit big-endian)
              if (bytes.length >= 11) {
                const symId = (bytes[8] << 16) | (bytes[9] << 8) | bytes[10]
                symIds.push(symId >>> 0)
              }

              // Auto-detect mode from the version/flags byte (bits 1-2)
              if (state.detectedMode === null && bytes.length >= 1) {
                state.detectedMode = packetModeFromFlags(bytes[0])
                updateModeStatus()
              }

              const accepted = processPacket(bytes)
              if (accepted) acceptedCount++
            } catch (err) {
              // Individual channel decode error, continue with others
            }
          }
        }

        // Show status with new decoder stats
        const symCount = state.decoder.uniqueSymbols || 0
        const symIdStr = symIds.length > 0 ? symIds.join('/') : '-'
        const conf = Math.round(decoded.stats.avgConfidence * 100)
        const drift = decoded.stats.avgDrift.toFixed(1)

        const statusText = `${modeName} ${channelBits.join('')} conf:${conf}% drift:${drift} [${symIdStr}] +${acceptedCount} #${symCount} ${rate}%`
        debugStatus(statusText)
        debugLog(statusText)

        if (acceptedCount > 0) {
          updateReceiverStats()

          if (state.decoder.isComplete()) {
            onReceiveComplete()
            return
          }
        }
      } catch (err) {
        console.log('Color decode error:', err.message)
        debugStatus(`${modeName} error: ${err.message}`)
      }
    }
  }

  state.animationId = requestAnimationFrame(scanFrame)
}

// Overlay geometry cache. getBoundingClientRect/offsetWidth are layout reads;
// doing them per detected frame inside the rAF loop causes layout thrash, so
// they run only here — on scan start and whenever the video element resizes.
let overlayGeom = null

function updateOverlayGeometry() {
  const video = elements && elements.video
  if (!video || !video.videoWidth) {
    overlayGeom = null
    return
  }
  const videoRect = video.getBoundingClientRect()
  const containerRect = video.parentElement.getBoundingClientRect()
  overlayGeom = {
    containerOffsetX: videoRect.left - containerRect.left,
    containerOffsetY: videoRect.top - containerRect.top,
    displayWidth: video.offsetWidth,
    displayHeight: video.offsetHeight,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight
  }
}

// Show overlay around detected QR code
function showQROverlay(location, video, cropOffsetX, cropOffsetY, cropSize) {
  const svg = elements.qrOverlay
  const polygon = elements.qrPolygon

  // Refresh the cache if the stream dimensions changed (camera switch)
  if (!overlayGeom || overlayGeom.videoWidth !== video.videoWidth ||
      overlayGeom.videoHeight !== video.videoHeight) {
    updateOverlayGeometry()
    if (!overlayGeom) return
  }
  const { containerOffsetX, containerOffsetY, displayWidth, displayHeight, videoWidth, videoHeight } = overlayGeom

  // The cropped area in the video
  const cropDisplayWidth = displayWidth * (cropSize / videoWidth)
  const cropDisplayHeight = displayHeight * (cropSize / videoHeight)

  // Scale from cropped canvas coordinates to display coordinates
  const scaleX = cropDisplayWidth / cropSize
  const scaleY = cropDisplayHeight / cropSize

  // Offset for crop area in display coordinates
  const cropDisplayOffsetX = displayWidth * (cropOffsetX / videoWidth)
  const cropDisplayOffsetY = displayHeight * (cropOffsetY / videoHeight)

  // Build polygon points from all 4 corners
  const points = [
    location.topLeftCorner,
    location.topRightCorner,
    location.bottomRightCorner,
    location.bottomLeftCorner
  ].map(p =>
    `${p.x * scaleX + cropDisplayOffsetX + containerOffsetX},${p.y * scaleY + cropDisplayOffsetY + containerOffsetY}`
  ).join(' ')

  polygon.setAttribute('points', points)
  svg.style.display = 'block'
}

// Update receiver statistics display
function updateReceiverStats() {
  const decoder = state.decoder
  if (!decoder) return

  const k = decoder.k || 0
  const solved = decoder.solved || 0
  const uniqueSymbols = decoder.uniqueSymbols || 0

  // If we have metadata, switch to receiving view
  if (decoder.metadata && k > 0) {
    showStatus('receiving')

    if (!state.announcedReceiving) {
      state.announcedReceiving = true
      announce('Receiving ' + decoder.metadata.filename)
    }

    const progress = (solved / k * 100)
    elements.progressFill.style.width = progress + '%'
    elements.progressFill.parentElement.setAttribute('aria-valuenow', String(Math.round(progress)))
    elements.statBlocks.textContent = solved + '/' + k
    elements.fileNameDisplay.textContent =
      decoder.metadata.filename + ' (' + formatBytes(decoder.metadata.fileSize) + ')'

    // Calculate rate based on actual file size and progress
    const times = state.symbolTimes
    const fileSize = decoder.metadata.fileSize
    if (times.length >= 2 && fileSize > 0) {
      const windowDuration = (times[times.length - 1] - times[0]) / 1000
      const bytesPerBlock = fileSize / k
      const bytesInWindow = times.length * bytesPerBlock
      const rateKBps = windowDuration > 0 ? (bytesInWindow / windowDuration / 1024) : 0
      elements.statRate.textContent = rateKBps.toFixed(1) + ' KB/s'

      // Estimate remaining time
      const remaining = k - solved
      const remainingBytes = remaining * bytesPerBlock
      const etaMs = rateKBps > 0 ? (remainingBytes / 1024 / rateKBps * 1000 * 1.3) : 0
      elements.statEta.textContent = etaMs > 0 ? ('~' + formatTime(etaMs)) : ''
    }
  } else {
    // Still in scanning phase
    elements.statSymbols.textContent = uniqueSymbols + ' codes'
  }
}

// Handle receive completion
async function onReceiveComplete() {
  // Capture final timing before stopping
  const endTime = Date.now()
  const totalTime = state.startTime ? endTime - state.startTime : 0

  stopScanning()

  const verified = await state.decoder.verify()

  if (verified) {
    // Notify user of successful completion
    playBeep()

    // reconstructFile() inflates gzip-compressed streams; verify() above
    // already proved the result hashes to the sender's original bytes.
    const data = await state.decoder.reconstructFile()
    const metadata = state.decoder.metadata

    state.reconstructedBlob = new Blob([data], { type: metadata.mimeType })
    state.fileDownloaded = false

    // Calculate average transfer rate
    const totalSeconds = totalTime / 1000
    const avgRateKBps = totalSeconds > 0 ? (metadata.fileSize / 1024 / totalSeconds) : 0

    showStatus('complete')
    elements.completeFileName.textContent =
      metadata.filename + ' (' + formatBytes(metadata.fileSize) + ') in ' + formatTime(totalTime)
    elements.completeRate.textContent = avgRateKBps.toFixed(1) + ' KB/s avg'
    announce('Transfer complete: ' + metadata.filename)
  } else {
    showError('Verification failed — the file was corrupted in transit. Scanning restarted; keep the sender running.')
    // Reset decoder and restart scanning; stopping on the dead "Scanning…"
    // screen with the camera off would strand the user.
    state.decoder = null
    state.reconstructedBlob = null
    state.startTime = null
    if (state.currentCameraId) {
      await startScanning(state.currentCameraId)
    } else {
      await autoStartReceiver()
    }
  }
}

// Download the received file
function downloadFile() {
  if (!state.reconstructedBlob || !state.decoder || !state.decoder.metadata) return
  triggerBlobDownload(state.reconstructedBlob, state.decoder.metadata.filename)
  state.fileDownloaded = true
}

// True while a fully received file is still only in memory. Navigation away
// resets the module and would silently discard it.
export function hasPendingDownload() {
  return !!state.reconstructedBlob && !state.fileDownloaded
}

// Reset receiver state
export function resetReceiver() {
  stopScanning()
  state.decoder = null
  state.reconstructedBlob = null
  state.startTime = null
  state.hasNotifiedFirstScan = false
  // Reset mode state
  state.detectedMode = null
  state.manualMode = null
  state.effectiveMode = QR_MODE.BW
  // Reset debug counters
  state.frameCount = 0
  state.detectCount = 0
  // Reset color decoder
  if (state.colorDecoder) {
    state.colorDecoder.reset()
  }

  state.announcedReceiving = false

  if (elements) {
    showStatus('scanning')
    setScanningLabel('Scanning…')
    elements.progressFill.style.width = '0%'
    elements.progressFill.parentElement.setAttribute('aria-valuenow', '0')
    elements.fileNameDisplay.textContent = '-'
    elements.statBlocks.textContent = '0/0'
    elements.statSymbols.textContent = '0 codes'
    elements.statRate.textContent = '-'
    elements.statEta.textContent = ''
    updateModeStatus()
  }
}

// Auto-start receiver (called when entering receiver screen)
export async function autoStartReceiver() {
  const defaultCameraId = await enumerateCameras()
  if (defaultCameraId) {
    await startScanning(defaultCameraId)
  }
}

// Initialize receiver module
export function initReceiver(errorHandler) {
  showError = errorHandler

  elements = {
    cameraDropdown: document.getElementById('camera-dropdown'),
    cameraPicker: document.getElementById('camera-picker'),
    btnCameraSwitch: document.getElementById('btn-camera-switch'),
    video: document.getElementById('camera-video'),
    qrOverlay: document.getElementById('qr-overlay'),
    qrPolygon: document.getElementById('qr-polygon'),
    statusScanning: document.getElementById('status-scanning'),
    scanningLabel: document.getElementById('scanning-label'),
    statusReceiving: document.getElementById('status-receiving'),
    statusComplete: document.getElementById('status-complete'),
    progressFill: document.getElementById('progress-fill'),
    fileNameDisplay: document.getElementById('file-name-display'),
    completeFileName: document.getElementById('complete-file-name'),
    statBlocks: document.getElementById('stat-blocks'),
    statSymbols: document.getElementById('stat-symbols'),
    statRate: document.getElementById('stat-rate'),
    statEta: document.getElementById('stat-eta'),
    btnDownload: document.getElementById('btn-download'),
    btnReceiveAnother: document.getElementById('btn-receive-another'),
    btnResetReceiver: document.getElementById('btn-reset-receiver'),
    completeRate: document.getElementById('complete-rate'),
    // Mode override elements
    modeStatus: document.getElementById('mode-status'),
    receiverModeButtons: document.querySelectorAll('#receiver-mode-selector .mode-btn'),
    // Debug elements
    btnCopyLog: document.getElementById('btn-copy-log'),
    btnClearLog: document.getElementById('btn-clear-log'),
    debugLog: document.getElementById('debug-log'),
    debugPanel: document.getElementById('debug-panel')
  }

  // Show debug panel only in test mode
  if (DEBUG_MODE && elements.debugPanel) {
    elements.debugPanel.style.display = 'block'
  }

  // Recompute cached overlay geometry when the video's layout size changes
  // (window resize, orientation change) instead of reading layout per frame.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(updateOverlayGeometry).observe(elements.video)
  }

  // Bind event handlers
  elements.btnCameraSwitch.onclick = toggleMobileCamera
  elements.cameraDropdown.onchange = (e) => switchCamera(e.target.value)
  elements.btnDownload.onclick = downloadFile
  elements.btnReceiveAnother.onclick = restartReceiver
  elements.btnResetReceiver.onclick = restartReceiver
  elements.btnCopyLog.onclick = () =>
    copyWithButtonFeedback(elements.btnCopyLog, elements.debugLog.textContent)
  if (elements.btnClearLog) {
    elements.btnClearLog.onclick = () => {
      elements.debugLog.textContent = ''
      debugLog('=== LOG CLEARED ===', true)
    }
  }

  // Mode override handlers
  elements.receiverModeButtons.forEach(btn => {
    btn.onclick = () => {
      const mode = parseInt(btn.dataset.mode)
      // Toggle: clicking active mode clears override (back to auto)
      if (state.manualMode === mode) {
        state.manualMode = null
      } else {
        state.manualMode = mode
      }
      updateModeStatus()
    }
  })
}

// True while a transfer is underway (metadata seen, file not yet complete);
// used by the beforeunload guard.
export function isReceiving() {
  return state.isScanning && !!(state.decoder && state.decoder.metadata) && !state.reconstructedBlob
}

// Restart receiver for another file
async function restartReceiver() {
  // Reset and "Receive Another" destroy the in-memory file just like leaving
  // the screen does; ask first.
  if (hasPendingDownload() &&
      !(await confirmDialog('The received file has not been downloaded yet. Discard it and scan again?'))) {
    return
  }
  resetReceiver()
  await autoStartReceiver()
}
