# Core — Self-Hosting Guide

> **These steps were followed on 2026-08-29 to deploy the instance at
> `core.harshitsaini.in`.** They are written from what actually happened,
> including the two places it went wrong, rather than from what was intended.
> What has not been done is a run-through on a _clean fork_ — so treat the
> numbers and screens as accurate and the ordering as tested once.

Core is built so that running your own instance costs nothing and takes about
fifteen minutes. Everything below fits inside free tiers.

---

## What you need

| Requirement                   | Notes                                                             |
| ----------------------------- | ----------------------------------------------------------------- |
| A Cloudflare account          | Free. Handles hosting, database, DNS and bot protection.          |
| A GitHub account              | To fork the repository and trigger deploys.                       |
| Node 20+ and pnpm 9+          | Wrangler ships as a project dependency; no global install needed. |
| A domain _(optional)_         | Cloudflare gives you a free `*.pages.dev` subdomain otherwise.    |
| A Resend account _(optional)_ | Only needed for login alerts and magic links.                     |

---

## 1. Fork and install

```bash
git clone https://github.com/<you>/core.git
cd core
pnpm install
```

## 2. Create the database

```bash
pnpm cf login
pnpm cf d1 create core-vault
```

Copy the printed `[[d1_databases]]` block into `wrangler.toml`. The
`database_id` is not a secret.

Apply the schema:

```bash
pnpm db:migrate:local   # local dev
pnpm db:migrate  # production
```

## 3. Create the KV namespace for rate limiting

```bash
pnpm cf kv namespace create RATE_LIMIT
```

Add the returned id to `wrangler.toml`.

### The limiter needs to know who is calling

Buckets are keyed by the caller's address, taken from `cf-connecting-ip` — which
Cloudflare sets and a client cannot forge. Deployed on Workers behind Cloudflare,
which is what this project is built for, that header is always present and there
is nothing to configure.

If you run Core anywhere else, note what happens instead. The fallback is the
first entry of `x-forwarded-for`, consulted **only** when `cf-connecting-ip` is
absent. And if neither header is there — an origin exposed directly to the
internet, with no proxy in front — **rate limiting does nothing**, and the server
logs a warning saying so on every request it could not attribute.

That is deliberate rather than an oversight. The alternative, counting every
unattributable request against one shared bucket, means any single visitor can
exhaust the limit for everybody, which is a denial of service dressed up as a
defence. So: put the instance behind something that sets one of those two
headers. Argon2id and the account lockout still apply either way.

## 4. Generate your auth pepper

This is a random server-side value that makes an offline attack against stolen
verifiers infeasible. Generate your own — never reuse anyone else's, and never
commit it.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
pnpm cf secret put AUTH_PEPPER
```

> **Keep a backup of this value somewhere safe.** If you lose it, existing
> accounts on your instance can no longer log in. It cannot be regenerated or
> reset.

For local development, copy `apps/web/.dev.vars.example` to `apps/web/.dev.vars` and put a
**different, disposable** pepper in it:

```
AUTH_PEPPER=<a separate local value>
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

`apps/web/.dev.vars` is git-ignored, and Wrangler loads it automatically — it
sits beside `wrangler.toml`, which is where the adapter looks. Keep it
distinct from production: local accounts are throwaway, so a leaked development
pepper costs nothing, whereas reusing the production value would extend a local
mistake to real users.

## 5. Optional — email

Sign up at [resend.com](https://resend.com), verify a domain you control —
a dedicated sending subdomain is worth it, so that a deliverability problem here
cannot affect your main domain — then create a sending API key:

```bash
pnpm cf secret put RESEND_API_KEY
```

Set `RESEND_FROM_EMAIL` to an address on that verified domain, in the form
`Core <no-reply@mail.example.com>`.

Without this, Core still works; you simply do not receive login alerts or
magic-link unlocks.

## 6. Optional — Turnstile

In the Cloudflare dashboard, create a Turnstile site for your domain in
_Managed_ mode. Put the site key in `.env` as
`NEXT_PUBLIC_TURNSTILE_SITE_KEY`, then:

```bash
pnpm cf secret put TURNSTILE_SECRET_KEY
```

## 7. Run locally

```bash
pnpm dev
```

Open <http://localhost:3000>.

## 8. Deploy

This is a **Workers** deploy, not Pages. `@opennextjs/cloudflare` produces a
Worker, and the bindings come from `wrangler.toml` rather than from a dashboard
form.

### Deploy from CI, not from your machine

The build does not run on Windows. pnpm links `react`, `react-dom` and
`styled-jsx` into the build output as symlinks and esbuild on Windows cannot
follow them — you get `Access is denied` for each, then
`Could not resolve "styled-jsx"`. OpenNext warns about this itself. On macOS or
Linux `pnpm build:cf && pnpm deploy` works directly; on Windows use WSL or the
included workflow.

The workflow is `.github/workflows/deploy.yml`. It is manual-only and asks you
to type `deploy`, because a password manager should not go out because somebody
merged a README change.

### The API token needs D1, and the Workers template does not include it

Create a token at **My Profile → API Tokens** from the **Edit Cloudflare
Workers** template, then **add one more permission**:

| Permission                                | Why                                                  |
| ----------------------------------------- | ---------------------------------------------------- |
| `Account` · `Workers Scripts` · `Edit`    | the deploy itself                                    |
| `Account` · `Workers KV Storage` · `Edit` | the rate-limit namespace                             |
| `Account` · `D1` · `Edit`                 | **not in the template** — migrations fail without it |

Without D1, the deploy fails at the migration step with
`The given account is not valid or is not authorized to access this service
[code: 7403]`, which does not mention D1 at all.

### Repository settings

On your fork, **Settings → Secrets and variables → Actions**:

| Name                    | Kind         | Value                           |
| ----------------------- | ------------ | ------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | secret       | the token above                 |
| `CLOUDFLARE_ACCOUNT_ID` | secret       | from any zone's overview page   |
| `DEPLOY_URL`            | **variable** | the address you will serve from |

`DEPLOY_URL` is required, not decorative. `NEXT_PUBLIC_APP_URL` is inlined at
build time, so an unset value does not fail — it ships `http://localhost:3000`
as the site's canonical URL and in every Open Graph tag. The workflow now stops
rather than building that.

### Run it

**Actions → Deploy → Run workflow**, type `deploy`. The order is deliberate:
typecheck, lint, tests, build, **migrations, then the code**. A column the new
code reads has to exist before that code serves; the other order is a window
where every request fails.

## 9. Custom domain

**Compute (Workers & Pages) → your worker → Settings → Domains & Routes → Add →
Custom Domain.** Cloudflare creates the DNS record itself if the zone is on the
same account.

Then, on the **zone** — not the Worker; this is the step people look for in the
wrong place — **SSL/TLS**:

- **Overview** → **Full (strict)**
- **Edge Certificates** → **Always Use HTTPS**

Always Use HTTPS matters more here than on an ordinary site. Web Crypto and
service workers both require a secure context, so over plain HTTP the app loads
and its cryptography does not.

Cloudflare's own **HSTS** toggle is optional: the app already sends
`Strict-Transport-Security` with a two-year max-age. The toggle applies to the
whole zone including every subdomain, so enabling `includeSubDomains` there will
break any sibling subdomain that is not on HTTPS. Leave **preload** off until
you are sure — it is hard to undo.

### Two things to do after the domain answers

1. Set `DEPLOY_URL` to the new address and **deploy again**. The old one is
   baked into the build.
2. Set `workers_dev = false` in `wrangler.toml` and deploy once more. Two
   addresses serving one vault is two places a session cookie can live, two
   origins a service worker can register against, and a second official-looking
   name to imitate.

`preview_urls = false` is already set and is worth understanding: Cloudflare
otherwise gives every deployment a permanent public URL bound to the same live
database, so every build you ever shipped stays reachable and serving real
data.

---

## Environment variables

| Variable                         | Type   | Required | Purpose                                                  |
| -------------------------------- | ------ | -------- | -------------------------------------------------------- |
| `AUTH_PEPPER`                    | secret | yes      | Mixed into auth verifiers; never touches data encryption |
| `RESEND_API_KEY`                 | secret | no       | Login alerts, magic links                                |
| `TURNSTILE_SECRET_KEY`           | secret | no       | Bot protection on auth endpoints                         |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | public | no       | Turnstile widget                                         |
| `NEXT_PUBLIC_APP_URL`            | public | yes      | Canonical URL used in emails and the manifest            |

See `.env.example` for the authoritative list.

---

## After deploying

1. Create your account. Signup generates an **Emergency Kit** PDF in your
   browser — it is never uploaded.
2. **Print it and store it physically.**
3. Verify it: open a private window, clear site data, and restore your account
   using only the kit.
4. Only then start putting real passwords in.

Skipping step 3 is the most common way people lose a self-hosted vault.

---

## Upgrading

```bash
git pull upstream main
pnpm install
pnpm db:migrate
```

Migrations never rewrite ciphertext. If a future release changes the encryption
envelope, the app re-encrypts client-side on your next unlock, and the release
notes will say so explicitly.

---

## Backups

D1 supports point-in-time restore on the free tier, but do not rely on that
alone. Use Core's own encrypted export (Settings → Export) periodically and keep
the file somewhere separate. The export is encrypted with your Account Key, so
it is safe to store in ordinary cloud storage.
