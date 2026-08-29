# Reporting a vulnerability

Core holds passwords, `.env` files and other secrets, and its whole design rests
on a small number of claims about what the server can and cannot see. A report
that breaks one of those claims is the most useful thing anyone can send.

## How to report

Use **GitHub's private vulnerability reporting** on this repository: the
*Security* tab → *Report a vulnerability*. It opens a private thread visible
only to the maintainers.

Please do not open a public issue for anything that could be used against a live
vault before there is a fix.

There is no email address here on purpose. A published address is a permanent
target for everything except the reports it is meant to receive, and GitHub's
private reporting gives the same private channel without one.

## What to include

Enough to reproduce it. In rough order of usefulness:

- What an attacker ends up able to do, stated plainly.
- The steps to get there, or a proof of concept.
- Which version or commit you tested.
- Whether it needs the attacker to already have something — a session, a device,
  a network position — and what.

## What to expect

This is a single-maintainer project, not a company with a rota, so the honest
version of a response-time promise is: you will get an acknowledgement, it will
not be instant, and a real fix matters more than a fast reply.

There is no bug bounty and no payment.

## What is in scope

Anything that breaks one of these:

- **Ciphertext stays ciphertext.** The server, its database and its logs never
  hold a master password, a derived key, or a readable item.
- **Keys stay in the browser.** Nothing in the client sends key material
  anywhere, and nothing persists it outside a non-extractable `CryptoKey`.
- **One account cannot reach another.** Item ids, folder ids, session ids and
  share tokens are all scoped to their owner.
- **Existence is not observable.** Sign-up, sign-in and recovery answer the same
  way for an address that exists and one that does not, in the same time.
- **Locking means locked.** Locking or the panic button leaves nothing readable
  in memory or on the device.

Also in scope: anything that lets an injected script exfiltrate — the Content
Security Policy is load-bearing here, and a way around `connect-src 'self'` is a
real finding even without a way in.

## What is out of scope

- **A device the attacker already controls.** Malware running as the user can
  read the browser's memory. Nothing in a browser prevents that, and the threat
  model says so rather than pretending otherwise.
- **A weak master password.** The strength meter is a hard gate at sign-up, and
  past that the password is the user's to choose.
- **Losing the master password and the Emergency Kit.** There is no recovery,
  by design. That is the product working, not failing.
- **The quick-unlock PIN being short.** Four to eight digits is guessable and is
  documented as such; it is bounded by an attempt limit and a device-bound key,
  and it is off unless somebody turns it on.
- **Rate limits on a self-hosted instance you own.** Tune them; they are yours.
- **Missing headers on a deployment that is not this one.** Report against a
  stock configuration.

## Third parties

The only outbound request Core ever makes on a user's behalf is the optional
breach check, which is off by default, sends five characters of a SHA-1, and is
proxied through the instance's own Worker so the browser never contacts anyone
else. Findings about that path are in scope.
