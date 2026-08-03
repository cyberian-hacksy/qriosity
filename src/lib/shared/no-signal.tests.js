// Tests for the no-signal hint timing policy (pure class, no DOM).
// The rules under test:
// - countdown starts when the camera does
// - tick() returns true exactly once per countdown, when the hint is due
// - dismissing only restarts the countdown (the transfer is still dead)
// - the first decoded frame ends it for good, dismissed or not

import { NoSignalHintTimer } from './no-signal.js'

export function testNoSignalHintLifecycle() {
  const timer = new NoSignalHintTimer(10_000)

  // Nothing fires before the camera starts.
  const quietBeforeStart = timer.tick(50_000) === false

  timer.cameraStarted(100_000)
  const quietBeforeDelay = timer.tick(105_000) === false
  const firesAfterDelay = timer.tick(110_001) === true
  // Fires exactly once — while visible, tick stays false.
  const firesOnce = timer.tick(120_000) === false && timer.isVisible === true

  // Dismiss hides it but re-arms the countdown from the dismissal time.
  timer.dismiss(120_000)
  const hiddenAfterDismiss = timer.isVisible === false
  const quietAfterDismiss = timer.tick(125_000) === false
  const refiresAfterDelay = timer.tick(130_001) === true

  const pass = quietBeforeStart && quietBeforeDelay && firesAfterDelay &&
    firesOnce && hiddenAfterDismiss && quietAfterDismiss && refiresAfterDelay
  console.log('No-signal hint lifecycle test:', pass ? 'PASS' : 'FAIL',
    { quietBeforeStart, quietBeforeDelay, firesAfterDelay, firesOnce, hiddenAfterDismiss, quietAfterDismiss, refiresAfterDelay })
  return pass
}

export function testNoSignalHintEndsOnDecode() {
  const timer = new NoSignalHintTimer(10_000)
  timer.cameraStarted(0)
  timer.tick(10_001) // hint goes visible

  // A decoded frame while visible: caller is told to remove the panel…
  const wasVisible = timer.frameDecoded() === true
  // …and the timer never fires again, even across a camera restart.
  const deadAfterDecode = timer.tick(1_000_000) === false
  timer.cameraStarted(2_000_000)
  const deadAfterRestart = timer.tick(3_000_000) === false

  // A decode with the hint NOT visible reports false (nothing to remove).
  const timer2 = new NoSignalHintTimer(10_000)
  timer2.cameraStarted(0)
  const nothingToRemove = timer2.frameDecoded() === false

  const pass = wasVisible && deadAfterDecode && deadAfterRestart && nothingToRemove
  console.log('No-signal hint decode-ends-it test:', pass ? 'PASS' : 'FAIL',
    { wasVisible, deadAfterDecode, deadAfterRestart, nothingToRemove })
  return pass
}
