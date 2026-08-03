// QR decode worker: zxing-cpp compiled to WASM. Dense frames (QR v27-v40)
// are beyond what jsQR sustains at frame rate, and Safari has never shipped
// BarcodeDetector, so WASM in a worker is the portable fast path. One frame
// in flight per worker; the main thread drops frames when every worker is
// busy — the fountain doesn't care.
//
// Vite ?worker&inline gives this worker a blob:/data: self.location that the
// URL spec rejects as a base, so the main thread computes the .wasm URL from
// document.baseURI and posts it in the init message (same pattern as the
// HDMI-UVC workers).

import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader'

let ready = false

self.onmessage = async (event) => {
  const msg = event.data
  if (msg.type === 'init') {
    prepareZXingModule({
      overrides: {
        locateFile: (path, prefix) => (path.endsWith('.wasm') ? msg.wasmUrl : prefix + path)
      }
    })
    // Warm the WASM so the first real frame doesn't pay instantiation. A
    // failed load leaves `ready` false and every frame answers null, which
    // the receiver treats as "pool unavailable" and falls back to jsQR.
    try {
      await readBarcodes(new ImageData(8, 8), { formats: ['QRCode'] })
      ready = true
    } catch (err) {
      console.error('zxing wasm load failed:', err)
    }
    self.postMessage({ id: -1, bytes: null, ready })
    return
  }

  if (!ready) {
    self.postMessage({ id: msg.id, bytes: null })
    return
  }
  try {
    const img = new ImageData(new Uint8ClampedArray(msg.buf), msg.w, msg.h)
    const results = await readBarcodes(img, { formats: ['QRCode'], maxNumberOfSymbols: 1 })
    const r = results.find((x) => x.isValid && x.bytes.length > 0)
    // position rides along for the receiver's detection overlay
    self.postMessage({ id: msg.id, bytes: r ? r.bytes : null, position: r ? r.position : null })
  } catch {
    self.postMessage({ id: msg.id, bytes: null })
  }
}
