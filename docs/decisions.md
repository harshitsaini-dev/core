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

---

## ADR-020 — A toast never carries a value, and blur-all has no hover reveal

**Date:** 2026-08-27 · **Status:** Accepted

**Context.** Two interface features that both touch what is visible on screen,
and both have an obvious version that quietly undoes the point.

**Decision — toasts.** A toast states what happened and never what it was.
"Password copied", never "Copied hunter2". Toasts appear unprompted, they
linger, and they sit in the corner of the frame a screen recording captures.
The value adds nothing a person did not already know and shows it to everyone
else.

A second line: a toast is for an _event_. A _condition_ — offline, four changes
waiting to sync — stays in the interface, because a message that disappears is
the wrong shape for something that has not stopped being true. Only a toast with
an action stays until it is answered; withdrawing an "undo" on a timer takes the
way back away while somebody is still reading what happened.

**Decision — blur-all.** No hover-to-reveal. It is the obvious affordance and it
breaks the feature in the exact case it exists for: a screen share, where the
presenter's cursor wanders across the list. Reading one value means turning the
switch off, which is deliberate and visible.

The blur covers values and leaves the structure legible — how many items there
are is not the secret, what is in them is. Values are marked at the point they
are rendered rather than found by walking the DOM for likely-looking text: a
heuristic would eventually guess wrong, and it would fail in the direction that
shows a password.

The class goes on the document, not on the vault's subtree, because the command
palette and the toast stack render outside it. A switch that missed either would
be worse than no switch — it would claim the screen was covered while part of it
was not.

**Consequences.** The promise is narrow and worth stating plainly: blur-all
stops a person looking at the screen. It does not stop a screenshot taken by
software on the device, and it is no defence against anything running in the
page. It is also not persisted — a blur that survives a reload is a setting, and
this is a gesture. The vault it protects does not survive a reload either.

A revealed password in an open form is closed when the switch goes on. A field
being typed into cannot be blurred and still be typed into, so the reveal is
what gives way.

---

## ADR-021 — A locked account answers like a wrong password, and the limiter is approximate

**Date:** 2026-08-27 · **Status:** Accepted · **Resolves** the open question from
2026-08-26 about enforcing account lockout

**Context.** `login` had been counting `failed_attempts` since Phase 2 and
nothing read the counter. The note in the code said enforcement had to wait for
a magic-link path, or a user who mistyped three times would be stranded with no
way back in. That was the right worry and the wrong conclusion.

**Decision — the lockout heals itself.** Ten consecutive failures lock an account
for fifteen minutes, and the window expires on its own. Nobody is ever locked
out permanently and no second channel is needed to get back in, which is what
the original objection was actually about.

**Decision — a locked account is indistinguishable from a wrong password.** Same
status, same body, same padded time. Saying "this account is locked" would
confirm the account exists, and every other decision on this path — the decoy
salts, the constant-time padding, the single generic failure — exists to prevent
exactly that. One helpful message would undo all of them.

Two costs, both real. Somebody whose account has been attacked is told
"incorrect" for fifteen minutes while their correct password is refused, with
nothing on screen explaining why. And anyone who knows an email address can hold
an account locked by failing on purpose. Both are bounded, neither loses data,
and the alternative trades a permanent enumeration oracle for a temporary
inconvenience — the wrong way round for a product whose whole claim is that the
server knows nothing.

**Decision — the progressive delay is keyed on the caller, never the account.**
A padding budget that grew with an account's failure count would make a
much-attacked address answer more slowly than an address with no account at all.
That is the oracle the padding was built to close, rebuilt out of the
countermeasure. The delay is driven by the caller's own token bucket instead,
which costs no extra storage and reveals nothing the caller does not already
know.

**Decision — the limiter is a throttle, not a counter.** Buckets live in Workers
KV, which is eventually consistent: two requests arriving in different locations
can both spend the last token. An exact ceiling would need a strongly consistent
store per key, which on this stack means a Durable Object per account. That is a
lot of machinery to make an approximate bound exact, when the exact bound is not
what stops the attack — Argon2id is, and it charges the attacker before a
request is ever sent.

**Consequences.** The limiter needs to know who is calling. Behind Cloudflare it
always does. Elsewhere it falls back to `x-forwarded-for`, and where neither
header exists it does nothing and logs that it is doing nothing — rather than
counting the whole world against one bucket, which any single visitor could
exhaust for everybody. That requirement is now in self-hosting.md.

RL-05, Turnstile, is still unbuilt and is now described that way in security.md,
which had been claiming it.

---

## ADR-022 — The `.env` parser is written here, and variable keys are encrypted

**Date:** 2026-08-28 · **Status:** Accepted

**Context.** The environment manager has to read and write `.env` files. There
are good libraries for that.

**Decision — no library.** The text being parsed is a file full of production
secrets, and it is parsed in the one origin that holds the vault keys. A
dependency there is a supply-chain path straight to them, bought for about a
hundred lines of string handling. It is written here, and covered by tests for
what real files contain rather than what a happy path looks like: `export`
prefixes, both quote styles, escapes, `#` comments including the trailing kind,
empty values, CRLF, and values that run across lines — a private key pasted into
a `.env` is one value across twenty lines, and losing it at the first newline is
the most annoying possible bug.

It is deliberately forgiving. Anything it cannot read is returned rather than
dropped, because a file that half-parses is more useful than a refusal — but
only if it says which half.

**Decision — the key is encrypted too, not just the value.**
`STRIPE_SECRET_KEY` in the clear tells an operator what a project integrates
with, and the same list across a few thousand users is a map of who uses what.
The value is the secret; the key is the metadata, and this product does not leak
metadata either.

**Decision — an import merges, and never removes.** An import that deleted the
variables it did not mention would turn "add the two new keys from staging" into
"lose everything else", and nobody would find out until a deploy failed.

**Consequences.** What the server still sees is the shape: how many projects,
how many environments each has, how many variables each holds, and when they
changed. Same as the vault, and in the threat model rather than implied away.

Ownership is the part that differs from the vault and needed the most care. A
vault item carries the user it belongs to; an environment belongs to a project
and a variable to an environment. Every read walks down from the projects a
session owns and every write is checked against the same walk, because getting
it wrong here would not leak a name — it would hand somebody else's production
secrets to whoever asked for them by id. Four of the eleven API tests are that
attack.

---

## ADR-023 — Variable history is bounded, masked, and not read back from the server

**Date:** 2026-08-28 · **Status:** Accepted

**Context.** A variable keeps its previous values so a change can be seen and
undone. Every one of those is a production secret that was live at some point.

**Decision — ten per variable.** Not unlimited, and not for storage reasons. A
key rotated because it leaked is exactly the one nobody wants kept forever. Ten
is enough to undo a mistake and short enough that history is not an archive.

**Decision — old values are masked like current ones,** and shown as a diff
against what replaced them. "It was `postgres://old-host/db`" is far less useful
than seeing which part moved, and a connection string differs from its
predecessor by one word about as often as not.

**Decision — history is a separate endpoint,** not part of sync. A project of
forty variables would otherwise carry four hundred blobs on every refresh that
it will almost certainly never show.

**Decision — the panel does not depend on reading back what was just written.**
The client knows the old value: it is what it just replaced. It keeps that in
memory and merges it with whatever the server returns.

That last one is the interesting one, and it came from a test that failed
intermittently on the phone viewport. A read immediately after a write did not
always include the row — and the panel then said "no previous values", which is
a false statement made with complete confidence. Refetching when the variable
changes helped and did not fix it. Not asking at all does.

**Consequences.** The diff is written here rather than pulled in, for the same
reason as the `.env` parser: what it compares is a production secret and it runs
in the origin holding the vault keys. Thirteen tests, including the property
that makes a diff trustworthy — every line of both sides appears somewhere in
the output, because a diff that quietly drops a line of a private key is worse
than none.

---

## ADR-024 — Password age is reported, not judged

**Date:** 2026-08-28 · **Status:** Accepted

**Context.** ORG-09 asks for a password age indicator. The obvious reading is a
traffic light that turns amber at ninety days and red at a year.

**Decision.** Show the age. Say nothing about whether it is too old.

Scheduled rotation is advice its own authors withdrew: NIST removed arbitrary
expiry from 800-63B because it makes people pick worse passwords and change them
in predictable ways — `Summer2024!` becomes `Autumn2024!`. A strong unique
password stored in a manager does not get weaker by sitting still. A product
that nags about it is training exactly the habit it exists to remove.

What age is genuinely useful for is the other direction: finding the
fifteen-year-old password you set before you had a manager, or checking whether
you rotated a credential after a breach notice. Both are answered by a number.

**Consequences.** There is no "expired" state and no colour change, and a test
asserts the row never says "expired", "too old" or "change it" at any age. If
breach checking arrives later (SEC-09, Have I Been Pwned with k-anonymity), that
is the thing worth flagging — a password known to be compromised — and it is a
different signal from an old one.

The timestamp lives inside the encrypted blob rather than in a column. When
somebody last changed a password is a fact about them, and the server has no
business knowing it any more than it knows the password. It is stamped only when
the value actually changes, so opening an item and saving it does not make an
old password look new — otherwise the field records when somebody last looked at
the item, which is a different thing wearing the same label.

---

## ADR-025 — A backup carries its own key material, and a restore renumbers

**Date:** 2026-08-28 · **Status:** Accepted

**Context.** A vault nobody can get their data out of is a vault nobody should
put data into. IO-01 and IO-07 are the way out and the way back.

**Decision — the file carries the salt, the KDF parameters and the wrapped
Account Key.** A backup that needs the running service to read is not a backup
of anything: the day it is needed is the day the account, or the service, is
gone. Those three values are already public in the sense that matters —
`prelogin` serves them to anyone who asks, and the offline cache keeps them on
the device.

The cost is real and is said at the point of download rather than in a footnote:
a backup file can be attacked offline, at the attacker's pace, with no rate
limit. It is worth roughly what the master password is worth. That is inherent
to every backup of an encrypted vault, and the defence is the one already in
place — Argon2id, tuned so each guess costs time and memory.

**Decision — restoring re-encrypts under the current account's key.** That is
what makes it disaster recovery rather than a copy-paste: the account it goes
into does not have to be the account it came from.

**Decision — a restore renumbers anything this account does not already have.**
Ids are globally unique keys, not per-account ones. A backup carries the ids of
the account that made it, so restoring into a different account while the
original rows still exist means every insert collides with a row somebody else
owns — and the server correctly refuses and says nothing.

The first version did exactly that: reported "restored 1 item" and wrote none.
Silence on the one day the feature matters. An id is now kept only when this
account already has it, which is the same-account case and the one where
updating in place is what somebody wants; everything else gets a fresh id and
every reference between the rows is rewritten to match.

**Consequences.** A restore never deletes. It adds what is missing and updates
what it can match, and anything the file does not mention is left alone —
"restore the two items I lost" must not mean "replace everything with a file
from March". Trash is restored as trash, since somebody who deleted something
and then had to restore a backup did not ask for it back.

## ADR-030 — Lighthouse CI is cut, not deferred

**Status:** accepted, 2026-08-29

**Context.** OSS-10 asked for a Lighthouse PWA score of 100 enforced in CI.

**What was found on trying to build it.** Two things, either of which is enough
on its own.

Lighthouse removed the PWA category in v12. `installable-manifest`,
`service-worker`, `maskable-icon`, `apple-touch-icon` and `themed-omnibox` are
not audits that exist any more — a run against this app returns none of them.
There is no PWA score to hold at 100, so the requirement names something that
cannot be measured.

And this app has no `next start`. The build output is for
`@opennextjs/cloudflare`, and the production server is `pnpm preview`, which is
workerd. A first attempt at the workflow used `next start`, which failed with
`MODULE_NOT_FOUND` — and the Lighthouse run that appeared to work was measuring
the _development_ server that happened to be on the same port. It reported
accessibility 92 and eight failing audits, all of which were artifacts of a page
whose stylesheet and chunks had 404'd.

**Decision.** Cut it rather than ship a workflow that has never run correctly.
The parts of it that were real are covered elsewhere and by things that do run:
UI-11 asserts reduced motion, UI-12 asserts a focus ring on every control, and
`smoke.spec.ts` asserts the manifest, the theme colour and the viewport.

**Revisit** if a Lighthouse job is wanted against a deployed instance, where the
server is the real one and the numbers mean something.

## ADR-031 — QR codes are read by the browser, not by a bundled decoder

**Status.** Accepted.

Scanning a QR code needs a decoder. The usual answer is a library, and the usual
library is a few hundred kilobytes of WebAssembly or minified JavaScript for a
feature most people use twice — once to add a code, once to move house.

`BarcodeDetector` is in Chrome, Edge and Android WebView already. It is not in
Safari or Firefox. So the decision is which of the two to be wrong about: ship
weight to everybody, or lose the camera on some browsers.

**Decision.** Use `BarcodeDetector` and say plainly where it is missing.

The fallback is not a consolation prize. Every site that shows a QR code also
prints the secret under "can't scan the code?", and this app already accepted
both a bare base32 secret and a whole `otpauth://` URI in that field — it did
before this feature existed. Where the API is absent the scanner renders one
sentence pointing at that field, rather than a button that fails when pressed.

The file path matters more than it looks. Google's export screen is on the phone
holding the accounts, so most people cannot scan it with that same phone's
camera; a screenshot sent to the machine doing the import is the normal route.
`BarcodeDetector` reads a `Blob` as happily as a video frame, so both paths are
the same three lines.

Nothing is uploaded. The frame and the file are decoded in the page and dropped.
A photograph of a QR code for a 2FA secret is a 2FA secret.

**Revisit** when Safari ships it, which would make the fallback text wrong and
worth deleting.

## ADR-032 — Google Authenticator's export is parsed by hand

**Status.** Accepted.

Google's "transfer accounts" QR code is not an `otpauth://` link. It is
`otpauth-migration://offline?data=` followed by base64 protobuf — which is why
pasting it into the secret field does nothing and why it needs its own way in.

Reading protobuf normally means `protobufjs` and a `.proto` file. That is a
dependency and a build step for one message with six fields, none of them
nested beyond one level.

**Decision.** Write the reader. It is about eighty lines: varints, length-
delimited fields, and skipping anything unrecognised, which is what the wire
format is designed to allow. Same reasoning as the hand-written TOTP next door.

Two behaviours are deliberate and are the ones worth remembering:

Counter-based (HOTP) codes are in the export and this app does not generate
them. They are listed and refused rather than imported, because an item that
shows a number and never the right one is worse than an item that is not there.

A long export is split across several QR codes. Scans accumulate and are
de-duplicated by secret, so scanning the second code adds to the first instead
of replacing it — the failure that would otherwise import only the last batch
and look like it worked.

Anything unreadable yields an empty list rather than a throw, and the screen
turns that into the sentence naming the menu the right code lives behind. A
plain `otpauth://` link is the thing people try first, and "nothing happened" is
the worst possible answer to it.

## ADR-033 — The backup reminder is checked on open, not scheduled

**Status.** Accepted. Supersedes the wording of IO-06, which said "scheduled".

Nothing here can be scheduled. The server holds ciphertext and cannot tell
whether a backup was ever taken, so it has nothing to schedule *from*. A push
notification would need a subscription tied to an account and a server willing
to say "you have not backed up" — which is a statement about a vault's history,
sent by the one party this product keeps a vault's history from.

**Decision.** Check when the vault is opened, which is the only moment the app
is running and the only moment the reminder can be acted on anyway.

The date is a number in `localStorage`, on the device that took the backup, and
it never leaves. Putting it on the server would tell that server exactly when
somebody is carrying a copy of their vault around, which is the week to try
stealing it.

The cost is that it is per-device: a backup on a laptop does not quiet the
reminder on a phone. Wrong in a small way, right in a larger one, and the
feature row was renamed rather than left claiming a schedule that does not
exist.

Not dismissible, and not a modal. A modal on open is one people learn to close
without reading inside a week, and a dismiss button lets somebody silence the
reminder while still having no backup — the exact state it exists to catch. A
stored date in the future is treated as no backup at all, because trusting it
produces a reminder that never appears again.

## ADR-034 — No Docker image, because it would be a second application

**Status.** Accepted. OSS-02 is cut.

A "single container for VPS self-hosters" sounds like a Dockerfile. It is not.

This app builds through `@opennextjs/cloudflare` into a Worker that runs on
workerd. There is no `next start` here — an early attempt at one failed with
`MODULE_NOT_FOUND`, which is recorded in ADR-030. A container would need the
ordinary Node build instead, and then:

- **D1 replaced.** `createDatabase(env.DB)` is one line, but D1 is SQLite over a
  Cloudflare binding. In a container it becomes a file or a Postgres server,
  with its own migration runner and its own connection handling.
- **KV replaced.** Rate limiting is a token bucket in Workers KV. In a container
  that is Redis, or a table, with different expiry semantics — and rate limiting
  that behaves differently is rate limiting nobody has tested.
- **`CF-Connecting-IP` replaced.** Eleven places read it. Behind Cloudflare it
  is a header a client cannot forge; behind an arbitrary reverse proxy
  `X-Forwarded-For` is a header a client *can* forge, and reading it the same
  way turns per-IP limits into no limits at all.
- **Turnstile.** Optional already, and off in a container that has no
  Cloudflare account — so the bot protection is gone too.

That is not a packaging job. It is a second deployment target with a second
database driver, a second rate-limit store, a different trust boundary at the
edge, and a second CI job to prove any of it works.

**Decision.** Cut it, rather than commit a Dockerfile that has never been run
and cannot be proven by anything in CI. An untested Dockerfile in a password
manager is worse than none: somebody would run it, get a build with unforgeable
headers now forgeable, and have no way to know.

`docs/self-hosting.md` stays, and is honest about what it describes — a
Cloudflare deploy with the free tiers this project already runs on.

**Revisit** if there is ever a reason to maintain a Node target, at which point
the work above is the actual scope and the CI job comes first, not last.

## ADR-035 — No light theme

**Status.** Accepted. UI-13 is cut.

"Inverted terminal" reads like swapping two tokens. The palette is tokenised —
`--color-bg`, `--color-accent` and the rest live in one `@theme` block — so that
part is genuinely one edit. The rest is not.

- **The glow is the theme.** `--shadow-glow` is green light bleeding into black.
  On white it is a smear. Every `text-glow` and `shadow-glow-soft` would need to
  become something else, and "something else" is a design decision, not a value.
- **Contrast inverts, not mirrors.** `#00FF41` on black passes; the same green on
  white is unreadable. A light theme needs its own accent, its own dim, its own
  muted — a second palette designed against white, not the first one flipped.
- **The tests assume one.** `theme.spec.ts` asserts pure black, the zero-radius
  rule and the accent, 22 tests across two viewports. They would each need to
  know which theme is on, which doubles them and halves what any one of them
  says.
- **Four places do not use the tokens at all**, deliberately: `global-error.tsx`
  renders when the app has failed and cannot depend on its own stylesheet, and
  the email template renders in clients that never see this CSS.

**Decision.** Cut it. This is a second visual language, and the product has one
on purpose.

**Revisit** if somebody needs it for a reason the OS cannot already answer —
and note that `prefers-reduced-motion` is honoured (UI-11) and the contrast on
black is already above AA, so the accessibility case is not what is missing.

## ADR-036 — A share link keeps its key after the `#`

**Status.** Accepted.

Sharing a password with somebody who has no account here needs the secret to
travel. The question is what the server sees while it does.

**Decision.** `https://.../s/<token>#<key>`.

The token goes to the server, which stores only its SHA-256 and looks the row up
by that — the same shape as the email tokens, so a database dump yields no
working links. The key is after the `#`, and no browser has ever sent a fragment
in a request. So the server holds a ciphertext, an identifier for it, and
nothing that would open it: not in the database, not in a request log, not in a
CDN cache, not in a `Referer` header.

A fresh 256-bit key per share rather than one derived from the vault. Deriving
would tie every share ever made to the vault key, and the point is to hand over
exactly one thing.

**`GET` looks, `POST` spends.** This is the part that is easy to get wrong.
A one-time link pasted into a chat is fetched by the preview bot before the
recipient ever sees it — Slack, WhatsApp and iMessage all do — and a link that
burned on `GET` would give its only view to a crawler and show the person it was
meant for an empty page with no way to tell why.

**The count is checked and incremented in one statement.** Reading the row and
then writing the count is a race that two requests a millisecond apart win, and
"one-time" that becomes twice under load is not a property. The row is then
deleted rather than marked spent: a row left behind is a ciphertext somebody can
still steal, and its only remaining purpose is to record that a share existed.

**One day, with no option to extend.** A share is a password being handed over
now. Anything still valid next week is a second copy of the secret living
somewhere with no master password in front of it.

**Never existed, already opened and expired all answer the same.** Telling them
apart would make this an oracle for whether a guessed token was ever real.

**The link is shown once and not stored.** A list of live shares would be a list
of keys, which would put the readable secret back on the device and, through
sync, back on the server.

## ADR-037 — An attachment is encrypted under its own key

**Status.** Accepted.

The obvious design is to encrypt a file under the Account Key, the way item
contents are. This does something slightly different: a fresh AES-256 key per
file, used on the body, then wrapped by the Account Key and stored beside the
row.

Two reasons.

**One leaked object is one leaked file.** R2 objects are the part of this system
most likely to be handled by something else — a lifecycle rule, a backup, a
misconfigured bucket policy. A per-file key bounds what any one of them costs.

**Listing stays cheap.** The wrapped key is 60-odd bytes and comes down with the
row, so a list of ten attachments is one request. The bodies stay in R2 until
somebody opens one.

**What the operator holds.** This is the question people actually ask, so it is
worth stating exactly: an R2 object under a random key containing
`v1.<iv>.<ciphertext>`, a wrapped key that needs the Account Key to open, an
encrypted filename, an encrypted MIME type, and a size. Not the contents, not
the name, not the type. Someone with the database and the bucket and root on the
machine has the same nothing as someone with neither, because the Account Key is
derived from a master password that never leaves a browser.

There is a test for that sentence rather than only the sentence. It uploads a
file with a marker in its name and contents, then walks `.wrangler/state` —
which is miniflare's R2 objects and D1 database, the same two things a
Cloudflare account holds — and searches every byte of every file. Deleting the
body encryption makes it fail and names the blob it found the plaintext in.

**Size is in the clear**, deliberately. The quota has to be enforced by
something that cannot read the file, and R2 bills on it. Anybody counting bytes
on the wire has it already.

**The row has no `user_id`.** An attachment belongs to an item and the item
knows whose it is, so every check joins through that rather than trusting a
denormalised copy — a copy is a thing that can disagree with the truth, and here
the disagreement is somebody reading somebody else's file.

**50 MB per account.** Not about cost: R2's free tier is 10 GB. It is about a
bucket nobody is watching, on a service where an account is free, and where
without a cap the storage bill is set by whoever signs up.
