//go:build js && wasm

// Command wasm exposes the engine's operations to JavaScript.
//
// This file is deliberately tiny and should stay that way. Operations register
// themselves from init() in internal/wasmapi, so adding one never means editing
// here — which is what lets several people work on different ops without
// colliding. See docs/PARALLEL.md.
package main

import (
	"github.com/kirancnayak/pdf-forge/engine/internal/wasmapi"
)

const version = "0.1.0"

func main() {
	wasmapi.Install(version)

	// Returning from main tears down the Go runtime and every registered
	// callback with it. This select is load-bearing.
	select {}
}
