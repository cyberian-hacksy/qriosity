// Shared display formatting helpers used by all sender/receiver UI modules.

// Format bytes to human readable (KB/MB/GB tiers cover every mode's limit up
// to HDMI-UVC's 1 GB).
export function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
}

// Format milliseconds to human readable time ("42s", "3m 12s", "1h 4m 5s").
export function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return totalSeconds + 's'

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return minutes + 'm ' + seconds + 's'

  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return hours + 'h ' + mins + 'm ' + seconds + 's'
}
