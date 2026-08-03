// Protocol and configuration constants
export const PROTOCOL_VERSION = 0x01

// Pinned QR mask pattern. Any declared mask is valid to a decoder; skipping
// the spec's 8-way mask evaluation makes v40 generation ~36x faster
// (0.7ms vs 25.6ms measured), which is what allows 30fps at max density.
export const QR_MASK_PATTERN = 4

// QR Mode constants
export const QR_MODE = {
  BW: 0,       // Standard black/white QR
  PCCC: 1,     // Color CMY with finder calibration
  PALETTE: 2   // Color RGB with HCC2D patch calibration
}

// Mode-specific margins as ratio of QR size
export const MODE_MARGIN_RATIOS = {
  [QR_MODE.BW]: 0.0125,      // ~1.25% quiet zone for BW (4px for 320px QR)
  [QR_MODE.PCCC]: 0.03,      // ~3% margin for CMY (10px for 320px QR)
  [QR_MODE.PALETTE]: 0.1875  // ~19% margin for patches (60px for 320px QR)
}

// Palette mode patch configuration as ratios of margin
// For 60px margin: patch=25px (42%), gap=5px (8%)
export const PATCH_SIZE_RATIO = 0.42   // Patch size as ratio of margin
export const PATCH_GAP_RATIO = 0.08    // Gap as ratio of margin
export const BLOCK_SIZE = 200
// QR-mode limit. Was 20MB when the mode peaked at ~8 KB/s; binary v40 frames
// plus adaptive gzip make 64MB (decimen parity) practical. Wire format is
// nowhere near its ceilings at this size (K' is 24-bit, sizes are uint32).
export const MAX_FILE_SIZE = 64 * 1024 * 1024 // 64MB
export const METADATA_INTERVAL = 10
export const FOUNTAIN_DEGREE = 3
export const DEGREE_ONE_PROBABILITY = 0.15

// Raptor-Lite pre-coding constants
export const PARITY_LAYERS = 3 // Number of parity layers (consecutive, offset, strided)

// Data density presets (block size + ECC level). Ultra/Insane are BW-only
// (the color renderer's finder/alignment handling and 3-channel decode don't
// scale to v27/v40) and need the zxing receiver path to decode at rate.
// Insane: 2938 + 15-byte header = 2953 = exactly QR v40-L byte capacity.
export const DATA_PRESETS = [
  { name: 'Light', blockSize: 150, ecc: 'M' },
  { name: 'Normal', blockSize: 200, ecc: 'M' },
  { name: 'Dense', blockSize: 300, ecc: 'L' },
  { name: 'Max', blockSize: 400, ecc: 'L' },
  { name: 'Ultra', blockSize: 1450, ecc: 'L' },
  { name: 'Insane', blockSize: 2938, ecc: 'L' }
]
export const DEFAULT_DATA_PRESET = 1
// Highest data preset the color modes can render/decode (index into DATA_PRESETS)
export const MAX_COLOR_DATA_PRESET = 3

// Display size presets (QR container size in pixels). XL exists for the
// Ultra/Insane presets: v40 is 177 modules, and 680px still gives 3px cells.
export const SIZE_PRESETS = [
  { name: 'Small', size: 320 },
  { name: 'Medium', size: 420 },
  { name: 'Large', size: 520 },
  { name: 'XL', size: 680 }
]
export const DEFAULT_SIZE_PRESET = 2

// Speed presets (frame interval in ms). Turbo ≈ 30fps: on a 60Hz panel each
// frame still owns two refresh cycles, so captures don't straddle transitions.
// Ludicrous ≈ 60fps is for 120Hz sender screens only — on a 60Hz panel the
// camera catches half-drawn frames and throughput goes DOWN, not up.
export const SPEED_PRESETS = [
  { name: 'Slow', interval: 200 },
  { name: 'Normal', interval: 100 },
  { name: 'Fast', interval: 50 },
  { name: 'Turbo', interval: 33 },
  { name: 'Ludicrous', interval: 16 }
]
export const DEFAULT_SPEED_PRESET = 1
