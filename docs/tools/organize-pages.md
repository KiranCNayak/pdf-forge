# Organize Pages

**Route** `/organize-pages` · **Phase** 1 · **Engine** Hybrid (Go ops, JS thumbnails)

## Purpose

One visual surface for reorder, delete, rotate and duplicate. The "power tool" that
subsumes several single-purpose tools — and the one users reach for when they don't know
which tool they need.

## User flow

1. Pick a file. Render a thumbnail grid (render worker, pdf.js).
2. Drag to reorder · click to delete · rotate individual pages · duplicate a page.
3. All edits are **local UI state** — nothing hits the engine until Apply.
4. Apply → single engine call → download.

The staged-edit model matters: a user reordering 40 pages must not trigger 40 engine
round-trips. Accumulate an intent list, then apply once.

## Engine op

```go
// internal/ops/organize.go
type PageOp struct {
    Source   int `json:"source"`   // 1-based page number in the ORIGINAL document
    Rotation int `json:"rotation"` // absolute delta to apply
}

type OrganizeParams struct {
    Pages []PageOp `json:"pages"`  // final order; omitted pages are deleted
}

func Organize(input []byte, p OrganizeParams) ([]byte, error)
```

Implementation: build a page-selection string from `Pages` (which handles reorder,
delete and duplicate in one go), then `api.Collect`, then group rotations and chain
`api.Rotate` calls — see [rotate](rotate.md).

```go
sel := selectionFromOps(p.Pages)          // e.g. ["3","1","1","7"]
var collected bytes.Buffer
api.Collect(bytes.NewReader(input), &collected, sel, conf)
// then rotate groups against collected, by POST-collect page index
```

**Index carefully.** `PageOp.Source` refers to the original document; rotations must be
applied using the *post-Collect* positions. Off-by-one here rotates the wrong page and is
easy to miss because the output is still a valid PDF.

`api.RemovePages` exists, but expressing everything through `Collect` gives one code path
for reorder + delete + duplicate instead of three.

## Memory

Two budgets running concurrently:

- **Render worker** — thumbnails. Cap at a low DPI (~72) and virtualise the grid; a
  500-page document must not hold 500 canvases. Release with
  `canvas.width = canvas.height = 0` when scrolled out.
- **Engine worker** — one Collect + up to three Rotate passes.

## Edge cases

| Case | Behaviour |
| --- | --- |
| Every page deleted | Block Apply. A 0-page PDF is invalid |
| No changes staged | Disable Apply |
| Duplicated page | Supported — the same source appears twice in the selection |
| Very large document | Virtualise thumbnails; render on demand, not upfront |
| Bookmarks | Outlines pointing at deleted/reordered pages break. Warn if the document has an outline |
| Encrypted input | `ERR_ENCRYPTED` |
| User reloads mid-edit | Staged edits live in memory only. Either persist to IndexedDB or warn on unload — don't silently lose 20 minutes of dragging |

## UI states

Idle → loaded (virtualised grid) → editing (undo/redo over the intent list) → applying →
done → error.

Undo/redo is over the intent list, not over engine calls — cheap, instant, and another
reason to stage.

## Fixtures

`pages_50.pdf`, `bookmarks.pdf`, `mixed_rotations.pdf`, generated 500-page file,
`encrypted_aes256.pdf`.
