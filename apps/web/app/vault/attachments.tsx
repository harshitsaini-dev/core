'use client';

import { Button } from '@core/ui';
import { useCallback, useEffect, useState } from 'react';
import {
  MAX_ATTACHMENT_BYTES,
  openAttachmentBody,
  openAttachmentMeta,
  sealAttachment,
} from '@/lib/client/attachments';
import { toast } from '@/lib/client/toast-store';
import { useVault } from '@/lib/client/vault-store';

/**
 * Files attached to one item.
 *
 * Encrypted here before anything leaves: a per-file key for the body, wrapped
 * by the Account Key, with the filename and type encrypted beside it. What the
 * server stores is ciphertext under a random object key, plus a size — the size
 * because the quota has to be enforced by something that cannot read the file,
 * and because anybody counting bytes on the wire has it anyway.
 *
 * Downloads are assembled in the tab from a blob. A link straight to storage
 * would be a URL that opens a file without a session, which is the one thing a
 * bucket like this must never have.
 */

interface Row {
  readonly id: string;
  readonly itemKeyWrapped: string;
  readonly filenameEnc: string;
  readonly mimeEnc: string;
  readonly size: number;
  readonly name: string;
}

const BUTTON_LIKE =
  'border-line text-muted hover:border-accent hover:text-accent cursor-pointer border px-3 py-2 font-mono text-xs';

export function Attachments({ itemId }: { readonly itemId: string }) {
  const keys = useVault((vault) => vault.keys);

  const [rows, setRows] = useState<readonly Row[]>([]);
  const [used, setUsed] = useState(0);
  const [quota, setQuota] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    if (!keys) return;

    try {
      const response = await fetch(`/api/vault/attachments?itemId=${encodeURIComponent(itemId)}`);
      const body = (await response.json()) as {
        attachments: Omit<Row, 'name'>[];
        used: number;
        quota: number;
      };

      const named = await Promise.all(
        body.attachments.map(async (row) => {
          const meta = await openAttachmentMeta(keys.dataKey, row.filenameEnc, row.mimeEnc);
          // A row whose name will not decrypt still exists and can still be
          // removed. Hiding it would leave storage nobody can see or reclaim.
          return { ...row, name: meta?.filename ?? 'unreadable' };
        }),
      );

      setRows(named);
      setUsed(body.used);
      setQuota(body.quota);
    } catch {
      setError('Could not list the files.');
    } finally {
      setLoading(false);
    }
  }, [itemId, keys]);

  useEffect(() => {
    void load();
  }, [load]);

  async function upload(file: File): Promise<void> {
    if (!keys) return;

    if (file.size > MAX_ATTACHMENT_BYTES) {
      setError(`That file is larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB.`);
      return;
    }

    setBusy(true);
    setError('');
    try {
      const sealed = await sealAttachment(keys.dataKey, file);

      const form = new FormData();
      form.set('itemId', itemId);
      form.set('body', new Blob([sealed.body as BlobPart]));
      form.set('itemKeyWrapped', sealed.itemKeyWrapped);
      form.set('filenameEnc', sealed.filenameEnc);
      form.set('mimeEnc', sealed.mimeEnc);

      const response = await fetch('/api/vault/attachments', { method: 'POST', body: form });
      const body = (await response.json()) as { error?: string; quota?: number };

      if (body.error === 'quota') {
        setError(
          `No room left. This account can store ${Math.round((body.quota ?? 0) / 1024 / 1024)} MB.`,
        );
        return;
      }

      if (!response.ok) {
        setError('The file could not be stored.');
        return;
      }

      await load();
      toast(`Attached ${file.name}.`);
    } catch {
      setError('The file could not be stored.');
    } finally {
      setBusy(false);
    }
  }

  async function download(row: Row): Promise<void> {
    if (!keys) return;

    setError('');
    try {
      const response = await fetch(`/api/vault/attachments/${row.id}`);
      if (!response.ok) {
        setError('The file could not be fetched.');
        return;
      }

      const plain = await openAttachmentBody(
        keys.dataKey,
        row.itemKeyWrapped,
        await response.arrayBuffer(),
      );

      if (!plain) {
        setError('That file could not be opened. It was stored under a different key.');
        return;
      }

      const url = URL.createObjectURL(new Blob([plain as BlobPart]));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = row.name;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('The file could not be fetched.');
    }
  }

  return (
    <div className="border-line mt-3 border p-4" data-testid="attachments">
      {loading ? (
        <p className="text-muted font-mono text-xs" data-testid="attachments-loading">
          <span aria-hidden="true">&gt; </span>
          loading...
        </p>
      ) : rows.length === 0 ? (
        <p className="text-muted font-mono text-xs" data-testid="attachments-empty">
          <span aria-hidden="true">&gt; </span>
          nothing attached
        </p>
      ) : (
        <ul className="font-mono text-xs" data-testid="attachment-list">
          {rows.map((row) => (
            <li
              key={row.id}
              className="border-line flex flex-wrap items-center gap-3 border-b py-2 last:border-b-0"
              data-testid="attachment-row"
            >
              <span className="text-fg secret min-w-0 flex-1 truncate">{row.name}</span>
              <span className="text-muted">{Math.max(1, Math.round(row.size / 1024))} KB</span>
              <Button
                type="button"
                variant="ghost"
                onClick={() => void download(row)}
                data-testid="attachment-download"
              >
                open
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  void fetch(`/api/vault/attachments/${row.id}`, { method: 'DELETE' }).then(
                    () => void load(),
                  );
                }}
                data-testid="attachment-delete"
              >
                remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className={BUTTON_LIKE}>
          {busy ? 'encrypting...' : 'attach a file'}
          <input
            type="file"
            className="sr-only"
            disabled={busy}
            data-testid="attachment-file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
              event.target.value = '';
            }}
          />
        </label>
        {quota > 0 ? (
          <span className="text-muted font-mono text-xs" data-testid="attachment-quota">
            {Math.round(used / 1024)} KB of {Math.round(quota / 1024 / 1024)} MB used
          </span>
        ) : null}
      </div>

      {error !== '' ? (
        <p
          role="alert"
          className="text-danger mt-3 font-mono text-xs"
          data-testid="attachment-error"
        >
          <span aria-hidden="true">! </span>
          {error}
        </p>
      ) : null}
    </div>
  );
}
