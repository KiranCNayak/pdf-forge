//go:build js && wasm

package wasmapi

import (
	"syscall/js"

	"github.com/kirancnayak/pdf-forge/engine/internal/ops"
)

func init() {
	Register("encrypt", func(args []js.Value) (any, error) {
		p, err := Params[ops.EncryptParams](args)
		if err != nil {
			return nil, err
		}
		in, err := Input(args)
		if err != nil {
			return nil, err
		}
		return Bytes(ops.Encrypt(in, p, Progress(args)))
	})

	Register("decrypt", func(args []js.Value) (any, error) {
		p, err := Params[ops.DecryptParams](args)
		if err != nil {
			return nil, err
		}
		in, err := Input(args)
		if err != nil {
			return nil, err
		}
		return Bytes(ops.Decrypt(in, p, Progress(args)))
	})

	Register("isEncrypted", func(args []js.Value) (any, error) {
		in, err := Input(args)
		if err != nil {
			return nil, err
		}
		return ops.IsEncrypted(in)
	})
}
