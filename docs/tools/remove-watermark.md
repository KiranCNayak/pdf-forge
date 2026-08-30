# Remove Watermark

**Route** `/remove-watermark` · **Phase** 4 · **Engine** Go

## Purpose

Strip a watermark someone else stamped onto a PDF — the removal counterpart to
[add-watermark](add-watermark.md), the same symmetry [remove-password](remove-password.md)
gives [encrypt](encrypt.md). Not on ihatepdf's own catalog (added directly from a user
request, not the reverse-engineering pass in `docs/HLD.md` §3), but squarely inside
what pdfcpu already does well: `pdfcpu inspect`/`pdfcpu stamp remove` exist as CLI verbs
for exactly this.

**This only removes watermarks pdfcpu itself applied** (or anything using the same
`/Artifact`-tagged form-XObject mechanism most third-party watermarking tools also use).
It cannot remove a watermark burned into the page's own content stream as ordinary
drawing operations with no watermark tag — pdfcpu has no way to distinguish "text that
happens to say DRAFT" from page content. Say this in the UI before the user waits through
an operation that does nothing.

## Status

**Shipped** (`web/src/tools/RemoveWatermark/tool.tsx`, added to
`engine/internal/ops/watermark.go`): pre-flight detection (`api.HasWatermarks`) shown as
soon as a file is picked, removal on all pages or a typed page selection — including
`even`/`odd`, since that's pdfcpu's own page-selection token syntax and needs no special
handling on our side (see Page selection below).

## User flow

1. Pick a file. Detect watermarks immediately (`api.HasWatermarks`) and say so plainly —
   "No watermark detected" is a valid, useful answer, not a dead end.
2. Choose all pages or a typed selection (`1-3, 5`, `even`, `odd`, `!7` — same syntax as
   [rotate](rotate.md)/[extract-pages](extract-pages.md)).
3. Remove → download.

## Engine op

```go
// internal/ops/watermark.go
type RemoveWatermarkParams struct {
    Selection []string `json:"selection,omitempty"` // nil/empty = all pages
    Password  string   `json:"password,omitempty"`
}

func RemoveWatermark(input []byte, p RemoveWatermarkParams, prog Progress) ([]byte, error)

func HasWatermarks(input []byte, password string) (bool, error)
```

```go
var out bytes.Buffer
err := api.RemoveWatermarks(bytes.NewReader(input), &out, p.Selection, conf)
```

`api.RemoveWatermarks(rs io.ReadSeeker, w io.Writer, selectedPages []string, conf) error`
— fully in memory, same shape as `AddWatermark`. `api.HasWatermarks(rs, conf) (bool, error)`
is the cheap pre-flight check, same role `isEncrypted`/`pageCount` play for other tools:
answer a question before the user commits to running an operation.

## Page selection: `even`/`odd` need nothing special

`Selection` is a `[]string` of raw pdfcpu tokens (`"1-3"`, `"5"`, `"even"`, `"odd"`,
`"!7"`), not a pre-parsed page-number set — the same convention `RotateParams.Selection`
and `WatermarkParams.Selection` already use. pdfcpu's own token handler
(`handlePageSelectionToken` in `pkg/api/selectPages.go`) recognises `even`/`odd` as
special tokens before falling through to range parsing, so a user typing `even` into the
same comma-separated text field every other selection-based tool already has gets exactly
what they asked for — no new UI, no new parsing, no new engine code beyond what
`AddWatermark`'s selection field already needed. This is the reason this doc doesn't have
a separate "Params" section for the odd/even variant the user asked about: it isn't a
variant, it's the existing syntax doing what it was always able to do.

## Params

| Field       | Notes                                                                                  |
| ----------- | -------------------------------------------------------------------------------------- |
| `selection` | pdfcpu page-selection tokens: ranges, `even`, `odd`, `!` exclusion. Empty = every page |
| `password`  | Only needed if the file is also encrypted                                              |

## Memory

Cheap — same profile as rotate/add-watermark. Removing a watermark deletes a form
XObject and its content-stream reference per page; no image decoding.

## Edge cases

| Case                                                                        | Behaviour                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No watermark present                                                        | Not an error. `HasWatermarks` says so up front; running removal anyway is a harmless no-op — literally: `api.RemoveWatermarks` itself errors ("no watermarks found") rather than no-oping, and `RemoveWatermark` (`engine/internal/ops/watermark.go`) catches exactly that message and hands back the original bytes unchanged rather than surfacing pdfcpu's internal wording as `ERR_INTERNAL` |
| Watermark burned into content stream, not tagged                            | Cannot be detected or removed — see the "This only removes..." note above. Say so, don't silently no-op with no explanation                                                                                                                                                                                                                                                                      |
| Selection resolves to zero pages                                            | `ERR_UNSUPPORTED`, same posture as `AddWatermark`'s own pre-check                                                                                                                                                                                                                                                                                                                                |
| Multiple stacked watermarks (added by running Add Watermark more than once) | All removed in one pass — pdfcpu iterates every watermarked XObject on the selected pages, not just the most recent                                                                                                                                                                                                                                                                              |
| Encrypted input                                                             | `ERR_ENCRYPTED`                                                                                                                                                                                                                                                                                                                                                                                  |

## UI states

Idle → loaded (watermark detected / not detected, page selection field) → removing →
done → error.

## Fixtures

`watermarked.pdf` (generated via this repo's own `AddWatermark`, not a third-party file —
keeps the fixture self-documenting), `plain.pdf` (no-watermark path),
`encrypted_aes256.pdf`.
