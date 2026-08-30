# Core — Threat Model & Security Policy

This document states plainly what Core protects against, what it does not, and
how to report a vulnerability. If a claim here is ever untrue of the code, that
is a bug worth reporting.

---

## 1. What Core protects against

### The server operator

The person running the instance — including the author of this project — cannot
read stored passwords, secrets, notes, `.env` values, item titles, URLs, folder
names or project names. All of it is ciphertext by the time it leaves your
device.

The one exception is your email address, which the server must be able to read
in order to send to it. That is covered under what Core does _not_ protect,
below.

### A full database compromise

An attacker who dumps the entire D1 database obtains encrypted blobs and
authentication verifiers. Each verifier is `HMAC-SHA256(pepper, authKey)`, and
the pepper lives in the Worker's secret store rather than the database — so an
offline attack cannot begin without also compromising that store. Even with the
pepper, every password guess still costs a full Argon2id derivation, because the
Auth Key is itself an Argon2id output.

### Server source-code and environment compromise

The server's secrets are used for authentication rate-limiting and email. None
of them participate in data encryption. Possessing the production `.env` does
not help decrypt any vault.

### Network interception

HTTPS only, HSTS enforced. Payload fields are already ciphertext before TLS is
applied, so a broken TLS session still yields nothing readable.

### Online brute force

A token bucket per caller per endpoint, sized to the endpoint: five logins in a
burst refilling at five a minute, twenty preloginses, a hundred syncs. Repeated
requests from one caller also lengthen the padded response time, doubling up to
a cap, so a guessing loop slows to a crawl while somebody who mistyped their
password twice notices nothing.

Ten consecutive failures against one account lock it for fifteen minutes. The
window expires on its own, so nobody is ever stranded, and a locked account
answers exactly like a wrong password — see the note on enumeration below.

Two limits of this, stated plainly. The buckets live in Workers KV, which is
eventually consistent, so it is a throttle rather than an exact ceiling: a
burst spread across Cloudflare locations can overshoot. And the limiter needs to
know who is calling — behind Cloudflare it always does, but an instance exposed
directly with no proxy setting `cf-connecting-ip` or `x-forwarded-for` has no
rate limiting at all, and says so in its logs. Both are documented in
self-hosting.md.

Neither is the first line of defence. Argon2id is: every guess costs the
attacker real time and memory on their own hardware before a request is sent.

Cloudflare Turnstile (RL-05) is specified and **not yet built**.

### User enumeration and timing analysis

The prelogin endpoint returns a deterministic fake salt for unknown addresses.
Verifier comparison is constant-time. Login, signup and password-reset endpoints
return identical generic messages regardless of whether an account exists.

The account lockout is arranged around the same rule and pays for it. A locked
account returns the same status, the same body and the same padded time as a
wrong password, because saying "this account is locked" would confirm the
account exists. The cost is real: somebody whose account has been attacked is
told "incorrect" for fifteen minutes while their correct password is refused,
with nothing explaining why. That is the wrong trade in most products and the
right one here, where the entire claim is that the server knows nothing.

The rate limit's own refusal is safe to distinguish, and is: it depends only on
the caller's address, which the caller already knows.

### Local device theft, partially

The offline cache is encrypted twice: item contents under the Account Key, and
each stored row again under a per-device key that is non-extractable, so no
script can copy it out. Auto-lock and a panic button that destroys the cache
limit the window of exposure.

What this does **not** remove is the offline attack. Opening the vault without a
network means keeping a local copy of the wrapped Account Key, and somebody
holding the device can attack that copy at their own pace with no rate limit.
This is inherent to every password manager that opens offline, and the defence
is the same one the server relies on: Argon2id, tuned so each guess costs real
time and memory. A weak master password is materially worse on a stolen device
than on a stolen database.

---

## 2. What Core does not protect against

Stating these honestly is more useful than pretending otherwise.

**A compromised device.** Malware, a keylogger, or a malicious browser
extension on your machine can capture your master password as you type it or
read plaintext out of the page after unlock. No web application can defend
against this.

**A malicious or compromised server _serving new code_.** Core's guarantee is
about data at rest and in transit. A hostile operator who modifies the
JavaScript delivered to your browser could make it exfiltrate keys. This is
inherent to all web-delivered end-to-end encryption, and no header helps against
the party that sets the headers. Mitigations: the code is public, and you can
self-host so that you control what is served.

Against _injected_ script — an XSS rather than a hostile operator — the Content
Security Policy does help, and specifically `connect-src 'self'`: injected code
can read what the page holds but cannot send it anywhere. One weakness is worth
stating plainly rather than leaving in the header: `style-src` still allows
inline styles, because React and Next both inject them and the framework offers
no way to nonce every one. Injected CSS can exfiltrate through a background-image
URL and can overlay a convincing prompt; it cannot read a `CryptoKey`.

**A weak master password.** Argon2id makes guessing expensive, not impossible.
If your master password is short or reused, the design cannot save you.

**Forgetting your master password.** There is no recovery path other than your
Emergency Kit. This is deliberate.

**Your email address.** The operator can read it. Core has to be able to send
you magic links, login alerts and new-device codes, and a server that cannot
read an address cannot send to it. The address is encrypted at rest under a
server-held key, so a database dump alone does not expose it — but the operator
holds that key. Everything else in your vault stays unreadable to them. If this
matters to you, self-host. See ADR-014.

**Traffic analysis.** The operator cannot read your data but can observe that
you synced, roughly how much data you hold, and when you were active.

**Malicious dependencies.** Mitigated by a pinned lockfile, a deliberately tiny
crypto dependency surface, Dependabot, secret scanning and SRI — but a supply
chain attack on a build-time dependency remains a real risk for any web app.

---

### Two surfaces that deserve naming

**Attachments.** The file body is encrypted in the browser under a key generated
for that one file, which is then wrapped by the Account Key. What R2 holds is
ciphertext under a random object name; what D1 holds beside it is a wrapped key,
an encrypted filename, an encrypted MIME type and a size. The operator has the
same nothing they have for a vault item.

The size is in the clear, deliberately: a quota has to be enforced by something
that cannot read the file, and anybody counting bytes on the wire has it anyway.
So an operator can see that an account stores four files and roughly how large
each one is. That is the whole of what leaks.

**Share links, which are different in kind.** Everything else in Core is
encrypted so that only you can read it. A share link exists to let somebody else
read one thing, so it steps outside that property on purpose, and it is worth
being exact about where it lands.

The link is `/s/<token>#<key>`. The token reaches the server, which stores only
its SHA-256; the key never leaves a browser, because no browser sends the part
after a `#`. So the operator holds a ciphertext they cannot open — the zero-
knowledge property survives intact on their side.

What changes is the threat model around the *link itself*. Anyone holding the
whole link can open the secret once. It is therefore exactly as sensitive as the
password inside it, and should travel the way that password would. Core narrows
the window rather than pretending it is closed: one view, one day, no extension,
and the row is deleted rather than marked spent. Opening is a `POST` behind a
click, so a chat client's preview crawler cannot consume the view before the
recipient sees it.

What Core cannot do is know who opened it. If a link is intercepted in transit,
the recipient finds it already spent — which is the alarm, and the only one
available.

## 3. Cryptography summary

| Purpose            | Primitive                                            |
| ------------------ | ---------------------------------------------------- |
| Key derivation     | Argon2id, `m = 64 MiB, t = 3, p = 1`, ~500 ms target |
| Key separation     | HKDF-SHA256 split of one Argon2id output             |
| Auth verifier      | HMAC-SHA256 under a server-side pepper               |
| Fallback KDF       | PBKDF2-SHA512, 600 000 iterations                    |
| Data encryption    | AES-256-GCM, 96-bit random IV per operation          |
| Key wrapping       | AES-256-GCM                                          |
| Sharing            | ECDH P-256 + HKDF-SHA256                             |
| Sub-key derivation | HKDF-SHA256 with distinct `info` strings             |
| Blind index        | HMAC-SHA256, truncated to 128 bits                   |
| Randomness         | `crypto.getRandomValues` only                        |

Test vectors for every primitive are published alongside `packages/crypto` so
that an independent implementation can verify compatibility.

---

## 4. Reporting a vulnerability

Please do not open a public issue for a security problem.

Report privately through GitHub's **Security → Report a vulnerability** on
<https://github.com/harshitsaini-dev/core>, which creates a private advisory.

Please include what you can: affected version or commit, a description of the
issue, reproduction steps, and your assessment of impact.

**What to expect:** an acknowledgement within 72 hours, an assessment within
seven days, and a fix released as fast as severity warrants. Credit in the
advisory unless you prefer otherwise.

This is a personal open-source project, not a funded programme — there is no
bug bounty, only genuine gratitude and public credit.

---

## 5. Supported versions

Until v1.0.0 ships, only the default branch is supported. After v1.0.0, the
latest minor release receives security fixes.
