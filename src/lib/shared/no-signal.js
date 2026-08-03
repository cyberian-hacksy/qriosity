// When to show, and re-show, the receiver's "nothing is decoding" hint
// (adapted from decimen-optical-transfer). Pure timing policy with no DOM in
// it: the rules are the part that can be wrong, the panel itself is markup.
//
// The rules:
// - The countdown starts when the camera does.
// - Dismissing the hint only restarts the countdown. Tapping a button does
//   not make frames start arriving, so if the transfer is still dead a delay
//   later the advice is still the advice.
// - The first frame that decodes ends it for good, dismissed or not. That is
//   the only event that actually means the link is working.

export class NoSignalHintTimer {
  constructor(delayMs) {
    this.delayMs = delayMs
    // `armed` is a separate flag rather than `armedAt === 0` meaning "not
    // started": zero is a legal timestamp.
    this.armed = false
    this.armedAt = 0
    this.visible = false
    this.sawFrame = false
  }

  get isVisible() {
    return this.visible
  }

  // The camera is live. Starts the first countdown.
  cameraStarted(now) {
    if (this.sawFrame) return
    this.armed = true
    this.armedAt = now
    this.visible = false
  }

  // Advance the clock. True exactly once per countdown, at the moment the
  // hint should go on screen — the caller renders it and is not told again
  // until the user dismisses it and another delay passes.
  tick(now) {
    if (!this.armed || this.visible || this.sawFrame) return false
    if (now - this.armedAt <= this.delayMs) return false
    this.visible = true
    return true
  }

  // The user dismissed it. Off screen, but the countdown restarts.
  dismiss(now) {
    this.visible = false
    this.armedAt = now
  }

  // A frame decoded. Returns whether the hint was on screen and needs removing.
  frameDecoded() {
    const wasVisible = this.visible
    this.sawFrame = true
    this.armed = false
    this.visible = false
    return wasVisible
  }
}
