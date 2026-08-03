// Reduce a received name to a bare basename. The name arrived over the
// optical channel and is whatever the other screen chose to send; the
// `download` attribute is the only consumer and browsers sanitise it too,
// but the receiver has no reason to take the sender's word for it.
export function safeFileName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? ''
  // Strip control characters (NUL and newlines in particular) and the
  // relative-path names that survive a basename split.
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'transfer.bin' : cleaned
}

// Trigger a browser download for an in-memory Blob via a temporary anchor.
// Shared by the QR, CIMBAR, and HDMI-UVC receivers, which each build the Blob
// their own way — sanitising here covers every mode at one choke point.
// Appends to the body (some browsers ignore clicks on detached anchors) and
// revokes the object URL on a delay (immediate revoke can abort the download
// in Safari).
export function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = safeFileName(filename)
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
