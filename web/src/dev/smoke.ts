// Browser smoke test for the Go↔JS bridge.
//
// Native `go test` cannot reach this layer: buffer copying, promise resolution,
// progress relay, worker lifecycle and the Wasm-only failure modes only exist in
// a browser. The pdfcpu config-directory crash (ops/config_js.go) was invisible
// to every native test and broke the very first call in the browser.
//
// Run `await __smoke()` in the dev console, or from an automated browser driver.
// Dev-only — not included in production builds.

import { engine } from '../engine/EngineClient'

interface Result {
  name: string
  ok: boolean
  detail?: string
}

const fixture = (n: string) => fetch(`/fixtures/${n}`).then((r) => r.arrayBuffer())

export async function smoke(): Promise<string> {
  const results: Result[] = []
  const check = (name: string, ok: boolean, detail?: string) => results.push({ name, ok, detail })

  const timings: Record<string, string> = {}

  // Cold boot includes fetching and instantiating the Wasm module.
  const t0 = performance.now()
  const merged = await engine.merge([await fixture('sample-a.pdf'), await fixture('sample-b.pdf')], {})
  timings.coldBootMerge = `${(performance.now() - t0).toFixed(0)}ms`
  check('merge 3+2 pages', (await engine.pageCount(merged.slice().buffer)) === 5)

  const t1 = performance.now()
  await engine.merge([await fixture('sample-a.pdf'), await fixture('sample-b.pdf')], {})
  timings.warmMerge = `${(performance.now() - t1).toFixed(1)}ms`

  let progressEvents = 0
  await engine.merge(
    [await fixture('sample-a.pdf'), await fixture('sample-b.pdf')],
    {},
    () => progressEvents++,
  )
  check('progress crosses the bridge', progressEvents > 0, `${progressEvents} events`)

  // Security round trip, plus the distinction the UI depends on: a missing
  // password must not look like a wrong one.
  const enc = await engine.encrypt(await fixture('sample-a.pdf'), {
    userPW: 'hunter2',
    ownerPW: 'hunter2',
  })

  let missingCode = ''
  try {
    await engine.pageCount(enc.slice().buffer)
  } catch (e) {
    missingCode = (e as { code: string }).code
  }
  check('no password → ERR_ENCRYPTED', missingCode === 'ERR_ENCRYPTED', missingCode)

  let wrongCode = ''
  try {
    await engine.decrypt(enc.slice().buffer, { password: 'nope' })
  } catch (e) {
    wrongCode = (e as { code: string }).code
  }
  check('wrong password → ERR_BAD_PASSWORD', wrongCode === 'ERR_BAD_PASSWORD', wrongCode)

  const dec = await engine.decrypt(enc.slice().buffer, { password: 'hunter2' })
  check('encrypt/decrypt round trip', (await engine.pageCount(dec.slice().buffer)) === 3)

  // Multi-buffer return path.
  const parts = await engine.split(await fixture('sample-a.pdf'), { mode: 'each' })
  check(
    'split returns real byte arrays',
    parts.length === 3 && parts[0].bytes instanceof Uint8Array,
    `${parts.length} parts`,
  )

  const ex = await engine.extractPages(await fixture('sample-a.pdf'), { selection: '1,3' })
  check('extract 1,3 → 2 pages', (await engine.pageCount(ex.slice().buffer)) === 2)

  const rot = await engine.rotate(await fixture('sample-a.pdf'), { rotation: 90 })
  check('rotate 90', rot.byteLength > 0)

  let badRotate = ''
  try {
    await engine.rotate(await fixture('sample-a.pdf'), { rotation: 45 })
  } catch (e) {
    badRotate = (e as { code: string }).code
  }
  check('rotate 45 rejected', badRotate === 'ERR_INVALID_PARAMS', badRotate)

  // Every error the UI can show needs displayable copy attached.
  let userMessage = ''
  try {
    await engine.decrypt(enc.slice().buffer, { password: 'nope' })
  } catch (e) {
    userMessage = (e as { userMessage: string }).userMessage
  }
  check('userMessage present', !!userMessage, userMessage)

  // Compress: the fixtures carry no images, so this exercises the structural
  // pass and the result shape, not image shrinkage — that's covered by the Go
  // fixtures in compress_test.go. What only a browser can prove is that a
  // CompressResult with all its fields survives the worker round trip.
  const preset = await engine.compress(await fixture('sample-a.pdf'), {
    mode: 'preset',
    preset: 'ebook',
  })
  check(
    'compress (preset) returns a valid PDF',
    preset.bytes.byteLength > 0 && (await engine.pageCount(preset.bytes.slice().buffer)) === 3,
    `${preset.originalSize} -> ${preset.resultSize} bytes, fallback=${preset.fallback}`,
  )

  const target = await engine.compress(await fixture('sample-a.pdf'), {
    mode: 'target',
    targetBytes: 1,
  })
  check(
    'compress (target, unreachable) reports reachedTarget: false',
    target.reachedTarget === false,
    `${target.resultSize} bytes`,
  )

  const wm = await engine.addWatermark(await fixture('sample-a.pdf'), {
    text: 'DRAFT',
    fontSize: 24,
    color: 'gray',
    position: 'c',
    rotation: 0,
    opacity: 0.5,
    onTop: true,
  })
  check(
    'add watermark returns a valid PDF',
    wm.byteLength > 0 && (await engine.pageCount(wm.slice().buffer)) === 3,
    `${wm.byteLength} bytes`,
  )

  const noWm = await engine.hasWatermarks(await fixture('sample-a.pdf'))
  check('hasWatermarks false on a plain file', noWm === false)

  const removed = await engine.removeWatermark(wm.slice().buffer, {})
  const stillHasWm = await engine.hasWatermarks(removed.slice().buffer)
  check(
    'remove watermark round trip',
    removed.byteLength > 0 && stillHasWm === false && (await engine.pageCount(removed.slice().buffer)) === 3,
  )

  const noOp = await engine.removeWatermark(await fixture('sample-a.pdf'), {})
  check('remove watermark on a plain file is a no-op, not ERR_INTERNAL', noOp.byteLength > 0)

  const failed = results.filter((r) => !r.ok)
  const lines = [
    ...results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`),
    '',
    ...Object.entries(timings).map(([k, v]) => `${k}: ${v}`),
    '',
    failed.length === 0 ? `all ${results.length} checks passed` : `${failed.length} FAILED`,
  ]
  return lines.join('\n')
}
