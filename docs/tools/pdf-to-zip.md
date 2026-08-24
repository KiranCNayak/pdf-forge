# PDF → ZIP

**Route** `/pdf-to-zip` · **Phase** 2 · **Engine** JS

## Purpose

Render every page to an image and deliver them as a single ZIP. Mechanically it is
[pdf-to-image](pdf-to-image.md) plus archiving — but it is the _bulk_ path, so the memory
discipline that pdf-to-image can sometimes get away with skipping is mandatory here.

Cheap to build once pdf-to-image exists. Worth its own route because "download all pages
as images" is a distinct search and a distinct intent.

## User flow

1. Pick a file.
2. Choose format (JPG/PNG) and DPI.
3. Convert → download one `.zip`.

## Implementation

Reuses the render worker and the same `getOptimalScale` / canvas-release logic as
pdf-to-image. The only new part is streaming into the archive.

```ts
// Stream pages into the ZIP as they render — never hold all blobs at once
for (const batch of batches(pages, deviceCaps.maxPagesPerBatch)) {
  for (const pageNr of batch) {
    const blob = await renderPageToBlob(pageNr, scale, format);
    zip.file(`page-${String(pageNr).padStart(4, "0")}.${ext}`, blob);
    releaseCanvas();
  }
  await pause(2000); // let GC run between batches
}
```

Zero-pad page numbers. `page-2.jpg` sorting after `page-10.jpg` in every file manager on
earth is a small thing that makes the output feel broken.

## Memory — the whole design constraint

A 300-page document at 300 DPI is the realistic worst case, and it will kill a tab if
handled carelessly.

- **Never accumulate rendered blobs in an array.** Add each to the archive and drop the
  reference immediately.
- **JSZip holds the full archive in memory** before generating. For large jobs this is the
  real ceiling — the sum of all compressed images must fit. Estimate it up front and refuse
  or downgrade DPI rather than discovering it at page 280.
- Prefer `zip.generateAsync({ type: 'blob', streamFiles: true })`, and consider
  `client-zip` (streaming, much lower peak) if JSZip's memory profile proves limiting.
  Evaluate in Phase 2 — this choice is the difference between a 100-page and a 500-page
  ceiling.
- JPEG over PNG by default here. PNG's ~1.5× cost compounds across every page, and photos
  gain nothing from lossless.
- Batch and pause between batches, exactly as pdf-to-image.

Estimate shown before starting:

```
estimatedZipBytes ≈ pageCount × avgPageBytes(dpi, format)
```

Show it. "This will produce roughly a 480 MB ZIP" stops a bad request before it starts.

## Edge cases

| Case                                    | Behaviour                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Very large document                     | Estimator refuses or downgrades DPI before starting                                                                      |
| Estimated ZIP exceeds device memory     | Suggest splitting the document first, or lowering DPI                                                                    |
| Single-page document                    | Skip the ZIP; hand back the image directly                                                                               |
| Page exceeds the 16,384 px canvas limit | Clamp, report effective DPI                                                                                              |
| Encrypted input                         | Prompt for password                                                                                                      |
| User cancels mid-run                    | Abort the loop, discard the partial archive, free canvases                                                               |
| Browser download blocked                | Fall back through the Safari-compatible chain — anchor `download`, then `window.open` which triggers the iOS share sheet |

## UI states

Idle → loaded (format/DPI pickers, estimated ZIP size) → converting (page N of M, batch
indicator, cancel button) → done (ZIP size, download) → error.

A cancel button is not optional for this tool. It is the longest-running operation in V1.

## Fixtures

`pages_50.pdf`, generated 300-page file, `huge_page_a0.pdf`, `pages_1.pdf`,
`encrypted_aes256.pdf`.
