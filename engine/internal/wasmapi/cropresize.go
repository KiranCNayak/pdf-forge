//go:build js && wasm

package wasmapi

import (
	"syscall/js"

	"github.com/kirancnayak/pdf-forge/engine/internal/ops"
)

func init() {
	Register("crop", func(args []js.Value) (any, error) {
		p, err := Params[ops.CropParams](args)
		if err != nil {
			return nil, err
		}
		in, err := Input(args)
		if err != nil {
			return nil, err
		}
		return Bytes(ops.Crop(in, p, Progress(args)))
	})

	Register("resize", func(args []js.Value) (any, error) {
		p, err := Params[ops.ResizeParams](args)
		if err != nil {
			return nil, err
		}
		in, err := Input(args)
		if err != nil {
			return nil, err
		}
		return Bytes(ops.Resize(in, p, Progress(args)))
	})
}
