# Merge PDFs

**Route** `/merge-pdf` · **Phase** 1 · **Engine** Go

## Purpose

Combine 2+ PDFs into one, in a user-chosen order. The highest-traffic tool on every
competitor site, and the natural first tool to build — it exercises the whole bridge
(multi-buffer in, one buffer out, progress) without needing any rendering.

## Status

**Shipped** (`web/src/tools/Merge/tool.tsx`): drop or pick N files, page count per file,
up/down reorder, remove individual files, merge → download.

**Deferred:**

- Drag-to-reorder — shipped as up/down buttons instead. Same effect, no drag library.
- Divider page — `MergeParams.DividerPage` exists in the engine op but isn't exposed in
  the UI yet.
- Per-file password entry when one input is encrypted — currently surfaces as a per-file
  error instead of a password field.

## User flow

1. Drop or pick N files. Show name, size, page count for each (page count via a cheap
   `PageCount` call, not a full parse).
2. Drag to reorder. Remove individual files.
3. Optional: insert a divider page between documents.
4. Merge → download.

## Engine op

```go
// internal/ops/merge.go
type MergeParams struct {
    DividerPage bool `json:"dividerPage"`
}

func Merge(inputs [][]byte, p MergeParams) ([]byte, error)
```

```go
readers := make([]io.ReadSeeker, len(inputs))
for i, b := range inputs {
    readers[i] = bytes.NewReader(b)
}
var out bytes.Buffer
err := api.MergeRaw(readers, &out, p.DividerPage, conf)
```

`api.MergeRaw(rsc []io.ReadSeeker, w io.Writer, dividerPage bool, conf *model.Configuration) error`
— fully in memory, no filesystem.

## Memory

Peak ≈ `2 × Σ(input sizes)` for the copies, plus pdfcpu's object model for all documents
simultaneously, since merge must hold every source open at once. **This is the most
memory-hungry op relative to input size.** Enforce the device tier against the _sum_, not
the largest file.

Above the watermark, respawn the worker afterwards (`docs/LLD.md` §2.1).

## Edge cases

| Case                             | Behaviour                                                                   |
| -------------------------------- | --------------------------------------------------------------------------- |
| One input is encrypted           | `ERR_ENCRYPTED` naming _which_ file. Offer per-file password entry          |
| Mixed page sizes                 | Allowed — pdfcpu preserves each page's box. Warn in the UI, don't normalise |
| One input corrupt                | `ERR_CORRUPT` naming the file; let the user drop it and retry               |
| Single file supplied             | Disable the button; merging one file is a no-op, not an error               |
| Sum exceeds device tier          | `ERR_TOO_LARGE` before starting, showing the cap and the sum                |
| Duplicate file added twice       | Allow — merging a document with itself is legitimate                        |
| Form fields with colliding names | pdfcpu handles field renaming; verify against a fixture                     |

## UI states

Idle → files staged (reorderable) → merging (per-file progress) → done (size, page count,
download) → error (specific file named).

## Fixtures

`merge_a.pdf`, `merge_b.pdf` (different page sizes), `encrypted_aes256.pdf`,
`corrupt_xref.pdf`, `forms_named_fields.pdf` ×2 for the collision case.
