//go:build js && wasm

package bridge

import (
	"fmt"
	"syscall/js"
)

// Handler is an operation exposed to JavaScript. It runs on its own goroutine,
// never on the Wasm event loop.
type Handler func(args []js.Value) (any, error)

// Promisify wraps a Handler so JavaScript receives a Promise.
//
// This is not a convenience — it is required for correctness. A js.FuncOf
// callback executes on the single Go thread servicing the Wasm event loop. Doing
// real work inline, or blocking on anything JavaScript, hangs the worker
// permanently: no error, no timeout, no stack. It also will not reproduce in a
// small test, because small inputs finish before you notice.
//
// Every exported op goes through here. See docs/LLD.md §1.4.
func Promisify(fn Handler) js.Func {
	return js.FuncOf(func(_ js.Value, args []js.Value) any {
		// Copy the arguments now. js.Value references are only valid while the
		// callback frame lives; reading them later from the goroutine is a
		// use-after-free in slow motion.
		argv := make([]js.Value, len(args))
		copy(argv, args)

		var handler js.Func
		handler = js.FuncOf(func(_ js.Value, pr []js.Value) any {
			resolve, reject := pr[0], pr[1]

			go func() {
				// Release after the promise settles, not when Promisify
				// returns — an op invoked a thousand times would otherwise leak
				// a thousand js.Func values.
				defer handler.Release()
				defer func() {
					if r := recover(); r != nil {
						reject.Invoke(errorValue(CodeInternal, fmt.Sprint(r)))
					}
				}()

				res, err := fn(argv)
				if err != nil {
					code := Classify(err)
					reject.Invoke(errorValue(code, err.Error()))
					return
				}
				resolve.Invoke(res)
			}()

			return nil
		})

		return js.Global().Get("Promise").New(handler)
	})
}

// errorValue builds the object a rejected promise carries. The worker forwards
// these fields verbatim; the UI switches on `code` and never parses `message`.
func errorValue(code Code, message string) js.Value {
	obj := js.Global().Get("Object").New()
	obj.Set("code", string(code))
	obj.Set("message", message)
	obj.Set("userMessage", UserMessage(code))
	return obj
}

// BytesFromJS copies a Uint8Array into Go memory.
//
// js.CopyBytesToGo requires a Uint8Array — an ArrayBuffer will silently copy
// zero bytes, which surfaces much later as an unhelpful parse error. Callers
// pass views, never raw buffers.
func BytesFromJS(v js.Value) ([]byte, error) {
	if v.IsUndefined() || v.IsNull() {
		return nil, Errf(CodeInvalid, "expected a Uint8Array, got %s", v.Type())
	}
	n := v.Get("byteLength")
	if n.IsUndefined() {
		return nil, Errf(CodeInvalid, "value is not a typed array")
	}
	buf := make([]byte, n.Int())
	if copied := js.CopyBytesToGo(buf, v); copied != len(buf) {
		return nil, Errf(CodeInternal, "copied %d of %d bytes from JS", copied, len(buf))
	}
	return buf, nil
}

// BytesToJS copies Go bytes into a fresh Uint8Array.
func BytesToJS(b []byte) js.Value {
	arr := js.Global().Get("Uint8Array").New(len(b))
	js.CopyBytesToJS(arr, b)
	return arr
}

// BuffersFromJS copies an array of Uint8Arrays.
func BuffersFromJS(v js.Value) ([][]byte, error) {
	if v.IsUndefined() || v.IsNull() {
		return nil, Errf(CodeInvalid, "expected an array of files")
	}
	n := v.Length()
	out := make([][]byte, 0, n)
	for i := range n {
		b, err := BytesFromJS(v.Index(i))
		if err != nil {
			return nil, Errf(CodeInvalid, "file %d: %v", i+1, err)
		}
		out = append(out, b)
	}
	return out, nil
}

// ProgressReporter returns a callback that forwards progress to JS. The returned
// function is safe to call from the op's goroutine.
//
// jobID correlates the report with the originating request, since one worker may
// have a job cancelled and replaced while a stale goroutine is still winding down.
func ProgressReporter(jobID string) func(done, total int, stage string) {
	return func(done, total int, stage string) {
		fn := js.Global().Get("__pdfforge_progress")
		if fn.IsUndefined() || fn.IsNull() {
			return
		}
		fn.Invoke(jobID, done, total, stage)
	}
}
