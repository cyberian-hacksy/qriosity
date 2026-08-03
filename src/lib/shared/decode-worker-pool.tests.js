// Tests for the fixed-slot decode worker pool, driven by fake workers so the
// slot-identity rules are checkable without real Workers or WASM.

import { DecodeWorkerPool, createJamDetector } from './decode-worker-pool.js'

function makeFakeWorkerFactory() {
  const workers = []
  return {
    workers,
    create() {
      const worker = {
        onmessage: null,
        posted: [],
        terminated: false,
        postMessage(message) { this.posted.push(message) },
        terminate() { this.terminated = true },
        // test helper: simulate the worker replying
        reply(payload) { this.onmessage({ data: payload }) }
      }
      workers.push(worker)
      return worker
    }
  }
}

export function testDecodeWorkerPoolSubmitAndDrain() {
  const factory = makeFakeWorkerFactory()
  const decoded = []
  const pool = new DecodeWorkerPool(factory.create, (bytes) => decoded.push(bytes))
  pool.resize(2)

  const twoWorkers = pool.size === 2 && factory.workers.length === 2

  // Two submits fill both slots; the third is refused (caller drops the frame).
  const s1 = pool.submit({ id: 1 }, [])
  const s2 = pool.submit({ id: 2 }, [])
  const s3 = pool.submit({ id: 3 }, [])
  const saturation = s1 === true && s2 === true && s3 === false && pool.busyCount === 2

  // A decode reply frees the slot and forwards the bytes.
  factory.workers[0].reply({ id: 1, bytes: new Uint8Array([7, 7]) })
  const drained = pool.busyCount === 1 && decoded.length === 1 && decoded[0].length === 2

  // A null-bytes reply (no QR in frame) frees the slot without forwarding.
  factory.workers[1].reply({ id: 2, bytes: null })
  const nullFreed = pool.busyCount === 0 && decoded.length === 1

  // Warm-up pings (id -1) neither free slots nor forward bytes.
  pool.submit({ id: 4 }, [])
  factory.workers[0].reply({ id: -1, bytes: null })
  const warmupIgnored = pool.busyCount === 1

  const pass = twoWorkers && saturation && drained && nullFreed && warmupIgnored
  console.log('Decode worker pool submit/drain test:', pass ? 'PASS' : 'FAIL',
    { twoWorkers, saturation, drained, nullFreed, warmupIgnored })
  return pass
}

export function testDecodeWorkerPoolWorkerFailure() {
  const factory = makeFakeWorkerFactory()
  const failures = []
  const pool = new DecodeWorkerPool(factory.create, () => {}, (slot) => failures.push(slot))
  pool.resize(2)

  // The pool must install error handlers on every worker it creates — a
  // worker whose module fetch 504s dies without ever posting a message.
  const handlersInstalled = typeof factory.workers[0].onerror === 'function' &&
    typeof factory.workers[0].onmessageerror === 'function'

  // A dying worker frees its slot and reports the failure; otherwise the
  // slot stays busy forever and the pool silently goes blind.
  pool.submit({ id: 1 }, [])
  pool.submit({ id: 2 }, [])
  factory.workers[0].onerror?.({ message: 'boom' })
  const slotFreed = pool.busyCount === 1 && failures.length === 1 && failures[0] === 0

  // messageerror (undeliverable reply) gets the same treatment.
  factory.workers[1].onmessageerror?.({})
  const msgErrFreed = pool.busyCount === 0 && failures.length === 2 && failures[1] === 1

  // A pool constructed without a failure callback must not throw on error.
  const pool2 = new DecodeWorkerPool(factory.create, () => {})
  pool2.resize(1)
  pool2.submit({ id: 3 }, [])
  let noCallbackSafe = true
  try { factory.workers[2].onerror?.({ message: 'boom' }) } catch { noCallbackSafe = false }
  noCallbackSafe = noCallbackSafe && pool2.busyCount === 0

  const pass = handlersInstalled && slotFreed && msgErrFreed && noCallbackSafe
  console.log('Decode worker pool worker-failure test:', pass ? 'PASS' : 'FAIL',
    { handlersInstalled, slotFreed, msgErrFreed, noCallbackSafe })
  return pass
}

export function testDecodeWorkerPoolJamDetector() {
  const jammed = createJamDetector(4000)

  // Healthy pool: replies keep busyCount below size — never a jam.
  const healthy = jammed(2, 3, 0) === false && jammed(2, 3, 10_000) === false

  // Going all-busy arms the clock; before the timeout it's not a jam yet.
  const armed = jammed(3, 3, 20_000) === false && jammed(3, 3, 23_999) === false

  // Still all-busy once the timeout elapses → jam.
  const trips = jammed(3, 3, 24_000) === true

  // Any free slot (a worker replied) disarms the clock entirely.
  const resets = jammed(2, 3, 30_000) === false &&
    jammed(3, 3, 31_000) === false && jammed(3, 3, 34_999) === false &&
    jammed(3, 3, 35_000) === true

  // An empty pool cannot jam.
  const emptySafe = createJamDetector(1000)(0, 0, 99_999) === false

  const pass = healthy && armed && trips && resets && emptySafe
  console.log('Decode worker pool jam detector test:', pass ? 'PASS' : 'FAIL',
    { healthy, armed, trips, resets, emptySafe })
  return pass
}

export function testDecodeWorkerPoolResize() {
  const factory = makeFakeWorkerFactory()
  const decoded = []
  const pool = new DecodeWorkerPool(factory.create, (bytes) => decoded.push(bytes))
  pool.resize(3)

  // Occupy slot 0 so its identity is observable after the shrink.
  pool.submit({ id: 1 }, [])

  // Shrink from the end: workers 2 and 1 die, worker 0 (busy) survives with
  // its slot index intact.
  pool.resize(1)
  const shrankFromEnd = pool.size === 1 &&
    factory.workers[2].terminated && factory.workers[1].terminated &&
    !factory.workers[0].terminated

  // The surviving slot still resolves correctly.
  factory.workers[0].reply({ id: 1, bytes: new Uint8Array([1]) })
  const survivorWorks = pool.busyCount === 0 && decoded.length === 1

  // Grow again: new worker takes slot 1, both submit paths work.
  pool.resize(2)
  const s1 = pool.submit({ id: 2 }, [])
  const s2 = pool.submit({ id: 3 }, [])
  const regrown = pool.size === 2 && s1 && s2 && pool.busyCount === 2

  // resize(0) terminates everything (how receivers reclaim WASM memory).
  pool.resize(0)
  const allDead = pool.size === 0 && factory.workers.every(w => w.terminated || w === factory.workers[0]) &&
    factory.workers[0].terminated

  const pass = shrankFromEnd && survivorWorks && regrown && allDead
  console.log('Decode worker pool resize test:', pass ? 'PASS' : 'FAIL',
    { shrankFromEnd, survivorWorks, regrown, allDead })
  return pass
}
