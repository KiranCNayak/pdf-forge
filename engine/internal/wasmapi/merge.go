//go:build js && wasm

package wasmapi

import (
	"syscall/js"

	"github.com/kirancnayak/pdf-forge/engine/internal/ops"
)

func init() {
	Register("merge", func(args []js.Value) (any, error) {
		p, err := Params[ops.MergeParams](args)
		if err != nil {
			return nil, err
		}
		in, err := Inputs(args)
		if err != nil {
			return nil, err
		}
		return Bytes(ops.Merge(in, p, Progress(args)))
	})
}
