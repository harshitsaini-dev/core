import { buttonClasses } from '@core/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The landing page.
 *
 * A password manager is asking for the most sensitive thing somebody owns, so
 * this page is written as a disclosure rather than a pitch. Every line is a
 * claim the rest of the code has to keep, which is also why the section on what
 * the server *can* see exists: a page that only lists what is hidden is telling
 * half of a true story, and the half it leaves out is the half a careful reader
 * came for.
 *
 * The iteration count is deliberately not printed. An earlier version said
 * `t=3` while the app calibrated on the device and landed at twelve or more —
 * a number nobody would check, on the one page everybody reads.
 */

const STATUS = [
  { text: 'encryption   AES-256-GCM / client-side only', accent: true },
  { text: 'derivation   Argon2id, calibrated on your device', accent: true },
  { text: 'server sees  ciphertext', accent: true },
  { text: 'recovery     Emergency Kit — there is no password reset', accent: false },
] as const;

const HOLDS = [
  { name: 'logins', detail: 'usernames, passwords, one-time codes, recovery codes' },
  { name: 'notes', detail: 'stored exactly as typed, never rendered as markup' },
  { name: 'cards', detail: 'number, expiry, CVV and PIN, masked in the list' },
  { name: 'identities', detail: 'the details forms ask for over and over' },
  { name: 'ssh keys', detail: 'private keys with their line breaks intact' },
  { name: '.env files', detail: 'per project, per environment — import and export whole' },
] as const;

const STEPS = [
  {
    step: '01',
    title: 'you type a master password',
    detail: 'It is never sent. Not hashed and sent — not sent.',
  },
  {
    step: '02',
    title: 'the browser derives your keys',
    detail: 'Memory-hard by design, so each guess costs an attacker real time and RAM.',
  },
  {
    step: '03',
    title: 'everything is encrypted here',
    detail: 'The server receives blobs, stores blobs, and returns blobs.',
  },
] as const;

const HIDDEN = [
  'passwords, notes, card numbers, SSH keys',
  'item titles, usernames and URLs',
  'folder names, tags and project names',
  'environment variable names — not only their values',
];

const VISIBLE = [
  'your email address, so it can send you a login link',
  'how many items you have, and when each last changed',
  'when you sign in, from roughly where',
];

export default function Home() {
  return (
    <main className="mx-auto min-h-dvh max-w-4xl px-6 py-16">
      <section>
        <h1 className="text-accent text-glow text-3xl font-bold tracking-tight">
          <span className="cursor">core</span>
        </h1>

        <p className="text-muted mt-4 font-mono text-xs tracking-widest">
          zero-knowledge password, secret and .env manager
        </p>

        <p className="text-fg mt-8 max-w-2xl text-lg leading-relaxed">
          Your passwords and your <span className="text-accent">.env</span> files, encrypted before
          they leave your browser.
        </p>
        <p className="text-muted mt-3 max-w-2xl text-sm leading-relaxed">
          The server stores what it cannot read. That is not a policy it promises to follow — it is
          the only thing it is ever given.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          {/*
            Links, not buttons that push a route. There are no keys in memory on
            this page, so a full navigation costs nothing — and a link belongs in
            the tab order as a link, opens in a new tab on middle-click, and is
            announced as one.
          */}
          <Link href="/signup" className={buttonClasses('primary')} data-testid="go-signup">
            create a vault
          </Link>
          <Link href="/login" className={buttonClasses('ghost')} data-testid="go-login">
            unlock
          </Link>
        </div>

        <div className="border-line bg-surface mt-10 border p-6 sm:p-8">
          <div className="flex gap-3 text-sm">
            <span className="text-accent-dim select-none">$</span>
            <span className="text-fg">core status</span>
          </div>
          <div className="mt-2 space-y-1 text-sm">
            {STATUS.map((line) => (
              <div key={line.text} className="flex gap-3">
                <span className="text-accent-dim select-none">&gt;</span>
                <span className={line.accent ? 'text-accent' : 'text-fg'}>{line.text}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <Section title="what it holds">
        <ul className="grid gap-px sm:grid-cols-2">
          {HOLDS.map((entry) => (
            <li key={entry.name} className="border-line bg-surface border p-4">
              <p className="text-accent font-mono text-xs tracking-widest uppercase">
                {entry.name}
              </p>
              <p className="text-muted mt-2 text-sm leading-relaxed">{entry.detail}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="how it works">
        <ol className="space-y-6">
          {STEPS.map((entry) => (
            <li key={entry.step} className="flex gap-4">
              <span className="text-accent-dim shrink-0 font-mono text-sm">{entry.step}</span>
              <div>
                <p className="text-fg text-sm">{entry.title}</p>
                <p className="text-muted mt-1 text-sm leading-relaxed">{entry.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="what the server can and cannot see">
        {/*
          The half most products leave out. A page that lists only what is hidden
          is telling half a true story, and the missing half is what a careful
          reader arrived for.
        */}
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="border-line border p-4">
            <p className="text-accent font-mono text-xs tracking-widest uppercase">cannot see</p>
            <ul className="mt-3 space-y-2">
              {HIDDEN.map((line) => (
                <li key={line} className="text-muted flex gap-2 text-sm leading-relaxed">
                  <span aria-hidden="true" className="text-accent select-none">
                    -
                  </span>
                  {line}
                </li>
              ))}
            </ul>
          </div>

          <div className="border-line border p-4">
            <p className="text-warning font-mono text-xs tracking-widest uppercase">can see</p>
            <ul className="mt-3 space-y-2">
              {VISIBLE.map((line) => (
                <li key={line} className="text-muted flex gap-2 text-sm leading-relaxed">
                  <span aria-hidden="true" className="text-warning select-none">
                    -
                  </span>
                  {line}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <Section title="the part to read twice">
        <div className="border-danger border p-4 sm:p-6">
          <p className="text-danger font-mono text-xs tracking-widest uppercase">
            no password reset
          </p>
          <p className="text-fg mt-3 text-sm leading-relaxed">
            Nobody here can open your vault, and that includes when you want them to. Lose your
            master password <em>and</em> your Emergency Kit and the vault is gone — not locked,
            gone.
          </p>
          <p className="text-muted mt-3 text-sm leading-relaxed">
            The Emergency Kit is shown once, when you create the vault. Print it, or write it down.
            It is the only way back.
          </p>
        </div>
      </Section>

      <footer className="border-line mt-16 border-t pt-6">
        <p className="text-muted text-xs">
          <span aria-hidden="true">&gt; </span>
          Encrypted in your browser. Unreadable to this server.
        </p>
      </footer>
    </main>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-16">
      <h2 className="text-accent-dim mb-6 font-mono text-xs tracking-widest uppercase">
        <span aria-hidden="true">## </span>
        {title}
      </h2>
      {children}
    </section>
  );
}
