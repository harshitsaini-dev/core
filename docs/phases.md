# Core — Build Phases

Six phases. Each one has a goal, a task list, an explicit **exit criteria**
block, and the feature IDs it delivers. A phase is not "done" because the code
exists — it is done when every exit criterion passes.

---

## Phase 0 — Foundation

**Goal:** a public repository that already looks like a serious project before a
single feature lands.

**Tasks**

- Git repository, MIT licence, README with the threat model up front
- `.gitignore` covering local planning artefacts and secrets
- pnpm workspace: `apps/web`, `packages/{crypto,db,ui,shared}`
- TypeScript strict everywhere, shared `tsconfig.base.json`
- ESLint + Prettier, single shared config package
- Vitest for unit tests, Playwright for end-to-end
- GitHub Actions: typecheck, lint, test on every push
- Conventional-commit style enforced by habit, not by a bot

**Delivers:** OSS-03, OSS-05, OSS-09

**Exit criteria**

- [x] `pnpm install && pnpm typecheck && pnpm lint && pnpm test` passes clean
- [x] CI is green on the default branch
- [x] `git ls-files` shows no secrets and no local planning files

---

## Phase 1 — The Crypto Brain

**Goal:** `packages/crypto` is complete, tested and provably correct _before_
anything depends on it. This is the phase that must not be rushed.

**Tasks**

- Argon2id wrapper (WASM), with tunable params and a calibration helper
- `deriveKeys(masterPassword, salt, params)` returning `{ authKey, masterKey }`
- AES-256-GCM `encrypt` / `decrypt` over the `v1.iv.ct` envelope
- Account Key generation, wrap and unwrap
- ECDH P-256 keypair generation, private-key wrapping, shared-secret derivation
- HKDF sub-key derivation (blind index key, device key)
- Blind index HMAC helper with input normalisation
- Constant-time byte comparison
- Secure random helpers (password generator primitives)
- Key-zeroing utility and a `LockedVault` state machine
- Published test vectors so a third party can verify the implementation
- Tailwind terminal theme tokens in `packages/ui`

**Delivers:** ZK-01 … ZK-13, UI-01, UI-02, UI-03, UI-10, OSS-06

**Exit criteria**

- [x] Round-trip property tests: encrypt → decrypt returns the exact input for
      1 000 random payloads including empty strings and 1 MB blobs
- [x] Tampering any byte of ciphertext, IV or tag causes decryption to throw
- [x] Wrong master password fails to unwrap the Account Key, and fails _loudly_
- [x] Calibrated Argon2id parameters land between 400 ms and 900 ms on the dev
      machine (defaults alone cost ~140 ms there, so calibration — not the
      default — is what has to hit the target)
- [x] Changing the master password re-wraps the Account Key and all previously
      encrypted items still decrypt
- [x] `packages/crypto` has zero imports from React, Next.js or `node:*`
- [x] Coverage on `packages/crypto` is above 95 %

---

## Phase 2 — Database & Authentication

**Goal:** a user can sign up and log in without the server ever learning
anything useful, and the schema is stable enough to build on.

**Tasks**

- Full Drizzle schema for every table in the architecture doc
- Migration workflow via `wrangler d1 migrations`
- Local D1 through `wrangler dev` and a seed script
- `POST /api/auth/prelogin` — constant time, deterministic fake salts
- `POST /api/auth/signup` — stores verifier, wrapped keys, public key
- `POST /api/auth/login` — peppered verifier, constant-time compare
- Session issuance, refresh rotation, logout, revoke-all
- Signup flow UI with the zxcvbn strength meter
- Emergency Kit PDF generation, client-side, never uploaded
- zod validation and body-size caps on every route
- `.env.example` documenting all four required secrets

**Delivers:** AUTH-01 … AUTH-07, GEN-07, SEC-07, ZK-16, RL-07, RL-08, RL-09, OSS-04

**Exit criteria**

- [x] Signing up then dumping the entire D1 database shows no readable field
      (verified 2026-08-26; the email is ciphertext too, though under a
      server-held key — see ADR-014)
- [x] `prelogin` timing for a known vs unknown email differs by under 5 ms
      across 100 samples — verified against a real Workers build, where the
      binding is local and the response time sits just above the padded budget.
      That is what shows the padding is doing the work rather than dev-server
      overhead masking the difference.
- [x] Login succeeds on the correct password and fails identically (same message,
      same shape) on a wrong password and an unknown user
- [x] Session cookie is `HttpOnly`, `SameSite=Strict`, `Path=/`; `Secure` is
      set outside development, where it would make the cookie invisible to a
      plain-HTTP localhost server
- [x] Emergency Kit restores an account: verified end to end through the UI,
      including that data encrypted before recovery still decrypts after it
- [ ] Migrations apply cleanly from an empty database

---

## Phase 3 — Vault UI & Offline PWA

**Goal:** Core becomes usable daily. This is the phase where it stops being an
experiment.

**Tasks**

- App shell: terminal chrome, sidebar on desktop, bottom nav on mobile
- Item CRUD for the login type, with custom fields
- TOTP generator with countdown ring
- Password and passphrase generators
- Fuzzy search over the decrypted index, command palette on Ctrl/Cmd+K
- Folders (nested), tags, colours, pin, sort, filter, grid/list toggle
- Trash with 30-day retention and restore
- Bulk selection actions
- Dexie schema, encrypted offline cache keyed by the device key
- Sync engine: pull cursor, optimistic writes, outbox drain, conflict handling
- Service worker, manifest, install prompt, offline indicator
- Swipe actions, haptics, pull-to-refresh
- Auto-lock, clipboard auto-clear, panic button, blur-all mode
- Toasts, empty states, typewriter reveal, invert-on-hover

**Delivers:** VLT-01/02/03/04/10/12/13, ORG-01 … ORG-08/10/11, GEN-01 … GEN-04,
PWA-01 … PWA-11, UI-04 … UI-09, SEC-03/04/05/11, AUTH-09, AUTH-14, ZK-14, ZK-15

**Exit criteria**

- [ ] Airplane mode: unlock, read, create and edit all work; changes sync on
      reconnect without loss
- [ ] IndexedDB inspected in DevTools shows only ciphertext
- [ ] Locking the vault leaves no plaintext reachable from the console
- [ ] Search across 1 000 seeded items returns in under 50 ms
- [ ] Installable on Android and iOS, launches standalone
- [ ] The author has migrated at least 20 real accounts into it and uses it daily

---

## Phase 4 — Developer ENV Manager

**Goal:** the feature that makes Core different from every other password
manager.

**Tasks**

- Projects and environments CRUD
- ENV editor with monospace syntax highlighting and inline value editing
- Mask / unmask all
- `.env` file drag-and-drop import and clipboard paste import
- Export: `.env` download, clipboard, `export KEY="value"` shell form
- Per-variable version history and a red/green diff viewer
- Environment duplication (dev → staging)
- Item version history and rollback for vault items
- Secure notes with Markdown, credit cards, identities, SSH keys
- Linked items between vault entries and ENV projects
- Drag-and-drop into folders, password age indicator
- API key / UUID / hex generators

**Delivers:** ENV-01 … ENV-06, ENV-08 … ENV-15, VLT-05 … VLT-08, VLT-11,
VLT-14, VLT-15, ORG-09, GEN-05, GEN-06

**Exit criteria**

- [ ] A real project's `.env` imports, exports and byte-matches the original
- [ ] Comments and quoted values survive the import/export round trip
- [ ] Diff viewer correctly shows added, removed and changed variables
- [ ] Rolling back a variable restores the exact previous value
- [ ] The author has moved every real project `.env` into Core

---

## Phase 5 — Hardening, Audit & Launch

**Goal:** safe to point strangers at.

**Tasks**

- Rate limiting on Workers KV: sliding window, token bucket, per-endpoint rules
- Progressive delays and account lockout, with magic-link unlock
- Cloudflare Turnstile on signup, login and share-open
- New-device and new-country login approval by email OTP
- Trusted devices list, concurrent session limits, revoke
- Audit log UI
- Security dashboard: weak, reused, aged passwords
- HaveIBeenPwned k-anonymity check (range API, prefix only)
- Suspicious-activity emails via Resend, terminal-themed React Email templates
- Master-password change flow
- Strict CSP with nonces, HSTS, security headers, SRI
- Import/export and restore flows
- Accessibility pass: keyboard, focus, reduced motion, contrast
- Lighthouse 100 PWA in CI, Playwright e2e suite
- SECURITY.md, self-hosting guide, Deploy-to-Cloudflare button
- Production deploy, `core.harshitsaini.in` DNS, smoke test

**Delivers:** RL-01 … RL-06, RL-10, SEC-01/02/06/08/09/12, AUTH-08/10/11/12/13,
IO-01 … IO-04, IO-07, UI-11, UI-12, PWA-12, OSS-01, OSS-07, OSS-08, OSS-10

**Exit criteria**

- [ ] 100 automated wrong-password attempts trigger IP block and account lockout
- [ ] CSP has no `unsafe-inline` or `unsafe-eval`; console shows zero violations
- [ ] securityheaders.com grade A or better
- [ ] Lighthouse: PWA 100, Performance 90+, Accessibility 95+
- [ ] Playwright e2e covers signup, unlock, CRUD, ENV export, lockout
- [ ] A clean fork deploys end-to-end following only the README
- [ ] `core.harshitsaini.in` serves over HTTPS with HSTS

---

## Phase 6 — Post-v1

Not scheduled. Pulled in only when v1 has been stable in daily use for a month.

- Encrypted attachments on R2 (VLT-09)
- One-time self-destructing share links (SEC-10)
- Docker single-container self-host (OSS-02)
- Additional importers (IO-05), backup reminders (IO-06)
- Optional light theme (UI-13), saved views (ORG-12)
- Docker/compose export format (ENV-07), placeholder warnings (ENV-16)
- Duplicate detection (VLT-16)
- Browser extension — separate repository, separate threat model
