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

// Detects a silently-jammed pool: every slot busy with no replies for
// `timeoutMs`. A healthy worker answers a frame in tens of milliseconds, so a
// pool that stays saturated for seconds is dead (e.g. its workers' module
// fetch failed) — callers should tear it down and fall back. Returns a
// `(busyCount, size, nowMs) => boolean` to call once per submitted frame.
export function createJamDetector(timeoutMs) {
  let allBusySince = null
  return (busyCount, size, nowMs) => {
    if (size === 0 || busyCount < size) {
      allBusySince = null
      return false
    }
    if (allBusySince === null) {
      allBusySince = nowMs
      return false
    }
    return nowMs - allBusySince >= timeoutMs
  }
}

export class DecodeWorkerPool {
  constructor(createWorker, onDecoded, onWorkerFailure = null) {
    this.createWorker = createWorker
    this.onDecoded = onDecoded
    this.onWorkerFailure = onWorkerFailure
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
      // A worker whose script fails to load (or that dies mid-decode) never
      // posts a reply — without these handlers its slot would stay busy
      // forever and the pool would silently starve.
      const fail = () => {
        this.busy[slot] = false
        if (this.onWorkerFailure) this.onWorkerFailure(slot)
      }
      worker.onerror = fail
      worker.onmessageerror = fail
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
