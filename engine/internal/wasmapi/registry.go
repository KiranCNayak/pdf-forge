//go:build js && wasm

// Package wasmapi adapts ops to JavaScript.
//
// Ops REGISTER THEMSELVES from init(), so adding an operation means adding one
// file here and one in internal/ops — and editing no shared file. That matters
// when several people (or agents) work in parallel: a central switch statement
// would make every task collide with every other task.
//
// See docs/PARALLEL.md.
package wasmapi

import (
	"encoding/json"
	"sort"
	"syscall/js"

	"github.com/kirancnayak/pdf-forge/engine/internal/bridge"
)

var registry = map[string]bridge.Handler{}

// Register adds an operation. Call it from init() in the op's own file.
// Panics on a duplicate name: two ops silently sharing a name is the kind of
// merge accident that should fail loudly at startup, not mysteriously at runtime.
func Register(name string, h bridge.Handler) {
	if _, dup := registry[name]; dup {
		panic("wasmapi: duplicate op registered: " + name)
	}
	registry[name] = h
}

// Install publishes every registered op on globalThis.__pdfforge and signals
// readiness. Called once from cmd/wasm.
func Install(version string) {
	api := map[string]any{
		"version": version,
		"ops":     opNames(),
	}
	for name, h := range registry {
		api[name] = bridge.Promisify(h)
	}
	js.Global().Set("__pdfforge", js.ValueOf(api))

	// Instantiation completing is not the same as the ops being callable, so the
	// worker waits for this rather than for WebAssembly.instantiate.
	if ready := js.Global().Get("__pdfforge_ready"); !ready.IsUndefined() {
		ready.Invoke()
	}
}

func opNames() []any {
	names := make([]string, 0, len(registry))
	for n := range registry {
		names = append(names, n)
	}
	sort.Strings(names)
	out := make([]any, len(names))
	for i, n := range names {
		out[i] = n
	}
	return out
}

// ---------------------------------------------------------------- helpers
//
// Argument layout for every op: (jobID, paramsJSON, ...buffers)
//
// Params travel as a JSON string rather than a js.Value so ops get real typed
// structs, and so adding a field never means touching the bridge.

// Params decodes the parameter payload.
func Params[T any](args []js.Value) (T, error) {
	var p T
	if len(args) < 2 {
		return p, bridge.Errf(bridge.CodeInvalid, "missing parameters")
	}
	raw := args[1].String()
	if raw == "" || raw == "{}" {
		return p, nil
	}
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		return p, bridge.Wrap(bridge.CodeInvalid, err, "could not read parameters")
	}
	return p, nil
}

// JobID correlates progress reports with the originating request.
func JobID(args []js.Value) string {
	if len(args) == 0 {
		return ""
	}
	return args[0].String()
}

// Progress returns a reporter bound to this job.
func Progress(args []js.Value) func(done, total int, stage string) {
	return bridge.ProgressReporter(JobID(args))
}

// Input copies the single input buffer.
func Input(args []js.Value) ([]byte, error) {
	if len(args) < 3 {
		return nil, bridge.Errf(bridge.CodeInvalid, "missing input file")
	}
	return bridge.BytesFromJS(args[2])
}

// Inputs copies an array of input buffers.
func Inputs(args []js.Value) ([][]byte, error) {
	if len(args) < 3 {
		return nil, bridge.Errf(bridge.CodeInvalid, "missing input files")
	}
	return bridge.BuffersFromJS(args[2])
}

// Bytes wraps a byte-slice result for return to JS.
func Bytes(b []byte, err error) (any, error) {
	if err != nil {
		return nil, err
	}
	return bridge.BytesToJS(b), nil
}

// NamedParts wraps a multi-output result, e.g. split.
func NamedParts[T any](parts []T, name func(T) string, data func(T) []byte, err error) (any, error) {
	if err != nil {
		return nil, err
	}
	arr := js.Global().Get("Array").New(len(parts))
	for i, p := range parts {
		o := js.Global().Get("Object").New()
		o.Set("name", name(p))
		o.Set("bytes", bridge.BytesToJS(data(p)))
		arr.SetIndex(i, o)
	}
	return arr, nil
}
