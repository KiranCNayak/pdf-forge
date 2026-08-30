# Redact

**Route** `/redact-pdf` · **Phase** 4 · **Engine** Hybrid

## Purpose

Permanently remove sensitive content from a PDF. This is the highest-stakes tool in the
app: getting it wrong doesn't produce a broken file, it produces a file that _looks_
redacted but leaks the thing it claims to hide — the single most common real-world
redaction failure (a black rectangle drawn over vector text that's still selectable,
copy-pasteable, and extractable underneath it).

## A deliberate deviation from `docs/TOOL_CATALOG.md`

The catalog specs this tool as `Engine: Go` with: _"Must remove the content stream text,
not draw a black box over it. Anything less is a security defect."_ That's the right
requirement; it just isn't achievable with what's actually available. pdfcpu — the only
PDF engine in this codebase — has no content-stream editor: no text-run removal, no
per-glyph bounding-box computation from font metrics, no image-region clipping. Building
that from scratch means a content-stream tokenizer, a full graphics/text-matrix stack,
glyph-width tables per font (including CID/Type0, Type3, kerning, rotated `Tm`, invisible
OCR-layer text), and partial-run splitting where a box only covers part of a text run.
That is exactly the class of feature where "mostly correct" is worse than not shipping it
— a partial-overlap bug that leaves three characters behind is a worse outcome than an
honest, documented limitation.

**What's built instead exceeds the catalog's requirement rather than falling short of
it, at a real cost stated up front:** every page of the document — not just the ones with
a box on them — is rasterized in the render worker, the redaction boxes are composited
directly onto the decoded pixels, and the whole document is rebuilt from those images.
The output PDF has no vector text, no annotations, no embedded files, no XMP/Info
metadata, and no OCG layers anywhere, because none of that data crosses the raster
boundary — not just the boxed regions, the entire file. This is the same principle real
redaction-vendor guidance and security literature increasingly recommend for "must not
leak" cases (flatten-to-image), and it's the only version of this tool one agent could
build, test exhaustively, and defend with confidence in one pass.

**The honest cost, shown in the tool's own UI, not just here:** the whole document loses
text search and selection — not just the redacted area — and file size goes up (raster
vs. vector text). A user who wants to keep the rest of the document searchable while
surgically removing one string is not served by this tool in V1.

## How it works

1. `web/src/tools/Redact/tool.tsx` opens the file in the render worker (same
   `RenderClient` every other render-worker tool uses) and shows one page at a time on an
   interactive `<canvas>`. Dragging on it draws a rectangle; released drags under 4px in
   either dimension are dropped as accidental clicks. Boxes are stored per page as
   fractions (`{x0,y0,x1,y1}` in `[0,1]`) of the page's own width/height — resolution
   independent of whatever DPI the interactive preview happens to render at.
2. **Apply** re-renders every page — not just the ones with a box — at the chosen output
   DPI/format, composites every stored box for that page directly onto the decoded pixels
   as a solid black fill (`OffscreenCanvas`, main thread — this is compositing an
   already-decoded bitmap, not parsing a PDF, so it doesn't need the render worker), then
   encodes each page back to JPEG/PNG.
3. The rebuilt images are handed to the Go engine's `imagesToPDF` op with a new
   `pageSize: "exact"` mode (`engine/internal/ops/imagestopdf.go`) that sizes every page
   to `width`/`height` in **points**, computed from the render worker's own
   `effectiveDpi` (`widthPt = pixelWidth * 72 / effectiveDpi`) — not from `"fit"`'s pixel-
   dimensions-as-points behaviour, which would blow a Letter page up to ~18×23 inches at
   150 DPI. If every page shares the same physical size (by far the common case, checked
   with a 0.5pt tolerance rather than exact equality — see below), this is one engine
   call for the whole document; a mixed-page-size document falls back to one call per
   page plus a final `merge`.

## Why `pageSize: "exact"` needed to exist

pdfcpu's own `"fit"` mode (`imp.Pos = types.Full`) sets the PDF's `/MediaBox` directly
from the image's own pixel dimensions, with no DPI conversion at all — confirmed by
reading `NewPagesForImage`/`importImagePDFBytes` in the vendored source, not assumed. That
is correct for "combine some photos into a PDF" (images-to-pdf's actual use case) and
would be wrong here: a Letter page rendered at 200 DPI is 1700×2200 _pixels_, and `"fit"`
would produce a 1700×2200 _point_ page — about 23.6×30.6 inches. `"exact"` instead sets
`imp.PageDim` explicitly and lets pdfcpu's own non-`Full` fit-to-page math (`Scale: 1.0`,
`Pos: Center`) place the image — which preserves aspect ratio rather than stretching, so
even a hairline rounding mismatch between the image's pixel aspect ratio and the given
point aspect ratio (both derived from the same `effectiveDpi`, so this should only ever be
sub-pixel) produces an imperceptible margin, never distortion. Verified directly:
`TestImagesToPDFExactSizesPageToGivenPoints`.

Batching all pages into one `imagesToPDF` call requires every page in that call to share
one `imp.PageDim` — an existing limitation this tool inherited rather than introduced (the
same one `"A4"`/`"Letter"` mode already has, per `imagestopdf.go`'s own doc comment). The
0.5pt tolerance for "do these pages count as the same size" (rather than exact float
equality) exists because `Math.ceil` on device pixels in the render worker can differ by
a sub-point amount between otherwise-identical pages; pdfcpu's aspect-preserving fit means
that tolerance can never cause visible distortion, only an invisible margin.

## What survives, what doesn't

| Content                                                                            | Survives redaction?                                                                                                                                             |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text under a drawn box                                                             | No — gone, not hidden                                                                                                                                           |
| Text anywhere else on the document                                                 | **No** — the whole document is rasterized, not just boxed pages                                                                                                 |
| Images, anywhere                                                                   | No — rasterized along with everything else                                                                                                                      |
| Annotations, form fields, embedded files, OCG layers, bookmarks, XMP/Info metadata | No — none of this exists in a document rebuilt purely from images                                                                                               |
| Page count and physical page size                                                  | Yes — preserved exactly (`"exact"` mode)                                                                                                                        |
| Visual appearance outside the boxed area                                           | Yes, as pixels — no longer selectable/searchable text, but visually intact                                                                                      |
| The original document's encryption                                                 | **No** — the rebuilt PDF is a fresh, unencrypted file. Re-encrypt via the Encrypt tool afterward if the source was protected. Documented cut, not an oversight. |

## Two hardening decisions, made before any adversarial review found the gaps

Both closed proactively rather than left for a red-team pass to surface:

- **Every drawn box is filled outset by `EDGE_MARGIN_PX` (3 device pixels at whatever
  resolution it's composited at), not filled exactly to the fractional rectangle the user
  dragged.** A box's `[0,1]` boundary essentially never lands on an exact device-pixel
  line once multiplied by the canvas's width/height, and `fillRect` anti-aliases that
  boundary — blending the edge row/column of pixels toward, not fully to, black. On its
  own that's imperceptible; re-encoding as JPEG can then spread a faint trace of that
  partially-blended edge pixel across an adjacent 8×8 DCT block. Neither gets remotely
  close to reconstructing covered content, but "close to" was never the bar for this
  tool. The outset costs nothing (every real box already has comfortable margin around
  what it's covering) and removes the edge case outright. Shared by both the live preview
  and the final compositing (`fillBoxes` in `tool.tsx`) so what the user sees while
  dragging matches what ships.
- **PNG, not JPEG, is the default output format** — the one tool in this app where that
  flips from every other render-worker tool's JPEG default (PdfToImage, PdfToZip). PNG is
  lossless: a box's interior is exactly what was painted, full stop, with no DCT-block
  interaction with neighbouring content at all. JPEG stays available as an explicit
  opt-in for a smaller file once a user has decided that trade-off is worth it, not as the
  unexamined default a tool this sensitive should ship with.

## Verification

The property that actually matters — "the secret string cannot survive anywhere in the
output file" — is not testable in a Go unit test, because Go never sees the original
vector PDF in this pipeline; it only ever receives already-rasterized images. The proof
lives in `web/e2e/redact.spec.ts`, against a real fixture with two known vector-text
strings (`web/e2e/fixtures/redact-secret.pdf`, generated by
`go run ./cmd/genfixtures -redact`, real content confirmed via `qpdf --qdf` — not assumed
from the generator code alone):

- Draws a box over the bottom-left corner only (where `"SECRET-9F3A1B47"` is stamped),
  runs Redact, downloads the output, and **reads the raw output bytes directly** —
  confirming `"9F3A1B47"` does not appear anywhere in the file, not just visually behind
  the box. This is the single test that actually matters; everything else is UI wiring.
- Feeds the output back through the app's own PdfToImage tool (`/pdf-to-jpg`) — a second,
  independent code path — and samples two pixels from the resulting PNG: one inside the
  drawn box (must be black) and one at the untouched page centre (must be near-white),
  proving the redaction is localized to the drawn region rather than a blanket black page.
- UI-only coverage: drawing/removing a box updates the on-screen count, an accidental
  sub-4px drag is dropped, "Redact Entire Page" fills the whole canvas with one box, and
  the Redact button stays disabled until at least one box exists.

Go-side coverage is limited to what Go actually owns: `TestImagesToPDFExactSizesPageToGivenPoints`,
`TestImagesToPDFExactAppliesToEveryImageInBatch`, and
`TestImagesToPDFExactRejectsNonPositiveDimensions` in `engine/internal/ops/imagestopdf_test.go`.

## Adversarial review

A dedicated agent (Opus model, tasked with actively trying to break the redaction
guarantee rather than a general code review) ran against this tool after the above was
shipped. It found and fixed two real bugs — one of them the exact "looks redacted but
isn't" failure mode this whole tool exists to prevent — and closed the mixed-page-size
gap flagged above. `web/e2e/redact-adversarial.spec.ts` (7 tests) and four fixtures
(`web/e2e/fixtures/adv-{rot90,multi5,encrypted,mixed}.pdf`, generated by
`go run ./cmd/genfixtures -adversarial`) are the permanent result.

**Bug 1 — the box editor stayed live while a redaction run was in flight.** `apply()`
freezes the box set it acts on at the moment Redact is clicked (a plain JS closure over
that render's `boxesByPage`, now named explicitly as a `const boxes = boxesByPage`
snapshot at the top of the function rather than left implicit). Nothing, however, stopped
the user from continuing to draw, delete, or clear boxes on the canvas _while a multi-page
run was still going_ — the visible box count and canvas would update immediately (a
completely separate render), while the frozen closure the running `apply()` was actually
using never saw those changes. A user could watch a new box appear on screen, see
"Redacted · N bytes" report success, download the file, and get a document that never
contained that box at all — success reported for a redaction that silently didn't happen.
Fixed by disabling every box-editing control (the canvas's pointer handlers, "Redact
Entire Page", "Clear This Page", "Clear All", each box's remove button) for the duration
of a run — `status.kind === 'working'` is now checked at every one of those entry points,
not just the top-level Redact button. Regression-tested by
`web/e2e/redact-adversarial.spec.ts`'s "the box editor is frozen while a redaction run is
in flight".

**Bug 2 — encrypted PDFs silently broke the password prompt in every render-worker tool,
not just Redact.** `render.worker.ts`'s error classifier checked `if (e?.code)` to detect
this codebase's own thrown errors (always an `ERR_`-prefixed string) before falling
through to pdf.js's own `PasswordException` handling. pdf.js's `PasswordException` also
carries a `code` property — a _number_ (`PasswordResponses.NEED_PASSWORD === 1`) — so the
bare truthiness check matched it first and misclassified every encrypted document as a
generic internal error, never reaching the branch that turns it into `ERR_ENCRYPTED` and
opens the password prompt. This wasn't Redact-specific — it's shared code, so it broke
Redact, PdfToImage, PdfToZip, ExtractText, and OrganizePages identically; Redact's own
adversarial fixture (`adv-encrypted.pdf`) is just what happened to surface it. Fixed by
checking the actual shape this codebase's own throws use (`typeof e.code === 'string' &&
e.code.startsWith('ERR_')`) instead of bare truthiness. Regression-tested by
`web/e2e/redact-adversarial.spec.ts`'s two encrypted-source tests (unlock-and-redact, and
wrong-password-is-recoverable).

**The mixed-page-size fallback branch (`imagesToPDF` per page + `merge`) now has real
coverage** — `adv-mixed.pdf` (Letter followed by A5) exercises it directly, asserting each
output page keeps its own physical aspect ratio through the merge. No bug found here; the
gap was coverage, not correctness.

**Everything else the review specifically tried and did NOT break:** a `/Rotate 90` source
page (box drawn against the rotated preview lands on the same content in the separately
re-rendered output — `adv-rot90.pdf`), page→box mapping and page order across a 5-page
document with boxes on non-contiguous pages 1/3/5 (`adv-multi5.pdf`), and cancelling a run
never leaving a downloadable result behind.

## Params (engine)

```go
// internal/ops/imagestopdf.go — extended, not a new op
type ImagesToPDFParams struct {
    PageSize    string  `json:"pageSize"`              // ... | "exact"
    Orientation string  `json:"orientation"`            // ignored for "exact"
    Width       float64 `json:"width,omitempty"`        // points, "exact" only
    Height      float64 `json:"height,omitempty"`       // points, "exact" only
}
```

`Width`/`Height` must both be positive — `ERR_INVALID_PARAMS` otherwise.

## UI states

Idle → loaded (page preview + box editor, page navigation, output quality controls) →
redacting (per-page progress) → done → error. Password-protected input follows the same
prompt flow as every other render-worker tool (PdfToImage, ExtractText).

## Fixtures

`web/e2e/fixtures/redact-secret.pdf` — one page, two real vector-text stamps
(`"SECRET-9F3A1B47"` bottom-left, `"PUBLIC-KEEP-VISIBLE"` top-right), built via
`go run ./cmd/genfixtures -redact` and committed (like `text-page.pdf`) rather than
regenerated per run, since Playwright can't run the Go generator itself.

`web/e2e/fixtures/adv-{rot90,multi5,encrypted,mixed}.pdf` — the four adversarial-review
fixtures (see "Adversarial review" above for what each one specifically targets), built
via `go run ./cmd/genfixtures -adversarial` and committed for the same reason. Originally
generated by a separate, explicitly-"temporary" `cmd/advfixtures` binary the review agent
wrote for itself; folded into `cmd/genfixtures` afterward rather than left as a second,
overlapping fixture generator now that its output is permanent, depended-on
infrastructure, not scratch work.
