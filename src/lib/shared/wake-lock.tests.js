// Tests for the shared screen wake-lock helper. The Wake Lock API is absent
// in the Node test environment (and may be absent or denied in browsers), so
// these exercise the logical held-state machine, which is exactly the part
// the six mode lifecycles depend on: transfers must be able to acquire and
// release unconditionally, with both calls idempotent, whether or not a real
// sentinel exists underneath.

import { acquireWakeLock, releaseWakeLock, _internals } from './wake-lock.js'

export async function testWakeLockStateMachine() {
  releaseWakeLock() // known baseline

  const initiallyIdle = _internals.isHeld() === false

  await acquireWakeLock()
  const heldAfterAcquire = _internals.isHeld() === true

  await acquireWakeLock() // idempotent re-acquire
  const stillHeld = _internals.isHeld() === true

  releaseWakeLock()
  const idleAfterRelease = _internals.isHeld() === false && _internals.hasSentinel() === false

  releaseWakeLock() // idempotent re-release
  const stillIdle = _internals.isHeld() === false

  const pass = initiallyIdle && heldAfterAcquire && stillHeld && idleAfterRelease && stillIdle
  console.log('Wake lock state machine test:', pass ? 'PASS' : 'FAIL',
    { initiallyIdle, heldAfterAcquire, stillHeld, idleAfterRelease, stillIdle })
  return pass
}

export async function testWakeLockSurvivesMissingApi() {
  // In this environment navigator.wakeLock is undefined (Node) or may reject
  // (browser without permission). Acquire must resolve without throwing and
  // still mark the logical hold so a later visibility change can retry.
  let threw = false
  try {
    await acquireWakeLock()
  } catch {
    threw = true
  }
  const held = _internals.isHeld() === true
  releaseWakeLock()

  const pass = !threw && held
  console.log('Wake lock missing-API test:', pass ? 'PASS' : 'FAIL', { threw, held })
  return pass
}
