# Invert Colours

**Route** `/invert-pdf` · **Phase** 4 · **Engine** Hybrid

## Purpose

Flip every page to a dark background with light text and photo-negative images — a
"dark mode" pass over a whole PDF. A literal per-channel invert, not a colour-aware edit
(a photo doesn't get white-balance-corrected, it gets negated, same as any naive "invert
colours" filter).

## Same deviation as Redact, for the same reason

The catalog specs this as `Engine: Go`, "rewrite colour operators in content streams." As
with Redact and Flatten, pdfcpu has no content-stream operator rewriter — no way to find
every `rg`/`RG`/`g`/`G`/`k`/`K` color-setting operator in a page's content stream and
rewrite it, and no way to invert an embedded raster image's own pixel data without fully
decoding and re-encoding it. Building that from scratch, for every colour space PDFs
support (DeviceRGB, DeviceGray, DeviceCMYK, indexed, ICC-based...), is its own project —
the same conclusion `docs/tools/redact.md`'s "A deliberate deviation" section reached for
surgical text removal.

Shipped instead: `docs/tools/redact.md`'s full-page rasterize-and-rebuild architecture,
directly reused — render every page in the render worker, transform the decoded pixels
(here, `255 - value` per RGB channel instead of compositing black boxes), rebuild the
document from the transformed images via `imagesToPDF`'s `"exact"` mode. Same honest
cost, stated in the tool's own UI: the whole document loses text search and selection,
not just the pages actually inverted.

**A page a user leaves out of the selection is still rasterized** — reconstructing the
document at all means every page goes through render→image→rebuild regardless of which
pages get inverted — but keeps its _original_ colours, not inverted ones. Verified
directly: `web/e2e/invert-colours.spec.ts`'s second test inverts only page 1 of a 3-page
document and checks page 2's exact RGB value came back unchanged.

## Verified with exact pixel arithmetic, not a brightness threshold

Unlike Redact (where "is there a trace of the original left" only needs a wide
brightness margin) this tool's correctness is a precise, checkable arithmetic fact: a
pixel that started at `RGBA(200, 40, 40)` (one of `sample-a.pdf`'s solid known colours —
see `engine/cmd/genfixtures`) must come back near `(55, 215, 215)`. `web/e2e/invert-
colours.spec.ts` checks exactly that, PNG (lossless) end to end so the numbers aren't
muddied by JPEG's own re-encoding error.

## A copy-paste bug caught before it shipped, not after

Writing this tool by adapting Redact's `apply()` loop copied its cancel-check too — but
as a plain `useState` boolean instead of Redact's `cancelRef`. That's the exact bug
Redact's own code comment warns about: `apply()`'s closure is fixed at the render that
created it, so a state variable checked mid-loop would never see a later Cancel click
update it. Caught by re-reading the adapted code against Redact's own comment before
writing a test for it, not by a failing test — worth noting as a real case where the
"why", not just the "what", written into a comment earned its keep on the very next
tool built from it. Fixed by using a ref, matching Redact exactly, before this ever
shipped. The same review also applied Redact's other post-adversarial-review fix
proactively: every page-selection/DPI/format control is disabled while a run is in
flight, so the visible UI state can never diverge from what a running `apply()` closure
is actually using.

## UI states

Idle → loaded (page selection, output quality controls) → inverting (per-page progress)
→ done → error. Same password-prompt flow as every other render-worker tool.

## Fixtures

`sample-a.pdf` — its three pages' known, solid RGB values (`engine/cmd/genfixtures`) are
what make an exact-value pixel check possible, rather than a wide brightness threshold.
