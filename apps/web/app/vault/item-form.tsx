'use client';

import { Button, Field, Input } from '@core/ui';
import type { DecryptedItem, LoginFields } from '@core/shared';
import { useId, useState } from 'react';
import { generatePassword } from '@/lib/client/generator';
import { useItems } from '@/lib/client/items-store';

/**
 * Create or edit a login.
 *
 * Only logins for now. The other item types share this shape and will reuse it,
 * but shipping five half-finished forms would be worse than one that works.
 */
export function ItemForm({
  existing,
  onDone,
  onCancel,
}: {
  // `| undefined` is explicit because of exactOptionalPropertyTypes: an absent
  // prop and one passed as undefined are different types under that flag, and
  // the caller spreads conditionally.
  existing?: DecryptedItem | undefined;
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const usernameId = useId();
  const passwordId = useId();
  const urlId = useId();

  const fields = (existing?.data.fields ?? {}) as LoginFields;

  const [title, setTitle] = useState(fields.title ?? '');
  const [username, setUsername] = useState(fields.username ?? '');
  const [password, setPassword] = useState(fields.password ?? '');
  const [url, setUrl] = useState(fields.url ?? '');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = useItems((state) => state.save);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (title.trim() === '' || busy) return;

    setBusy(true);
    try {
      const id = await save(
        {
          type: 'login',
          fields: {
            title: title.trim(),
            // Empty strings are dropped rather than stored. An item that
            // records `username: ""` is indistinguishable from one that has a
            // username when read back, and the list would show a blank line.
            ...(username.trim() ? { username: username.trim() } : {}),
            ...(password ? { password } : {}),
            ...(url.trim() ? { url: url.trim() } : {}),
          },
        },
        existing?.id,
      );
      onDone(id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate>
      <Field label="title" htmlFor={titleId}>
        <Input
          id={titleId}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          autoComplete="off"
          data-testid="item-title"
          required
        />
      </Field>

      <Field label="username" htmlFor={usernameId}>
        <Input
          id={usernameId}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="off"
          data-testid="item-username"
        />
      </Field>

      <Field label="password" htmlFor={passwordId}>
        <div className="flex gap-2">
          <Input
            id={passwordId}
            // Typed in the clear only when asked. Shoulder-surfing is the threat
            // this screen actually faces day to day.
            type={reveal ? 'text' : 'password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="off"
            data-testid="item-password"
          />
          <Button
            type="button"
            variant="ghost"
            onClick={() => setReveal((current) => !current)}
            aria-pressed={reveal}
            data-testid="item-reveal"
          >
            {reveal ? 'hide' : 'show'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setPassword(generatePassword());
              // Revealed on generation: a string nobody has seen is one nobody
              // can check, and this is the moment to notice it went in wrong.
              setReveal(true);
            }}
            data-testid="item-generate"
          >
            generate
          </Button>
        </div>
      </Field>

      <Field label="url" htmlFor={urlId}>
        <Input
          id={urlId}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          autoComplete="off"
          inputMode="url"
          data-testid="item-url"
        />
      </Field>

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={busy || title.trim() === ''} data-testid="item-save">
          {busy ? '... saving' : 'save'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} data-testid="item-cancel">
          cancel
        </Button>
      </div>
    </form>
  );
}
