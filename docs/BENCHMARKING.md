# Benchmarking

**Phase 5 — deferred.** Designed now so the engine is built in a shape that makes it
cheap later. Nothing here is required for V1.

---

## Why this is nearly free

`engine/cmd/wasm` and `engine/cmd/cli` link the *same* `internal/ops` package. That gives
a native baseline at zero additional cost, and it means the interesting number —
**Wasm overhead vs native Go** — falls out of running one binary two ways.

Building the CLI from day one is what makes this possible. It is not a separate project;
it is `main.go` plus flag parsing.

## The question we are actually answering

Not "is Go faster than JavaScript" — that's unanswerable in the abstract and useless in
the specific. The three questions worth money:

1. **Is Go→Wasm fast enough** that the 1.32 MB download and the copy-in/copy-out overhead
   are worth it, versus `pdf-lib`?
2. **How much does Wasm cost us** against native Go — i.e. what is the ceiling if we ever
   run the same engine server-side for self-hosted deployments?
3. **Does our compressor hold up against Ghostscript**, given we lack font subsetting
   (`docs/LLD.md` §3.4)?

Question 3 is the one with a known bad answer on text-heavy input. Measuring it tells us
how much font subsetting is worth before we spend weeks on it.

## Matrix

| | merge | split | rotate | compress | encrypt |
| --- | --- | --- | --- | --- | --- |
| Go native (CLI) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Go → Wasm (browser) | ✓ | ✓ | ✓ | ✓ | ✓ |
| pdf-lib (JS) | ✓ | ✓ | ✓ | ✗ *(can't)* | ✗ *(can't)* |
| Ghostscript-Wasm | ✗ | ✗ | ✗ | ✓ | ✗ |

The gaps in the pdf-lib row are themselves a result. "The library everyone else builds on
cannot do two of these five operations" is the argument for the engine choice, stated as
data rather than assertion.

## Metrics

Speed alone is a misleading headline. Record all four:

| Metric | How | Why |
| --- | --- | --- |
| Wall time | `performance.now()` around the op, median of 5 runs after 1 warm-up | The obvious one |
| Peak memory | `performance.measureUserAgentSpecificMemory()` where available; Go native via `runtime.MemStats` | Determines device tiers; often the real constraint |
| Output size | bytes | **Essential for compress.** 3× faster and 40% worse is not a win |
| Fidelity | visual diff vs source render, SSIM per page | Catches a "fast" compressor that destroys the document |

Report speed and output size together, always. A benchmark table showing only time for a
compression tool is a marketing artifact, not a measurement.

## Fixture corpus

Reuses the per-tool fixtures, organised by shape:

| Fixture | Shape | Probes |
| --- | --- | --- |
| `text_only.pdf` | 50 pp, embedded fonts, no images | The font-subsetting gap |
| `images_heavy.pdf` | 30 pp, large photos | Our imaging pipeline's strength |
| `scanned_300dpi.pdf` | 100 pp, one image per page | The common real-world case |
| `forms.pdf` | AcroForm fields | Structural handling |
| `large_120mb.pdf` | Generated | Memory ceilings, worker respawn |
| `pages_500.pdf` | Generated | Per-page scaling |

Generated fixtures are produced by a script and **not committed** — a repo carrying a
120 MB binary is its own problem.

## Harness

- **Native:** Go benchmarks (`go test -bench`), `-benchmem` for allocations.
- **Browser:** Playwright driving a `/bench` route that runs the matrix and emits JSON.
  Chromium, Firefox and WebKit — WebKit matters because Safari lacks
  `navigator.deviceMemory` and has its own Wasm characteristics.
- **Mobile:** at minimum one real low-end Android device. Emulated results are not
  trustworthy for memory pressure, and mobile is exactly where the device tiers bite.

Output a committed `benchmarks/results-<date>.json` plus a generated markdown table, so
regressions across engine versions are visible in diffs.

## Honesty rules

Because these numbers will end up in marketing copy, and that's where benchmarks go to
become lies:

1. **Publish the losses.** If Ghostscript beats us on text-heavy compression, that goes in
   the table. A benchmark suite that only shows wins isn't a benchmark suite.
2. **Report medians and spread**, not best-of-N.
3. **State the hardware.** A desktop number presented without context is meaningless to a
   phone user, who is the person actually constrained.
4. **Never compare across different output quality** without saying so. Most PDF-tool
   benchmark claims in the wild are exactly this trick.
5. **Include the download cost.** 1.32 MB of Brotli'd engine is real latency on first use;
   a per-op speed win that takes 40 operations to repay the download should say so.
