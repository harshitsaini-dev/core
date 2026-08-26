# Core — Self-Hosting Guide

> **This guide is written ahead of the code.** Steps marked *(planned)* describe
> the intended flow and will be verified against a clean fork before v1.0.0 is
> tagged. Until then, treat this as the design of the deployment story rather
> than a working recipe.

Core is built so that running your own instance costs nothing and takes about
fifteen minutes. Everything below fits inside free tiers.

---

## What you need

| Requirement | Notes |
|---|---|
| A Cloudflare account | Free. Handles hosting, database, DNS and bot protection. |
| A GitHub account | To fork the repository and trigger deploys. |
| Node 20+ and pnpm 9+ | For local setup and the Wrangler CLI. |
| A domain *(optional)* | Cloudflare gives you a free `*.pages.dev` subdomain otherwise. |
| A Resend account *(optional)* | Only needed for login alerts and magic links. |

---

## 1. Fork and install

```bash
git clone https://github.com/<you>/core.git
cd core
pnpm install
```

## 2. Create the database

```bash
pnpm dlx wrangler login
pnpm dlx wrangler d1 create core-vault
```

Copy the printed `[[d1_databases]]` block into `wrangler.toml`. The
`database_id` is not a secret.

Apply the schema:

```bash
pnpm dlx wrangler d1 migrations apply core-vault --local   # local dev
pnpm dlx wrangler d1 migrations apply core-vault --remote  # production
```

## 3. Create the KV namespace for rate limiting

```bash
pnpm dlx wrangler kv namespace create RATE_LIMIT
```

Add the returned id to `wrangler.toml`.

## 4. Generate your auth pepper

This is a random server-side value that makes an offline attack against stolen
verifiers infeasible. Generate your own — never reuse anyone else's, and never
commit it.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
pnpm dlx wrangler secret put AUTH_PEPPER
```

> **Keep a backup of this value somewhere safe.** If you lose it, existing
> accounts on your instance can no longer log in. It cannot be regenerated or
> reset.

For local development, put the same value in `.dev.vars`:

```
AUTH_PEPPER=<your value>
```

`.dev.vars` is git-ignored.

## 5. Optional — email

Sign up at [resend.com](https://resend.com), verify your domain, create a
sending API key, then:

```bash
pnpm dlx wrangler secret put RESEND_API_KEY
```

Without this, Core still works; you simply do not receive login alerts or
magic-link unlocks.

## 6. Optional — Turnstile

In the Cloudflare dashboard, create a Turnstile site for your domain in
*Managed* mode. Put the site key in `.env` as
`NEXT_PUBLIC_TURNSTILE_SITE_KEY`, then:

```bash
pnpm dlx wrangler secret put TURNSTILE_SECRET_KEY
```

## 7. Run locally

```bash
pnpm dev
```

Open <http://localhost:3000>.

## 8. Deploy *(planned)*

1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
2. Select your fork.
3. Build command `pnpm build`.
4. Under **Settings → Functions → Bindings**, bind the D1 database as `DB` and
   the KV namespace as `RATE_LIMIT`.
5. Deploy. Every push to `main` redeploys automatically.

## 9. Custom domain *(planned)*

Pages project → **Custom domains** → add your subdomain. If the zone is already
on Cloudflare the DNS record is created for you. Then set SSL/TLS to
**Full (strict)**, enable **Always Use HTTPS**, and turn on **HSTS**.

---

## Environment variables

| Variable | Type | Required | Purpose |
|---|---|---|---|
| `AUTH_PEPPER` | secret | yes | Mixed into auth verifiers; never touches data encryption |
| `RESEND_API_KEY` | secret | no | Login alerts, magic links |
| `TURNSTILE_SECRET_KEY` | secret | no | Bot protection on auth endpoints |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | public | no | Turnstile widget |
| `NEXT_PUBLIC_APP_URL` | public | yes | Canonical URL used in emails and the manifest |

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
pnpm dlx wrangler d1 migrations apply core-vault --remote
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
