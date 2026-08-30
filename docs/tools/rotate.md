# Rotate PDF

**Route** `/rotate-pdf` · **Phase** 1 · **Engine** Go

## Purpose

Fix sideways or upside-down pages — usually scanner output. Rotate the whole document or
selected pages by 90/180/270.

## Status

**Shipped** (`web/src/tools/Rotate/tool.tsx`): pick one of 90°/180°/270°, apply to all
pages or a typed page selection.

**Deferred, decided against building here:**

- Thumbnail grid with per-page rotate buttons and CSS-preview. The render worker this
  needed didn't exist when this doc was first written; it does now
  (`web/src/lib/render/`), and `web/src/tools/OrganizePages` already builds exactly this
  UI — a thumbnail grid with per-page rotate, wired to the render worker for previews and
  the `organize` Go op to apply. Building a second, Rotate-specific thumbnail grid would
  duplicate that surface for the one case it doesn't already cover (rotating everything,
  or a typed range, by a single angle) — which the current text-field selection already
  handles directly and more quickly than clicking through thumbnails would. Revisit only
  if user feedback specifically asks for visual rotation on this route rather than a
  detour through Organize.
- Mixed per-page rotations (different pages by different amounts in one submit) — one
  rotation value applies to the whole selection per call. `OrganizePages`'s per-page
  rotate button covers this case today; folding it into Rotate itself would need the same
  thumbnail grid just deferred above.

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
