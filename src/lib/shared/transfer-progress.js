// QR transfer progress + ETA estimation (approach adapted from
// decimen-optical-transfer, remapped to this codec's systematic+parity
// scheme).
//
// The problem with a solved-blocks bar: fountain solving back-loads — under
// loss the solve cascade sits still and then finishes in a rush, so a
// blocks-only bar reads as stalled and then teleports. Unique-symbol ARRIVAL
// is what actually progresses linearly, so frames drive a continuously
// moving baseline and actually-solved blocks can push the bar further ahead
// at any time. Only verified completion (handled by the caller) reaches 100%.
//
// Expected-completion model for this codec: the systematic phase means a
// clean transfer completes after ~K useful symbols, and one full pass (K'
// symbols, parity included) covers realistic loss. Past K', the stream is
// running long — exactly when someone stares at the bar wondering if it
// stalled — so the ETA extends one parity-sized step at a time instead of
// going silent or negative.

export function estimateQrProgress({ K, KPrime, solved, uniqueSymbols, elapsedSeconds }) {
  const k = Math.max(1, K)
  const kPrime = Math.max(k, KPrime || k)
  const parityStep = Math.max(1, kPrime - k)

  // Frames baseline: 0–86% while collecting the clean-completion minimum,
  // 86–96% through the parity margin, then an asymptotic 96–99% tail.
  let frameFraction
  if (uniqueSymbols < k) {
    frameFraction = 0.86 * (uniqueSymbols / k)
  } else if (uniqueSymbols <= kPrime) {
    frameFraction = 0.86 + 0.1 * ((uniqueSymbols - k) / parityStep)
  } else {
    const extra = (uniqueSymbols - kPrime) / parityStep
    frameFraction = 0.96 + 0.03 * (1 - Math.exp(-extra))
  }

  const solvedFraction = 0.99 * Math.min(1, solved / k)
  const fraction = Math.min(0.99, Math.max(frameFraction, solvedFraction))

  // ETA from the observed unique-symbol rate. Held back for the first few
  // symbols — a two-sample rate reads wildly wrong.
  const rate = elapsedSeconds > 0 ? uniqueSymbols / elapsedSeconds : 0
  const overshoot = uniqueSymbols - kPrime
  const target = overshoot < 0
    ? kPrime
    : kPrime + parityStep * (Math.floor(overshoot / parityStep) + 1)
  const etaSeconds =
    uniqueSymbols >= 3 && elapsedSeconds >= 1 && rate > 0
      ? (target - uniqueSymbols) / rate
      : undefined

  return { fraction, etaSeconds }
}
