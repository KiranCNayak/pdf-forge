// Safari-compatible download.
//
// Safari blocks some programmatic downloads, so fall back through an anchor to
// window.open, which triggers the iOS share sheet. Revoking the object URL is
// not optional — skipping it leaks the whole file for the tab's lifetime.

export function downloadBytes(bytes: Uint8Array, filename: string, mime = 'application/pdf') {
  downloadBlob(new Blob([bytes as unknown as BlobPart], { type: mime }), filename)
}

/** Same Safari fallback chain as downloadBytes, for callers that already have
 * a Blob — e.g. PdfToZip's JSZip output — and would otherwise have to read it
 * back into a Uint8Array just to hand it to downloadBytes. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)

  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)

  try {
    a.click()
  } catch {
    window.open(url, '_blank')
  }

  setTimeout(() => {
    a.remove()
    URL.revokeObjectURL(url)
  }, 1000)
}
