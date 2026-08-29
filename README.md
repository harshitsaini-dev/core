<div align="center">

```
  ____ ___  ____  _____
 / ___/ _ \|  _ \| ____|
| |  | | | | |_) |  _|
| |__| |_| |  _ <| |___
 \____\___/|_| \_\_____|

 $ core unlock
 > deriving key ... argon2id
 > vault decrypted ... local only
```

**A zero-knowledge password, secret and `.env` manager you can actually self-host.**

[![License: MIT](https://img.shields.io/badge/license-MIT-00FF41?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/status-in%20development-orange?style=flat-square)](docs/roadmap.md)
[![PWA](https://img.shields.io/badge/PWA-offline%20first-00FF41?style=flat-square)](#)

</div>

---

> **Status: pre-alpha.** Core is being built in the open. It is not ready to
> hold your real passwords yet. Watch the repository or check
> [the roadmap](docs/roadmap.md) for the v1 target.

---

## What it is

Core stores two things that most tools force you to keep in two different
places:

- **Your accounts** — usernames, passwords, TOTP codes, recovery codes, security
  questions, cards, identities.
- **Your projects' secrets** — `.env` variables, scoped per project and per
  environment, with version history, diffs and one-click export.

It runs as an installable PWA, works fully offline, and looks like a terminal
because that is where developers already live.

## The one guarantee

**The server cannot read your data. Neither can whoever runs it.**

That is not a policy — it is the architecture. Encryption and decryption happen
entirely in your browser. What reaches the server is ciphertext and an
authentication verifier that cannot be reversed into your master password.

Give an attacker the database, the source code, the server and the production
`.env` file, and they still cannot recover a single stored password.

This has a consequence you must accept before using Core:

> **If you forget your master password and lose your Emergency Kit, your data is
> gone. Permanently. There is no reset, no recovery, and no support request that
> can help — including from the person hosting your instance.**

## How it works

```
Master Password
   │
   └── Argon2id ──► Root Key          one expensive derivation
                       │
                       ├── HKDF ──► Auth Key ──► server (peppered verifier only)
                       │
                       └── HKDF ──► Master Key
                                        │
                                        └── unwraps ──► Account Key
                                                            │
                                                            └── AES-256-GCM ──► your vault
```

- **Argon2id** key derivation, tuned so each attempt costs real time and memory.
  It runs once; HKDF then splits the result into two keys that can never be
  derived from one another.
- **AES-256-GCM** for every stored value, with a fresh IV each time and built-in
  tamper detection.
- A random **Account Key** encrypts your data and is itself wrapped by the key
  derived from your master password — so changing your password re-encrypts 32
  bytes instead of your entire vault.
- **Metadata is encrypted too.** Titles, URLs, folder names and `.env` keys. The
  operator should not learn which bank you use or that a project has a
  `STRIPE_SECRET_KEY`.
- Search and filtering run **client-side** over the decrypted vault, because the
  server has nothing to search.

Full details, including the key hierarchy and the data model, are in
[`docs/architecture.md`](docs/architecture.md). The threat model — what Core
protects against and what it does not — is in
[`docs/security.md`](docs/security.md).

## Planned features

A short version. The full catalogue is [`docs/features.md`](docs/features.md).

**Vault** — logins, secure notes, cards, identities, SSH keys, custom fields,
built-in TOTP, recovery codes, attachments, version history, trash with restore.

**Organisation** — fuzzy search, `Ctrl/Cmd+K` command palette, nested folders,
tags, colours, pins, multi-filter, sorting, grid or list.

**Developer** — projects and environments, syntax-highlighted `.env` editor,
drag-and-drop import, one-click export as `.env` or shell `export` lines,
per-variable history and diffs, mask/unmask all.

**PWA** — installable, fully offline read and write, swipe actions, haptics,
pull-to-refresh, bottom navigation, OLED-black theme.

**Security** — auto-lock, clipboard auto-clear, panic button, blur-all mode,
WebAuthn/passkey unlock, breach checking, audit log, rate limiting, account
lockout, Turnstile.

## Stack

| Layer     | Choice                             |
| --------- | ---------------------------------- |
| Framework | Next.js (App Router)               |
| Styling   | Tailwind CSS                       |
| State     | Zustand                            |
| Offline   | Dexie / IndexedDB + service worker |
| Crypto    | WebCrypto + Argon2id (WASM)        |
| Database  | Cloudflare D1 with Drizzle ORM     |
| Hosting   | Cloudflare Pages (Workers runtime) |
| Email     | Resend                             |
| CI        | GitHub Actions                     |

Every one of these has a free tier that covers personal use. Running your own
Core instance costs nothing.

## Self-hosting

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/harshitsaini-dev/core)

The button forks the repository, creates the D1 database and the KV namespace,
and deploys. Two things it cannot do for you:

- **Set `AUTH_PEPPER`** — 32 random bytes, added as a secret. Without it the
  server has nothing to hash auth verifiers against, and it will not start.
- **Run the migrations** — `pnpm db:migrate` against the new database.

Detailed instructions land with v1 — see
[`docs/self-hosting.md`](docs/self-hosting.md). The short version, by hand:

```bash
git clone https://github.com/harshitsaini-dev/core.git
cd core
pnpm install

pnpm cf d1 create core-vault         # paste the id into wrangler.toml
pnpm db:migrate:local                # create the tables
cp apps/web/.dev.vars.example apps/web/.dev.vars       # then add a local AUTH_PEPPER

pnpm dev
```

Then deploy. This is a Workers deploy rather than Pages, and the build does
not run on Windows — `docs/self-hosting.md` covers both, along with the API
token permission the Cloudflare template leaves out.

## Development

```bash
pnpm install
pnpm dev            # local dev server on :3000
pnpm check          # typecheck + lint + unit tests
pnpm test:watch     # unit tests in watch mode
```

On Windows there are batch wrappers for the dev server — `start.bat`,
`stop.bat`, `restart.bat` and `status.bat`. They take an optional port and act
on the process that owns it rather than on every `node.exe`, so they will not
disturb anything else you have running. `status.bat` also probes an API route,
which distinguishes "the port is open" from "the database is actually
reachable".

End-to-end tests run against a real browser:

```bash
pnpm e2e:install    # one-time: download the browsers
pnpm e2e            # the full suite, headless, four workers
pnpm e2e:headed     # one visible browser, paced so you can follow it
pnpm e2e:ui         # time-travel UI, watch mode, locator picker
pnpm e2e:debug      # step through with the Playwright Inspector
pnpm e2e:report     # open the last HTML report
```

Headless by default. A watchable run is a real thing and `e2e:headed` is it —
but the suite runs for half an hour, and four browser windows appearing over
whatever else is on screen is an interruption rather than a run being watched.

`SLOWMO=500` changes the pacing and `DEVTOOLS=1` opens DevTools alongside it.

The API specs drive HTTP directly, so a headed run shows a browser sitting on a
blank page — there is nothing to paint until the UI exists.

Project documentation lives in [`docs/`](docs/) —
[architecture](docs/architecture.md) ·
[features](docs/features.md) ·
[phases](docs/phases.md) ·
[roadmap](docs/roadmap.md) ·
[decisions](docs/decisions.md).

## Contributing

Issues and pull requests are welcome, with one condition: anything touching
`packages/crypto` needs a clear explanation of _why_ it is correct, plus test
vectors. Security is the whole product here.

If you believe you have found a vulnerability, please do not open a public
issue — see [`docs/security.md`](docs/security.md) for how to report it.

## Licence

[MIT](LICENSE) — use it, fork it, host it, sell services around it.
