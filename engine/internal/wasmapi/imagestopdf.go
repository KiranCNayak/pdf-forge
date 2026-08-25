//go:build js && wasm

package wasmapi

import (
	"syscall/js"

	"github.com/kirancnayak/pdf-forge/engine/internal/ops"
)

func init() {
	Register("imagesToPDF", func(args []js.Value) (any, error) {
		p, err := Params[ops.ImagesToPDFParams](args)
		if err != nil {
			return nil, err
		}
		in, err := Inputs(args)
		if err != nil {
			return nil, err
		}
		return Bytes(ops.ImagesToPDF(in, p, Progress(args)))
	})
}
