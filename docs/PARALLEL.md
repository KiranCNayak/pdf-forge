# Working in parallel

How to run several agents (or people) on this repo at once without them fighting
each other.

The short version: **the repo is structured so that adding a tool or an operation
touches no shared file.** That property is deliberate and fragile — most of the
rules below exist to protect it.

---

## Why this needed design, not just process

The obvious way to add an operation is a `switch` in `cmd/wasm/main.go`. The obvious
way to add a tool page is another entry in `App.tsx`. Both work fine for one person
and fail badly for four: every task edits the same three lines, so every branch
conflicts with every other branch, and the conflicts are in exactly the code that is
easiest to resolve wrongly.

So both were replaced with self-registration:

| Instead of | We use |
| --- | --- |
| A switch in `cmd/wasm/main.go` | `wasmapi.Register()` from `init()` in the op's own file |
| A tool list in `App.tsx` | `import.meta.glob` over `tools/*/meta.ts` |

`cmd/wasm/main.go` is now four lines and should never change again. `App.tsx` renders
navigation from the registry and never names a tool.

---

## Lanes

Four lanes with no file overlap. One agent per lane; two agents in one lane will
collide.

### Lane A — Engine operations (Go)

**Owns:** `engine/internal/ops/`, `engine/internal/wasmapi/`, `engine/testdata/`

Adding an operation:

1. `engine/internal/ops/<name>.go` — params struct, function, doc comment pointing
   at `docs/tools/<name>.md`
2. `engine/internal/ops/<name>_test.go` — the happy path plus **every** `ERR_*` the
   op can produce
3. `engine/internal/wasmapi/<name>.go` — `func init() { Register(...) }`
4. One method on `EngineClient` (see the coordination note below)

Never edit `cmd/wasm/main.go`, `cmd/cli/main.go` or `registry.go` to add an op. If
you think you need to, the abstraction is wrong — say so rather than working around it.

### Lane B — Tool UIs (React)

**Owns:** `web/src/tools/<Name>/`

Adding a tool — create a directory with exactly two files:

```
web/src/tools/Rotate/
  meta.ts     export const meta: ToolMeta = { route, name, description, category }
  tool.tsx    export default function RotateTool() { ... }
```

That's the whole registration. No import anywhere, no route table, no nav entry.
Set `draft: true` in meta to keep something out of navigation while you build it.

Copy the shape of `web/src/tools/Merge/tool.tsx`: staged input → device-tier budget
check → engine call with progress → `EngineError.code` switch → download. The
heading and description are rendered by the shell from `meta.ts`; don't repeat them
in the component.

### Lane C — Signaling server (Go)

**Owns:** `signaling/` — does not exist yet, so this lane starts from an empty
directory and can run start-to-finish without touching anything else. The most
parallel-friendly work in the project. Design is in `docs/tools/p2p-share.md` §2.

### Lane D — Render pipeline (pdf.js)

**Owns:** `web/src/workers/render.worker.ts`, `web/src/lib/render/`

Rasterization, thumbnails, text extraction. Independent of the Go engine by the
boundary rule in `docs/HLD.md` §4 — Lane D never calls the engine and Lane A never
produces pixels. Feeds the pdf-to-image, pdf-to-zip, extract-text and organize-pages
tools.

---

## Shared files: the coordination points

These are the only files that more than one lane needs. There aren't many, and that's
the point.

| File | Who touches it | How to avoid a conflict |
| --- | --- | --- |
| `web/src/engine/EngineClient.ts` | Lane A, per new op | Append methods **at the end** of the ops section, never reorder |
| `web/src/engine/protocol.ts` | Lane A, per new op | Append to the `OpName` union, one name per line |
| `engine/go.mod`, `web/package.json` | Anyone adding a dependency | Announce first — see below |
| `docs/STATE.md` | Everyone, at the end of a task | Edit only your own row/bullet; never restructure |
| `web/src/styles.css` | Lane B, Lane D | Append a clearly-commented block; don't edit others' rules |

**Dependencies need a heads-up before they're added.** Two agents adding different
routers, or different date libraries, produces a mess that is tedious to unpick and
that neither of them can see coming. Ask first.

---

## Git worktrees

Each agent gets its own working directory sharing one repository, so branches don't
overwrite each other's files on disk:

```bash
./scripts/worktree.sh add lane-a-compress
```

That creates `../pdf-forge-lane-a-compress/` on a fresh branch off `main`. Work there
as normal. When done:

```bash
./scripts/worktree.sh remove lane-a-compress
```

Each worktree needs its own `npm install` (node_modules is not shared) and its own
`./scripts/build-wasm.sh` — the Wasm artifact is gitignored and per-directory.

---

## Conventions that keep merges clean

1. **One lane per branch, one branch per worktree.** Branch names: `lane-<letter>-<topic>`.
2. **Never reformat a file you aren't otherwise changing.** A gofmt or prettier sweep
   across the repo turns every open branch into a conflict.
3. **Append, don't reorder.** In shared lists — `OpName`, `EngineClient` methods, the
   category list — additions go at the end. Reordering rewrites lines someone else is
   editing.
4. **Both test layers.** Go changes need `go test ./...`. Bridge changes need
   `await __smoke()` in the browser. Native tests genuinely cannot catch Wasm-only
   failures — see `docs/STATE.md` for the one that bit us.
5. **Rebuild the Wasm after any `engine/` change.** Vite serves it as a static asset
   and won't do it for you.
6. **Update `docs/STATE.md` when your lane's state changes**, in a single surgical edit.
7. **Don't fix things outside your lane.** File it, mention it, move on. A drive-by fix
   in someone else's files is a conflict you chose to create.

---

## Before merging

The pre-push hook (`./scripts/install-hooks.sh`, one-time setup — see README) runs the
Go and web checks below automatically on `git push`. Run them by hand only to check
before you're ready to push:

```bash
cd engine && go test ./... && gofmt -l . && go vet ./...
```

```bash
./scripts/build-wasm.sh && cd web && npx tsc --noEmit && npm run build
```

Then `npm run dev` and `await __smoke()` — all checks must pass. The smoke test covers
the bridge, which is the part most likely to break from a merge and least likely to be
caught by anything else.

---

## Splitting the current work

Phase 1 engine ops all exist and are tested; the UIs do not. A reasonable four-way split
from here:

| Lane | Task |
| --- | --- |
| A | Compress — `docs/tools/compress.md`. The hardest and most valuable work |
| B | Tool pages for split, extractPages, rotate, encrypt, decrypt |
| C | Signaling server — `docs/tools/p2p-share.md` §2 |
| D | Render worker + PDF→JPG — `docs/tools/pdf-to-image.md` |

These four touch essentially disjoint files. B is several tools and could be split
further if the directories are assigned explicitly up front.

`organize-pages` deliberately isn't listed: it needs both Lane B and Lane D, so it
should wait until D lands rather than being built twice.
