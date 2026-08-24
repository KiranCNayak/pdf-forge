# Encrypt PDF

**Route** `/encrypt-pdf` · **Phase** 1 · **Engine** Go

## Purpose

Add AES-256 password protection and permission flags. One of the strongest arguments for
the Go engine: `pdf-lib` — what every JS-based competitor uses — has no real encryption
support, so they either skip this tool or ship something weak.

## Status

**Shipped** (`web/src/tools/Encrypt/tool.tsx`): open + owner password, permission
checkboxes (print, modify contents, copy/extract, annotate/fill forms, assemble),
AES-256, a "no recovery" acknowledgment checkbox gating submission once an open password
is set.

**Deferred:**

- 128-bit / 40-bit key length — `EncryptParams.KeyLength` supports it, but the UI locks
  to 256 per this doc's own "advanced-only" call.
- Password strength meter.

## User flow

1. Pick a file.
2. Set an **open password** (user password) and/or an **owner password**.
3. Set permissions: print, copy, modify, annotate, fill forms, extract for accessibility,
   assemble, print high-resolution.
4. Encrypt → download.

## Engine op

```go
// internal/ops/encrypt.go
type EncryptParams struct {
    UserPW      string `json:"userPW"`
    OwnerPW     string `json:"ownerPW"`
    KeyLength   int    `json:"keyLength"`   // 256 (default) | 128 | 40
    Permissions int16  `json:"permissions"` // model.PermissionFlags bitfield
}

func Encrypt(input []byte, p EncryptParams) ([]byte, error)
```

```go
conf := model.NewDefaultConfiguration()
conf.UserPW = p.UserPW
conf.OwnerPW = p.OwnerPW
conf.EncryptUsingAES = true              // false would mean RC4 — never expose that
conf.EncryptKeyLength = p.KeyLength      // 256
conf.Permissions = model.PermissionFlags(p.Permissions)

var out bytes.Buffer
err := api.Encrypt(bytes.NewReader(input), &out, conf)
```

Verified against pdfcpu v0.15.0 `model.Configuration`: `EncryptUsingAES bool`,
`EncryptKeyLength int` (AES: 40/128/256), `Permissions PermissionFlags` (int16).

**Always AES-256.** RC4 is broken and 128-bit AES is only worth exposing for
compatibility with very old readers — and if we do expose it, the UI must say why it's
worse. Default the picker to 256 and treat anything lower as an advanced option.

## The user/owner password distinction

Worth stating in the UI, because most tools get this wrong and users are confused by it:

- **User password** — required to _open_ the document. Real protection.
- **Owner password** — governs permissions. Any reader can choose to ignore permission
  flags entirely; many do. An owner password with no user password is **advisory, not
  security**.

If the user sets only an owner password, say so plainly: "This restricts what compliant
readers allow, but anyone can still open the file, and some readers ignore these
restrictions." Do not let a privacy-first product imply protection it isn't providing.

## Params

| Field         | Notes                                            |
| ------------- | ------------------------------------------------ |
| `userPW`      | Empty means no open password                     |
| `ownerPW`     | Empty means pdfcpu uses the user password        |
| `keyLength`   | 256 default. 128/40 advanced-only                |
| `permissions` | See ISO-32000 Table 22 / `model.PermissionFlags` |

## Memory

Cheap. Encryption rewrites strings and streams but adds no significant structure.
Peak ≈ input copy + object model + output.

## Edge cases

| Case                               | Behaviour                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Input already encrypted            | `ERR_ENCRYPTED` — decrypt first. Offer to chain via remove-password                                           |
| Both passwords empty               | Block. Nothing to do                                                                                          |
| User and owner passwords identical | pdfcpu permits it; warn that permissions become meaningless                                                   |
| Password contains a space or tab   | **Rejected up front.** See the pdfcpu bug below                                                               |
| Accented / CJK password            | Works. Verified round-trip for `café`, `日本語パス`, `p@ssw0rd!`                                              |
| User forgets the password          | **Unrecoverable. Say this before encrypting, not after.** There is no reset, no server-side copy, no recovery |

## pdfcpu bug: passwords that encrypt but never decrypt

**Found during the Phase 0 spike. This one destroys user data silently.**

pdfcpu v0.15.0 prepares PDF 2.0 passwords in `crypto.go processInput` with:

```go
p := precis.NewIdentifier(precis.BidiRule, precis.Norm(norm.NFKC))
```

The comment says SASLprep. SASLprep is the **FreeformClass** (`precis.OpaqueString`),
which permits spaces. `NewIdentifier` builds an **IdentifierClass** profile, which does
not.

The failure is asymmetric and therefore vicious: encrypting with `"my password"`
**succeeds**, and every later attempt to decrypt it fails with
`precis: disallowed rune encountered`. The user is holding a file that nothing —
not our tool, not pdfcpu's CLI — will ever open again, and nothing warned them.

Our guard runs pdfcpu's own profile at _encrypt_ time, while the user can still choose
differently:

```go
var pdfcpuPasswordProfile = precis.NewIdentifier(precis.BidiRule, precis.Norm(norm.NFKC))
```

Covered by `TestEncryptRejectsPasswordsPdfcpuCannotDecrypt`. Keep it in lockstep with
pdfcpu — if a future version switches to `OpaqueString`, relax the guard and invert the
test rather than deleting it.

Worth reporting upstream.

## Security notes

- The password must **never** be written to localStorage, IndexedDB, the URL, or any log
  or telemetry. It exists in memory for the duration of the call and nowhere else.
- Don't put the password in the RPC `params` object if we ever add request logging — and
  don't add request logging.
- The generated file's name must not embed the password (a real mistake shipped by other
  tools).

## UI states

Idle → loaded → configuring (password fields with strength meter, permission checkboxes,
explicit "no recovery" warning) → encrypting → done → error.

## Fixtures

`plain.pdf`, `encrypted_aes256.pdf` (for the already-encrypted path), `forms.pdf`,
plus a unicode-password test case.
