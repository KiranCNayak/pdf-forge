# PDF → JPG / PNG

**Route** `/pdf-to-jpg` · **Phase** 2 · **Engine** JS (pdf.js)

## Purpose

Render pages to raster images at a chosen DPI. **Stays in JavaScript** — Go has no PDF
rasterizer, and writing one is out of the question. This is the boundary rule in
`docs/HLD.md` §4 doing its job.

## User flow

1. Pick a file.
2. Choose format (JPG/PNG), DPI (72/150/300/600), and pages (all or a selection).
3. Convert → download single images or a ZIP.

## Implementation

Runs in `render.worker.ts` with pdf.js. Ported near-verbatim from ihatepdf, because their
version is correct and hard-won:

```ts
const dpiToScale = (dpi: number) => dpi / 72; // 72 DPI is the browser's base

function getOptimalScale(viewport, requested: number) {
  const MAX = 16384; // hard browser canvas limit
  const w = viewport.width * requested;
  const h = viewport.height * requested;
  if (w > MAX || h > MAX) {
    return Math.min(MAX / viewport.width, MAX / viewport.height) * 0.95;
  }
  return requested;
}
```

Render settings that matter:

```ts
const ctx = canvas.getContext("2d", {
  alpha: false,
  willReadFrequently: false,
});
ctx.fillStyle = "white";
ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.imageSmoothingQuality = "high";
await page.render({ canvasContext: ctx, viewport, intent: "print" }).promise;
```

`alpha: false` plus an explicit white fill — a transparent canvas exported to JPEG comes
out with a black background, which is the single most common bug in this tool. `intent:
'print'` makes pdf.js render at print fidelity rather than screen.

## Memory — the dominant concern

This tool crashes tabs if built naively. Every rule here exists because of a specific
failure:

- **Quadratic scaling.** Memory grows with scale², so 600 DPI costs 4× what 300 does.
  The estimator must square the scale.
- **Canvas costs RAM _and_ VRAM.** A 4000×6000 canvas is ~96 MB RAM plus ~96 MB GPU
  texture. On shared-memory mobile that's 192 MB gone per page.
- **Release explicitly.** `canvas.width = canvas.height = 0` after each page. Nulling the
  reference is not enough — this is what actually frees the GPU texture.
- **Batch with pauses.** Process `maxPagesPerBatch` pages, then wait ~2 s. Chrome's GC
  triggers after roughly 1–1.5 s idle. `window.gc` is a hint the browser may ignore.
- **PNG costs ~1.5× JPEG.** Factor it into the estimate.

```ts
estimateRenderBytes(pageCount, scale, format) =>
  pageCount * 5_000_000 * scale ** 2 * (format === 'png' ? 1.5 : 1.0)
```

Apply a 1.5× safety margin; compare against `navigator.deviceMemory * 0.5`. If it exceeds,
**degrade automatically first** (drop DPI to the device cap, force batching) and only
prompt when degradation isn't possible. ihatepdf shows a `confirm()` dialog; a silent
sensible downgrade with a visible note is better UX than a modal asking users to reason
about gigabytes.

Device caps from `docs/HLD.md` §6: phone 300 DPI / 10 per batch, low-memory 450 / 30,
desktop 600 / 50.

## Edge cases

| Case                                    | Behaviour                                                |
| --------------------------------------- | -------------------------------------------------------- |
| Page exceeds 16,384 px at requested DPI | Clamp to the safe scale, tell the user the effective DPI |
| 500-page document at 600 DPI            | Estimator refuses or downgrades before starting          |
| Encrypted input                         | Prompt for password (pdf.js accepts one)                 |
| Transparent page content                | White background fill handles it for JPEG                |
| Vector-only page                        | Renders fine; note that raster output loses scalability  |
| Single page selected                    | Download the image directly, don't zip                   |

## UI states

Idle → loaded (page count, DPI/format pickers, live size estimate) → converting (per-page
progress, batch indicator) → done (thumbnail results, download all/individual) → error.

Show the estimated output size _before_ starting. It's the cheapest way to stop someone
requesting 600 DPI on 300 pages.

## Fixtures

`pages_50.pdf`, `huge_page_a0.pdf` (triggers the clamp), `vector_only.pdf`,
`transparency.pdf`, `encrypted_aes256.pdf`.
