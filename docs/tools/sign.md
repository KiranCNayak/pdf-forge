# Sign

**Route** `/sign-pdf` · **Phase** 4 · **Engine** Hybrid

## Purpose

Draw a signature and stamp it onto a document — the catalog's own spec, "canvas
signature capture → image stamp via watermark API." Unlike Redact/Invert/Flatten, this
tool doesn't rasterize anything: the rest of the document stays exactly as it was,
vector text and all. Only an image is added.

## How it works

1. `web/src/tools/Sign/tool.tsx` draws a signature on an `HTMLCanvasElement` with a fully
   transparent background — never filled — so only the ink strokes carry real pixel
   data. Pointer-driven freehand drawing, same coordinate-mapping approach Redact's box
   editor uses (`getBoundingClientRect` ratio against the canvas's own pixel dimensions,
   not its CSS display size).
2. On Sign, the canvas exports via `canvas.toBlob('image/png')` — PNG specifically,
   because JPEG has no alpha channel and would turn the transparent background into an
   opaque white rectangle covering page content.
3. The PNG and the PDF are sent to a new Go op, `AddImageWatermark`
   (`engine/internal/ops/watermark.go`), which calls `api.ImageWatermarkForReader` +
   `api.AddWatermarks` — the same mechanism `AddWatermark`'s text watermark already uses;
   `ImageWatermarkForReader`'s `desc` string shares the identical "key:value" parser with
   `TextWatermark` (confirmed directly in the vendored source), just with `scalefactor`
   instead of `points`/`color`.

Selection defaults to the **last page**, not "all pages" — a contract usually gets
signed once, on one page. "All pages" stays available for a genuine per-page initial.

## PNG transparency actually survives the round trip

This mattered enough to verify directly rather than assume: pdfcpu decodes a PNG's alpha
channel and embeds it as a real `/SMask` on the image XObject
(`model.CreateImageResources` in the vendored source) — a transparent signature really
does composite over page content rather than painting an opaque white box. Confirmed by
extracting the embedded image back out of a real signed PDF with `api.ExtractImagesFile`
and inspecting it directly, not just reading the encoder code and assuming it works.

## A real bug this tool's own e2e test found — in shared code, not this tool

Building the "does the stamp actually render" verification for this tool surfaced a bug
in `web/src/workers/render.worker.ts` that had nothing to do with Sign specifically and
affects every tool that renders a page through it: **`PdfToImage`, `PdfToZip`, Redact,
and `OrganizePages`' thumbnails could all crash on a document containing certain small
images.**

pdf.js's own image-scaling helper (`_scaleImage`, used when a decoded image needs runtime
resampling — which pdf.js's operator-list builder can trigger even for a small _XObject_
image, not only a literal inline one) creates a temporary canvas via
`document.createElement('canvas')`. That's fine on the main thread; `document` doesn't
exist inside a Worker. The failure mode was silent and generic
(`ERR_INTERNAL` / "Something went wrong.") — confirmed directly by instrumenting
`render.worker.ts`'s own catch block against a real signed PDF, not guessed from reading
pdf.js's source. The real underlying error:

```
TypeError: Cannot read properties of undefined (reading 'createElement')
    at DOMCanvasFactory._createCanvas
    at _CanvasGraphics._scaleImage
    at _CanvasGraphics.paintInlineImageXObject
```

`getDocument()` accepts a pluggable `CanvasFactory` option exactly for this —
`pdfjs-dist` ships its own `NodeCanvasFactory` for Node.js, following the identical
pattern. `render.worker.ts` now passes an `OffscreenCanvasFactory` (a small class
implementing the same `create`/`reset`/`destroy` shape pdf.js's internal
`BaseCanvasFactory` expects, using `OffscreenCanvas` instead of a DOM `<canvas>`) so any
temporary canvas pdf.js creates _for itself_, mid-render, also works inside the Worker —
not just the canvases this app's own render calls already own and pass in explicitly.

This was a latent bug before Sign existed — any real-world PDF with a small enough
embedded image (a tiny logo, an icon, a small stamp from another tool) could have hit it
in any render-worker tool. Sign's own test fixture just happened to be small and scaled
down far enough to trigger it reliably.

## Params (engine)

```go
// internal/ops/watermark.go — new op, not an extension of WatermarkParams
type ImageWatermarkParams struct {
    Selection []string `json:"selection,omitempty"`
    Scale     float64  `json:"scale"`     // (0, 1], relative to page width
    Position  string   `json:"position"`  // same 9-point anchor as WatermarkParams
    Rotation  float64  `json:"rotation"`  // -180..180, always sent explicitly
    Opacity   float64  `json:"opacity"`   // (0, 1]
    OnTop     bool     `json:"onTop"`
    Password  string   `json:"password,omitempty"`
}

func AddImageWatermark(input, image []byte, p ImageWatermarkParams, prog Progress) ([]byte, error)
```

Not Sign-specific by name or shape — a future "stamp a logo" or "stamp a QR code" tool
can call it directly.

## Edge cases

| Case                                | Behaviour                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| No signature drawn                  | Sign button disabled, not a blocked-with-no-explanation state                        |
| Scale outside `(0, 1]`              | `ERR_INVALID_PARAMS`                                                                 |
| Opacity/rotation outside range      | `ERR_INVALID_PARAMS`, same bounds as `AddWatermark`                                  |
| Selection resolves to zero pages    | `ERR_UNSUPPORTED`, same posture as every other watermark-family op                   |
| Encrypted input                     | Same password prompt flow as `AddWatermark`                                          |
| Empty image (canvas never drawn on) | Blocked client-side (`hasInk`) before an empty-image request ever reaches the engine |

## UI states

Idle → loaded (signature canvas, placement controls, page selection) → signing → done →
error. Password prompt reused from `AddWatermark`'s exact shape.

## Fixtures

`sample-a.pdf` for UI-level tests. Its pages are a deliberately tiny 120×160pt fixture
(see `engine/cmd/genfixtures`), which the pixel-verification e2e test compensates for by
requesting a larger placement size than the tool's own 25% default — otherwise a hairline
stroke scaled down that far becomes sub-pixel and invisible regardless of whether the
stamp is really there, a fixture-scale artifact, not evidence the default is wrong.
