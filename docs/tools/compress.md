# Compress PDF

**Route** `/compress-pdf` · **Phase** 2 · **Engine** Go

The hardest tool in V1 and the one that justifies the engine choice. `pdf-lib` cannot
compress at all; ihatepdf ships an entire Ghostscript-Wasm build for this one feature.

Full pipeline design lives in `docs/LLD.md` §3. This document covers the product surface.

## User flow

1. Pick one or more files.
2. Choose a mode:
   - **Preset** — Screen / eBook / Printer / Prepress
   - **Target size** — "get under 5 MB"
3. Compress → show original vs result vs percentage saved, per file.
4. Download individually or as a ZIP.

## Engine op

```go
// internal/ops/compress.go
type CompressParams struct {
    Mode        string `json:"mode"`        // "preset" | "target"
    Preset      string `json:"preset"`      // screen|ebook|printer|prepress
    TargetBytes int64  `json:"targetBytes"`
}

type CompressResult struct {
    Bytes         []byte `json:"-"`
    OriginalSize  int64  `json:"originalSize"`
    ResultSize    int64  `json:"resultSize"`
    ReachedTarget bool   `json:"reachedTarget"`
    Fallback      bool   `json:"fallback"`
    ImagesTouched int    `json:"imagesTouched"`
    ImagesSkipped int    `json:"imagesSkipped"`
    SkipReasons   map[string]int `json:"skipReasons"`
}

func Compress(input []byte, p CompressParams, prog Progress) (CompressResult, error)
```

`Fallback` is the "already optimised" case below: the output came out bigger, so `Bytes`
is the untouched input. There is deliberately no password parameter — an encrypted file
returns `ERR_ENCRYPTED` and must go through remove-password first, so the UI can say why.

`SkipReasons` keys are the `Skip*` constants in `internal/ops/compress.go`:
`transparency`, `stencil`, `thumbnail`, `jpeg2000`, `unsupportedType`, `alreadyLowDPI`,
`noGain`.

The skip counters are not diagnostics for us — they are **UI copy**. "8 of 12 images
compressed; 4 skipped (transparency)" is a far better answer than a mysterious 3%
saving.

## Presets

| Preset   | Ghostscript equivalent | DPI | JPEG quality | Use                |
| -------- | ---------------------- | --- | ------------ | ------------------ |
| Screen   | `/screen`              | 72  | 40           | Email, web         |
| eBook    | `/ebook`               | 150 | 60           | Tablets, reading   |
| Printer  | `/printer`             | 300 | 80           | Office printing    |
| Prepress | `/prepress`            | 300 | 92           | Professional print |

Mapped 1:1 onto Ghostscript's so the Phase-5 benchmark compares like with like.

## Target-size mode

Binary search over a monotonic (DPI, quality) ladder rather than ihatepdf's linear preset
walk. Capped at 4 full passes; always returns the best result found with
`reachedTarget` so the UI can be honest when the target was unreachable.

**Compression is not idempotent and not always a win.** If the output is larger than the
input — common on already-optimised documents — return the _original_ and say "already
optimised" rather than shipping a worse file. ihatepdf does this too (their
`wasFallback` flag); it's the correct behaviour.

## Known gap: font subsetting

Ghostscript trims embedded fonts to the glyphs actually used, up to 90% off a font. That
dominates savings on text-heavy PDFs with no images. **pdfcpu does not do this and V1
will not have it.**

Stated plainly: **on text-heavy documents we will lose to ihatepdf.** On image-heavy
documents we should be competitive or better. Do not claim otherwise in marketing copy,
and do not let the UI imply a saving it can't deliver — if a document is text-only, say
"limited savings available: this document is mostly text" up front.

Phase 4 remedy: `golang.org/x/image/font/sfnt` subsetting. Non-trivial — CID fonts,
Type1/CFF and subset naming all bite.

## Memory

The most expensive op in V1. Peak is driven by the largest _decoded_ image, not the file
size: a 4000×6000 RGB image is 72 MB decoded regardless of being 2 MB as JPEG.

- Process images strictly one at a time; never hold two decoded images.
- Free each `image.Image` before decoding the next.
- Target-size mode re-runs the pipeline — the peak repeats per pass but doesn't accumulate
  _if_ buffers are released between passes. Verify with a heap profile in Phase 0.
- **Always respawn the engine worker after a compress job**, regardless of input size.
  This op has the highest high-water mark of anything we run.

## Edge cases

| Case                           | Behaviour                                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| No images at all               | Structural pass only. Report the honest (small) saving                                                                 |
| Output larger than input       | Return the original, report "already optimised"                                                                        |
| Image has `/SMask` or `/Mask`  | **V1: skip it**, count it, name the reason. See `docs/LLD.md` §3.1 — mishandling masks produces visibly corrupt output |
| `JPXDecode` (JPEG 2000) image  | Skip — Go has no decoder                                                                                               |
| Image already below target DPI | Skip; recompressing degrades for nothing                                                                               |
| 1-bit image mask / stencil     | Skip; JPEG would make it larger and worse                                                                              |
| Encrypted input                | `ERR_ENCRYPTED`                                                                                                        |
| Target unreachable             | Return best effort with `reachedTarget: false` and show the size achieved                                              |
| Very large image (>50 MP)      | Guard before decoding; `ERR_TOO_LARGE` beats an OOM crash                                                              |

## UI states

Idle → files staged → configuring (preset or target) → compressing (per-file, per-image
progress) → done (before/after per file, skip reasons) → error.

Progress granularity is per-image, since pdfcpu offers no finer hook. Don't fake a smooth
bar.

## Fixtures

`images_heavy.pdf`, `text_only.pdf`, `already_optimised.pdf`, `smask_transparency.pdf`,
`stencil_mask.pdf`, `jpeg2000.pdf`, `scanned_300dpi.pdf`, `huge_image_60mp.pdf`,
`encrypted_aes256.pdf`.

Each maps to a specific branch above; this corpus is the tool's real test suite.

**As built**, fixtures are generated in `compress_test.go` rather than committed, and two
of them cannot be generated honestly:

- `jpeg2000.pdf` — Go cannot _encode_ JPX either, so there is nothing to build the fixture
  from. The skip branch is asserted against `classifyImage` directly.
- `huge_image_60mp.pdf` — 60 MP of RGBA is 240 MB of test data. The guard is exercised by
  lowering `maxImagePixels` instead.

Also worth knowing: pdfcpu normalises a 1-bit paletted PNG to 8 bpc on import, so the
stencil _fixture_ does not reach the stencil branch — it lands on `noGain`, which is the
correct outcome for it and is asserted as such. The stencil rule itself is unit-tested.
