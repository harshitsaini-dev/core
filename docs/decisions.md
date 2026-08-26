# Core — Decision Log

Architecture decision records. Append-only: never edit a decided entry, add a
superseding one instead. Format: context, decision, consequences.

---

## ADR-001 — Project name and domain

**Date:** 2026-08-26 · **Status:** Accepted

**Context.** The project sits alongside `orbit`, `hive` and `lovetrack` — short,
meaning-driven names. This tool holds the most sensitive data of all of them.

**Decision.** Name it **Core**, host at `core.harshitsaini.in`, repository
`harshitsaini-dev/core`, public from day one.

**Consequences.** Name is generic in GitHub search, so the repository
description and README must do the discoverability work. Public from day one
means no messy history to hide later — commits are written for an audience.

---

## ADR-002 — Zero-knowledge architecture is non-negotiable

**Date:** 2026-08-26 · **Status:** Accepted

**Context.** The author owns the code, the server, the database and the
production secrets. Anyone self-hosting has the same power over their own
users. A password manager where the operator can read the vault is not a
password manager.

**Decision.** All encryption and decryption happens client-side. The server
stores ciphertext, a non-reversible auth verifier and blind indexes. Metadata —
titles, URLs, folder names, ENV keys — is encrypted too, not just the values.

**Consequences.**
- Search, sort and filter must run client-side, which forces a full vault sync
  to the device and caps practical vault size at tens of thousands of items.
- Server-side features that need plaintext are permanently impossible: admin
  reset, server-rendered vault views, server-side breach scanning of stored
  values.
- A forgotten master password with no Emergency Kit means permanent data loss,
  and the README must say so plainly rather than bury it.

---

## ADR-003 — Argon2id over PBKDF2

**Date:** 2026-08-26 · **Status:** Accepted

**Context.** WebCrypto ships PBKDF2 natively but not Argon2. PBKDF2 is
GPU-friendly, so an attacker with a stolen database gets far better throughput
against it.

**Decision.** Argon2id (`m = 64 MiB, t = 3, p = 1`) via a pinned WASM build,
calibrated to roughly 500 ms per derivation. Parameters are stored per user so
they can be raised later. PBKDF2-SHA512 at 600 000 iterations remains a
recorded fallback for environments where WASM is unavailable.

**Consequences.** One WASM dependency in an otherwise dependency-free crypto
layer — it must be pinned, integrity-checked and reviewed on every bump. Memory
cost may be too high for very old mobile devices, which is what the calibration
and fallback are for.

---

## ADR-004 — Two derived keys plus a wrapped Account Key

**Date:** 2026-08-26 · **Status:** Accepted

**Context.** Using one key for both authentication and encryption would mean
handing the server material related to the encryption key. Encrypting every item
directly with a password-derived key would make a password change an O(n)
re-encryption of the whole vault.

**Decision.** Derive an Auth Key and a Master Key from the master password using
distinct context strings. Generate a random Account Key at signup, encrypt all
data with it, and store it wrapped by the Master Key.

**Consequences.** Changing the master password re-wraps 32 bytes and nothing
else. Losing the Account Key wrapper is unrecoverable, so it must be included in
the Emergency Kit. Adds one indirection to reason about in every crypto test.

---

## ADR-005 — Cloudflare D1 and Pages over Vercel or MongoDB

**Date:** 2026-08-26 · **Status:** Accepted

**Context.** The stack must be free forever, must work for a stranger who forks
it, and the domain already sits on Cloudflare. Candidates were Cloudflare D1 +
Pages, Neon Postgres + Vercel, and MongoDB Atlas + Vercel.

**Decision.** Cloudflare D1 (SQLite at the edge) with Drizzle ORM, deployed on
Cloudflare Pages using the Workers runtime. Workers KV for rate-limit counters,
R2 for attachments later.

**Consequences.** Everything lives in one provider with one dashboard and one
free tier to reason about. The Workers runtime is not Node, so every dependency
must be Web-standard-compatible — this constrains library choice for the entire
project and must be checked before adding anything. Local development requires
Wrangler rather than a plain `next dev`. NoSQL flexibility is not missed because
every sensitive field is an opaque blob anyway.

---

## ADR-006 — pnpm monorepo

**Date:** 2026-08-26 · **Status:** Accepted

**Context.** The cryptographic layer needs to be auditable in isolation. Mixing
it into a Next.js app makes that impossible to verify at a glance.

**Decision.** pnpm workspace with `apps/web` and `packages/{crypto,db,ui,shared}`.
`packages/crypto` may not import React, Next.js or any `node:*` module.

**Consequences.** Slightly heavier tooling for a solo project, and an extra
build step to keep straight. In exchange, a reviewer can read one small package
and judge the security of the whole product.

---

## ADR-007 — Terminal / cyber-brutalist theme

**Date:** 2026-08-26 · **Status:** Accepted

**Context.** Glassmorphism and claymorphism were considered. Glass hurts
readability for monospace secrets; clay reads as playful, which is wrong for a
vault.

**Decision.** Pure black background, Matrix green `#00FF41` accent, monospace
typography throughout, zero border radius, 1px hard borders, invert-on-hover,
blinking-cursor motifs.

**Consequences.** High contrast is good for accessibility and for OLED battery
life, but a single-hue palette makes semantic colour (error, warning, success)
harder — those need shape, prefix glyphs and position to carry meaning, not just
colour. A light theme becomes awkward, so it is deferred to post-v1.

---

## ADR-008 — Offline-first with a client-authoritative sync engine

**Date:** 2026-08-26 · **Status:** Accepted

**Context.** A password manager that is useless without a network is useless at
the moment you most need it. Since the server cannot read the data, it also
cannot merge it intelligently.

**Decision.** Dexie/IndexedDB stores the encrypted vault locally, wrapped by a
per-device non-extractable key. Writes are optimistic and queued in an outbox.
Conflicts resolve last-write-wins per field, with the losing value preserved in
version history.

**Consequences.** The device holds a complete encrypted copy of the vault, so
device compromise matters more — hence auto-lock, PIN/biometric gating and cache
wipe on panic. Sync logic is the most bug-prone part of the app and needs the
heaviest test coverage outside of crypto.

---

## ADR-009 — Planning documents stay out of the repository

**Date:** 2026-08-26 · **Status:** Accepted

**Context.** Some working documents are personal process notes — a daily log, a
personal setup checklist containing account-specific steps, a running state
file. They are useful locally and noise (or leakage) in public.

**Decision.** Commit `docs/architecture.md`, `docs/features.md`,
`docs/phases.md`, `docs/roadmap.md`, `docs/decisions.md`, `docs/security.md` and
`docs/self-hosting.md`. Keep `docs/daily-log.md`, `docs/manual-work.md`,
`docs/project-state.md`, `docs/skills.md` and the original planning transcript
local via `.gitignore`.

**Consequences.** The public docs must stand alone without the private ones. If
a decision is made in the daily log it has to be promoted here, or it is
effectively lost to anyone reading the repository.

---

## ADR-010 — Session model: short-lived cookie plus rotating refresh

**Date:** 2026-08-26 · **Status:** Accepted

**Context.** A long-lived bearer token in `localStorage` is an XSS jackpot. The
encryption key never leaves memory regardless, but a stolen session token still
allows ciphertext exfiltration and destructive writes.

**Decision.** Access token in an `HttpOnly; Secure; SameSite=Strict` cookie with
a short lifetime, plus a rotating refresh token bound to a device record. Any
refresh reuse invalidates the whole device chain.

**Consequences.** Refresh rotation adds bookkeeping and a race condition to
handle when several tabs refresh at once. Sessions become individually
revocable, which the trusted-devices UI depends on.
