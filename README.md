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
[![Status](https://img.shields.io/badge/status-v1-00FF41?style=flat-square)](docs/roadmap.md)
[![PWA](https://img.shields.io/badge/PWA-offline%20first-00FF41?style=flat-square)](#)

</div>

---

> **Status: v1.** Everything below is built, tested and deployed. What Core
> does not do is listed as plainly as what it does — three planned features were
> cut rather than shipped half-finished, with the reasoning in
> [`docs/decisions.md`](docs/decisions.md).
>
> It has not been audited by anyone but the people who wrote it. Read
> [`docs/security.md`](docs/security.md) before trusting it with something you
> cannot afford to lose, and keep the Emergency Kit it gives you.

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
- **Attachments** get a key each, wrapped by the Account Key. What the operator
  holds is an object under a random name, a key they cannot unwrap, an encrypted
  filename and a size. There is a test that walks the local storage and searches
  every byte for a marker, rather than a paragraph saying so.
- **Share links** put their key after the `#`, which no browser has ever sent in
  a request. The server stores a ciphertext it can identify and cannot open.

Full details, including the key hierarchy and the data model, are in
[`docs/architecture.md`](docs/architecture.md). The threat model — what Core
protects against and what it does not — is in
[`docs/security.md`](docs/security.md).

## Features

A short version. The full catalogue, with what was cut and why, is
[`docs/features.md`](docs/features.md).

**Vault** — logins, secure notes, cards, identities, SSH keys, custom fields,
built-in TOTP, recovery codes, encrypted attachments, version history, trash
with restore, duplicate detection.

**Organisation** — fuzzy search, `Ctrl/Cmd+K` command palette, nested folders,
tags, colours, pins, multi-filter, sorting, grid or list, drag-and-drop filing,
saved filter views.

**Developer** — projects and environments, syntax-highlighted `.env` editor,
drag-and-drop import, one-click export as `.env`, shell `export` lines, Docker
`--env` flags or a `docker-compose` block, per-variable history and diffs,
warnings on values that were never filled in, mask/unmask all.

**PWA** — installable, fully offline read and write, swipe actions, haptics,
pull-to-refresh, bottom navigation, OLED-black theme.

**Security** — auto-lock, clipboard auto-clear, panic button, blur-all mode,
WebAuthn/passkey unlock, breach checking, audit log, rate limiting, account
lockout, Turnstile, one-time share links, backup reminders.

**Getting in and out** — CSV import that recognises what nine password managers
export, QR scanning for one-time codes, bulk import from Google Authenticator,
encrypted backups, and a plaintext export behind a deliberately awkward gate.

## Stack

| Layer     | Choice                             |
| --------- | ---------------------------------- |
| Framework | Next.js (App Router)               |
| Styling   | Tailwind CSS                       |
| State     | Zustand                            |
| Offline   | Dexie / IndexedDB + service worker |
| Crypto    | WebCrypto + Argon2id (WASM)        |
| Database  | Cloudflare D1 with Drizzle ORM     |
| Files     | Cloudflare R2                      |
| Hosting   | Cloudflare Workers                 |
| Email     | Resend                             |
| CI        | GitHub Actions                     |

Every one of these has a free tier that covers personal use. Running your own
Core instance costs nothing.

## Self-hosting

There is no one-click deploy button, and there was one here until it was
checked. It could not have worked: an instance needs `AUTH_PEPPER` set as a
secret before it will start at all, migrations run against a fresh database, an
R2 bucket created, and an API token carrying a permission the Cloudflare Workers
template leaves out. A button that produced a broken instance and said nothing
is worse than a page of instructions.

[`docs/self-hosting.md`](docs/self-hosting.md) is that page, including the token
permission and the reason the build does not run on Windows. The short version:

```bash
git clone https://github.com/harshitsaini-dev/core.git
cd core
pnpm install

pnpm cf d1 create core-vault         # paste the id into wrangler.toml
pnpm cf kv namespace create RATE_LIMIT
pnpm cf r2 bucket create core-attachments
pnpm db:migrate:local                # create the tables
cp apps/web/.dev.vars.example apps/web/.dev.vars       # then add a local AUTH_PEPPER

pnpm dev
```

Then deploy. This is a Workers deploy rather than Pages, and the build does not
run on Windows, so deploying happens from CI — `docs/self-hosting.md` covers
both.

Email (Resend) and the bot check (Turnstile) are optional. An instance without
them is a working instance with three notifications switched off and one layer
of defence missing, not a broken one.

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
but the full suite is over eight hundred tests across two viewports and runs for
the better part of an hour, and four browser windows appearing over whatever
else is on screen is an interruption rather than a run being watched.

`SLOWMO=500` changes the pacing and `DEVTOOLS=1` opens DevTools alongside it.

The API specs drive HTTP directly, so a headed run shows a browser sitting on a
blank page — there is nothing to paint until the UI exists.

Project documentation lives in [`docs/`](docs/) —
[architecture](docs/architecture.md) ·
[security](docs/security.md) ·
[features](docs/features.md) ·
[self-hosting](docs/self-hosting.md) ·
[phases](docs/phases.md) ·
[roadmap](docs/roadmap.md) ·
[decisions](docs/decisions.md).

[`docs/decisions.md`](docs/decisions.md) is the one worth reading if you are
deciding whether to trust this. It is thirty-odd records of what was chosen and
what was refused — including the features that were cut, and the several
occasions something was marked done, checked, and found not to work.

## Contributing

Issues and pull requests are welcome, with one condition: anything touching
`packages/crypto` needs a clear explanation of _why_ it is correct, plus test
vectors. Security is the whole product here.

If you believe you have found a vulnerability, please do not open a public
issue — see [`docs/security.md`](docs/security.md) for how to report it.

## Licence

[MIT](LICENSE) — use it, fork it, host it, sell services around it.
