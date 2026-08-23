//go:build js && wasm

package wasmapi

import (
	"syscall/js"

	"github.com/kirancnayak/pdf-forge/engine/internal/bridge"
	"github.com/kirancnayak/pdf-forge/engine/internal/ops"
)

func init() {
	Register("compress", func(args []js.Value) (any, error) {
		p, err := Params[ops.CompressParams](args)
		if err != nil {
			return nil, err
		}
		in, err := Input(args)
		if err != nil {
			return nil, err
		}

		res, err := ops.Compress(in, p, Progress(args))
		if err != nil {
			return nil, err
		}

		// Compress is the only op returning more than bytes: the skip counts are
		// UI copy ("4 skipped — transparency"), not diagnostics, so they have to
		// cross the boundary alongside the document.
		//
		// The worker transfers a bare Uint8Array result but structured-clones an
		// object, so these bytes are copied once more than a merge result is.
		// Worth it for an honest before/after panel; revisit if a profile says so.
		out := js.Global().Get("Object").New()
		out.Set("bytes", bridge.BytesToJS(res.Bytes))
		out.Set("originalSize", res.OriginalSize)
		out.Set("resultSize", res.ResultSize)
		out.Set("reachedTarget", res.ReachedTarget)
		out.Set("fallback", res.Fallback)
		out.Set("imagesTouched", res.ImagesTouched)
		out.Set("imagesSkipped", res.ImagesSkipped)

		reasons := js.Global().Get("Object").New()
		for reason, n := range res.SkipReasons {
			reasons.Set(reason, n)
		}
		out.Set("skipReasons", reasons)

		return out, nil
	})
}
