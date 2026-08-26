# @core/crypto

Every cryptographic operation in Core lives in this directory. It is deliberately
small so that the zero-knowledge claim can be checked by reading one package
rather than a whole application.

If you are auditing Core, this is the only code you strictly have to read. If
something is wrong here, nothing else matters; if this is right, the worst the
rest of the app can do is fail to use it.

## Constraints

Enforced by lint rules and by review:

- no `react`, no `next`, no `node:*` — the package must run identically in a
  browser, in a Cloudflare Worker and in a test runner
- no network access
- no `Math.random` — all randomness comes from `random.ts`
- nothing is ever logged

## Layout

| File | Responsibility |
|---|---|
| `encoding.ts` | base64url, UTF-8, hex, concat, constant-time compare, buffer wiping |
| `random.ts` | `getRandomValues` wrappers, unbiased `randomInt`, shuffle |
| `kdf.ts` | Argon2id, HKDF split into Auth Key + Master Key, auth verifier, calibration |
| `aes.ts` | AES-256-GCM envelope: encrypt, decrypt, parse, validate |
| `account.ts` | Account Key generation, wrapping, recovery, master-password change |
| `blind-index.ts` | HMAC tags for server-side equality lookups |
| `sharing.ts` | ECDH P-256 key pairs and recipient-addressed encryption |

## The shape of the system

```
master password
   |
   v  Argon2id (m=64MiB, t=3, p=1)  -- the one expensive step
root key
   |
   +-- HKDF "core.auth.v1" --> Auth Key    --> server (as HMAC(pepper, authKey))
   |
   +-- HKDF "core.enc.v1"  --> Master Key
                                   |
                                   v  AES-GCM unwrap
                              Account Key
                                   |
                                   +--> encrypts every vault item
                                   +--> HKDF "core.blind-index.v1" --> index key
                                   +--> wraps the ECDH private key
```

The Account Key indirection is what makes a master-password change cost 32 bytes
of re-encryption instead of the entire vault.

## Ciphertext format

```
v1.<base64url iv>.<base64url ciphertext+tag>
```

Key wrappers additionally authenticate a fixed domain string as AES-GCM AAD
(`core.account-key.v1`, `core.private-key.v1`, `core.share.v1`) so that a
ciphertext cannot be moved between columns by a hostile server.

## Test vectors

`vectors/v1.json` pins the byte-level output of every primitive against fixed
inputs. `src/vectors.test.ts` verifies the implementation against it.

The vectors exist so that somebody else can write a compatible client — or check
that this one does what it claims — without trusting this repository's own test
suite. They use deliberately weak KDF parameters so verification is fast;
production parameters are in `@core/shared`.

Regenerate with:

```bash
node packages/crypto/scripts/generate-vectors.mjs
```

Every input is fixed, so regenerating should produce no diff. If it does, either
the format changed deliberately or something broke. Never commit a diff here you
cannot explain.

## What the tests actually assert

Beyond round trips:

- flipping **any single byte** of a ciphertext, its IV or its tag causes
  decryption to fail
- wrong key, tampered data and wrong AAD all fail with an **identical** error
- the master key cannot be exported, even by code inside this package
- 200 encryptions of the same plaintext produce 200 distinct IVs
- changing a master password leaves every existing ciphertext byte-for-byte
  unchanged and still readable
- `randomInt` is uniform for ranges that do not divide 2³² evenly
- blind-index tags differ across users for the same input

```bash
pnpm test                    # all of it
pnpm exec vitest run --coverage
```
