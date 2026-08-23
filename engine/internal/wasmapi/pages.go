//go:build js && wasm

package wasmapi

import (
	"syscall/js"

	"github.com/kirancnayak/pdf-forge/engine/internal/ops"
)

func init() {
	Register("rotate", func(args []js.Value) (any, error) {
		p, err := Params[ops.RotateParams](args)
		if err != nil {
			return nil, err
		}
		in, err := Input(args)
		if err != nil {
			return nil, err
		}
		return Bytes(ops.Rotate(in, p, Progress(args)))
	})

	Register("extractPages", func(args []js.Value) (any, error) {
		p, err := Params[ops.ExtractParams](args)
		if err != nil {
			return nil, err
		}
		in, err := Input(args)
		if err != nil {
			return nil, err
		}
		return Bytes(ops.ExtractPages(in, p, Progress(args)))
	})

	Register("split", func(args []js.Value) (any, error) {
		p, err := Params[ops.SplitParams](args)
		if err != nil {
			return nil, err
		}
		in, err := Input(args)
		if err != nil {
			return nil, err
		}
		parts, err := ops.Split(in, p, Progress(args))
		return NamedParts(parts,
			func(s ops.SplitPart) string { return s.Name },
			func(s ops.SplitPart) []byte { return s.Bytes },
			err)
	})

	Register("pageCount", func(args []js.Value) (any, error) {
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
		return ops.PageCount(in, p.Password)
	})
}
