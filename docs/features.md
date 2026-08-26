# Core — Feature Catalogue

Every feature has a stable ID. Phases, issues, commits and the state file all
refer to these IDs, so nothing gets lost between planning and shipping.

**Status legend:** `TODO` · `WIP` · `DONE` · `CUT`
**Phase legend:** P1 Crypto · P2 Auth+DB · P3 Vault UI/PWA · P4 ENV manager ·
P5 Hardening+Deploy · P6 Post-v1

---

## ZK — Zero-Knowledge Core

| ID | Feature | Phase | Status |
|---|---|---|---|
| ZK-01 | Client-side-only encryption; plaintext never crosses the network | P1 | DONE |
| ZK-02 | Master password never sent to the server in any form | P1 | DONE |
| ZK-03 | AES-256-GCM for all vault data, fresh IV per operation | P1 | DONE |
| ZK-04 | Argon2id key derivation, tuned to ~500 ms client-side | P1 | DONE |
| ZK-05 | Two independent derived keys (auth vs encryption) | P1 | DONE |
| ZK-06 | Random per-user Account Key wrapped by the Master Key | P1 | DONE |
| ZK-07 | Master-password change re-wraps only the Account Key | P1 | DONE |
| ZK-08 | ECDH P-256 key pair per user for encrypted sharing | P1 | DONE |
| ZK-09 | Server secrets are irrelevant to data confidentiality | P1 | DONE |
| ZK-10 | Encrypted metadata: titles, URLs, folder names, ENV keys | P1 | DONE |
| ZK-11 | Blind index (HMAC) for server-side equality lookups | P1 | DONE |
| ZK-12 | Versioned ciphertext envelope (`v1.iv.ct`) for future migration | P1 | DONE |
| ZK-13 | Native WebCrypto only; single pinned Argon2 WASM dependency | P1 | DONE |
| ZK-14 | Memory wipe of keys and plaintext on lock or tab close | P3 | DONE |
| ZK-15 | Per-device non-extractable key encrypting the offline cache | P3 | DONE |
| ZK-16 | No administrator password reset — documented as a hard guarantee | P2 | DONE |

## AUTH — Authentication & Session

| ID | Feature | Phase | Status |
|---|---|---|---|
| AUTH-01 | Signup with client-side key generation and Emergency Kit | P2 | DONE |
| AUTH-02 | Login via derived Auth Key, peppered verifier on server | P2 | DONE |
| AUTH-03 | Constant-time verifier comparison | P2 | DONE |
| AUTH-04 | Prelogin salt endpoint with deterministic fake salts | P2 | DONE |
| AUTH-05 | User-enumeration-proof generic error messages | P2 | DONE |
| AUTH-06 | Short-lived session token in HttpOnly/Secure/SameSite cookie | P2 | DONE |
| AUTH-07 | Rotating refresh tokens, revocable per device | P2 | DONE |
| AUTH-08 | WebAuthn / passkey unlock (biometric, FaceID, YubiKey) | P5 | TODO |
| AUTH-09 | Device PIN quick-unlock backed by the device key | P3 | TODO |
| AUTH-10 | Magic-link account unlock after lockout (Resend) | P5 | TODO |
| AUTH-11 | New-device / new-country login approval via email OTP | P5 | TODO |
| AUTH-12 | Concurrent session limit with oldest-session eviction | P5 | TODO |
| AUTH-13 | Trusted-device list with individual revoke | P5 | TODO |
| AUTH-14 | Inactivity auto-lock with configurable timeout | P3 | DONE |

## VAULT — Items & Data Entry

| ID | Feature | Phase | Status |
|---|---|---|---|
| VLT-01 | Login items: title, username, password, URL, notes | P3 | DONE |
| VLT-02 | Arbitrary custom fields (text, hidden, date, number) | P3 | TODO |
| VLT-03 | Isolated recovery-code storage per item | P3 | TODO |
| VLT-04 | Built-in TOTP generator with live countdown ring | P3 | TODO |
| VLT-05 | Secure notes with Markdown rendering | P4 | TODO |
| VLT-06 | Credit-card items (number, CVV, expiry, PIN) | P4 | TODO |
| VLT-07 | Identity profiles (name, address, phone) | P4 | TODO |
| VLT-08 | SSH key / certificate item type | P4 | TODO |
| VLT-09 | Encrypted attachments up to 10 MB (R2) | P6 | TODO |
| VLT-10 | Inline editing directly in the list | P3 | TODO |
| VLT-11 | Item version history with per-version restore | P4 | TODO |
| VLT-12 | Trash with 30-day retention and restore | P3 | DONE |
| VLT-13 | Bulk select: delete, move, tag | P3 | TODO |
| VLT-14 | Drag-and-drop items into folders (desktop) | P4 | TODO |
| VLT-15 | Linked items (DB credential linked to an ENV project) | P4 | TODO |
| VLT-16 | Duplicate item detection | P6 | TODO |

## ORG — Search, Filter, Organisation

| ID | Feature | Phase | Status |
|---|---|---|---|
| ORG-01 | Client-side fuzzy search tolerant of typos | P3 | DONE |
| ORG-02 | Global command palette (Ctrl/Cmd + K) | P3 | TODO |
| ORG-03 | Tags with `#` syntax | P3 | TODO |
| ORG-04 | Nested folders, unlimited depth | P3 | TODO |
| ORG-05 | Colour-coded folders and tags | P3 | TODO |
| ORG-06 | Multi-level combined filtering | P3 | TODO |
| ORG-07 | Sort by A-Z, Z-A, modified, created, most-used | P3 | DONE |
| ORG-08 | Pinned / favourite items at the top | P3 | DONE |
| ORG-09 | Password age indicator per item | P4 | TODO |
| ORG-10 | Grid vs list view toggle | P3 | TODO |
| ORG-11 | Recently used section | P3 | DONE |
| ORG-12 | Saved filter views | P6 | TODO |

## GEN — Generators & Utilities

| ID | Feature | Phase | Status |
|---|---|---|---|
| GEN-01 | Password generator with length, case, digits, symbols | P3 | DONE |
| GEN-02 | Pronounceable passphrase generator (diceware style) | P3 | DONE |
| GEN-03 | Exclude-ambiguous-characters toggle | P3 | DONE |
| GEN-04 | Generator history (session-scoped, never persisted) | P3 | TODO |
| GEN-05 | API-key utility: random 32 / 64 character keys | P4 | DONE |
| GEN-06 | UUID / hex / base64 quick generators | P4 | DONE |
| GEN-07 | Master-password strength meter (zxcvbn) | P2 | DONE |

## ENV — Developer Environment Manager

| ID | Feature | Phase | Status |
|---|---|---|---|
| ENV-01 | Project-scoped secret organisation | P4 | TODO |
| ENV-02 | Per-project environments (dev / staging / prod) | P4 | TODO |
| ENV-03 | Terminal-style editor with syntax highlighting | P4 | TODO |
| ENV-04 | One-click `.env` download | P4 | TODO |
| ENV-05 | Copy whole environment to clipboard as `.env` | P4 | TODO |
| ENV-06 | Export as shell `export KEY="value"` lines | P4 | TODO |
| ENV-07 | Export as Docker `--env` / `docker-compose` fragment | P6 | TODO |
| ENV-08 | Mask / unmask all values with one button | P4 | TODO |
| ENV-09 | Drag-and-drop `.env` import with parsing | P4 | TODO |
| ENV-10 | Paste-to-import from clipboard | P4 | TODO |
| ENV-11 | Version history per variable | P4 | TODO |
| ENV-12 | Diff viewer between versions (red/green) | P4 | TODO |
| ENV-13 | Copy a single variable value | P4 | TODO |
| ENV-14 | Duplicate an environment (dev to staging) | P4 | TODO |
| ENV-15 | Per-variable notes / description | P4 | TODO |
| ENV-16 | Warn on empty or placeholder values | P6 | TODO |

## PWA — Progressive Web App & Mobile UX

| ID | Feature | Phase | Status |
|---|---|---|---|
| PWA-01 | Installable PWA with manifest and maskable icons | P3 | DONE |
| PWA-02 | Service worker with offline app shell | P3 | DONE |
| PWA-03 | Dexie / IndexedDB encrypted offline vault | P3 | DONE |
| PWA-04 | Offline read *and* write with outbox queue | P3 | DONE |
| PWA-05 | Offline / online indicator dot | P3 | DONE |
| PWA-06 | Bottom navigation bar on mobile | P3 | TODO |
| PWA-07 | Pull-to-refresh manual sync | P3 | TODO |
| PWA-08 | Swipe actions: copy username / copy password | P3 | TODO |
| PWA-09 | Haptic feedback on copy (Vibration API) | P3 | DONE |
| PWA-10 | Safe-area insets and one-handed reachability | P3 | DONE |
| PWA-11 | Keyboard shortcuts across desktop | P3 | TODO |
| PWA-12 | Update-available prompt when a new SW is waiting | P5 | TODO |

## UI — Terminal Theme & Interaction

| ID | Feature | Phase | Status |
|---|---|---|---|
| UI-01 | Cyber-brutalist terminal theme, pure black background | P1 | DONE |
| UI-02 | Matrix-green accent (`#00FF41`), monospace everywhere | P1 | DONE |
| UI-03 | Zero border radius, 1px hard borders | P1 | DONE |
| UI-04 | Blinking cursor motif on headings and inputs | P3 | TODO |
| UI-05 | Typewriter reveal on first paint of a view | P3 | TODO |
| UI-06 | Invert-on-hover interaction (black text on green block) | P3 | TODO |
| UI-07 | Toast notifications, bottom-anchored | P3 | TODO |
| UI-08 | Command-line style empty and error states | P3 | TODO |
| UI-09 | Anti-screenshot blur-all toggle | P3 | TODO |
| UI-10 | True OLED black for battery saving | P1 | DONE |
| UI-11 | Reduced-motion support | P5 | TODO |
| UI-12 | Full keyboard navigation and visible focus rings | P5 | TODO |
| UI-13 | Optional light theme (inverted terminal) | P6 | TODO |

## SEC — Security Features (user-facing)

| ID | Feature | Phase | Status |
|---|---|---|---|
| SEC-01 | Security dashboard: weak, reused, old passwords | P5 | TODO |
| SEC-02 | HaveIBeenPwned k-anonymity breach check | P5 | TODO |
| SEC-03 | Clipboard auto-clear after 30 / 60 seconds | P3 | DONE |
| SEC-04 | Session timeout slider (1 / 5 / 15 min / never) | P3 | TODO |
| SEC-05 | Panic button — instant lock and cache wipe | P3 | DONE |
| SEC-06 | Audit log of unlocks, devices, IPs, timestamps | P5 | TODO |
| SEC-07 | Emergency Kit PDF with recovery key | P2 | DONE |
| SEC-08 | Master-password change with Account Key re-wrap | P5 | TODO |
| SEC-09 | Suspicious-activity email alerts | P5 | TODO |
| SEC-10 | One-time self-destructing share links | P6 | TODO |
| SEC-11 | Auto-lock on tab blur (optional) | P3 | TODO |
| SEC-12 | Local security self-check page (CSP, HTTPS, SW status) | P5 | TODO |

## RL — Rate Limiting & Abuse Prevention

| ID | Feature | Phase | Status |
|---|---|---|---|
| RL-01 | Per-IP sliding-window rate limit on auth endpoints | P5 | TODO |
| RL-02 | Endpoint-specific throttles (login 5/min, sync 100/min) | P5 | TODO |
| RL-03 | Progressive response delay on repeated failures | P5 | TODO |
| RL-04 | Token-bucket algorithm for burst tolerance | P5 | TODO |
| RL-05 | Cloudflare Turnstile on signup, login, share-open | P5 | TODO |
| RL-06 | Account-level lockout after N consecutive failures | P5 | TODO |
| RL-07 | Constant-time responses across all auth paths | P2 | DONE |
| RL-08 | Server-side pepper in the verifier | P2 | DONE |
| RL-09 | Body-size limits and strict zod validation on every route | P2 | DONE |
| RL-10 | Structured abuse logging with hashed IPs | P5 | TODO |

## IO — Import, Export, Backup

| ID | Feature | Phase | Status |
|---|---|---|---|
| IO-01 | Encrypted full-vault export (Core native format) | P5 | TODO |
| IO-02 | Plaintext CSV / JSON export with a hard confirmation gate | P5 | TODO |
| IO-03 | Import wizard with column mapping | P5 | TODO |
| IO-04 | Bitwarden import | P5 | TODO |
| IO-05 | 1Password / Chrome / LastPass CSV import | P6 | TODO |
| IO-06 | Scheduled encrypted backup reminder | P6 | TODO |
| IO-07 | Restore-from-backup flow | P5 | TODO |

## OSS — Self-Hosting & Project Health

| ID | Feature | Phase | Status |
|---|---|---|---|
| OSS-01 | One-click Deploy to Cloudflare button | P5 | TODO |
| OSS-02 | Docker single-container option for VPS self-hosters | P6 | TODO |
| OSS-03 | `.env.example` with every variable documented | P2 | DONE |
| OSS-04 | Automated migrations via `wrangler d1 migrations apply` | P2 | DONE |
| OSS-05 | GitHub Actions CI: typecheck, lint, unit, e2e | P2 | DONE |
| OSS-06 | Crypto test vectors published for independent audit | P1 | DONE |
| OSS-07 | SECURITY.md with a responsible-disclosure policy | P5 | TODO |
| OSS-08 | Self-hosting guide with screenshots | P5 | TODO |
| OSS-09 | MIT licence | P0 | DONE |
| OSS-10 | Lighthouse PWA score 100 in CI | P5 | TODO |

---

## Counts

| Group | Features |
|---|---|
| ZK | 16 |
| AUTH | 14 |
| VAULT | 16 |
| ORG | 12 |
| GEN | 7 |
| ENV | 16 |
| PWA | 12 |
| UI | 13 |
| SEC | 12 |
| RL | 10 |
| IO | 7 |
| OSS | 10 |
| **Total** | **145** |
