// Text snippets travel the same pipeline as files — packed as a synthetic
// file with a private MIME type so the receiver can tell "show this inline
// with a Copy button" apart from "download this". Nothing else changes:
// hashing, gzip, fountain coding and verification all treat it as a file.

export const SNIPPET_MIME = 'text/x-beammeup-snippet'
export const SNIPPET_FILENAME = 'snippet.txt'

// Generous for text (a phone screen of prose is ~2 KB) while keeping even a
// worst-case snippet transfer to a handful of QR passes at the Light preset.
export const MAX_SNIPPET_BYTES = 64 * 1024

export function packSnippet(text) {
  if (!text || text.trim() === '') {
    throw new Error('Type or paste some text to send.')
  }
  const bytes = new TextEncoder().encode(text)
  if (bytes.length > MAX_SNIPPET_BYTES) {
    throw new Error('Text is ' + bytes.length + ' bytes — the limit is ' +
      MAX_SNIPPET_BYTES / 1024 + ' KB. Save it as a file and send that instead.')
  }
  return { bytes, filename: SNIPPET_FILENAME, mimeType: SNIPPET_MIME }
}

export function isSnippet(metadata) {
  return metadata?.mimeType === SNIPPET_MIME
}

export function snippetText(bytes) {
  return new TextDecoder().decode(bytes)
}
