// Tests for safeFileName: the filename a receiver saves arrived over the
// optical channel and is whatever the other screen chose to send. The
// `download` attribute is the only consumer and browsers sanitise it too,
// but the receiver has no reason to take the sender's word for it.

import { safeFileName } from './download.js'

export function testSafeFileName() {
  const cases = [
    // Paths reduce to their basename, both separators.
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\victim\\evil.exe', 'evil.exe'],
    ['dir/sub/report.pdf', 'report.pdf'],
    // Control characters are stripped.
    ['bad\u0000name\n.txt', 'badname.txt'],
    ['tab\tname.txt', 'tabname.txt'],
    // Degenerate names fall back.
    ['', 'transfer.bin'],
    ['.', 'transfer.bin'],
    ['..', 'transfer.bin'],
    ['///', 'transfer.bin'],
    ['   ', 'transfer.bin'],
    // Ordinary names pass through untouched.
    ['photo_2026-08-03.jpg', 'photo_2026-08-03.jpg'],
    ['résumé.pdf', 'résumé.pdf']
  ]

  let pass = true
  for (const [input, expected] of cases) {
    const got = safeFileName(input)
    if (got !== expected) {
      console.log('  safeFileName(' + JSON.stringify(input) + ') = ' + JSON.stringify(got) + ', expected ' + JSON.stringify(expected))
      pass = false
    }
  }
  console.log('Safe filename test:', pass ? 'PASS' : 'FAIL')
  return pass
}
