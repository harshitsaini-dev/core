const BOOT_LINES = [
  { prompt: '$', text: 'core --version', accent: false },
  { prompt: '>', text: 'core 0.0.0 (pre-alpha)', accent: false },
  { prompt: '$', text: 'core status', accent: false },
  { prompt: '>', text: 'encryption   AES-256-GCM / client-side only', accent: true },
  { prompt: '>', text: 'derivation   Argon2id (m=64MiB, t=3, p=1)', accent: true },
  { prompt: '>', text: 'server sees  ciphertext', accent: true },
  { prompt: '>', text: 'vault        not built yet — phase 0', accent: false },
] as const;

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center px-6 py-16">
      <div className="border border-line bg-surface p-6 sm:p-8">
        <h1 className="text-accent text-2xl font-bold tracking-tight">
          <span className="cursor">core</span>
        </h1>
        <p className="text-muted mt-2 text-sm">
          zero-knowledge password, secret and .env manager
        </p>

        <div className="mt-8 space-y-1 text-sm">
          {BOOT_LINES.map((line) => (
            <div key={line.text} className="flex gap-3">
              <span className="text-accent-dim select-none">{line.prompt}</span>
              <span className={line.accent ? 'text-accent' : 'text-fg'}>{line.text}</span>
            </div>
          ))}
        </div>
      </div>

      <p className="text-muted mt-6 text-xs">
        Built in the open ·{' '}
        <a
          className="text-accent hover:bg-accent hover:text-bg"
          href="https://github.com/harshitsaini-dev/core"
        >
          github.com/harshitsaini-dev/core
        </a>
      </p>
    </main>
  );
}
