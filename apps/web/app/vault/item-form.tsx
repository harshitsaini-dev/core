'use client';

import { parseOtpauth } from '@core/crypto';
import { orderFolders } from '@core/shared';
import type { CustomField, DecryptedItem, LoginFields, VaultItemData } from '@core/shared';
import { Button, Field, Input, Select, Textarea } from '@core/ui';
import { useEffect, useId, useMemo, useState } from 'react';
import { generatePassword } from '@/lib/client/generator';
import { usePrivacy } from '@/lib/client/privacy-store';
import { activeProjects, useEnv } from '@/lib/client/env-store';
import { activeFolders, useItems } from '@/lib/client/items-store';

/**
 * Create or edit an item.
 *
 * Two types so far: logins and notes. They share the save path and the custom
 * fields; everything else differs enough that a single set of inputs would suit
 * neither.
 */

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
          {(['login', 'note', 'card', 'identity', 'ssh'] as const).map((option) => (
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
      ) : type === 'card' ? (
        <CardForm {...(existing ? { existing } : {})} onDone={onDone} onCancel={onCancel} />
      ) : type === 'identity' ? (
        <IdentityForm {...(existing ? { existing } : {})} onDone={onDone} onCancel={onCancel} />
      ) : type === 'ssh' ? (
        <SshForm {...(existing ? { existing } : {})} onDone={onDone} onCancel={onCancel} />
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

/** `tags: ['a', 'b']` from `"a, b"`, deduplicated, blanks dropped. */
function parseTags(input: string): string[] {
  const seen = new Set<string>();
  for (const part of input.split(',')) {
    const trimmed = part.trim();
    if (trimmed !== '') seen.add(trimmed);
  }
  return [...seen];
}

/**
 * Where an item is filed.
 *
 * Folders and tags answer different questions — "where does this live" and
 * "what is this about" — so both exist and neither replaces the other. They
 * share this component because both types of item need them and the two
 * controls are one line of thought.
 *
 * Nested folders are indented rather than prefixed. The dropdown is ours, so
 * it can indent — a native `<select>` could not, and a flat list of names loses
 * the distinction between two folders that happen to share one.
 */
function Organisation({
  folderId,
  tags,
  linkedProjectId,
  onFolderChange,
  onTagsChange,
  onLinkChange,
}: {
  folderId: string | null;
  tags: string;
  linkedProjectId: string | null;
  onFolderChange: (value: string | null) => void;
  onTagsChange: (value: string) => void;
  onLinkChange: (value: string | null) => void;
}) {
  const folderFieldId = useId();
  const tagsFieldId = useId();
  const projectFieldId = useId();

  const folders = useItems((state) => state.folders);
  const ordered = useMemo(() => orderFolders(activeFolders(folders)), [folders]);

  // The vault does not otherwise need the environment manager's data, so it is
  // fetched only when a form is open — which is the only place a link can be
  // made.
  const projects = useEnv((state) => state.projects);
  const loadEnv = useEnv((state) => state.load);
  useEffect(() => {
    void loadEnv();
  }, [loadEnv]);

  const live = useMemo(() => activeProjects(projects), [projects]);

  return (
    <div className="grid gap-6 sm:grid-cols-2">
      <Field label="folder" htmlFor={folderFieldId}>
        <Select
          id={folderFieldId}
          value={folderId ?? ''}
          onChange={(next) => onFolderChange(next || null)}
          data-testid="item-folder"
          options={[
            { value: '', label: 'no folder' },
            ...ordered.map(({ folder, depth }) => ({
              value: folder.id,
              label: folder.name,
              depth,
              color: folder.color,
            })),
          ]}
        />
      </Field>

      <Field label="tags" htmlFor={tagsFieldId} hint="Comma separated.">
        <Input
          id={tagsFieldId}
          value={tags}
          onChange={(event) => onTagsChange(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="work, banking"
          data-testid="item-tags"
        />
      </Field>

      {live.length > 0 ? (
        <Field
          label="linked project"
          htmlFor={projectFieldId}
          hint="For the credential a project's .env uses."
        >
          <Select
            id={projectFieldId}
            value={linkedProjectId ?? ''}
            onChange={(next) => onLinkChange(next || null)}
            data-testid="item-project"
            options={[
              { value: '', label: 'none' },
              ...live.map((project) => ({ value: project.id, label: project.name })),
            ]}
          />
        </Field>
      ) : null}
    </div>
  );
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
  const [folderId, setFolderId] = useState<string | null>(existing?.folderId ?? null);
  const [tags, setTags] = useState((fields?.tags ?? []).join(', '));
  const [linkedProjectId, setLinkedProjectId] = useState<string | null>(
    fields?.linkedProjectId ?? null,
  );
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
      const parsedTags = parseTags(tags);

      const id = await save(
        {
          type: 'note',
          fields: {
            title: derivedTitle,
            ...(body ? { body } : {}),
            ...(parsedTags.length > 0 ? { tags: parsedTags } : {}),
            ...(linkedProjectId ? { linkedProjectId } : {}),
          },
        },
        existing?.id,
        folderId,
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
        <Textarea
          id={bodyId}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={14}
          spellCheck
          autoFocus
          placeholder="Write anything. It is encrypted before it leaves this device."
          data-testid="note-body"
        />
      </Field>

      <Organisation
        folderId={folderId}
        tags={tags}
        linkedProjectId={linkedProjectId}
        onFolderChange={setFolderId}
        onTagsChange={setTags}
        onLinkChange={setLinkedProjectId}
      />

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
  const [folderId, setFolderId] = useState<string | null>(existing?.folderId ?? null);
  const [tags, setTags] = useState((fields.tags ?? []).join(', '));
  const [linkedProjectId, setLinkedProjectId] = useState<string | null>(
    fields.linkedProjectId ?? null,
  );
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);

  // Blurring the screen has to take a revealed password with it. The blur only
  // covers displayed values — a field being typed into cannot be blurred and
  // still be typed into — so the reveal is closed instead.
  const blurred = usePrivacy((state) => state.blurred);
  useEffect(() => {
    if (blurred) setReveal(false);
  }, [blurred]);

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
      const parsedTags = parseTags(tags);

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
            // Stamped only when the password actually changed, so opening an
            // item and saving it does not make an old password look new.
            ...(password && password !== fields.password
              ? { passwordChangedAt: Date.now() }
              : fields.passwordChangedAt !== undefined
                ? { passwordChangedAt: fields.passwordChangedAt }
                : {}),
            ...(url.trim() ? { url: url.trim() } : {}),
            ...(totpSecret ? { totpSecret } : {}),
            ...(codes.length > 0 ? { recoveryCodes: codes } : {}),
            ...(parsedTags.length > 0 ? { tags: parsedTags } : {}),
            ...(linkedProjectId ? { linkedProjectId } : {}),
            ...(cleanedCustom.length > 0 ? { customFields: cleanedCustom } : {}),
          },
        },
        existing?.id,
        folderId,
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
        <Textarea
          id={codesId}
          value={recoveryCodes}
          onChange={(event) => setRecoveryCodes(event.target.value)}
          rows={4}
          spellCheck={false}
          data-testid="item-recovery-codes"
        />
      </Field>

      <Organisation
        folderId={folderId}
        tags={tags}
        linkedProjectId={linkedProjectId}
        onFolderChange={setFolderId}
        onTagsChange={setTags}
        onLinkChange={setLinkedProjectId}
      />

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
 * The shape every simple form here has.
 *
 * A title, a set of fields, the organisation controls and the two buttons. The
 * login form is not built on this because it has a generator, a reveal, an
 * otpauth parser and recovery codes, and bending a shared abstraction around
 * all of that would make both harder to read than either is apart.
 */
function SimpleForm({
  existing,
  onDone,
  onCancel,
  type,
  children,
  toData,
}: FormProps & {
  type: 'card' | 'identity' | 'ssh';
  children: React.ReactNode;
  toData: (title: string, tags: string[], linkedProjectId: string | null) => VaultItemData;
}) {
  const titleId = useId();

  const initial = existing?.data.type === type ? existing.data.fields : undefined;

  const [title, setTitle] = useState(initial?.title ?? '');
  const [folderId, setFolderId] = useState<string | null>(existing?.folderId ?? null);
  const [tags, setTags] = useState((initial?.tags ?? []).join(', '));
  const [linkedProjectId, setLinkedProjectId] = useState<string | null>(
    initial?.linkedProjectId ?? null,
  );
  const [busy, setBusy] = useState(false);

  const save = useItems((state) => state.save);

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (title.trim() === '' || busy) return;

    setBusy(true);
    try {
      const id = await save(
        toData(title.trim(), parseTags(tags), linkedProjectId),
        existing?.id,
        folderId,
      );
      onDone(id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="space-y-6" noValidate>
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

      {children}

      <Organisation
        folderId={folderId}
        tags={tags}
        linkedProjectId={linkedProjectId}
        onFolderChange={setFolderId}
        onTagsChange={setTags}
        onLinkChange={setLinkedProjectId}
      />

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
 * A payment card.
 *
 * Every field here is masked in the list and shown only on the item, for the
 * obvious reason: a card number, an expiry and a CVV together are the card. The
 * list shows the last four digits, which is how people tell cards apart and is
 * the part that is printed on a receipt anyway.
 */
function CardForm({ existing, onDone, onCancel }: FormProps) {
  const cardholderId = useId();
  const numberId = useId();
  const expiryId = useId();
  const cvvId = useId();
  const pinId = useId();

  const initial = existing?.data.type === 'card' ? existing.data.fields : undefined;

  const [cardholder, setCardholder] = useState(initial?.cardholder ?? '');
  const [number, setNumber] = useState(initial?.number ?? '');
  const [expiry, setExpiry] = useState(initial?.expiry ?? '');
  const [cvv, setCvv] = useState(initial?.cvv ?? '');
  const [pin, setPin] = useState(initial?.pin ?? '');

  return (
    <SimpleForm
      {...(existing ? { existing } : {})}
      onDone={onDone}
      onCancel={onCancel}
      type="card"
      toData={(title, tags, linkedProjectId) => ({
        type: 'card',
        fields: {
          title,
          ...(cardholder.trim() ? { cardholder: cardholder.trim() } : {}),
          // Spaces stripped: people type them from the card and no payment form
          // wants them back.
          ...(number.trim() ? { number: number.replace(/\s+/g, '') } : {}),
          ...(expiry.trim() ? { expiry: expiry.trim() } : {}),
          ...(cvv.trim() ? { cvv: cvv.trim() } : {}),
          ...(pin.trim() ? { pin: pin.trim() } : {}),
          ...(tags.length > 0 ? { tags } : {}),
          ...(linkedProjectId ? { linkedProjectId } : {}),
        },
      })}
    >
      <Field label="cardholder" htmlFor={cardholderId}>
        <Input
          id={cardholderId}
          value={cardholder}
          onChange={(event) => setCardholder(event.target.value)}
          autoComplete="off"
          data-testid="card-holder"
        />
      </Field>

      <Field label="number" htmlFor={numberId}>
        <Input
          id={numberId}
          value={number}
          onChange={(event) => setNumber(event.target.value)}
          autoComplete="off"
          inputMode="numeric"
          spellCheck={false}
          data-testid="card-number"
        />
      </Field>

      <div className="grid gap-6 sm:grid-cols-3">
        <Field label="expiry" htmlFor={expiryId}>
          <Input
            id={expiryId}
            value={expiry}
            onChange={(event) => setExpiry(event.target.value)}
            placeholder="MM/YY"
            autoComplete="off"
            data-testid="card-expiry"
          />
        </Field>
        <Field label="cvv" htmlFor={cvvId}>
          <Input
            id={cvvId}
            type="password"
            value={cvv}
            onChange={(event) => setCvv(event.target.value)}
            autoComplete="off"
            inputMode="numeric"
            data-testid="card-cvv"
          />
        </Field>
        <Field label="pin" htmlFor={pinId}>
          <Input
            id={pinId}
            type="password"
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            autoComplete="off"
            inputMode="numeric"
            data-testid="card-pin"
          />
        </Field>
      </div>
    </SimpleForm>
  );
}

/** A person: the details forms ask for over and over. */
function IdentityForm({ existing, onDone, onCancel }: FormProps) {
  const fullNameId = useId();
  const emailId = useId();
  const phoneId = useId();
  const addressId = useId();

  const initial = existing?.data.type === 'identity' ? existing.data.fields : undefined;

  const [fullName, setFullName] = useState(initial?.fullName ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [address, setAddress] = useState(initial?.address ?? '');

  return (
    <SimpleForm
      {...(existing ? { existing } : {})}
      onDone={onDone}
      onCancel={onCancel}
      type="identity"
      toData={(title, tags, linkedProjectId) => ({
        type: 'identity',
        fields: {
          title,
          ...(fullName.trim() ? { fullName: fullName.trim() } : {}),
          ...(email.trim() ? { email: email.trim() } : {}),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          ...(address.trim() ? { address: address.trim() } : {}),
          ...(tags.length > 0 ? { tags } : {}),
          ...(linkedProjectId ? { linkedProjectId } : {}),
        },
      })}
    >
      <Field label="full name" htmlFor={fullNameId}>
        <Input
          id={fullNameId}
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
          autoComplete="off"
          data-testid="identity-name"
        />
      </Field>

      <div className="grid gap-6 sm:grid-cols-2">
        <Field label="email" htmlFor={emailId}>
          <Input
            id={emailId}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="off"
            inputMode="email"
            data-testid="identity-email"
          />
        </Field>
        <Field label="phone" htmlFor={phoneId}>
          <Input
            id={phoneId}
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            autoComplete="off"
            inputMode="tel"
            data-testid="identity-phone"
          />
        </Field>
      </div>

      <Field label="address" htmlFor={addressId}>
        <Textarea
          id={addressId}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          rows={3}
          data-testid="identity-address"
        />
      </Field>
    </SimpleForm>
  );
}

/**
 * An SSH key.
 *
 * The private key is a textarea rather than a masked input, because it is
 * twenty-odd lines and nobody can check a masked one. It is not shown in the
 * list, and the row reports only that a key is stored.
 */
function SshForm({ existing, onDone, onCancel }: FormProps) {
  const hostId = useId();
  const publicKeyId = useId();
  const privateKeyId = useId();
  const passphraseId = useId();

  const initial = existing?.data.type === 'ssh' ? existing.data.fields : undefined;

  const [host, setHost] = useState(initial?.host ?? '');
  const [publicKey, setPublicKey] = useState(initial?.publicKey ?? '');
  const [privateKey, setPrivateKey] = useState(initial?.privateKey ?? '');
  const [passphrase, setPassphrase] = useState(initial?.passphrase ?? '');

  return (
    <SimpleForm
      {...(existing ? { existing } : {})}
      onDone={onDone}
      onCancel={onCancel}
      type="ssh"
      toData={(title, tags, linkedProjectId) => ({
        type: 'ssh',
        fields: {
          title,
          ...(host.trim() ? { host: host.trim() } : {}),
          ...(publicKey.trim() ? { publicKey: publicKey.trim() } : {}),
          // Not trimmed beyond the ends: the line breaks are load-bearing.
          ...(privateKey.trim() ? { privateKey: privateKey.trim() } : {}),
          ...(passphrase ? { passphrase } : {}),
          ...(tags.length > 0 ? { tags } : {}),
          ...(linkedProjectId ? { linkedProjectId } : {}),
        },
      })}
    >
      <Field label="host" htmlFor={hostId}>
        <Input
          id={hostId}
          value={host}
          onChange={(event) => setHost(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="git@github.com"
          data-testid="ssh-host"
        />
      </Field>

      <Field label="public key" htmlFor={publicKeyId}>
        <Textarea
          id={publicKeyId}
          value={publicKey}
          onChange={(event) => setPublicKey(event.target.value)}
          rows={3}
          spellCheck={false}
          data-testid="ssh-public"
        />
      </Field>

      <Field
        label="private key"
        htmlFor={privateKeyId}
        hint="Line breaks are kept exactly. A key with them collapsed will not work."
      >
        <Textarea
          id={privateKeyId}
          value={privateKey}
          onChange={(event) => setPrivateKey(event.target.value)}
          rows={8}
          spellCheck={false}
          data-testid="ssh-private"
        />
      </Field>

      <Field label="passphrase" htmlFor={passphraseId}>
        <Input
          id={passphraseId}
          type="password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          autoComplete="off"
          data-testid="ssh-passphrase"
        />
      </Field>
    </SimpleForm>
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
