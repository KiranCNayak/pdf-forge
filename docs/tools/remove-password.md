# Remove Password

**Route** `/remove-password` · **Phase** 1 · **Engine** Go

## Purpose

Decrypt a PDF you can already open, producing an unprotected copy.

**This is not password recovery.** pdfcpu decrypts using a password you supply; it does
not crack. Say so above the fold, because a large share of arriving traffic is looking for
recovery, and letting them discover that after uploading wastes their time and our
credibility.

## Status

**Shipped** (`web/src/tools/RemovePassword/tool.tsx`): matches this doc closely —
encryption detection, password prompt, wrong-password re-prompt with the file retained,
"not password recovery" messaging up front. Nothing notable deferred; this is the tool
that tracks its plan doc most closely.

## User flow

1. Pick a file. Detect encryption immediately (attempt a parse; `ERR_ENCRYPTED` confirms).
2. Prompt for the password, stating clearly that it must be one they know.
3. Decrypt → download.

## Engine op

```go
// internal/ops/decrypt.go
type DecryptParams struct {
    Password string `json:"password"`
}

func Decrypt(input []byte, p DecryptParams) ([]byte, error)
```

```go
conf := model.NewDefaultConfiguration()
conf.UserPW = p.Password
conf.OwnerPW = p.Password        // try as both — the user rarely knows which they have

var out bytes.Buffer
err := api.Decrypt(bytes.NewReader(input), &out, conf)
```

Setting the same value as both user and owner password is deliberate: users know "the
password", not which of PDF's two roles it fills. pdfcpu will match whichever applies.

## Detection

Cheap pre-check so the UI can prompt before the user hits a button:

```go
_, err := api.ReadAndValidate(bytes.NewReader(input), model.NewDefaultConfiguration())
// classify(err) == ERR_ENCRYPTED  →  encrypted
```

## Memory

Cheap — same profile as encrypt.

## Edge cases

| Case                                     | Behaviour                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Wrong password                           | `ERR_BAD_PASSWORD`. **Keep the file staged** and re-prompt; making them re-pick the file for a typo is hostile                  |
| Input not encrypted                      | Not an error. Say "this file isn't password protected" and offer the original back                                              |
| Owner password only, empty user password | Opens without a password but has restrictions. Decrypting still removes the restrictions — this is the legitimate main use case |
| RC4-encrypted legacy file                | pdfcpu supports RC4 40/128 for _reading_. Decrypt works; output is unencrypted                                                  |
| Certificate-based encryption             | `ERR_UNSUPPORTED`. pdfcpu's `PrivateKeyPW` path exists but is out of V1 scope                                                   |
| Corrupt + encrypted                      | `ERR_CORRUPT` takes precedence; repair isn't available until Phase 4                                                            |

## Rate limiting / abuse

None needed, and none possible — everything runs locally with no server to protect. Worth
noting explicitly so nobody later adds a "security" measure that only inconveniences
legitimate users.

A brute-force attacker gains nothing from our UI that a local script wouldn't give them
faster. We are not the control point, and pretending otherwise would be theatre.

## Security notes

Same as [encrypt](encrypt.md): the password lives in memory for the call's duration and is
never persisted, logged, or placed in a URL. Clear the field on success.

## UI states

Idle → loaded (encryption detected / not detected) → password prompt → decrypting →
done → wrong-password (re-prompt, file retained) → error.

## Fixtures

`encrypted_aes256.pdf` (known password), `encrypted_rc4_128.pdf`,
`owner_pw_only.pdf`, `plain.pdf`, `corrupt_encrypted.pdf`.
