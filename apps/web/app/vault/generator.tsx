'use client';

import { Button, Checkbox, Panel, RadioGroup } from '@core/ui';
import { useCallback, useEffect, useState } from 'react';
import { copySecret } from '@/lib/client/clipboard';
import {
  generateApiKey,
  generateBase64,
  generateHex,
  generatePassphrase,
  generatePassword,
  generateUuid,
} from '@/lib/client/generator';
import { HISTORY_LIMIT, useGeneratorHistory } from '@/lib/client/generator-history';
import { toast } from '@/lib/client/toast-store';

/**
 * The generator.
 *
 * Everything here was already implemented and none of it was reachable — the
 * item form had one `generate` button wired to the defaults, so the length, the
 * character classes, the passphrase and the API-key utility existed as
 * functions nobody could call. The feature list said otherwise. This is the
 * screen that makes it true.
 */

type Mode = 'password' | 'passphrase' | 'api-key' | 'uuid' | 'hex' | 'base64';

const MODES: readonly { value: Mode; label: string }[] = [
  { value: 'password', label: 'password' },
  { value: 'passphrase', label: 'passphrase' },
  { value: 'api-key', label: 'api key' },
  { value: 'uuid', label: 'uuid' },
  { value: 'hex', label: 'hex' },
  { value: 'base64', label: 'base64url' },
];

/** Everything the generator can be asked for, in one place. */
function produce(mode: Mode, options: Options): string {
  switch (mode) {
    case 'passphrase':
      return generatePassphrase(options.words);
    case 'api-key':
      return generateApiKey(options.bytes);
    case 'uuid':
      return generateUuid();
    case 'hex':
      return generateHex(options.bytes);
    case 'base64':
      return generateBase64(options.bytes);
    case 'password':
      return generatePassword({
        length: options.length,
        uppercase: options.uppercase,
        digits: options.digits,
        symbols: options.symbols,
      });
  }
}

interface Options {
  length: number;
  words: number;
  bytes: number;
  uppercase: boolean;
  digits: boolean;
  symbols: boolean;
}

const DEFAULTS: Options = {
  length: 20,
  words: 6,
  bytes: 32,
  uppercase: true,
  digits: true,
  symbols: true,
};

export function GeneratorPanel({ onBack }: { readonly onBack: () => void }) {
  const [mode, setMode] = useState<Mode>('password');
  const [options, setOptions] = useState<Options>(DEFAULTS);
  const [value, setValue] = useState('');
  const [revealed, setRevealed] = useState(false);
  // One at a time, by index. A "reveal all" over a list of passwords is exactly
  // the affordance this panel exists to avoid.
  const [revealedEntry, setRevealedEntry] = useState<number | null>(null);

  const remember = useGeneratorHistory((history) => history.remember);
  const history = useGeneratorHistory((store) => store.items);

  const regenerate = useCallback(() => {
    const next = produce(mode, options);
    setValue(next);
    remember(next, mode);
  }, [mode, options, remember]);

  // Regenerated whenever the shape changes, so the value on screen always
  // matches the settings above it. A stale value under changed options is the
  // one thing a generator must not do: it is how somebody saves a 12-character
  // password believing they asked for 32.
  useEffect(() => {
    regenerate();
  }, [regenerate]);

  async function copy(text: string): Promise<void> {
    toast(
      (await copySecret(text))
        ? 'Copied. The clipboard clears itself shortly.'
        : 'This browser would not let the page write to the clipboard.',
    );
  }

  const set = <K extends keyof Options>(key: K, next: Options[K]): void =>
    setOptions((current) => ({ ...current, [key]: next }));

  return (
    <Panel className="mt-6" data-testid="generator">
      <h2 className="text-accent typewriter mb-2 font-mono text-sm tracking-widest uppercase">
        generate
      </h2>
      <p className="text-muted mb-6 font-mono text-xs">
        <span aria-hidden="true">&gt; </span>
        Drawn from the browser&apos;s CSPRNG, without bias. Ambiguous characters are left out, so
        this can be read off a printed page.
      </p>

      <div
        className="border-line bg-surface mb-6 border p-4"
        data-testid="generated"
        aria-live="polite"
      >
        {/*
          Hidden by default and marked `secret`, so blur-all covers it too. A
          generator that painted a fresh password across the screen the moment
          the panel opened would be the one place in the app that does.
        */}
        <p
          className={`text-accent secret font-mono text-sm break-all ${revealed ? '' : 'is-hidden'}`}
          data-testid="generated-value"
        >
          {revealed ? value : '•'.repeat(Math.min(value.length, 48))}
        </p>
      </div>

      <div className="mb-8 flex flex-wrap gap-3">
        <Button type="button" onClick={regenerate} data-testid="generate-again">
          regenerate
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => void copy(value)}
          data-testid="generate-copy"
        >
          copy
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => setRevealed((shown) => !shown)}
          data-testid="generate-reveal"
        >
          {revealed ? 'hide' : 'reveal'}
        </Button>
      </div>

      <RadioGroup
        name="generator-mode"
        legend="shape"
        value={mode}
        onChange={(next) => setMode(next as Mode)}
        options={MODES}
      />

      {mode === 'password' ? (
        <div className="border-line mt-8 space-y-4 border-t pt-6" data-testid="password-options">
          <Range
            label="length"
            min={8}
            max={64}
            value={options.length}
            onChange={(next) => set('length', next)}
            testId="generate-length"
          />
          <Checkbox
            name="uppercase"
            checked={options.uppercase}
            onChange={(event) => set('uppercase', event.target.checked)}
            label="uppercase"
            data-testid="generate-uppercase"
          />
          <Checkbox
            name="digits"
            checked={options.digits}
            onChange={(event) => set('digits', event.target.checked)}
            label="digits"
            data-testid="generate-digits"
          />
          <Checkbox
            name="symbols"
            checked={options.symbols}
            onChange={(event) => set('symbols', event.target.checked)}
            label="symbols"
            data-testid="generate-symbols"
          />
        </div>
      ) : null}

      {mode === 'passphrase' ? (
        <div className="border-line mt-8 border-t pt-6">
          <Range
            label="words"
            min={3}
            max={12}
            value={options.words}
            onChange={(next) => set('words', next)}
            testId="generate-words"
          />
          <p className="text-muted mt-3 font-mono text-xs leading-relaxed">
            <span aria-hidden="true">&gt; </span>
            256 words, so each one is 8 bits. Three words is 24 bits and is not enough for anything
            that matters.
          </p>
        </div>
      ) : null}

      {mode === 'api-key' || mode === 'hex' || mode === 'base64' ? (
        <div className="border-line mt-8 border-t pt-6">
          <Range
            label={mode === 'api-key' ? 'characters' : 'bytes'}
            min={8}
            max={64}
            value={options.bytes}
            onChange={(next) => set('bytes', next)}
            testId="generate-bytes"
          />
        </div>
      ) : null}

      <div className="border-line mt-8 border-t pt-6">
        <h3 className="text-accent-dim mb-2 font-mono text-xs tracking-widest uppercase">
          this session
        </h3>
        <p className="text-muted mb-4 font-mono text-xs leading-relaxed">
          <span aria-hidden="true">&gt; </span>
          The last {HISTORY_LIMIT}, held in memory only and gone when the vault locks. For the
          password you pasted into a signup form and then regenerated before saving.
        </p>

        {history.length === 0 ? (
          <p className="text-muted font-mono text-xs" data-testid="history-empty">
            <span aria-hidden="true">&gt; </span>
            nothing yet
          </p>
        ) : (
          <ul className="border-line border-t" data-testid="generator-history">
            {history.map((entry, index) => (
              <li
                key={`${entry.value}-${index}`}
                className="border-line flex items-center justify-between gap-3 border-b py-3"
              >
                {/*
                  Masked like the value above it. Listing these in the clear
                  would undo the point of hiding the current one — the panel
                  would still be a column of readable passwords, just further
                  down the page. The kind tells the rows apart, and copying
                  needs no reading at all.
                */}
                <span className="text-accent-dim shrink-0 font-mono text-xs">{entry.kind}</span>
                <span
                  className="text-muted secret is-hidden min-w-0 flex-1 truncate font-mono text-xs"
                  data-testid="history-value"
                >
                  {revealedEntry === index ? entry.value : '•'.repeat(12)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setRevealedEntry(revealedEntry === index ? null : index)}
                  data-testid="history-reveal"
                >
                  {revealedEntry === index ? 'hide' : 'show'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void copy(entry.value)}
                  data-testid="history-copy"
                >
                  copy
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Button
        type="button"
        variant="ghost"
        onClick={onBack}
        className="mt-8"
        data-testid="generator-back"
      >
        back
      </Button>
    </Panel>
  );
}

/** A labelled number, shown as a slider with its value beside it. */
function Range({
  label,
  min,
  max,
  value,
  onChange,
  testId,
}: {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly testId: string;
}) {
  return (
    <label className="block font-mono text-xs">
      <span className="text-muted flex justify-between tracking-widest uppercase">
        {label}
        <span className="text-accent" data-testid={`${testId}-value`}>
          {value}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="control-range mt-2 w-full"
        data-testid={testId}
      />
    </label>
  );
}
