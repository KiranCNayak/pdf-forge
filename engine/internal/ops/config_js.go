//go:build js && wasm

package ops

import "github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"

// pdfcpu keeps a configuration directory on disk and creates it on first use.
// Under GOOS=js there is no filesystem, so NewDefaultConfiguration fails with
// "config problem: mkdir /tmp: not implemented on js" — and it fails on the very
// first operation, before any PDF is touched.
//
// Setting ConfigPath to the sentinel "disable" makes pdfcpu skip config loading
// entirely and use its built-in defaults, which is exactly what we want: we
// configure everything explicitly in ops.go and have no use for a user config
// file in a browser tab.
//
// This is a Wasm-only failure. Native `go test` never reaches it, which is why
// the browser smoke test in web/ is not optional.
func init() {
	model.ConfigPath = "disable"
}
