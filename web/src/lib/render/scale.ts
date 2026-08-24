// Scale math for rasterization. Ported near-verbatim from ihatepdf per
// docs/tools/pdf-to-image.md — their version is correct and hard-won.

/** 72 DPI is pdf.js's (and PDF's) base unit — a scale of 1 renders at 72 DPI. */
export const dpiToScale = (dpi: number): number => dpi / 72

/**
 * Clamps a requested scale so neither canvas dimension exceeds the browser's
 * hard 16,384px limit. Returns the requested scale unchanged when it's safe.
 */
export function getOptimalScale(viewport: { width: number; height: number }, requested: number): number {
  const MAX = 16384 // hard browser canvas limit
  const w = viewport.width * requested
  const h = viewport.height * requested
  if (w > MAX || h > MAX) {
    return Math.min(MAX / viewport.width, MAX / viewport.height) * 0.95
  }
  return requested
}
