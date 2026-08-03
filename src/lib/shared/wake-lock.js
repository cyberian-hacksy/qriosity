// Keep the screen awake while a transfer runs, best effort — a device that
// sleeps mid-stream kills the transfer, but a browser without the Wake Lock
// API (or a denied request) is fine to run without it.
//
// The browser releases the sentinel whenever the tab is hidden, so while a
// transfer is logically "held" a visibilitychange back to visible re-acquires
// it. Shared by the QR, CIMBAR, and HDMI-UVC senders and receivers; both
// calls are idempotent so overlapping stop paths are safe.

let sentinel = null
let held = false
let listenerInstalled = false

async function requestSentinel() {
  try {
    sentinel = (await navigator.wakeLock?.request('screen')) ?? null
    // The browser can release the sentinel on its own (tab hidden, battery
    // saver); drop our reference so the visibility handler knows to retry.
    sentinel?.addEventListener?.('release', () => { sentinel = null })
  } catch {
    sentinel = null // fine without it
  }
}

function handleVisibilityChange() {
  if (held && document.visibilityState === 'visible' && !sentinel) {
    requestSentinel()
  }
}

export async function acquireWakeLock() {
  held = true
  if (!listenerInstalled && typeof document !== 'undefined') {
    listenerInstalled = true
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }
  if (!sentinel) await requestSentinel()
}

export function releaseWakeLock() {
  held = false
  sentinel?.release?.().catch(() => {})
  sentinel = null
}

export const _internals = {
  isHeld: () => held,
  hasSentinel: () => sentinel !== null,
  handleVisibilityChange
}
