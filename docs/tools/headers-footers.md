# Headers & Footers

**Route** `/headers-footers` · **Phase** 4 · **Engine** Go

## Purpose

Stamp independent text into a header (top) and/or footer (bottom) band on every page —
document title, date, confidentiality line, page numbers, or any combination. Same
mechanism as [page-numbers](page-numbers.md): a pure UI layer over
[add-watermark](add-watermark.md)'s `addWatermark` op, **zero new engine code**.

## Why two text bands need two calls, not one

`AddWatermarks` places exactly one watermark (one text, one position) per call. A header
and a footer are two independent placements, so this tool makes **up to two sequential
`engine.addWatermark` calls**, chaining the first call's output bytes into the second
call's input:

```
original.pdf → addWatermark(header text, position: top)   → intermediate bytes
intermediate → addWatermark(footer text, position: bottom) → final bytes
```

This composes for free because every Go op here is `[]byte in, []byte out` with no
filesystem or shared state — the exact "chain ops in one pass" property
`docs/TOOL_CATALOG.md` calls out under `/workflow` as a structural advantage over
competitors that must round-trip through a Blob between steps. Skipping an empty field
(header or footer left blank) skips its call entirely rather than watermarking an empty
string.

## Status

**Shipped** (`web/src/tools/HeadersFooters/tool.tsx`): independent header and footer text
fields, each with its own left/center/right alignment, shared font size and color, apply
to all pages or a typed selection. Both fields accept the same `%p`/`%P` tokens
[page-numbers](page-numbers.md) uses — "Page %p0 of %P" works equally well typed directly
into either field here, so a header/footer with a running page count doesn't need the
separate Page Numbers tool.

**Deferred:**

- Independent selections for header vs. footer (e.g. footer on every page, header only
  from page 2 onward) — V1 applies one selection to both.
- A rule/divider line under the header or above the footer — would need
  `api.AddPDFWatermarks` with a tiny generated PDF, or content-stream drawing; out of
  scope for a text-only tool.

## User flow

1. Pick a file.
2. Type header text (optional) and choose its alignment (left/center/right).
3. Type footer text (optional) and choose its alignment (left/center/right).
4. Shared font size and color.
5. Apply to all pages or a typed selection (same syntax as
   [extract-pages](extract-pages.md), including `even`/`odd`).
6. Apply → download. At least one of header/footer must be non-empty.

## Params

No new params type — this file issues two `WatermarkParams`-shaped calls (see
[add-watermark](add-watermark.md#params)), one per non-empty field:

| Field    | Header call    | Footer call    |
| -------- | -------------- | -------------- |
| position | `tl`/`tc`/`tr` | `bl`/`bc`/`br` |
| onTop    | `true`         | `true`         |
| rotation | `0`            | `0`            |

## Edge cases

Inherits every edge case from [add-watermark](add-watermark.md#edge-cases) — same op,
called up to twice. One specific to this tool:

| Case                                                                                 | Behaviour                                                                                                                                                                |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Both header and footer empty                                                         | Blocked before the run starts — nothing to apply                                                                                                                         |
| Only one of the two filled in                                                        | Exactly one `addWatermark` call runs; the other is skipped, not called with empty text                                                                                   |
| Second call fails (rare — same file, same page count as the first call's own output) | Reports the second call's error; the file the user sees on error is the ORIGINAL, not the header-only intermediate — this tool never surfaces a partially-applied result |

## UI states

Idle → loaded (header field + alignment, footer field + alignment, style controls,
selection field) → applying header → applying footer → done → error.

## Fixtures

`plain.pdf`, `pages_10.pdf`, `encrypted_aes256.pdf`.
