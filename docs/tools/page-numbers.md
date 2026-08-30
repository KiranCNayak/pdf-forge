# Page Numbers

**Route** `/page-numbers` · **Phase** 4 · **Engine** Go

## Purpose

Stamp a page number (optionally "of N") onto every page. Pure UI layer over
[add-watermark](add-watermark.md)'s existing `addWatermark` op — **zero new engine code**.

## Why this needed no Go changes

pdfcpu's `AddWatermarks` substitutes format tokens inside the watermark text **per page,
during rendering** (`pkg/pdfcpu/format.Text`, called once per page from `stamp.go`'s
`textDescriptor`) — not once up front. `%p{offset}` means "page number + offset",
`%P` means "total page count". `AddWatermark` (`engine/internal/ops/watermark.go`)
already forwards `p.Text` to `api.TextWatermark` verbatim, so a text string like
`"Page %p0 of %P"` already produces the right number on every page with the code that
exists today.

`TestAddWatermarkSupportsPageNumberTokens` in `watermark_test.go` regression-tests this
specifically, so a future pdfcpu upgrade that changes the token format fails a Go test
first, not silently in this tool's UI.

## Status

**Shipped** (`web/src/tools/PageNumbers/tool.tsx`): format preset (number only / "Page X
of Y" / "X / Y"), a "start numbering at" field (translates to `%p{offset}`, offset =
start − 1), 6-point position preset (top/bottom × left/center/right), font size, color,
apply to all pages or a typed selection. Calls `engine.addWatermark` directly — no new
`EngineClient` method, no new wasm registration.

**Deferred:**

- Skip the first page (common for a cover page) — would need a page selection like `2-`
  combined with an offset that still counts the cover page as page 1 for display purposes
  (i.e. page 2 displays "1"). pdfcpu's `%p{offset}` is a flat additive offset applied
  uniformly to whatever pages are selected, so "start display numbering at 1 beginning on
  page 2" needs offset `-1` plus selection `2-` — mathematically already possible with
  today's fields, just not surfaced as a labelled preset. Revisit if this turns out to be
  the common case rather than an edge one.
- Roman numerals, letter sequences (`i, ii, iii` / `A, B, C`) — pdfcpu's token only emits
  Arabic numerals.

## User flow

1. Pick a file.
2. Choose a format: page number alone, "Page X of Y", or "X / Y".
3. Optional: "start numbering at" (default 1) for documents where the first page
   shouldn't be "1" (e.g. a cover page kept in the selection).
4. Position: one of 6 presets (top/bottom × left/center/right).
5. Font size and color.
6. Apply to all pages or a typed selection (same syntax as
   [extract-pages](extract-pages.md) — including `even`/`odd`, per
   [remove-watermark](remove-watermark.md)'s note on why that needs no special handling).
7. Apply → download.

## How the UI builds the watermark text

```ts
const offset = startAt - 1; // %p{offset} means offset + actual page number
const text =
  format === "n"
    ? `%p${offset}`
    : format === "n-of-total"
      ? `Page %p${offset} of %P`
      : `%p${offset} / %P`;
```

This `text` is handed to `engine.addWatermark` exactly like a literal string would be —
the tool has no idea it contains tokens, and doesn't need to.

## Params

Reuses `WatermarkParams` (see [add-watermark](add-watermark.md#params)) entirely. No new
params type. `onTop` is always `true` here (a page number hidden behind content is
useless) and `rotation` is always `0`.

## Edge cases

Inherits every edge case from [add-watermark](add-watermark.md#edge-cases) — same op,
same validation. One page-numbers-specific case:

| Case                                  | Behaviour                                                                                                                                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Start numbering at" is 0 or negative | Allowed — pdfcpu's offset arithmetic handles negative offsets fine (page 1 could display "0" or lower). Not blocked, since a legitimate use is numbering a document whose "real" page 1 is bound before this file |

## UI states

Idle → loaded (format preset, start-at field, position grid, style controls, selection
field) → applying → done → error.

## Fixtures

`plain.pdf`, `pages_10.pdf` (to see the sequence run), `encrypted_aes256.pdf`.
