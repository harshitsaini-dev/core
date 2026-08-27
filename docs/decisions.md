# Core — Decision Log

Architecture decision records. Append-only: never edit a decided entry, add a
superseding one instead. Format: context, decision, consequences.

---

## ADR-001 — Project name and domain

**Date:** 2026-08-26 · **Status:** Accepted

**Context.** The naming convention in use is short, single-word and
meaning-driven. This tool holds more sensitive data than anything else built
under it, so the name should read as solid rather than clever.

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

---

## ADR-011 — One Argon2id pass, split by HKDF

**Date:** 2026-08-26 · **Status:** Accepted · **Supersedes part of** ADR-004

**Context.** The original sketch derived the Auth Key and the Master Key with
two separate Argon2id runs using different context strings. Implementing it
made the cost obvious: at the target of ~500 ms per derivation, every unlock
would spend a full second in key derivation on a desktop, and considerably
longer on a phone.

**Decision.** Run Argon2id exactly once over `(password, salt)` to produce a
32-byte root key, then split it with HKDF-Expand into the Auth Key
(`info = "core.auth.v1"`) and the Master Key (`info = "core.enc.v1"`). The root
key is wiped as soon as both are derived.

**Consequences.** Unlock cost halves with no loss of security — the strength of
both keys already derived entirely from that one Argon2id computation, and
HKDF-Expand provides cryptographic domain separation. The two `info` strings
are now load-bearing: changing either one silently locks every existing vault
out, so they are pinned by test as well as by review.

---

## ADR-012 — The auth verifier is an HMAC, not a second Argon2id

**Date:** 2026-08-26 · **Status:** Accepted · **Supersedes part of** ADR-002

**Context.** The plan called for the server to store `Argon2id(authKey + pepper)`
and compare against it. That treats the Auth Key as if it were a password.

**Decision.** Store `HMAC-SHA256(pepper, authKey)` instead.

**Rationale.** The Auth Key is already the output of a memory-hard derivation
over the password. An attacker with the database who wants to guess passwords
must compute Argon2id per guess regardless of what the server does afterwards,
so a second expensive pass adds no resistance. It does add two real costs: every
login burns 64 MiB and hundreds of milliseconds of Worker CPU, which is both a
free-tier problem and an obvious denial-of-service lever for an unauthenticated
endpoint.

**Consequences.** Login verification becomes microseconds instead of hundreds of
milliseconds, which also makes constant-time comparison easier to reason about.
The pepper carries more weight than before — it is now the only thing standing
between a leaked database and an offline attack on the verifier — so losing it
locks every existing account out permanently. That is documented in
`.env.example` and in the self-hosting guide.

---

## ADR-013 — Additional authenticated data on key wrappers

**Date:** 2026-08-26 · **Status:** Accepted

**Context.** A hostile server cannot read a ciphertext, but nothing in plain
AES-GCM stops it from moving one. Copying a user's wrapped Account Key into
another user's row, or replaying an old wrapper after a password change, are
both cheap attacks against an untrusted storage layer.

**Decision.** Every wrapper passes a fixed domain string as AES-GCM additional
authenticated data — `core.account-key.v1` for the Account Key,
`core.private-key.v1` for the ECDH private key, `core.share.v1` for share
payloads. The AAD is authenticated but not encrypted, and decryption fails
unless it matches exactly.

**Consequences.** Ciphertexts are bound to their role and cannot be substituted
across columns. The strings become part of the on-disk format, so changing one
breaks existing data; they are covered by the published test vectors. Binding to
a specific _row id_ rather than a role would be stronger still, and remains open
for Phase 2 once the schema exists.

---

## ADR-014 — The email address is readable by the operator

**Date:** 2026-08-26 · **Status:** Accepted · **Qualifies** ADR-002

**Context.** The schema originally described `users.email_enc` as encrypted like
every other user field. Building signup made the contradiction obvious: Core is
supposed to send magic links, login alerts and new-device codes, and a server
that cannot read an address cannot send to it. Encrypting the email under the
user's Account Key would have silently made every one of those features
impossible — or, worse, quietly invited a later change that stored the address
in plaintext beside the ciphertext.

**Decision.** The email address is encrypted at rest under a **server-held** key
derived from `AUTH_PEPPER`, not under the user's Account Key. The operator can
decrypt it. This is stated plainly in the threat model rather than left for
someone to discover in the schema.

**What this still buys.** A database dump on its own yields no addresses,
because the key lives in the Worker secret store rather than in D1. An attacker
needs both the database and the secret store.

**What it costs.** Core is no longer zero-knowledge with respect to _who its
users are_ — only with respect to what they store. The operator can enumerate
addresses. Anyone who considers that unacceptable should self-host, which is one
of the reasons self-hosting is a first-class goal rather than a nice-to-have.

**Rejected alternative.** Dropping email entirely and identifying accounts by a
random handle would preserve the stronger property, but it removes account
recovery, breach alerts and new-device verification — protections that matter
more, in practice, than hiding an address from a server the user chose to trust
enough to hold their vault.

**Consequences.** `email_enc` is the single field in the schema encrypted under a
server key. It is commented as such, and the plaintext-allowlist test does not
cover that distinction, so the comment and this ADR are what carry it. Every
other `_enc` column remains unreadable to the operator.

---

## ADR-015 — One local D1 replica, pinned explicitly

**Date:** 2026-08-27 · **Status:** Accepted

**Context.** Miniflare stores its local database under `.wrangler/state`,
resolved relative to whatever directory the process started in. The dev server
runs from `apps/web`, the CLI runs from the repository root, and moving
`wrangler.toml` into `apps/web` for the OpenNext build moved a third reference
point. Each combination produced a plausible-looking path.

The failure mode is what makes this worth an ADR rather than a comment. Two
replicas do not error. Migrations report success against one while the app reads
the other; a seeded account is invisible to the running server; a test that
queries the database sees an empty table and fails for a reason that looks like
a bug in the feature. It has now happened twice, the second time after a change
that appeared unrelated.

**Decision.** Every invocation names the path explicitly. Wrangler commands pass
`--persist-to .wrangler/state`, and the dev adapter is configured with
`persist: { path: '../../.wrangler/state/v3' }`. There is exactly one local
replica, at the repository root, and no code path relies on the default.

**Consequences.** Slightly noisier commands, and a rule that has to be applied to
any new script that touches the local database. Cheap next to a class of failure
that presents as a broken feature rather than as a broken configuration.

---

## ADR-016 — The Workers build runs in CI, not on the development machine

**Date:** 2026-08-27 · **Status:** Accepted

**Context.** Two assertions cannot be settled against `next dev`: the prelogin
constant-time proof, because the dev D1 binding goes through an IPC proxy
costing more than the timing budget, and cold offline navigation, because dev
compiles chunks on demand and renames them on every compilation.

Building for the Workers runtime locally fails. OpenNext copies `node_modules`,
and pnpm's symlinks cannot be traversed on Windows — the incompatibility
OpenNext warns about in its own output.

**Decision.** A separate workflow builds with `opennextjs-cloudflare`, starts a
real Workers preview with local D1 and KV, and runs the suite against it with
`WORKERS_BUILD=1`. The two assertions are skipped everywhere else and enabled
there.

**Rejected alternatives.** Moving development to WSL, or switching the workspace
to hoisted `node_modules`, would both make the local build work — and both
reshape the development environment to suit one build step. Deleting the two
assertions would have been quieter and dishonest: the properties they check are
the ones the product claims hardest.

**Consequences.** The strongest assertions run on push rather than on save,
which is a slower feedback loop for exactly the things worth being sure about.
Accepted because the alternative is not knowing at all.

**Amendment, same day.** The workflow first ran the entire suite and the preview
died partway through, refusing connections, on a commit that CI passed. It now
runs only the specs that need workerd — smoke, prelogin and offline. Running
everything twice cost double for almost no extra signal, and the sustained load
was what destabilised a single `wrangler dev` process. If a focused run ever
brings it down again, that is a real signal rather than an artefact of scale.

---

## ADR-017 — Notes are text, not rendered Markdown

**Date:** 2026-08-27 · **Status:** Accepted · **Supersedes part of** the
feature catalogue, which said "secure notes with Markdown rendering"

**Context.** The note field was specified as Markdown. Rendering it means
running a parser over user-supplied text and injecting the resulting HTML into
the page.

That page is the one place in the product where the vault keys exist in
plaintext. A note is also the easiest place for hostile content to arrive:
pasted from anywhere, synced from another device, or written by an attacker who
briefly had access. Every Markdown renderer that has ever shipped has had an
injection bug at some point, and the sanitiser is a second dependency with the
same history.

**Decision.** Notes are stored exactly as typed and displayed as text with line
breaks preserved. No parser, no HTML generation, no sanitiser.

**Consequences.** No headings, no bold, no lists. Markdown syntax survives in
the stored text, so anyone who wants formatting can paste it into something that
renders — the text is theirs and is returned unchanged.

The cost is a formatting nicety. The alternative is an HTML injection path into
the origin holding the master key, defended by a dependency whose failures would
be silent. If rendering is ever added, it belongs in a sandboxed iframe with its
own origin and no access to the keys — not inline in this page.

---

## ADR-018 — Folders and tags both exist, and the filters compose

**Date:** 2026-08-27 · **Status:** Accepted

**Context.** Folders and tags overlap enough that most products pick one. A
vault of a few hundred items argues for both, but only if it is clear which
question each answers.

**Decision.** Folders answer "where does this live" — one per item, nested,
named, coloured. Tags answer "what is this about" — many per item, flat, free
text. Applying both narrows twice rather than the second replacing the first,
and both narrow the pool _before_ search ranks it.

Folder names are encrypted under the Account Key like every other user value.
Colours are not: a swatch reveals nothing, and the list has to paint before
anything is decrypted. Colours come from a fixed palette of five rather than a
picker — the interface is a single hue on black, and arbitrary colours would
either break that or produce swatches nobody can tell apart.

**Consequences.** The server holds a folder tree it cannot read. It can enforce
ownership and reject a folder that names itself as its own parent; it cannot see
a longer cycle, so the client treats the shape it is given as untrusted, breaks
cycles when ordering, and appends anything unreachable rather than hiding it.

Deleting a folder is soft and moves its items out rather than down with it.
Losing a folder must never mean losing what was inside — on a product with no
password reset that would be a second way to lose data permanently.

Ranking before filtering was rejected: a folder holding three items would show
two, because the ones the filter hid had already taken the top places.

---

## ADR-019 — Form controls are drawn by us, and the dropdown is rebuilt

**Date:** 2026-08-27 · **Status:** Accepted · **Extends** ADR-007 (the terminal
theme)

**Context.** The theme is pure black, one hue, square corners, 1px borders.
Native form controls ignore all of it: a checkbox arrives as a rounded blue
Windows widget, a `<select>` opens a white OS menu in the middle of a black
terminal, and Edge adds its own reveal eye beside the app's own show/hide
button. No amount of styling around them helps, because the platform paints
them.

**Decision.** Two different problems, solved two different ways.

Checkboxes and radios keep the native input. `appearance: none` removes the
platform drawing and leaves a real, focusable, labellable control behind it —
everything that matters (focus, the accessibility tree, a screen reader saying
"checked", Playwright's `.check()`) is still the browser's job. Only the paint
is ours, and the mark is a `::after` driven by `:checked`, so there is no second
node to keep in sync.

The dropdown cannot be done that way: a `<select>`'s popup is drawn by the OS
and is not reachable from CSS. So it is rebuilt as a listbox — a button, a
panel, and the keyboard behaviour a select has: arrows move, Home and End jump,
Enter and Space commit, Escape cancels, Tab closes, and typing jumps to the
matching option.

Both radios and checkboxes stay square. The zero-radius rule gets no exception;
what tells them apart is the mark, not the box.

**Consequences.** Rebuilding a select spends something real. The native control
is free, maintained by the platform, correct on every device, and behaves
properly with a phone's own picker UI. All of that is now ours to keep right,
and this is the component most likely to have a bug a native one would not.

It is spent because the alternative is a white menu in the middle of a black
terminal, which is the one thing the theme exists to avoid.

Tests assert the paint as well as the behaviour, because this failure mode is
silent: a native checkbox on a black page is a rounded blue square nobody
catches in review and every user sees.

Two knock-ons found while doing it. Escape closing a dropdown also threw away
the form it was in — the global shortcut handler now ignores events that were
already handled. And Next's development indicator sits in the bottom-left
corner, on top of the app's own bottom navigation bar, swallowing taps; it is
switched off.
