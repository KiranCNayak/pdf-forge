//go:build js && wasm

package wasmapi

import (
	"syscall/js"

	"github.com/kirancnayak/pdf-forge/engine/internal/ops"
)

func init() {
	Register("addWatermark", func(args []js.Value) (any, error) {
		p, err := Params[ops.WatermarkParams](args)
		if err != nil {
			return nil, err
		}
		in, err := Input(args)
		if err != nil {
			return nil, err
		}
		return Bytes(ops.AddWatermark(in, p, Progress(args)))
	})

	Register("removeWatermark", func(args []js.Value) (any, error) {
		p, err := Params[ops.RemoveWatermarkParams](args)
		if err != nil {
			return nil, err
		}
		in, err := Input(args)
		if err != nil {
			return nil, err
		}
		return Bytes(ops.RemoveWatermark(in, p, Progress(args)))
	})

	Register("hasWatermarks", func(args []js.Value) (any, error) {
		p, err := Params[struct {
			Password string `json:"password"`
		}](args)
		if err != nil {
			return nil, err
		}
		in, err := Input(args)
		if err != nil {
			return nil, err
		}
		return ops.HasWatermarks(in, p.Password)
	})
}
