'use client';

import { parseOtpauth } from '@core/crypto';
import type { CustomField, DecryptedItem, LoginFields, VaultItemData } from '@core/shared';
import { Button, Field, Input } from '@core/ui';
import { useId, useState } from 'react';
import { generatePassword } from '@/lib/client/generator';
import { useItems } from '@/lib/client/items-store';

/**
 * Create or edit an item.
 *
 * Two types so far: logins and notes. They share the save path and the custom
 * fields; everything else differs enough that a single set of inputs would suit
 * neither.
 */

/** Shared by both types, so the textarea styling lives in one place. */
const TEXTAREA_CLASS =
  'border-line text-fg placeholder:text-muted/60 focus:border-accent focus:shadow-glow-soft w-full border bg-black px-3 py-2 font-mono text-base focus:outline-none sm:text-sm';

type ItemType = VaultItemData['type'];

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
  // The type is fixed once an item exists. Changing it would silently discard
  // whichever fields the other type does not have.
  const [type, setType] = useState<ItemType>(existing?.data.type ?? 'login');

  return (
    <div className="space-y-6">
      {existing ? null : (
        <div className="flex flex-wrap gap-2" role="group" aria-label="item type">
          {(['login', 'note'] as const).map((option) => (
            <Button
              key={option}
              type="button"
              variant={type === option ? 'primary' : 'ghost'}
              onClick={() => setType(option)}
              aria-pressed={type === option}
              data-testid={`type-${option}`}
            >
              {option}
            </Button>
          ))}
        </div>
      )}

      {type === 'note' ? (
        <NoteForm {...(existing ? { existing } : {})} onDone={onDone} onCancel={onCancel} />
      ) : (
        <LoginForm {...(existing ? { existing } : {})} onDone={onDone} onCancel={onCancel} />
      )}
    </div>
  );
}

interface FormProps {
  existing?: DecryptedItem | undefined;
  onDone: (id: string) => void;
  onCancel: () => void;
}

/**
 * A note.
 *
 * Free-form text, stored as written. Deliberately **not** rendered as Markdown,
 * despite the field being Markdown-friendly: turning user text into HTML means
 * running a parser and injecting its output into the one origin that holds the
 * vault keys. A note is the easiest place in the product for hostile content to
 * arrive — pasted from anywhere, synced from another device — and rendering it
 * would trade a real risk for a formatting nicety.
 *
 * So the text is shown exactly as typed, with line breaks preserved. Markdown
 * syntax survives for anyone who wants to paste it elsewhere; it simply is not
 * interpreted here.
 */
function NoteForm({ existing, onDone, onCancel }: FormProps) {
  const titleId = useId();
  const bodyId = useId();

  const fields = existing?.data.type === 'note' ? existing.data.fields : undefined;

  const [title, setTitle] = useState(fields?.title ?? '');
  const [body, setBody] = useState(fields?.body ?? '');
  const [busy, setBusy] = useState(false);

  const save = useItems((state) => state.save);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    // A note with only a body is a normal thing to write. Rather than refusing
    // it, take the first line as the title — which is what the person typing
    // almost certainly meant by it.
    const derivedTitle = title.trim() || body.trim().split('\n')[0]?.slice(0, 80) || '';
    if (derivedTitle === '') return;

    setBusy(true);
    try {
      const id = await save(
        {
          type: 'note',
          fields: {
            title: derivedTitle,
            ...(body ? { body } : {}),
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
      <Field label="title" htmlFor={titleId} hint="Optional. The first line is used if left blank.">
        <Input
          id={titleId}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          autoComplete="off"
          data-testid="note-title"
        />
      </Field>

      <Field label="note" htmlFor={bodyId}>
        <textarea
          id={bodyId}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={14}
          spellCheck
          autoFocus
          placeholder="Write anything. It is encrypted before it leaves this device."
          data-testid="note-body"
          className={TEXTAREA_CLASS}
        />
      </Field>

      <div className="flex flex-wrap gap-3">
        <Button
          type="submit"
          disabled={busy || (title.trim() === '' && body.trim() === '')}
          data-testid="item-save"
        >
          {busy ? '... saving' : 'save'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} data-testid="item-cancel">
          cancel
        </Button>
      </div>
    </form>
  );
}

/** A login. */
function LoginForm({ existing, onDone, onCancel }: FormProps) {
  const titleId = useId();
  const usernameId = useId();
  const passwordId = useId();
  const urlId = useId();
  const totpId = useId();
  const codesId = useId();

  const fields = (existing?.data.type === 'login' ? existing.data.fields : {}) as LoginFields;

  const [title, setTitle] = useState(fields.title ?? '');
  const [username, setUsername] = useState(fields.username ?? '');
  const [password, setPassword] = useState(fields.password ?? '');
  const [url, setUrl] = useState(fields.url ?? '');
  const [totpSecret, setTotpSecret] = useState(fields.totpSecret ?? '');
  const [totpError, setTotpError] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState((fields.recoveryCodes ?? []).join('\n'));
  const [custom, setCustom] = useState<CustomField[]>(fields.customFields ?? []);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = useItems((state) => state.save);

  /**
   * Accept either a bare base32 secret or a whole `otpauth://` URI.
   *
   * Pasting the URI is what people do when a site shows "can't scan the code?",
   * and silently storing it as if it were a secret would produce a TOTP field
   * that never generates a working code.
   */
  function onTotpChange(value: string): void {
    const trimmed = value.trim();
    setTotpError('');

    if (trimmed.toLowerCase().startsWith('otpauth://')) {
      const parsed = parseOtpauth(trimmed);
      if (!parsed) {
        setTotpSecret(trimmed);
        setTotpError('That otpauth link could not be read.');
        return;
      }
      setTotpSecret(parsed.secret);
      return;
    }

    setTotpSecret(trimmed);
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (title.trim() === '' || busy) return;

    setBusy(true);
    try {
      const codes = recoveryCodes
        .split('\n')
        .map((code) => code.trim())
        .filter((code) => code !== '');

      const cleanedCustom = custom.filter((field) => field.label.trim() !== '');

      const id = await save(
        {
          type: 'login',
          fields: {
            title: title.trim(),
            // Empty values are dropped rather than stored. An item recording
            // `username: ""` reads back as though it has one, and the list
            // shows a blank line under the title.
            ...(username.trim() ? { username: username.trim() } : {}),
            ...(password ? { password } : {}),
            ...(url.trim() ? { url: url.trim() } : {}),
            ...(totpSecret ? { totpSecret } : {}),
            ...(codes.length > 0 ? { recoveryCodes: codes } : {}),
            ...(cleanedCustom.length > 0 ? { customFields: cleanedCustom } : {}),
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
        <div className="flex flex-wrap gap-2">
          <Input
            id={passwordId}
            // Shown in the clear only when asked. Shoulder-surfing is the threat
            // this screen actually faces day to day.
            type={reveal ? 'text' : 'password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="off"
            data-testid="item-password"
            className="min-w-0 flex-1"
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

      <Field
        label="one-time code secret"
        htmlFor={totpId}
        error={totpError || undefined}
        hint={totpError ? undefined : 'Paste the base32 secret, or the whole otpauth:// link.'}
      >
        <Input
          id={totpId}
          value={totpSecret}
          onChange={(event) => onTotpChange(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          invalid={totpError !== ''}
          data-testid="item-totp"
        />
      </Field>

      <Field
        label="recovery codes"
        htmlFor={codesId}
        hint="One per line. Kept apart from the password, since they are what survives losing it."
      >
        <textarea
          id={codesId}
          value={recoveryCodes}
          onChange={(event) => setRecoveryCodes(event.target.value)}
          rows={4}
          spellCheck={false}
          data-testid="item-recovery-codes"
          className={TEXTAREA_CLASS}
        />
      </Field>

      <CustomFields fields={custom} onChange={setCustom} />

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

/**
 * Arbitrary extra fields.
 *
 * The `hidden` flag is the point of these. Security question answers, PINs and
 * licence keys are all secrets that fit no named field, and storing them in the
 * notes means they render in the clear next to everything else.
 */
function CustomFields({
  fields,
  onChange,
}: {
  fields: CustomField[];
  onChange: (fields: CustomField[]) => void;
}) {
  function update(index: number, patch: Partial<CustomField>): void {
    onChange(
      fields.map((field, position) => (position === index ? { ...field, ...patch } : field)),
    );
  }

  return (
    <fieldset className="space-y-3">
      <legend className="text-muted font-mono text-xs tracking-widest uppercase">
        custom fields
      </legend>

      {fields.map((field, index) => (
        <div key={index} className="flex flex-wrap gap-2">
          <Input
            value={field.label}
            onChange={(event) => update(index, { label: event.target.value })}
            placeholder="label"
            aria-label={`custom field ${index + 1} label`}
            data-testid="custom-label"
            className="min-w-0 flex-1"
          />
          <Input
            type={field.hidden ? 'password' : 'text'}
            value={field.value}
            onChange={(event) => update(index, { value: event.target.value })}
            placeholder="value"
            aria-label={`custom field ${index + 1} value`}
            data-testid="custom-value"
            className="min-w-0 flex-1"
          />
          <Button
            type="button"
            variant="ghost"
            onClick={() => update(index, { hidden: !field.hidden })}
            aria-pressed={field.hidden}
            aria-label={field.hidden ? 'show this field' : 'hide this field'}
            data-testid="custom-hidden"
          >
            {field.hidden ? 'hidden' : 'visible'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onChange(fields.filter((_, position) => position !== index))}
            aria-label={`remove custom field ${index + 1}`}
            data-testid="custom-remove"
          >
            remove
          </Button>
        </div>
      ))}

      <Button
        type="button"
        variant="ghost"
        onClick={() => onChange([...fields, { label: '', value: '', hidden: false }])}
        data-testid="custom-add"
      >
        add field
      </Button>
    </fieldset>
  );
}
