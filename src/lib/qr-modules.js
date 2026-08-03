// Build QR module matrices straight from packet bytes: real byte-mode
// segments (no base64 — 25% more payload per frame) with a pinned mask
// pattern (see QR_MASK_PATTERN). Shared by the BW and color-channel QR
// renderers in sender.js; kept DOM-free so the wire format is testable
// against a real decoder in Node (qr-modules.tests.js).

import QRCode from 'qrcode'
import { QR_MASK_PATTERN } from './constants.js'

export function getQRModules(packetBytes, eccLevel) {
  const qr = QRCode.create([{ data: packetBytes, mode: 'byte' }], {
    errorCorrectionLevel: eccLevel,
    maskPattern: QR_MASK_PATTERN
  })
  const count = qr.modules.size
  const data = qr.modules.data // row-major, truthy = dark
  return { count, isDark: (row, col) => !!data[row * count + col] }
}
