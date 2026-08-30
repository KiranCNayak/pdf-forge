# Flatten

**Route** `/flatten-pdf` · **Phase** 4 · **Engine** Hybrid

## Purpose

Bake filled form fields and annotations into static page content — the values stay
visible, the interactive fields don't. Finalize a filled-in form so it can't be edited
further, or make a document with comments/stamps render identically everywhere without
depending on a viewer's own annotation support.

## Same deviation as Redact and Invert Colours, for a related but distinct reason

The catalog specs this as `api.RemoveFormFields` + "annotation flattening." The first
half exists; the second doesn't, and the two don't compose into what "flatten" means.
Read directly in the vendored source (`pkg/pdfcpu/form/form.go`'s `RemoveFormFields`):
it deletes the field objects from the AcroForm field tree and the page's annotation
array. It does **not** first merge the field's current appearance stream into the page's
own content stream. Calling it on a filled-in field doesn't flatten the value into the
page — it makes the value **vanish**, interactivity and visible content both gone. That's
the opposite of this tool's job.

Shipped instead: the same full-page rasterize-and-rebuild architecture Redact and Invert
Colours already established, with no transform step at all — render every page, rebuild
the document from the images, unchanged pixels. Simpler than either of them, since
there's nothing to composite or invert.

## The load-bearing assumption, verified before writing any tool code

This design only works if the render worker actually **bakes a filled field's value
into the raster** rather than relying on a separate interactive DOM layer this app never
mounts. That's not a safe thing to assume silently, so it wasn't: pdf.js's own type
declarations state its default `annotationMode` is `AnnotationMode.ENABLE`, which
"includes all possible annotations (thus rendering both annotation layer and canvas
annotations)" — but rather than trust the doc comment alone (the same kind of trust that
burned Sign's own build, when a _different_ pdf.js assumption turned out to need a
Worker-specific fix), a real fixture was built and rendered first:
`cmd/genfixtures -flatten-form` creates a one-page PDF with a genuine AcroForm text field
widget (`api.Create` from pdfcpu's own declarative JSON page format, not a plain text
stamp — confirmed via `qpdf --qdf` to actually contain `/FT /Tx` and `/Widget`, not just
assumed from the generator code), value `"SECRET-FORM-VAL-9Q8W7E"`. Rendered through the
app's own PdfToImage tool at 300 DPI before this tool existed, the value came back
clearly legible in the resulting PNG. `web/e2e/flatten.spec.ts` keeps that exact proof as
a permanent regression test rather than a one-off manual check.

## What survives, what doesn't

Same table shape as `docs/tools/redact.md`'s, for the same reason (full-page
rasterization): filled field values and annotation appearances survive as pixels; the
fields, form structure, and annotation objects themselves don't; the rest of the
document's text search/selection is lost along with everything else, not just the fields
— the same honest cost Redact and Invert Colours both state in their own UI. Page count
and physical page size are preserved exactly via `imagesToPDF`'s `"exact"` mode, verified
directly here too (`web/e2e/flatten.spec.ts` checks the output keeps A4's aspect ratio).

## No page selection

Unlike Redact and Invert Colours, this tool has no per-page selection UI. "Flatten some
pages, leave others as-is" isn't a request this tool's actual purpose (finalize a filled
form, lock it from further editing) has a real use for — the whole document goes through
the same pipeline regardless of which pages happen to have a field or annotation on
them. A deliberate simplification, not an oversight.

## No pixel decode/re-encode roundtrip

Redact and Invert Colours both decode each rendered page into a bitmap, composite or
transform it, and re-encode. Flatten has no transform, so `tool.tsx` skips that entirely
— the render worker's own encoded bytes go straight into `imagesToPDF` unchanged, one
fewer step than either of its siblings.

## UI states

Idle → loaded (output quality controls only) → flattening (per-page progress) → done →
error. Same password-prompt flow as every other render-worker tool.

## Fixtures

`form-fixture.pdf` (`go run ./cmd/genfixtures -flatten-form`) — a real AcroForm text
field, not a stamp, which is the whole point: this tool's correctness claim is
specifically about form fields, and a plain text stamp would prove nothing about
`RemoveFormFields`'s actual (wrong) behavior or pdf.js's actual (right) one.
