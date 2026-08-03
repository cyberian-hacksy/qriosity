// Fixed-slot pool of decode workers (adapted from decimen-optical-transfer).
//
// The subtle part is slot identity: every worker's message handler closes
// over its own index, so growing and shrinking the pool has to leave the
// surviving workers' indices alone. Shrinking from the end is what makes
// that true.
//
// Each worker holds its own WASM instance (~941 KB for zxing), so the pool
// is also how a receiver reclaims that memory the moment the transfer ends:
// resize(0).

export class DecodeWorkerPool {
  constructor(createWorker, onDecoded) {
    this.createWorker = createWorker
    this.onDecoded = onDecoded
    this.workers = []
    this.busy = []
  }

  get size() {
    return this.workers.length
  }

  get busyCount() {
    return this.busy.filter(Boolean).length
  }

  // Grow or shrink in place. Terminating a busy worker just drops the frame
  // it held, which the fountain absorbs like any other miss.
  resize(count) {
    while (this.workers.length > Math.max(0, count)) {
      this.workers.pop().terminate()
      this.busy.pop()
    }
    while (this.workers.length < count) {
      const slot = this.workers.length
      const worker = this.createWorker()
      worker.onmessage = (event) => {
        const { id, bytes } = event.data
        if (id === -1) return // warm-up ping, no frame attached
        this.busy[slot] = false
        // Full message as second arg so callers can read side-channel fields
        // (e.g. the QR position for the detection overlay).
        if (bytes) this.onDecoded(bytes, event.data)
      }
      this.workers.push(worker)
      this.busy.push(false)
    }
  }

  // Hand a frame to a free worker. False when every worker is busy — the
  // caller drops the frame rather than queueing it, because a stale frame is
  // worth less than the next one.
  submit(message, transfer) {
    const slot = this.busy.indexOf(false)
    if (slot === -1) return false
    this.busy[slot] = true
    this.workers[slot].postMessage(message, transfer)
    return true
  }
}
