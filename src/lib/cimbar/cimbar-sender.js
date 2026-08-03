// CIMBAR Sender module - handles file encoding and CIMBAR display
import { loadCimbarWasm, getModule } from './cimbar-loader.js'
import { formatBytes, formatTime } from '../format.js'
import { wireDropZone } from '../shared/dropzone.js'
import { acquireWakeLock, releaseWakeLock } from '../shared/wake-lock.js'

const MAX_FILE_SIZE = 33 * 1024 * 1024 // 33MB (CIMBAR limit)

const SIZE_PRESETS = [
  { name: 'Small', size: 480 },
  { name: 'Medium', size: 600 },
  { name: 'Large', size: 720 },
  { name: 'Full', size: 1024 }
]

const SPEED_PRESETS = [
  { name: 'Slow', fps: 10, interval: 100 },
  { name: 'Normal', fps: 15, interval: 66 },
  { name: 'Fast', fps: 20, interval: 50 }
]

// Sender state
const state = {
  fileData: null,
  fileName: null,
  fileSize: 0,
  timerId: null,
  isSending: false,
  isPaused: false,
  frameCount: 0,
  wasmLoaded: false,
  idealRatio: 1
}

let elements = null
let showError = (msg) => console.error(msg)

function getTargetInterval() {
  const index = parseInt(elements.speedSlider.value)
  return SPEED_PRESETS[index].interval
}

function getTargetSize() {
  const index = parseInt(elements.sizeSlider.value)
  return SIZE_PRESETS[index].size
}

function estimateTime() {
  if (!state.fileSize) return ''
  const bytesPerFrame = 7500
  const fps = SPEED_PRESETS[parseInt(elements.speedSlider.value)].fps
  const totalFrames = Math.ceil(state.fileSize / bytesPerFrame)
  const seconds = totalFrames / fps
  return '~' + formatTime(Math.ceil(seconds) * 1000)
}

function updateDropZoneState() {
  const container = elements.container
  if (!state.fileData) {
    container.classList.add('empty')
    container.classList.remove('has-file')
    container.setAttribute('tabindex', '0')
    container.setAttribute('aria-disabled', 'false')
  } else {
    container.classList.remove('empty')
    container.classList.add('has-file')
    // The zone stops being interactive once a file is loaded.
    container.setAttribute('tabindex', '-1')
    container.setAttribute('aria-disabled', 'true')
  }
}

function updateActionButton() {
  const btn = elements.btnAction
  if (!state.fileData || !state.wasmLoaded) {
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
  elements.btnStop.disabled = !state.fileData
}

// Scale canvas using CSS (WASM renders at fixed internal size via WebGL)
// Matches cimbar.org scaleCanvas logic
function scaleCanvas() {
  const canvas = elements.canvas
  const size = getTargetSize()

  // Target dimensions (square container)
  let width = size
  let height = size

  // Calculate our target ratio
  const ourRatio = width / height

  // Adjust dimensions to maintain CIMBAR aspect ratio
  let xdim = width
  let ydim = height
  if (ourRatio > state.idealRatio) {
    // Target is wider than ideal - shrink width
    xdim = Math.floor(xdim * state.idealRatio / ourRatio)
  } else if (ourRatio < state.idealRatio) {
    // Target is taller than ideal - shrink height
    ydim = Math.floor(ydim * ourRatio / state.idealRatio)
  }

  // Apply as CSS dimensions only (WASM manages internal canvas size)
  canvas.style.width = xdim + 'px'
  canvas.style.height = ydim + 'px'
}

function renderFrame() {
  if (!state.isSending || state.isPaused) return

  const Module = getModule()
  if (!Module) return

  Module._cimbare_render()
  Module._cimbare_next_frame(false) // false = no color balance

  state.frameCount++

  // Schedule next frame
  state.timerId = setTimeout(renderFrame, getTargetInterval())
}

// Copy data to WASM heap
function copyToWasmHeap(Module, data) {
  const ptr = Module._malloc(data.length)
  const wasmData = new Uint8Array(Module.HEAPU8.buffer, ptr, data.length)
  wasmData.set(data)
  return { ptr, view: wasmData }
}

async function startSending() {
  if (!state.fileData) return

  const Module = getModule()
  if (!Module) {
    showError('CIMBAR not loaded')
    return
  }

  try {
    const canvas = elements.canvas

    // Set canvas on Module for WASM rendering (must be done before configure)
    Module.canvas = canvas

    // Configure mode (68 = mode B, -1 = use defaults)
    Module._cimbare_configure(68, -1)
    state.idealRatio = Module._cimbare_get_aspect_ratio()

    // Show canvas
    canvas.style.display = 'block'
    elements.placeholder.style.display = 'none'

    // Scale canvas via CSS (WASM manages internal dimensions via WebGL)
    scaleCanvas()

    // Initialize encoder with filename
    const fnBytes = new TextEncoder().encode(state.fileName)
    const fnAlloc = copyToWasmHeap(Module, fnBytes)
    Module._cimbare_init_encode(fnAlloc.ptr, fnBytes.length, -1)
    Module._free(fnAlloc.ptr)

    // Encode file data in chunks
    const chunkSize = Module._cimbare_encode_bufsize()
    const fileBytes = new Uint8Array(state.fileData)

    for (let offset = 0; offset < fileBytes.length; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, fileBytes.length)
      const chunk = fileBytes.subarray(offset, end)
      const chunkAlloc = copyToWasmHeap(Module, chunk)
      Module._cimbare_encode(chunkAlloc.ptr, chunk.length)
      Module._free(chunkAlloc.ptr)
    }

    // Final flush with empty buffer
    const emptyAlloc = copyToWasmHeap(Module, new Uint8Array(0))
    Module._cimbare_encode(emptyAlloc.ptr, 0)
    Module._free(emptyAlloc.ptr)

    state.isSending = true
    state.isPaused = false
    void acquireWakeLock()
    state.frameCount = 0

    elements.sizeSlider.disabled = true
    elements.speedSlider.disabled = true

    updateActionButton()
    renderFrame()

  } catch (err) {
    console.error('CIMBAR start error:', err)
    showError('Failed to start: ' + err.message)
  }
}

function pauseSending() {
  state.isPaused = true
  releaseWakeLock()
  if (state.timerId) {
    clearTimeout(state.timerId)
    state.timerId = null
  }
  updateActionButton()
}

function resumeSending() {
  state.isPaused = false
  void acquireWakeLock()
  updateActionButton()
  renderFrame()
}

function stopSending() {
  releaseWakeLock()
  if (state.timerId) {
    clearTimeout(state.timerId)
    state.timerId = null
  }

  state.fileData = null
  state.fileName = null
  state.fileSize = 0
  state.isSending = false
  state.isPaused = false
  state.frameCount = 0

  elements.sizeSlider.disabled = false
  elements.speedSlider.disabled = false

  elements.canvas.style.display = 'none'
  elements.placeholder.style.display = 'flex'
  elements.placeholderIcon.textContent = '+'
  elements.placeholderText.textContent = 'Drop file here or select one'
  elements.fileInfo.textContent = 'No file'
  elements.estimate.textContent = ''
  elements.fileInput.value = ''

  updateDropZoneState()
  updateActionButton()
}

function handleActionClick() {
  if (!state.fileData) return

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

  if (file.size > MAX_FILE_SIZE) {
    showError('File too large for CIMBAR transfer (limit 33 MB). Use HDMI-UVC (up to 1 GB) from the home screen.')
    return
  }

  try {
    // Show loading if WASM not ready
    if (!state.wasmLoaded) {
      elements.loading.classList.remove('hidden')
      await loadCimbarWasm()
      state.wasmLoaded = true
      elements.loading.classList.add('hidden')
    }

    const buffer = await file.arrayBuffer()

    state.fileData = buffer
    state.fileName = file.name
    state.fileSize = file.size
    state.isSending = false
    state.isPaused = false

    elements.fileInfo.textContent = file.name + ' (' + formatBytes(file.size) + ')'
    elements.estimate.textContent = estimateTime()

    // Update placeholder to show file is ready
    elements.placeholderIcon.textContent = '✓'
    elements.placeholderText.textContent = 'File ready — press Start'

    updateDropZoneState()
    updateActionButton()

  } catch (err) {
    console.error('File read error:', err)
    elements.loading.classList.add('hidden')
    showError('Failed to read file: ' + err.message)
  }
}


function handleSizeChange() {
  const index = parseInt(elements.sizeSlider.value)
  const preset = SIZE_PRESETS[index]
  const label = preset.name + ' (' + preset.size + 'px)'
  elements.sizeDisplay.textContent = label
  elements.sizeSlider.setAttribute('aria-valuetext', label)

  // If sending, update canvas size
  if (state.isSending) {
    scaleCanvas()
  }
}

function handleSpeedChange() {
  const index = parseInt(elements.speedSlider.value)
  const preset = SPEED_PRESETS[index]
  const label = preset.name + ' (' + preset.fps + ' FPS)'
  elements.speedDisplay.textContent = label
  elements.speedSlider.setAttribute('aria-valuetext', label)
  elements.estimate.textContent = estimateTime()
}

export function resetCimbarSender() {
  stopSending()
}

// True while a transfer is running (or paused mid-transfer); used by the
// beforeunload guard.
export function isSenderBusy() {
  return state.isSending
}

export function initCimbarSender(errorHandler) {
  showError = errorHandler

  elements = {
    fileInput: document.getElementById('cimbar-file-input'),
    container: document.getElementById('cimbar-container'),
    placeholder: document.getElementById('cimbar-placeholder'),
    placeholderIcon: document.getElementById('cimbar-placeholder-icon'),
    placeholderText: document.getElementById('cimbar-placeholder-text'),
    canvas: document.getElementById('cimbar-canvas'),
    loading: document.getElementById('cimbar-loading'),
    sizeSlider: document.getElementById('cimbar-size-slider'),
    sizeDisplay: document.getElementById('cimbar-size-display'),
    speedSlider: document.getElementById('cimbar-speed-slider'),
    speedDisplay: document.getElementById('cimbar-speed-display'),
    fileInfo: document.getElementById('cimbar-file-info'),
    estimate: document.getElementById('cimbar-estimate'),
    btnAction: document.getElementById('btn-cimbar-action'),
    btnStop: document.getElementById('btn-cimbar-stop')
  }

  updateDropZoneState()
  updateActionButton()
  handleSizeChange()
  handleSpeedChange()

  elements.sizeSlider.oninput = handleSizeChange
  elements.speedSlider.oninput = handleSpeedChange
  elements.btnAction.onclick = handleActionClick
  elements.btnStop.onclick = stopSending

  wireDropZone({
    container: elements.container,
    fileInput: elements.fileInput,
    hasFile: () => !!state.fileData,
    onFile: processFile
  })
}
