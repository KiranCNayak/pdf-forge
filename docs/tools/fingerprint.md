# Fingerprint

**Route** `/fingerprint-pdf` · **Phase** 4 · **Engine** Go

## Purpose

Stamp a unique, faint code onto every page of a document before sending it to a specific
recipient. If that copy leaks, the code identifies which recipient's copy it was —
`docs/TOOL_CATALOG.md`'s own framing, "per-recipient invisible marks for leak
attribution."

## What "invisible" means here

Genuinely invisible/steganographic watermarking (encoded in glyph kerning, whitespace
width, or pixel-level noise, undetectable without the extraction algorithm) is its own
research project, not something buildable as a wrapper over `AddWatermark` in this pass.
What's shipped instead is honest about the trade-off: real vector text, extractable and
technically visible if someone looks closely, but small (7pt), pale (`#cccccc` at 15%
opacity), and placed in all four corners rather than centre — unobtrusive at normal
reading size, present in the file regardless. This is the same "close the actual gap in
front of you rather than the idealized one" reasoning `docs/tools/redact.md` used for its
own deviation, just in the other direction: Redact needed to be _stronger_ than pdfcpu
could naturally support; Fingerprint's honest version is _weaker_ than "invisible"
technically implies, and says so.

Four corners, not one placement, because a single corner being cropped, covered by a
sticky note, or scanned with a wide margin trimmed would erase the only copy of a
one-placement mark. Four independent `engine.addWatermark` calls, chained exactly the way
`docs/tools/headers-footers.md` already chains two — this needed no new engine code at
all, the third tool in a row to reuse `AddWatermarks` for something other than a visible
watermark.

## Code generation

`{label}-{6 hex chars}`, or just the 6 hex chars if the label is left blank. The random
suffix (`crypto.getRandomValues`, not `Math.random`) is **always** appended, even to a
non-empty label — two recipients typo'd into the same label, or the same recipient given
the file twice, still get distinguishable codes. The full generated code is shown to the
user after the run so they can record which code went to whom; this tool has no
server-side memory of that mapping, by the app's own no-account, no-upload design — the
user is the only place that record can live.

## Verified

`AddWatermarks` doesn't discriminate on opacity or colour — a 15%-opacity, pale-gray,
7pt string is exactly as much real content-stream text as a bold black one, so the same
extractability guarantee `docs/tools/add-watermark.md` already established holds here
unchanged. `web/e2e/fingerprint.spec.ts` proves it isn't just theoretical: it feeds the
fingerprinted output through the app's own ExtractText tool — a second, independent code
path that decompresses and reads real page text — and confirms the generated code comes
back out, plus a second test confirming a blank label still produces a valid random-only
code.

## Params (engine)

None — zero new Go code, zero new `EngineClient` method. Four sequential calls to the
existing `addWatermark`:

```ts
{ text: code, fontSize: 7, color: '#cccccc', position: corner, rotation: 0, opacity: 0.15, onTop: true }
```

for `corner` in `tl, tr, bl, br`.

## Edge cases

| Case             | Behaviour                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Encrypted input  | Same password prompt flow as every other Go-engine tool; reused across all four chained calls                                        |
| Blank label      | Random-only 6-char code, not blocked                                                                                                 |
| Very small pages | Not specially handled — `AddWatermarks`' own corner-anchor positioning is what places the text, same as `AddWatermark`/`PageNumbers` |

## UI states

Idle → loaded → fingerprinting (per-corner progress, 4 steps) → done (code shown,
download) → error.

## Fixtures

`sample-a.pdf` (3-page, image-only — proves the stamp works even on a document with no
pre-existing text layer, since `AddWatermarks` inserts real text regardless).
