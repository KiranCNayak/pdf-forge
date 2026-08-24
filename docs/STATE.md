# Current state

Updated 2026-08-24. **Read this first** — it says what exists, what is proven, and what
the next task is. `docs/HLD.md` and `docs/LLD.md` say how it is meant to work; this file
says how far it actually got.

---

## What works today

Phase 0 is complete. The engine runs end-to-end in a browser.

| Layer | State |
| --- | --- |
| `engine/internal/ops` | 9 ops: merge, split, extractPages, rotate, encrypt, decrypt, pageCount, isEncrypted, **compress** (Lane A, Phase 2: structural + imaging + metadata passes, presets and target-size search) |
| `engine/internal/bridge` | Error codes + `Classify`; `Promisify`, buffer copy, progress relay (js build tag) |
| `engine/internal/wasmapi` | Self-registering JS adapters; ops register from `init()` |
| `engine/cmd/wasm` | 4 lines. Calls `wasmapi.Install()` — never needs editing again |
| `engine/cmd/cli` | Same ops natively — `merge`, `split`, `extract`, `rotate`, `encrypt`, `decrypt`, `info` |
| `engine/cmd/genfixtures` | Test PDF generator |
| `web/src/engine/EngineClient.ts` | Worker lifecycle, RPC correlation, transferables, respawn policy |
| `web/src/workers/engine.worker.ts` | Hosts the Wasm instance; main thread never touches it |
| `web/src/workers/render.worker.ts`, `web/src/lib/render/` | Lane D: pdf.js render pipeline — `RenderClient` (worker lifecycle, matches `EngineClient`'s shape), page rasterization to JPEG/PNG via `OffscreenCanvas` (`getOptimalScale`/16,384px clamp, white-fill + `intent: 'print'` per `docs/tools/pdf-to-image.md`), and text extraction with line/paragraph/column reconstruction plus scanned/low-confidence detection (`docs/tools/extract-text.md`). Independent of the engine, per the boundary rule. Not yet imported by any tool UI — feeds pdf-to-image, pdf-to-zip, extract-text, organize-pages, all still to be built (Lane B). Adds `pdfjs-dist` to `web/package.json`, bundled locally (its own worker script pulled in via a Vite `?url` import, not a CDN) |
| `web/src/tools/registry.ts` | Filesystem-discovered tools via `import.meta.glob` |
| `web/src/lib/router.ts` | ~25-line hash router, no dependency |
| `web/src/tools/Merge` | Reference tool: `meta.ts` + `tool.tsx` — **copy this shape** |
| `web/src/tools/{Split,ExtractPages,Rotate,Encrypt,RemovePassword}` | Lane B: five Phase 1 tool pages built on `EngineClient`, same staged-input → budget → call → error-switch → download shape. `Rotate`/`ExtractPages` skip the thumbnail picker (needs Lane D's render worker); `Split` offers per-part downloads instead of a ZIP (no zip dependency added — flag before adding one, per `docs/PARALLEL.md`) |
| `web/src/dev/smoke.ts` | 10-check browser smoke test |
| `signaling/` | WebSocket signaling server (Go module, `cmd/signaling`): room create/join/relay for SDP+ICE via `internal/hub`, per-IP rate limiting via `internal/wsserver`, Crockford-base32 room codes via `internal/roomcode`. 27 Go tests pass, gofmt clean, vet clean. See `signaling/README.md` |

48 Go tests pass. 10 browser checks pass. TypeScript is clean. Production build works.
Compress has no browser check yet — `__smoke()` predates it.

## Measured, not estimated

| | |
| --- | --- |
| Wasm binary | 18.29 MB raw / 4.37 MB gzip / **3.08 MB Brotli** (was 17.70/4.24/3.00 before compress) |
| Cold boot + merge | ~199 ms |
| Warm merge | ~12.4 ms |
| External requests at runtime | zero |

Adding ops is nearly free — going from one to eight added 0.8 MB. pdfcpu's fixed cost
dominates, so do not bother splitting the engine per tool.

## Still guesses

Flagged so nobody mistakes them for findings:

- `RESPAWN_AFTER_BYTES` (64 MB) in `EngineClient.ts` — arbitrary.
- `ENGINE_MULTIPLIER` (4.0) in `lib/device.ts` — the real pdfcpu heap multiplier is
  unmeasured. **The spike used 2 KB fixtures**, which proves correctness and says nothing
  about memory.
- Device tier caps — inherited from ihatepdf's JS-tuned numbers, not ours.

Measuring these needs a 100 MB+ fixture: `go run ./cmd/genfixtures -out /tmp/big -pages 500`.

---

## Commands

```bash
cd engine && go test ./...
```

```bash
./scripts/build-wasm.sh
```

```bash
cd web && npm install && npm run dev
```

Then open http://localhost:5173 and run `await __smoke()` in the console.

```bash
cd engine && go run ./cmd/cli info ../web/public/fixtures/sample-a.pdf
```

**Rebuild the Wasm after any change under `engine/`.** Vite serves
`web/public/wasm/engine.wasm` as a static asset and will not rebuild it for you — this
is the single easiest way to spend an hour debugging a change that was never compiled.

---

## Things that will bite you

Each of these cost real time during Phase 0. All are guarded now; the guards are load-bearing.

1. **Never do work directly inside a `js.FuncOf` callback.** It runs on the thread
   servicing the Wasm event loop; the worker hangs with no error and no timeout. Use
   `bridge.Promisify`, which spawns a goroutine.
2. **pdfcpu needs `model.ConfigPath = "disable"` under `GOOS=js`** — otherwise it tries
   to `mkdir /tmp` and dies on the first call. See `internal/ops/config_js.go`. No native
   test catches this.
3. **`js.CopyBytesToGo` needs a `Uint8Array`, not an `ArrayBuffer`.** Handing it a buffer
   copies zero bytes and surfaces much later as a confusing parse error.
4. **Measuring binary size needs a real call path.** `_ = ops.Merge` does not defeat
   dead-code elimination; pdfcpu drops out and you measure a bare runtime. Our first
   measurement was wrong by 3× this way.
5. **Rotation is relative**, not absolute — it adds to the page's existing `/Rotate`.
   Most scans already carry one.
6. **Don't use `api.Split` or `api.SplitByPageNr`.** They demand an output directory,
   which would drag a filesystem shim into the Wasm build. `api.Collect` does it in memory.
7. **Passwords with spaces are rejected on purpose.** pdfcpu encrypts them and then can
   never decrypt them. See `docs/tools/encrypt.md`.
8. **`api.UpdateImages` cannot downsample.** pdfcpu v0.15.0 rejects a replacement image
   whose pixel dimensions differ from the original, which is most of what compress does.
   Compress replaces the xref entry itself instead — `docs/LLD.md` §3.1 explains why that
   is safe. Also: extracting an image mutates its stream dict, so the context you plan on
   must never be the context you write.

---

## Next task

**Phase 1 UI**, plus whatever else runs alongside it. Routing exists; the engine ops for
Phase 1 exist and are tested. What is missing is a tool page per operation.

Build `split`, `extractPages`, `rotate`, `encrypt`, `decrypt` as directories under
`web/src/tools/`, each following `web/src/tools/Merge/`: a `meta.ts` and a `tool.tsx`,
with staged input → device-tier budget check → engine call with progress → typed error
handling on `EngineError.code` → download.

`organize-pages` needs pdf.js thumbnails and is the first tool to touch the render
worker — treat it as its own piece of work, not a fifth copy of the merge page.

After that, Phase 2 opens with compress, which is where the engine choice earns out and
where the design in `docs/LLD.md` §3 gets tested against reality.

**This work parallelises.** `docs/PARALLEL.md` defines four non-overlapping lanes —
engine ops, tool UIs, signaling server, render pipeline — and the worktree flow for
running them at once.

---

## Handing this to another agent

The repo is self-contained; no context from the originating conversation is required.
Point the agent at `CLAUDE.md` (constraints and commands), then this file (state), then
`docs/HLD.md` and `docs/LLD.md` (design), then the relevant `docs/tools/*.md`.

For **several** agents at once, `docs/PARALLEL.md` assigns lanes and lists the few
shared files that need coordination. Give each agent its own worktree
(`./scripts/worktree.sh add <lane>`) and exactly one lane.

The one thing not in the repo is the reverse-engineering of ihatepdf.cv that produced the
tool catalog. Its conclusions are recorded in `docs/HLD.md` §3 and
`docs/tools/p2p-share.md` §1 — including where that site's public write-up does not match
its shipped code, so do not treat that write-up as a reference.
