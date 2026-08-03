// Sender module - handles file encoding and QR display
import { getQRModules } from './qr-modules.js'
import { MAX_FILE_SIZE, METADATA_INTERVAL, DATA_PRESETS, MAX_COLOR_DATA_PRESET, SIZE_PRESETS, SPEED_PRESETS, QR_MODE, MODE_MARGIN_RATIOS, PATCH_SIZE_RATIO, PATCH_GAP_RATIO } from './constants.js'
import { createPacket } from './packet.js'
import { PALETTE_RGB } from './color/palette.js'
import { wireDropZone } from './shared/dropzone.js'
import { acquireWakeLock, releaseWakeLock } from './shared/wake-lock.js'
import { maybeCompress } from './shared/compression.js'
import { packSnippet } from './shared/snippet.js'
import { createEncoder } from './encoder.js'
import { formatBytes } from './format.js'
import { announce, flashHighlight } from './feedback.js'

// Sender state
const state = {
  encoder: null,
  fileBuffer: null, // wire bytes: gzipped when `compressed`, else the original
  fileName: null,
  mimeType: null,
  fileHash: null, // SHA-256 of the ORIGINAL bytes, end-to-end
  originalSize: 0,
  compressed: false,
  intervalId: null,
  symbolId: 1,
  isPaused: false,
  isSending: false,
  frameCount: 0,
  mode: QR_MODE.BW,
  payloadKind: 'file' // 'file' | 'text' — which sender pane feeds the stream
}

// DOM elements (initialized on setup)
let elements = null

// ============ Color Mode Helpers ============

// CMY to RGB conversion for PCCC mode
function cmyToRgb(c, m, y) {
  return [
    Math.round(255 * (1 - c)),
    Math.round(255 * (1 - m)),
    Math.round(255 * (1 - y))
  ]
}

// Fixed 8-color RGB palette for Palette mode
// Index encodes: bit2=R, bit1=G, bit0=B (inverted for QR: high index = dark)
// Shared table — see color/palette.js for the ordering contract.

// Palette patch configuration for HCC2D calibration
// Each corner has 2 patches arranged to show all 8 palette colors
const PALETTE_PATCH_CONFIG = [
  { corner: 'TL', offset: 0, paletteIndex: 0 },  // White
  { corner: 'TL', offset: 1, paletteIndex: 3 },  // Red
  { corner: 'TR', offset: 0, paletteIndex: 5 },  // Green
  { corner: 'TR', offset: 1, paletteIndex: 4 },  // Cyan
  { corner: 'BL', offset: 0, paletteIndex: 6 },  // Blue
  { corner: 'BL', offset: 1, paletteIndex: 2 },  // Magenta
  { corner: 'BR', offset: 0, paletteIndex: 1 },  // Yellow
  { corner: 'BR', offset: 1, paletteIndex: 7 },  // Black
]

// Check if position is finder or timing pattern (must stay B/W for detection)
function isFinderOrTiming(row, col, size) {
  // Top-left finder (includes separator)
  if (row < 8 && col < 8) return true
  // Top-right finder
  if (row < 8 && col >= size - 8) return true
  // Bottom-left finder
  if (row >= size - 8 && col < 8) return true
  // Timing patterns
  if (row === 6 || col === 6) return true
  // Alignment pattern for larger QR codes
  if (size > 25) {
    const alignPos = size - 7
    if (row >= alignPos - 2 && row <= alignPos + 2 &&
        col >= alignPos - 2 && col <= alignPos + 2) return true
  }
  return false
}

// Get patch position for Palette mode calibration (proportional to margin)
function getPatchPosition(corner, offset, canvasSize, patchSize, patchGap) {
  switch (corner) {
    case 'TL':
      return {
        x: patchGap + offset * (patchSize + patchGap),
        y: patchGap
      }
    case 'TR':
      return {
        x: canvasSize - patchGap - patchSize - offset * (patchSize + patchGap),
        y: patchGap
      }
    case 'BL':
      return {
        x: patchGap + offset * (patchSize + patchGap),
        y: canvasSize - patchGap - patchSize
      }
    case 'BR':
      return {
        x: canvasSize - patchGap - patchSize - offset * (patchSize + patchGap),
        y: canvasSize - patchGap - patchSize
      }
  }
}

// Draw calibration patches for Palette mode
function drawCalibrationPatches(ctx, canvasSize, margin) {
  // Calculate patch size and gap from margin (proportional sizing)
  const patchSize = Math.round(margin * PATCH_SIZE_RATIO)
  const patchGap = Math.round(margin * PATCH_GAP_RATIO)

  for (const patch of PALETTE_PATCH_CONFIG) {
    const pos = getPatchPosition(patch.corner, patch.offset, canvasSize, patchSize, patchGap)
    const color = PALETTE_RGB[patch.paletteIndex]
    ctx.fillStyle = 'rgb(' + color.join(',') + ')'
    ctx.fillRect(pos.x, pos.y, patchSize, patchSize)

    // Add thin border for visibility
    ctx.strokeStyle = '#333'
    ctx.lineWidth = 1
    ctx.strokeRect(pos.x, pos.y, patchSize, patchSize)
  }
}

// Update drop zone appearance based on state. In Text mode the container is
// no longer a file target — it's just where the QR will appear — so it goes
// inert and says so instead of inviting a drop.
function updateDropZoneState() {
  const container = elements.qrContainer
  const textMode = state.payloadKind === 'text'
  const icon = elements.qrPlaceholder.querySelector('.drop-zone-icon')
  const label = icon?.nextElementSibling

  if (!state.encoder) {
    container.classList.add('empty')
    container.classList.remove('has-file')
    // No icon in Text mode — the sentence alone says what the area is; the
    // big "+" glyph only makes sense as a drop/pick affordance.
    if (icon) {
      icon.textContent = '+'
      icon.style.display = textMode ? 'none' : ''
    }
    if (label) label.textContent = textMode
      ? 'QR code appears here — press "Send text"'
      : 'Drop file here or select one'
    container.setAttribute('aria-label', textMode
      ? 'QR code display area'
      : 'Choose a file to send')
    // Interactive as a picker only in File mode.
    container.setAttribute('tabindex', textMode ? '-1' : '0')
    container.setAttribute('aria-disabled', String(textMode))
  } else {
    container.classList.remove('empty')
    container.classList.add('has-file')
    // The zone stops being interactive once a payload is loaded.
    container.setAttribute('tabindex', '-1')
    container.setAttribute('aria-disabled', 'true')
  }
}

// Update action button label based on state
function updateActionButton() {
  const btn = elements.btnAction
  if (!state.encoder) {
    btn.textContent = 'Start'
    btn.disabled = true
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

  elements.btnStop.disabled = !state.encoder
}

// Render a symbol as QR code on canvas (BW mode)
function renderSymbolBW(symbolId) {
  const dataPreset = DATA_PRESETS[parseInt(elements.dataSlider.value)]
  const sizePreset = SIZE_PRESETS[parseInt(elements.sizeSlider.value)]

  const packet = state.encoder.generateSymbol(symbolId)

  // Raw packet bytes in byte mode, ECC from preset, pinned mask
  const qr = getQRModules(packet, dataPreset.ecc)

  const moduleCount = qr.count
  // Scale to fit within preset size
  const cellSize = Math.floor(sizePreset.size / moduleCount)
  const actualSize = moduleCount * cellSize

  const canvas = elements.qrCanvas
  canvas.width = actualSize
  canvas.height = actualSize
  canvas.style.display = 'block'
  elements.qrPlaceholder.style.display = 'none'

  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, actualSize, actualSize)

  ctx.fillStyle = '#000000'
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (qr.isDark(row, col)) {
        ctx.fillRect(col * cellSize, row * cellSize, cellSize, cellSize)
      }
    }
  }
}


// Render 3 symbols as color QR (PCCC or Palette mode)
function renderSymbolsColor(symbolIds) {
  const dataPreset = DATA_PRESETS[parseInt(elements.dataSlider.value)]
  const sizePreset = SIZE_PRESETS[parseInt(elements.sizeSlider.value)]

  // Size preset is canvas size, QR shrinks to fit margins
  const canvasSize = sizePreset.size
  const marginRatio = MODE_MARGIN_RATIOS[state.mode]
  // Solve: canvasSize = qrSize + 2*margin, margin = qrSize * marginRatio
  // canvasSize = qrSize * (1 + 2*marginRatio)
  const qrSize = Math.round(canvasSize / (1 + 2 * marginRatio))
  const margin = Math.round((canvasSize - qrSize) / 2)

  // Generate packets for all 3 channels — raw bytes, byte mode. Same
  // blockSize + ECC + pinned mask means identical geometry across channels.
  const packets = symbolIds.map(id => state.encoder.generateSymbol(id))
  const qrModules = packets.map(p => getQRModules(p, dataPreset.ecc))
  const moduleCount = qrModules[0].count
  const cellSize = qrSize / moduleCount

  const canvas = elements.qrCanvas
  canvas.width = canvasSize
  canvas.height = canvasSize
  canvas.style.display = 'block'
  elements.qrPlaceholder.style.display = 'none'

  const ctx = canvas.getContext('2d')

  // White background
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvasSize, canvasSize)

  // Draw QR code with color encoding
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      const ch0 = qrModules[0].isDark(row, col) ? 1 : 0
      const ch1 = qrModules[1].isDark(row, col) ? 1 : 0
      const ch2 = qrModules[2].isDark(row, col) ? 1 : 0

      let rgb
      if (isFinderOrTiming(row, col, moduleCount)) {
        // Keep finder patterns black/white for detection
        rgb = ch0 ? [0, 0, 0] : [255, 255, 255]
      } else if (state.mode === QR_MODE.PCCC) {
        // PCCC: CMY encoding (ch0=C, ch1=M, ch2=Y)
        rgb = cmyToRgb(ch0, ch1, ch2)
      } else {
        // Palette: RGB encoding (ch0=R bit, ch1=G bit, ch2=B bit)
        const paletteIndex = ch0 * 4 + ch1 * 2 + ch2
        rgb = PALETTE_RGB[paletteIndex]
      }

      const x = margin + col * cellSize
      const y = margin + row * cellSize

      ctx.fillStyle = 'rgb(' + rgb.join(',') + ')'
      ctx.fillRect(x, y, cellSize + 0.5, cellSize + 0.5)
    }
  }

  // Draw calibration patches for Palette mode
  if (state.mode === QR_MODE.PALETTE) {
    drawCalibrationPatches(ctx, canvasSize, margin)
  }

  // Draw visible border for positioning guide (color modes only)
  // This helps the receiver know to keep the entire frame visible
  const borderWidth = 3
  ctx.strokeStyle = '#00d4ff'  // Cyan border
  ctx.lineWidth = borderWidth
  ctx.strokeRect(borderWidth / 2, borderWidth / 2, canvasSize - borderWidth, canvasSize - borderWidth)
}

// Render symbol(s) based on current mode
function renderSymbol(symbolId) {
  if (state.mode === QR_MODE.BW) {
    renderSymbolBW(symbolId)
  } else {
    // Color modes: symbolId is actually the first of 3 symbol IDs
    // or for metadata, all 3 channels carry the same symbolId (0)
    if (symbolId === 0) {
      renderSymbolsColor([0, 0, 0])
    } else {
      renderSymbolsColor([symbolId, symbolId + 1, symbolId + 2])
    }
  }
}

// Single tick of the sender loop
function senderTick() {
  if (state.isPaused) return

  state.frameCount++

  // Symbols per frame: 1 for BW, 3 for color modes
  const symbolsPerFrame = state.mode === QR_MODE.BW ? 1 : 3

  // Every METADATA_INTERVAL frames, send metadata
  if (state.frameCount % METADATA_INTERVAL === 0) {
    renderSymbol(0)
    elements.statSymbol.textContent = 'metadata'
  } else {
    renderSymbol(state.symbolId)
    if (state.mode === QR_MODE.BW) {
      elements.statSymbol.textContent = '#' + state.symbolId
    } else {
      elements.statSymbol.textContent = '#' + state.symbolId + '-' + (state.symbolId + 2)
    }
    state.symbolId += symbolsPerFrame
    // Loop back after K_prime symbols (includes parity blocks)
    if (state.encoder && state.symbolId > state.encoder.K_prime) {
      state.symbolId = 1
    }
  }
}

// Start sending
function startSending() {
  if (!state.encoder) return

  state.isPaused = false
  state.isSending = true
  void acquireWakeLock()
  updateActionButton()

  // Disable data, size sliders, and mode selector during transmission
  elements.dataSlider.disabled = true
  elements.sizeSlider.disabled = true
  elements.modeButtons.forEach(btn => btn.disabled = true)

  // Initial tick
  senderTick()

  // Start interval using speed preset
  const speedIndex = parseInt(elements.speedSlider.value)
  state.intervalId = setInterval(senderTick, SPEED_PRESETS[speedIndex].interval)
}

// Pause sending
function pauseSending() {
  state.isPaused = true
  releaseWakeLock()
  clearInterval(state.intervalId)
  state.intervalId = null
  updateActionButton()
}

// Resume sending
function resumeSending() {
  state.isPaused = false
  void acquireWakeLock()
  updateActionButton()

  // Resume interval using speed preset
  const speedIndex = parseInt(elements.speedSlider.value)
  state.intervalId = setInterval(senderTick, SPEED_PRESETS[speedIndex].interval)
}

// Stop sending and reset
function stopSending() {
  releaseWakeLock()
  if (state.intervalId) {
    clearInterval(state.intervalId)
    state.intervalId = null
  }
  state.encoder = null
  state.fileBuffer = null
  state.fileName = null
  state.mimeType = null
  state.fileHash = null
  state.originalSize = 0
  state.compressed = false
  state.isPaused = false
  state.isSending = false
  state.symbolId = 1
  state.frameCount = 0

  // Re-enable sliders and mode selector
  elements.dataSlider.disabled = false
  elements.sizeSlider.disabled = false
  elements.modeButtons.forEach(btn => btn.disabled = false)

  elements.qrCanvas.style.display = 'none'
  elements.qrPlaceholder.style.display = 'flex'
  elements.fileInfo.textContent = 'No file'
  elements.statSymbol.textContent = ''
  elements.fileInput.value = ''

  updateDropZoneState()
  updateActionButton()
}

// Handle action button click (Start/Pause/Resume)
function handleActionClick() {
  if (!state.encoder) return

  if (state.isSending && !state.isPaused) {
    pauseSending()
  } else if (state.isPaused) {
    resumeSending()
  } else {
    startSending()
  }
}

// Process a file (from input or drop)
async function processFile(file) {
  if (!file) return

  if (file.size > MAX_FILE_SIZE) {
    showError('File too large for QR transfer (limit ' + (MAX_FILE_SIZE / (1024 * 1024)) + ' MB). Use HDMI-UVC (up to 1 GB) from the home screen.')
    return
  }

  try {
    const buffer = await file.arrayBuffer()
    // Hash the ORIGINAL bytes — the receiver verifies end-to-end after any
    // decompression, so the hash must not describe the wire stream.
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))
    const { bytes: wireBytes, compressed } = await maybeCompress(new Uint8Array(buffer), file.type || '')

    // Store (possibly gzipped) wire data for re-encoding on preset change
    state.fileBuffer = wireBytes.buffer
    state.fileName = file.name
    state.mimeType = file.type || 'application/octet-stream'
    state.fileHash = hash
    state.originalSize = buffer.byteLength
    state.compressed = compressed

    const dataIndex = parseInt(elements.dataSlider.value)
    const blockSize = DATA_PRESETS[dataIndex].blockSize
    state.encoder = createEncoder(state.fileBuffer, file.name, state.mimeType, hash, blockSize, state.mode, {
      compressed,
      originalSize: buffer.byteLength
    })
    state.symbolId = 1
    state.frameCount = 0
    state.isPaused = false
    state.isSending = false

    const K = state.encoder.K
    elements.fileInfo.textContent = file.name + ' (' + formatBytes(file.size) + ', ' + K + ' blocks' + getModeLabel(state.mode) + ')'

    updateDropZoneState()
    updateActionButton()

    // Show first QR (metadata)
    renderSymbol(0)
  } catch (err) {
    console.error('File read error:', err)
    showError('Failed to read file. Please try again.')
  }
}

// Handle file selection
// Handle data preset change
function handleDataPresetChange() {
  // Ultra/Insane are BW-only — clamp the slider back in color modes.
  if (state.mode !== QR_MODE.BW && parseInt(elements.dataSlider.value) > MAX_COLOR_DATA_PRESET) {
    elements.dataSlider.value = MAX_COLOR_DATA_PRESET
    announce('Preset limited to ' + DATA_PRESETS[MAX_COLOR_DATA_PRESET].name + ' in color modes')
  }
  const index = parseInt(elements.dataSlider.value)
  const preset = DATA_PRESETS[index]
  const label = preset.name + ' (' + preset.blockSize + 'B)'
  elements.dataDisplay.textContent = label
  elements.dataSlider.setAttribute('aria-valuetext', label)

  // Re-encode if file is loaded but not sending
  if (state.fileBuffer && !state.isSending) {
    state.encoder = createEncoder(
      state.fileBuffer,
      state.fileName,
      state.mimeType,
      state.fileHash,
      preset.blockSize,
      state.mode,
      { compressed: state.compressed, originalSize: state.originalSize }
    )
    state.symbolId = 1
    state.frameCount = 0
    elements.fileInfo.textContent = state.fileName + ' (' + formatBytes(state.originalSize) + ', ' + state.encoder.K + ' blocks' + getModeLabel(state.mode) + ')'
    renderSymbol(0)
  }
}

// Get mode label for display
function getModeLabel(mode) {
  switch (mode) {
    case QR_MODE.BW: return ''
    case QR_MODE.PCCC: return ' CMY'
    case QR_MODE.PALETTE: return ' RGB'
    default: return ''
  }
}

// Apply mode-specific default settings
function applyModeDefaults(mode, { notify = true } = {}) {
  if (mode === QR_MODE.BW) {
    // BW: use B/W QRs, can handle more data
    elements.dataSlider.value = 3
    elements.sizeSlider.value = 2
    elements.speedSlider.value = 2
  } else {
    // Color modes: least dense, largest, slowest
    elements.dataSlider.value = 0
    elements.sizeSlider.value = 2
    elements.speedSlider.value = 0
  }
  // Update displays
  handleDataPresetChange()
  handleSizePresetChange()
  handleSpeedPresetChange()

  // Changing mode overwrites whatever the user had dialed in; make that
  // visible instead of silent.
  if (notify) {
    const modeNames = ['BW', 'CMY', 'RGB']
    announce('Data, size and speed presets adjusted for ' + modeNames[mode] + ' mode')
    for (const el of [elements.dataDisplay, elements.sizeDisplay, elements.speedDisplay]) {
      flashHighlight(el)
    }
  }
}

// Handle mode change
function handleModeChange(newMode) {
  if (state.isSending) return // Don't change mode while sending

  state.mode = newMode

  // Update button states
  elements.modeButtons.forEach(btn => {
    const isActive = parseInt(btn.dataset.mode) === newMode
    btn.classList.toggle('active', isActive)
    btn.setAttribute('aria-pressed', String(isActive))
  })

  // Apply mode-specific defaults
  applyModeDefaults(newMode)

  // Re-encode if file is loaded
  if (state.fileBuffer) {
    const dataIndex = parseInt(elements.dataSlider.value)
    const blockSize = DATA_PRESETS[dataIndex].blockSize
    state.encoder = createEncoder(
      state.fileBuffer,
      state.fileName,
      state.mimeType,
      state.fileHash,
      blockSize,
      state.mode,
      { compressed: state.compressed, originalSize: state.originalSize }
    )
    state.symbolId = 1
    state.frameCount = 0
    elements.fileInfo.textContent = state.fileName + ' (' + formatBytes(state.originalSize) + ', ' + state.encoder.K + ' blocks' + getModeLabel(state.mode) + ')'
    renderSymbol(0)
  }
}

// Handle size preset change
function handleSizePresetChange() {
  const index = parseInt(elements.sizeSlider.value)
  const preset = SIZE_PRESETS[index]
  const label = preset.name + ' (' + preset.size + 'px)'
  elements.sizeDisplay.textContent = label
  elements.sizeSlider.setAttribute('aria-valuetext', label)

  // Re-render if QR is visible
  if (state.encoder) {
    renderSymbol(state.isSending ? state.symbolId : 0)
  }
}

// Handle speed preset change
function handleSpeedPresetChange() {
  const index = parseInt(elements.speedSlider.value)
  const preset = SPEED_PRESETS[index]
  const label = preset.name + ' (' + preset.interval + 'ms)'
  elements.speedDisplay.textContent = label
  elements.speedSlider.setAttribute('aria-valuetext', label)

  // Update interval if currently sending
  if (state.intervalId && !state.isPaused) {
    clearInterval(state.intervalId)
    state.intervalId = setInterval(senderTick, preset.interval)
  }
}

// Error display (will be connected to global error banner)
let showError = (msg) => console.error(msg)

// Reset sender state
export function resetSender() {
  stopSending()
}

// True while a transfer is running (or paused mid-transfer); used by the
// beforeunload guard.
export function isSenderBusy() {
  return state.isSending
}

// Initialize sender module
export function initSender(errorHandler) {
  showError = errorHandler

  elements = {
    fileInput: document.getElementById('file-input'),
    fileInfo: document.getElementById('file-info'),
    qrContainer: document.getElementById('qr-container'),
    qrPlaceholder: document.getElementById('qr-placeholder'),
    qrCanvas: document.getElementById('qr-canvas'),
    dataSlider: document.getElementById('data-slider'),
    dataDisplay: document.getElementById('data-display'),
    sizeSlider: document.getElementById('size-slider'),
    sizeDisplay: document.getElementById('size-display'),
    speedSlider: document.getElementById('speed-slider'),
    speedDisplay: document.getElementById('speed-display'),
    btnAction: document.getElementById('btn-action-send'),
    btnStop: document.getElementById('btn-stop-send'),
    statSymbol: document.getElementById('stat-symbol'),
    modeSelector: document.getElementById('qr-mode-selector'),
    modeButtons: document.querySelectorAll('#qr-mode-selector .mode-btn'),
    btnPayloadFile: document.getElementById('btn-payload-file'),
    btnPayloadText: document.getElementById('btn-payload-text'),
    snippetPane: document.getElementById('snippet-pane'),
    snippetText: document.getElementById('snippet-text'),
    btnSendSnippet: document.getElementById('btn-send-snippet')
  }

  // Set initial state
  updateDropZoneState()
  updateActionButton()

  // Apply mode-specific defaults for initial mode (BW); nothing user-chosen
  // is being overwritten yet, so skip the adjustment notice.
  applyModeDefaults(state.mode, { notify: false })

  // Payload-type toggle: Text swaps the drop-zone flow for a paste box. The
  // snippet still travels the file pipeline (hash/gzip/fountain) — it's a
  // synthetic File with a private MIME type the receiver shows inline.
  // Switching kinds kills any payload in flight: a file QR pulsing away under
  // a text pane (or vice versa) reads as "still sending the old thing".
  const setPayloadKind = (kind) => {
    if (kind === state.payloadKind) return
    state.payloadKind = kind
    if (state.encoder) stopSending()
    const isText = kind === 'text'
    elements.btnPayloadFile.classList.toggle('active', !isText)
    elements.btnPayloadFile.setAttribute('aria-pressed', String(!isText))
    elements.btnPayloadText.classList.toggle('active', isText)
    elements.btnPayloadText.setAttribute('aria-pressed', String(isText))
    elements.snippetPane.classList.toggle('hidden', !isText)
    updateDropZoneState()
    updateActionButton()
  }
  elements.btnPayloadFile.onclick = () => setPayloadKind('file')
  elements.btnPayloadText.onclick = () => setPayloadKind('text')
  elements.btnSendSnippet.onclick = () => {
    try {
      const { bytes, filename, mimeType } = packSnippet(elements.snippetText.value)
      processFile(new File([bytes], filename, { type: mimeType }))
    } catch (err) {
      showError(err.message)
    }
  }

  // Bind event handlers
  elements.dataSlider.oninput = handleDataPresetChange
  elements.sizeSlider.oninput = handleSizePresetChange
  elements.speedSlider.oninput = handleSpeedPresetChange
  elements.btnAction.onclick = handleActionClick
  elements.btnStop.onclick = stopSending

  // Mode selector handlers
  elements.modeButtons.forEach(btn => {
    btn.onclick = () => handleModeChange(parseInt(btn.dataset.mode))
  })

  // Drop zone + file input handlers
  wireDropZone({
    container: elements.qrContainer,
    fileInput: elements.fileInput,
    // In Text mode the container is a display area, not a file target —
    // clicks, Enter/Space, and drops are all inert.
    hasFile: () => !!state.encoder || state.payloadKind === 'text',
    onFile: processFile
  })
}
