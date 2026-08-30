/// <reference lib="webworker" />
//
// Hosts the Go Wasm engine. This is the ONLY place the Wasm instance exists —
// the main thread never instantiates it. See docs/LLD.md §1.1.

import type { Request, Response, SplitPart } from '../engine/protocol'

declare const self: DedicatedWorkerGlobalScope

// wasm_exec.js defines this. It is Go's own glue and we do not modify it.
declare class Go {
  importObject: WebAssembly.Imports
  run(instance: WebAssembly.Instance): Promise<void>
}

type PdfForge = Record<string, (...args: unknown[]) => Promise<unknown>>

declare global {
  // eslint-disable-next-line no-var
  var __pdfforge: PdfForge | undefined
  // eslint-disable-next-line no-var
  var __pdfforge_ready: (() => void) | undefined
  // eslint-disable-next-line no-var
  var __pdfforge_progress: ((id: string, done: number, total: number, stage: string) => void) | undefined
}

const post = (msg: Response, transfer: Transferable[] = []) => self.postMessage(msg, transfer)

// Go calls this directly; we relay to the main thread.
globalThis.__pdfforge_progress = (id, done, total, stage) => {
  post({ id, kind: 'progress', done, total, stage })
}

let ready: Promise<void> | null = null

function boot(): Promise<void> {
  if (ready) return ready

  ready = (async () => {
    // importScripts is unavailable in module workers, so load Go's glue by
    // evaluating it in global scope. wasm_exec.js is a classic script.
    const glue = await fetch('/wasm/wasm_exec.js').then((r) => r.text())
    // eslint-disable-next-line no-new-func
    new Function(glue).call(globalThis)

    const go = new Go()
    const { instance } = await WebAssembly.instantiateStreaming(
      fetch('/wasm/engine.wasm'),
      go.importObject,
    )

    const registered = new Promise<void>((resolve) => {
      globalThis.__pdfforge_ready = resolve
    })

    // Never await go.run(): it resolves only when Go's main returns, which for
    // us means the runtime has torn down. Await readiness instead — the ops
    // being registered is a later event than the module instantiating.
    void go.run(instance)
    await registered
  })()

  return ready
}

self.onmessage = async (e: MessageEvent<Request>) => {
  const { id, op, params, buffers } = e.data

  try {
    await boot()

    const api = globalThis.__pdfforge
    if (!api || typeof api[op] !== 'function') {
      throw Object.assign(new Error(`unknown op ${op}`), { code: 'ERR_INVALID_PARAMS' })
    }

    // Go's js.CopyBytesToGo needs a Uint8Array view, not a raw ArrayBuffer —
    // handing it a buffer silently copies zero bytes.
    const views = buffers.map((b) => new Uint8Array(b))
    // Every op takes one buffer except these three, which take a list — same
    // shape as Go's [][]byte / two-buffer params (MergeParams,
    // ImagesToPDFParams, AddImageWatermark's pdf+image pair).
    const multiBuffer = op === 'merge' || op === 'imagesToPDF' || op === 'addImageWatermark'
    const arg = multiBuffer ? views : views[0]

    const result = await api[op](id, JSON.stringify(params ?? {}), arg)

    // Detach the result so it moves rather than copies.
    const transfer: Transferable[] = []
    let payload: unknown = result

    if (result instanceof Uint8Array) {
      payload = result
      transfer.push(result.buffer as ArrayBuffer)
    } else if (Array.isArray(result)) {
      // split() returns [{ name, bytes }]
      payload = result as SplitPart[]
      for (const part of result as SplitPart[]) {
        if (part?.bytes instanceof Uint8Array) transfer.push(part.bytes.buffer as ArrayBuffer)
      }
    }

    post({ id, kind: 'ok', result: payload }, transfer)
  } catch (err: unknown) {
    const e2 = err as { code?: string; message?: string; userMessage?: string }
    post({
      id,
      kind: 'error',
      code: (e2?.code as Response extends { code: infer C } ? C : never) ?? ('ERR_INTERNAL' as never),
      message: e2?.message ?? String(err),
      userMessage: e2?.userMessage ?? 'Something went wrong.',
    })
  }
}

// Tell the client the worker itself is alive (distinct from the engine being ready).
post({ kind: 'ready' })
