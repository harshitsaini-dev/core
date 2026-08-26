# Core — Roadmap

Start date: **2026-08-26**

The original plan assumed five neat weeks. That estimate ignored two things: the
crypto layer deserves more than a few days, and hardening always expands. The
schedule below is deliberately slower and has slack built in. Treat the week
numbers as ordering, not as a contract.

---

## Timeline

| Week | Dates | Phase | Milestone |
|---|---|---|---|
| 0 | Aug 26 – Aug 28 | P0 Foundation | Repo public, CI green, monorepo boots |
| 1 | Aug 29 – Sep 04 | P1 Crypto | `packages/crypto` complete with test vectors |
| 2 | Sep 05 – Sep 11 | P2 Auth + DB | Signup and login working against local D1 |
| 3 | Sep 12 – Sep 18 | P3 Vault UI | Item CRUD, search, folders, generators |
| 4 | Sep 19 – Sep 25 | P3 PWA | Offline sync, install, mobile UX |
| 5 | Sep 26 – Oct 02 | P4 ENV | Projects, editor, import/export, diff |
| 6 | Oct 03 – Oct 09 | P4 + types | Notes, cards, identities, versioning |
| 7 | Oct 10 – Oct 16 | P5 Hardening | Rate limits, lockout, Turnstile, headers |
| 8 | Oct 17 – Oct 23 | P5 Launch | Audit dashboard, e2e, deploy, DNS |
| 9 | Oct 24 – Oct 30 | Buffer | Overflow, dogfooding fixes, docs polish |

**Target v1.0.0: end of October 2026.**

---

## Milestones

### M0 — Repository live
Public repo, MIT licence, README that states the threat model, CI passing.
*Signal: a stranger can read the README and understand what Core guarantees.*

### M1 — Crypto verified
Every cryptographic primitive implemented, tested and documented with public
test vectors.
*Signal: a security-minded reader can audit `packages/crypto` alone and judge
the whole product.*

### M2 — Zero-knowledge proven
An account exists in D1 and a full database dump reveals nothing readable.
*Signal: screenshot of the raw table alongside the decrypted UI.*

### M3 — Daily driver
The author's real passwords live in Core and the phone PWA is the primary way
they are accessed.
*Signal: the author stops opening their old password manager.*

### M4 — ENV replacement
Every project `.env` on the machine is sourced from Core.
*Signal: no loose `.env` files in the projects folder outside of git ignores.*

### M5 — Public v1.0.0
Deployed at `core.harshitsaini.in`, self-hosting guide verified from a clean
fork, security headers grade A, tagged release.

---

## Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Argon2 WASM is slow or unsupported on an older phone | Users cannot unlock | Calibrate params at signup, store them per user, fall back to PBKDF2-SHA512 with 600 k iterations and record which KDF was used |
| Cloudflare Workers runtime lacks a Node API a dependency needs | Build breaks late | Enforce `nodejs_compat` awareness from Phase 0; prefer Web-standard APIs everywhere |
| D1 free-tier row-read limits hit during sync | Sync fails | Cursor-based delta sync, never full-table pulls; cache aggressively in Dexie |
| Losing the master password during development | Test data lost | Emergency Kit generated in Phase 2, before any real data enters |
| Scope creep from a 145-feature list | v1 never ships | Phase gates are binding; anything not in P1–P5 goes to P6 without debate |
| Subtle crypto bug found after real data is stored | Catastrophic | Versioned ciphertext envelope allows re-encryption migration; publish test vectors early and invite review |
| Solo-developer burnout across ten weeks | Stalls | Week 9 is deliberate slack; daily log keeps momentum visible |

---

## Definition of v1.0.0

Core ships as v1 when all of the following are simultaneously true:

1. Phases 0 through 5 have every exit criterion checked.
2. The author has used it as their only password manager for at least 14
   consecutive days with no data loss.
3. A clean fork deploys successfully by following the README alone, verified on
   a second Cloudflare account.
4. `pnpm test` and the Playwright suite pass on the default branch.
5. SECURITY.md exists with a working disclosure contact.
