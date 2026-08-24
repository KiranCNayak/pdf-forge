# Rotate PDF

**Route** `/rotate-pdf` · **Phase** 1 · **Engine** Go

## Purpose

Fix sideways or upside-down pages — usually scanner output. Rotate the whole document or
selected pages by 90/180/270.

## Status

**Shipped** (`web/src/tools/Rotate/tool.tsx`): pick one of 90°/180°/270°, apply to all
pages or a typed page selection.

**Deferred:**

- Thumbnail grid with per-page rotate buttons and CSS-preview — needs the render worker
  (`web/src/lib/render/`, built but not yet wired into any tool). A text field stands in
  for page selection meanwhile.
- Mixed per-page rotations (different pages by different amounts in one submit) — one
  rotation value applies to the whole selection per call.

## User flow

1. Pick a file.
2. Thumbnail grid with per-page rotate buttons, plus "rotate all left/right".
3. Live preview (thumbnails re-render at the new rotation without re-running the engine —
   apply a CSS transform, don't round-trip).
4. Apply → download.

## Engine op

```go
// internal/ops/rotate.go
type RotateParams struct {
    Rotation  int      `json:"rotation"`  // 90 | 180 | 270 | -90
    Selection []string `json:"selection"` // nil = all pages
}

func Rotate(input []byte, p RotateParams) ([]byte, error)
```

```go
var out bytes.Buffer
err := api.Rotate(bytes.NewReader(input), &out, p.Rotation, p.Selection, conf)
```

`api.Rotate(rs io.ReadSeeker, w io.Writer, rotation int, selectedPages []string, conf) error`

**Rotation is relative, not absolute** — it adds to the page's existing `/Rotate` value.
Two calls of 90 give 180. The UI tracks intended final orientation and sends the delta;
getting this backwards produces a tool that "randomly" fails on documents that already
carry a `/Rotate` entry, which is most scans.

### Mixed per-page rotations

`api.Rotate` takes one rotation for one selection. When the user has rotated different
pages by different amounts, group pages by delta and call once per distinct value,
chaining the output of each into the next:

```go
for delta, pages := range groups {   // e.g. {90: ["1","3"], 180: ["7"]}
    // feed previous output as next input
}
```

Chaining stays inside a single Wasm call — no bridge crossings, no intermediate Blobs.
This is the composition advantage noted in `docs/TOOL_CATALOG.md` under `/workflow`.

## Memory

Cheapest op in the catalog. Rotation touches only the page dictionary's `/Rotate` entry —
no content streams, no images. Peak ≈ input copy + object model + output, and chaining
adds one output-sized buffer per distinct delta group (at most three).

## Edge cases

| Case                          | Behaviour                                                       |
| ----------------------------- | --------------------------------------------------------------- |
| Rotation not a multiple of 90 | Reject in the UI. PDF `/Rotate` only accepts multiples of 90    |
| Negative rotation             | Normalise to `((r % 360) + 360) % 360` before sending           |
| Rotation of 0 / 360           | No-op. Disable the button rather than writing an identical file |
| Page already has `/Rotate 90` | Expected and common — remember rotation is additive             |
| Encrypted input               | `ERR_ENCRYPTED`                                                 |

## UI states

Idle → loaded (thumbnail grid, per-page and bulk controls, CSS-preview) → applying →
done → error.

## Fixtures

`scan_sideways.pdf` (pre-existing `/Rotate 90`), `pages_50.pdf`, `mixed_rotations.pdf`,
`encrypted_aes256.pdf`.
