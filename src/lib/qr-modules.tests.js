// Wire-format test for the binary QR module builder: packet bytes go into a
// byte-mode QR and must come back out of a real decoder bit-identical. This
// is the test that guards the base64 → raw-binary flip — jsQR is the same
// decoder the receiver's fallback path uses, so a pass here means the two
// ends agree on the wire format.

import jsQR from 'jsqr'
import { getQRModules } from './qr-modules.js'
import { createPacket } from './packet.js'

// Paint the module matrix into an RGBA buffer jsQR can scan: `scale` px per
// module plus a 4-module quiet zone, white background, black modules.
function rasterize(qr, scale, margin) {
  const size = (qr.count + 2 * margin) * scale
  const rgba = new Uint8ClampedArray(size * size * 4)
  rgba.fill(255)
  for (let row = 0; row < qr.count; row++) {
    for (let col = 0; col < qr.count; col++) {
      if (!qr.isDark(row, col)) continue
      for (let dy = 0; dy < scale; dy++) {
        const y = (margin + row) * scale + dy
        for (let dx = 0; dx < scale; dx++) {
          const x = (margin + col) * scale + dx
          const at = (y * size + x) * 4
          rgba[at] = 0
          rgba[at + 1] = 0
          rgba[at + 2] = 0
        }
      }
    }
  }
  return { rgba, size }
}

export function testQrModulesBinaryRoundtrip() {
  // A realistic packet: full 15-byte header + payload covering all byte
  // values, including the ones base64/UTF-8 handling used to mangle.
  const payload = new Uint8Array(200)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 37 + 251) & 0xff
  const packet = createPacket(0xDEADBEEF, 1000, 77, payload, false, payload.length)

  const qr = getQRModules(packet, 'L')
  const { rgba, size } = rasterize(qr, 4, 4)
  const decoded = jsQR(rgba, size, size)

  if (!decoded) {
    console.log('QR modules binary roundtrip test: FAIL - jsQR found no code')
    return false
  }

  const bytes = Uint8Array.from(decoded.binaryData)
  let match = bytes.length === packet.length
  if (match) {
    for (let i = 0; i < packet.length; i++) {
      if (bytes[i] !== packet[i]) { match = false; break }
    }
  }

  const pass = match
  console.log('QR modules binary roundtrip test:', pass ? 'PASS' : 'FAIL', {
    packetLen: packet.length,
    decodedLen: bytes.length,
    moduleCount: qr.count
  })
  return pass
}

// Identical blockSize + ECC must yield identical geometry across the three
// color-channel QRs — the color renderer overlays them module-for-module.
export function testQrModulesStableGeometry() {
  const mk = (seed) => {
    const payload = new Uint8Array(150)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * seed + 7) & 0xff
    return createPacket(0x12345678, 500, seed, payload, false, payload.length)
  }
  const a = getQRModules(mk(1), 'L')
  const b = getQRModules(mk(2), 'L')
  const c = getQRModules(mk(3), 'L')

  const pass = a.count === b.count && b.count === c.count
  console.log('QR modules stable geometry test:', pass ? 'PASS' : 'FAIL',
    { a: a.count, b: b.count, c: c.count })
  return pass
}
