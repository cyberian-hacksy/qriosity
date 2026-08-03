// Tests for the QR transfer progress/ETA estimator (pure math, no DOM).

import { estimateQrProgress } from './transfer-progress.js'

export function testProgressMonotonicAndBounded() {
  const K = 100
  const KPrime = 130
  let previous = -1
  let ok = true
  // Sweep a plausible transfer: symbols arrive steadily, solved lags behind
  // and stalls entirely in the middle (loss), then catches up.
  for (let unique = 0; unique <= 2 * KPrime; unique++) {
    const solved = unique < 40 ? Math.min(K, unique) : unique < 150 ? 40 : Math.min(K - 1, unique - 110)
    const { fraction } = estimateQrProgress({
      K, KPrime, solved, uniqueSymbols: unique, elapsedSeconds: unique / 10
    })
    if (fraction < previous - 1e-9) { ok = false; break }
    if (fraction > 0.99 + 1e-9) { ok = false; break }
    previous = fraction
  }
  const startsAtZero = estimateQrProgress({ K, KPrime, solved: 0, uniqueSymbols: 0, elapsedSeconds: 0 }).fraction === 0

  const pass = ok && startsAtZero
  console.log('Progress monotonic/bounded test:', pass ? 'PASS' : 'FAIL', { monotonicAndCapped: ok, startsAtZero })
  return pass
}

export function testProgressMovesWhileSolvedStalls() {
  // LT solving back-loads: while solved sits still, arriving symbols must
  // keep the bar moving so it doesn't read as a stall.
  const K = 100
  const KPrime = 130
  const stalled = (unique) => estimateQrProgress({
    K, KPrime, solved: 60, uniqueSymbols: unique, elapsedSeconds: unique / 10
  }).fraction

  const early = stalled(70)
  const mid = stalled(110)
  const late = stalled(170)
  const pass = mid > early && late > mid && late <= 0.99
  console.log('Progress moves-through-stall test:', pass ? 'PASS' : 'FAIL', { early, mid, late })
  return pass
}

export function testEtaBehaviour() {
  const K = 100
  const KPrime = 130

  // Too few samples → no estimate rather than a wild one.
  const tooEarly = estimateQrProgress({ K, KPrime, solved: 1, uniqueSymbols: 2, elapsedSeconds: 0.5 })
  const noEarlyEta = tooEarly.etaSeconds === undefined

  // Mid-transfer: finite, positive, and shrinking as symbols arrive.
  const a = estimateQrProgress({ K, KPrime, solved: 30, uniqueSymbols: 40, elapsedSeconds: 4 })
  const b = estimateQrProgress({ K, KPrime, solved: 70, uniqueSymbols: 100, elapsedSeconds: 10 })
  const shrinks = a.etaSeconds > 0 && b.etaSeconds > 0 && b.etaSeconds < a.etaSeconds

  // Running long (past a full pass): the estimate extends instead of going
  // negative or silent — honest about the transfer needing more redundancy.
  const over = estimateQrProgress({ K, KPrime, solved: 90, uniqueSymbols: 150, elapsedSeconds: 15 })
  const extendsHonestly = over.etaSeconds !== undefined && over.etaSeconds > 0

  const pass = noEarlyEta && shrinks && extendsHonestly
  console.log('Progress ETA behaviour test:', pass ? 'PASS' : 'FAIL',
    { noEarlyEta, shrinks, extendsHonestly, aEta: a.etaSeconds, bEta: b.etaSeconds, overEta: over.etaSeconds })
  return pass
}
