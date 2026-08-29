'use client';

import { Button } from '@core/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { qrScanningPossible, readQrFromFile, scanWithCamera } from '@/lib/client/qr';
import type { Scanner } from '@/lib/client/qr';

/**
 * Point a camera at a QR code.
 *
 * Two ways in, because one of them is missing on half the phones people own:
 * the camera where `BarcodeDetector` exists, and an image file everywhere it
 * does. Where neither works the component says so and points at the field that
 * has always accepted a pasted URI — which is what every setup screen offers
 * under "can't scan the code?".
 *
 * Nothing leaves the page. The frame and the file are decoded here and dropped,
 * because a photograph of a QR code for a 2FA secret is a 2FA secret.
 */
export function ScanQr({
  onScanned,
  label = 'scan a qr code',
}: {
  readonly onScanned: (value: string) => void;
  readonly label?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const scanner = useRef<Scanner | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');

  const close = useCallback(() => {
    scanner.current?.stop();
    scanner.current = null;
    setOpen(false);
  }, []);

  // The camera must stop when this unmounts, not only when the button is
  // pressed. A stream left running behind a closed panel is a camera light
  // somebody notices an hour later and cannot explain.
  useEffect(() => () => scanner.current?.stop(), []);

  async function start(): Promise<void> {
    setError('');
    setOpen(true);

    try {
      const started = await scanWithCamera((value) => {
        close();
        onScanned(value);
      });

      scanner.current = started;
      host.current?.replaceChildren(started.video);
      started.video.className = 'border-line w-full border';
    } catch {
      setOpen(false);
      setError('Could not open the camera. Use an image, or paste the code instead.');
    }
  }

  async function fromFile(file: File): Promise<void> {
    setError('');
    const value = await readQrFromFile(file);

    if (value) onScanned(value);
    else setError('No QR code found in that image.');
  }

  if (!qrScanningPossible()) {
    return (
      <p className="text-muted font-mono text-xs leading-relaxed" data-testid="qr-unsupported">
        <span aria-hidden="true">&gt; </span>
        This browser cannot read QR codes. Paste the code the site shows under &quot;can&apos;t scan
        the code?&quot; instead — it works the same.
      </p>
    );
  }

  return (
    <div data-testid="scan-qr">
      {open ? (
        <>
          <div ref={host} />
          <Button
            type="button"
            variant="ghost"
            onClick={close}
            className="mt-3"
            data-testid="scan-stop"
          >
            stop
          </Button>
        </>
      ) : (
        <div className="flex flex-wrap gap-3">
          <Button
            type="button"
            variant="ghost"
            onClick={() => void start()}
            data-testid="scan-start"
          >
            {label}
          </Button>

          <label className="inline-flex">
            <span className="sr-only">choose an image of a qr code</span>
            <input
              type="file"
              accept="image/*"
              className="block w-full font-mono text-xs file:mr-3 file:border file:border-line file:bg-transparent file:px-3 file:py-2 file:font-mono file:text-xs file:text-accent"
              data-testid="scan-file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void fromFile(file);
              }}
            />
          </label>
        </div>
      )}

      {error ? (
        <p className="text-danger mt-2 font-mono text-xs" data-testid="scan-error">
          <span aria-hidden="true">! </span>
          {error}
        </p>
      ) : null}
    </div>
  );
}
