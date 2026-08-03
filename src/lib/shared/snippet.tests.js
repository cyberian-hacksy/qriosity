// Tests for the text-snippet container: text travels as a synthetic file
// with a private MIME type; the receiver detects it from metadata and shows
// the text inline instead of downloading.

import { packSnippet, isSnippet, snippetText, MAX_SNIPPET_BYTES, SNIPPET_MIME } from './snippet.js'

export function testSnippetRoundtrip() {
  const text = 'wifi: Starbase-9 / pass: mäke-it-sö 🖖\nsecond line'
  const packed = packSnippet(text)

  const detected = isSnippet({ mimeType: packed.mimeType })
  const notDetected = isSnippet({ mimeType: 'text/plain' }) === false
  const restored = snippetText(packed.bytes) === text
  const named = typeof packed.filename === 'string' && packed.filename.length > 0
  const mimeStable = packed.mimeType === SNIPPET_MIME

  const pass = detected && notDetected && restored && named && mimeStable
  console.log('Snippet roundtrip test:', pass ? 'PASS' : 'FAIL',
    { detected, notDetected, restored, named, mimeStable })
  return pass
}

export function testSnippetLimits() {
  // Empty (or whitespace-only) text is refused.
  let emptyThrew = false
  try { packSnippet('   ') } catch { emptyThrew = true }

  // Over the byte cap is refused — the cap counts UTF-8 bytes, not chars.
  let overThrew = false
  try { packSnippet('ü'.repeat(MAX_SNIPPET_BYTES)) } catch { overThrew = true }

  // At the cap is fine.
  let atCapOk = true
  try { packSnippet('a'.repeat(MAX_SNIPPET_BYTES)) } catch { atCapOk = false }

  const pass = emptyThrew && overThrew && atCapOk
  console.log('Snippet limits test:', pass ? 'PASS' : 'FAIL', { emptyThrew, overThrew, atCapOk })
  return pass
}
