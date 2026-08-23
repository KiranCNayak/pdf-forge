# pdf-forge

Browser-based PDF tools that never upload your file.

Every operation runs on your own machine — merge, split, compress, encrypt — with no
account, no watermark and no server holding your documents. Works offline after the first
load.

> **Status: Phase 0 complete.** The Go→WebAssembly engine runs end-to-end in a browser
> with eight operations, a native CLI, and a browser smoke test. Tool UIs beyond Merge
> are not built yet. See [docs/STATE.md](docs/STATE.md).

---

## What makes it different

The engine is **Go compiled to WebAssembly**, built on [pdfcpu](https://pdfcpu.io/),
rather than the collection of JavaScript libraries every comparable tool assembles.

That buys three things:

- **Operations JS can't do.** `pdf-lib` — the foundation of essentially every free
  browser PDF tool — cannot compress and has no real encryption support. Ours does both.
- **One engine, three targets.** The same `internal/ops` package serves the browser, a
  self-hostable CLI binary, and the benchmark harness.
- **A reasonable download for what it covers.** The engine is **3.0 MB Brotli'd** with
  eight operations linked — measured, not estimated. For comparison, the Ghostscript build
  ihatepdf.cv loads for compression *alone* is 10.4 MB Brotli. Adding operations is nearly
  free: going from one to eight cost 0.8 MB, because pdfcpu's fixed cost dominates.

The trade is honest rather than one-sided: on simple page operations, `pdf-lib` does the
job in a fraction of the bytes. We pay more on the cheap tools and far less on the
expensive one, and the engine loads once per version rather than once per tool.

It also means no CDN. Comparable tools load a dozen libraries from third-party CDNs at
runtime, which leaks every visitor's IP and *which tool they opened*. We bundle
everything, so "works offline" is a structural guarantee rather than a hope about cache
state.

## Documentation

| Doc | Contents |
| --- | --- |
| [HLD](docs/HLD.md) | System architecture, engine boundary, memory model, deployment, roadmap |
| [LLD](docs/LLD.md) | Go↔JS bridge contract, worker protocol, compress pipeline, build pipeline |
| [Tool catalog](docs/TOOL_CATALOG.md) | All 56 tools, phased — plus what's deferred and why |
| [Benchmarking](docs/BENCHMARKING.md) | Phase 5 measurement design |
| [Per-tool plans](docs/tools/) | Implementation detail for each V1 tool |
| [STATE](docs/STATE.md) | What exists today, what is still a guess, what to do next |
| [PARALLEL](docs/PARALLEL.md) | Working several lanes at once without conflicts |
| [CLAUDE.md](CLAUDE.md) | Working agreements and hard constraints |

## Roadmap

| Phase | Contents |
| --- | --- |
| 0 | Bridge spike — proves the Go→Wasm path and replaces estimated constants with measurements |
| 1 | Merge, split, extract pages, rotate, organize · encrypt, remove password |
| 2 | Compress · PDF→JPG, images→PDF, extract text, PDF→ZIP |
| 3 | P2P file share + Go signaling server |
| 4 | Office format conversion (~15 tools) |
| 5 | Benchmark harness |

V1 is Phases 1–2: twelve tools. The full in-scope target is 43.

## Stack

- **Engine** — Go 1.25, [pdfcpu](https://github.com/pdfcpu/pdfcpu) v0.15.0, `GOOS=js GOARCH=wasm`
- **Web** — Vite + React + TypeScript, pdf.js for rendering
- **Signaling** — Go WebSocket server (P2P share only; relays connection metadata, never file bytes)
- **Hosting** — Cloudflare Pages (static) + Fly.io (signaling)

## Prior art

The tool catalog and several design details were derived by studying
[ihatepdf.cv](https://www.ihatepdf.cv/), which demonstrates the client-side model well.
Its device-tier memory management and canvas discipline are genuinely good and we've
adopted both. Its published technical write-up describes a P2P signaling architecture that
[the shipped code does not implement](docs/tools/p2p-share.md) — our teardown documents
what it actually does.
