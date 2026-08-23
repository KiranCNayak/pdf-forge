//go:build js && wasm

// Command wasm exposes the engine's operations to JavaScript.
//
// It registers everything on globalThis.__pdfforge, signals readiness, and then
// blocks forever. Returning from main tears down the Go runtime and every
// registered callback with it, so the select{} at the bottom is load-bearing.
package main

import (
	"encoding/json"
	"syscall/js"

	"github.com/kirancnayak/pdf-forge/engine/internal/bridge"
	"github.com/kirancnayak/pdf-forge/engine/internal/ops"
)

// Argument layout for every op: (jobID, params JSON string, ...buffers)
//
// Params travel as a JSON string rather than a js.Value object so the Go side
// gets real typed structs with no reflection over JS values, and so adding a
// field never means touching the bridge.
func params[T any](args []js.Value, idx int) (T, error) {
	var p T
	if len(args) <= idx {
		return p, bridge.Errf(bridge.CodeInvalid, "missing parameters")
	}
	raw := args[idx].String()
	if raw == "" {
		return p, nil
	}
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		return p, bridge.Wrap(bridge.CodeInvalid, err, "could not read parameters")
	}
	return p, nil
}

func jobID(args []js.Value) string {
	if len(args) == 0 {
		return ""
	}
	return args[0].String()
}

func main() {
	api := map[string]any{
		"version": "0.1.0",

		"merge": bridge.Promisify(func(args []js.Value) (any, error) {
			p, err := params[ops.MergeParams](args, 1)
			if err != nil {
				return nil, err
			}
			inputs, err := bridge.BuffersFromJS(args[2])
			if err != nil {
				return nil, err
			}
			out, err := ops.Merge(inputs, p, bridge.ProgressReporter(jobID(args)))
			if err != nil {
				return nil, err
			}
			return bridge.BytesToJS(out), nil
		}),

		"rotate": bridge.Promisify(func(args []js.Value) (any, error) {
			p, err := params[ops.RotateParams](args, 1)
			if err != nil {
				return nil, err
			}
			in, err := bridge.BytesFromJS(args[2])
			if err != nil {
				return nil, err
			}
			out, err := ops.Rotate(in, p, bridge.ProgressReporter(jobID(args)))
			if err != nil {
				return nil, err
			}
			return bridge.BytesToJS(out), nil
		}),

		"extractPages": bridge.Promisify(func(args []js.Value) (any, error) {
			p, err := params[ops.ExtractParams](args, 1)
			if err != nil {
				return nil, err
			}
			in, err := bridge.BytesFromJS(args[2])
			if err != nil {
				return nil, err
			}
			out, err := ops.ExtractPages(in, p, bridge.ProgressReporter(jobID(args)))
			if err != nil {
				return nil, err
			}
			return bridge.BytesToJS(out), nil
		}),

		"split": bridge.Promisify(func(args []js.Value) (any, error) {
			p, err := params[ops.SplitParams](args, 1)
			if err != nil {
				return nil, err
			}
			in, err := bridge.BytesFromJS(args[2])
			if err != nil {
				return nil, err
			}
			parts, err := ops.Split(in, p, bridge.ProgressReporter(jobID(args)))
			if err != nil {
				return nil, err
			}
			out := js.Global().Get("Array").New(len(parts))
			for i, part := range parts {
				o := js.Global().Get("Object").New()
				o.Set("name", part.Name)
				o.Set("bytes", bridge.BytesToJS(part.Bytes))
				out.SetIndex(i, o)
			}
			return out, nil
		}),

		"encrypt": bridge.Promisify(func(args []js.Value) (any, error) {
			p, err := params[ops.EncryptParams](args, 1)
			if err != nil {
				return nil, err
			}
			in, err := bridge.BytesFromJS(args[2])
			if err != nil {
				return nil, err
			}
			out, err := ops.Encrypt(in, p, bridge.ProgressReporter(jobID(args)))
			if err != nil {
				return nil, err
			}
			return bridge.BytesToJS(out), nil
		}),

		"decrypt": bridge.Promisify(func(args []js.Value) (any, error) {
			p, err := params[ops.DecryptParams](args, 1)
			if err != nil {
				return nil, err
			}
			in, err := bridge.BytesFromJS(args[2])
			if err != nil {
				return nil, err
			}
			out, err := ops.Decrypt(in, p, bridge.ProgressReporter(jobID(args)))
			if err != nil {
				return nil, err
			}
			return bridge.BytesToJS(out), nil
		}),

		"pageCount": bridge.Promisify(func(args []js.Value) (any, error) {
			p, err := params[struct {
				Password string `json:"password"`
			}](args, 1)
			if err != nil {
				return nil, err
			}
			in, err := bridge.BytesFromJS(args[2])
			if err != nil {
				return nil, err
			}
			n, err := ops.PageCount(in, p.Password)
			if err != nil {
				return nil, err
			}
			return n, nil
		}),

		"isEncrypted": bridge.Promisify(func(args []js.Value) (any, error) {
			in, err := bridge.BytesFromJS(args[2])
			if err != nil {
				return nil, err
			}
			return ops.IsEncrypted(in)
		}),
	}

	js.Global().Set("__pdfforge", js.ValueOf(api))

	// Tell the worker the ops are registered. Instantiation completing is not
	// the same as being callable.
	if ready := js.Global().Get("__pdfforge_ready"); !ready.IsUndefined() {
		ready.Invoke()
	}

	select {} // never return
}
