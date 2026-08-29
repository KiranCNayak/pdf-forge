// Device capability tiers and memory estimation.
//
// The constants here are PLACEHOLDERS inherited from ihatepdf's JS-tuned figures.
// Our engine has a different memory shape — pdfcpu builds a full object model, so
// structural ops scale with file size rather than with page count × DPI². Phase 0
// must measure the real multiplier and replace ENGINE_MULTIPLIER.
// See docs/LLD.md §2.2.

export interface DeviceCaps {
  tier: 'phone' | 'lowMemory' | 'desktop'
  maxFileBytes: number
  maxDPI: number
  maxPagesPerBatch: number
  /** Approximate GB available to this tab. */
  memoryGB: number
}

export function deviceCaps(): DeviceCaps {
  const nav = navigator as Navigator & { deviceMemory?: number }
  // deviceMemory is unavailable in Safari; 4 GB is the conventional default.
  const memoryGB = nav.deviceMemory ?? 4
  const isPhone = /Android|iPhone|iPod/i.test(navigator.userAgent) || screen.width < 768

  if (isPhone) {
    return { tier: 'phone', maxFileBytes: 50 * 1024 ** 2, maxDPI: 300, maxPagesPerBatch: 10, memoryGB }
  }
  if (memoryGB < 4) {
    return { tier: 'lowMemory', maxFileBytes: 100 * 1024 ** 2, maxDPI: 450, maxPagesPerBatch: 30, memoryGB }
  }
  return { tier: 'desktop', maxFileBytes: 150 * 1024 ** 2, maxDPI: 600, maxPagesPerBatch: 50, memoryGB }
}

/**
 * Peak bytes a structural (Go) operation is expected to need.
 *
 * Two copies of the file cross the bridge, and pdfcpu builds an object model on
 * top. PLACEHOLDER multiplier — measure it.
 */
const ENGINE_MULTIPLIER = 4.0

export function estimateEngineBytes(totalInputBytes: number): number {
  return totalInputBytes * ENGINE_MULTIPLIER
}

/**
 * Peak bytes a rasterization (pdf.js) operation is expected to need.
 *
 * Memory scales with the SQUARE of scale — 600 DPI costs 4× what 300 does — and
 * PNG costs about 1.5× JPEG.
 */
export function estimateRenderBytes(pageCount: number, scale: number, format: 'jpeg' | 'png'): number {
  const perPageAtScale1 = 5 * 1024 ** 2
  return pageCount * perPageAtScale1 * scale ** 2 * (format === 'png' ? 1.5 : 1.0)
}

export interface Verdict {
  ok: boolean
  /** true when the job should be automatically downgraded rather than refused. */
  degrade: boolean
  message?: string
}

/** Applies a 1.5× safety margin against half the device's memory. */
export function checkBudget(estimatedBytes: number, caps = deviceCaps()): Verdict {
  const withSafety = estimatedBytes * 1.5
  const budget = caps.memoryGB * 1024 ** 3 * 0.5

  if (withSafety <= budget) return { ok: true, degrade: false }
  if (withSafety <= budget * 2) {
    return {
      ok: true,
      degrade: true,
      message: 'Reducing quality to fit this device’s memory.',
    }
  }
  return {
    ok: false,
    degrade: false,
    message: `This needs about ${(withSafety / 1024 ** 3).toFixed(1)} GB, more than this device can spare.`,
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(2)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}
