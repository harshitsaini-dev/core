import { StatusScreen, buttonClasses } from '@core/ui';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Access denied — Core',
  robots: { index: false, follow: false },
};

/**
 * Access denied.
 *
 * Shown when a request is refused: no session, an expired one, or a token that
 * was replayed after rotation.
 *
 * It does not say which. The API answers those cases identically on purpose,
 * and a screen that helpfully distinguished them would hand back exactly what
 * the API withholds — including telling an attacker whose replayed token just
 * triggered a mass revocation that their replay was noticed.
 */
export default function DeniedPage() {
  return (
    <StatusScreen
      code="403"
      title="access denied"
      actions={
        <>
          <Link href="/login" className={buttonClasses()}>
            unlock
          </Link>
          <Link href="/" className={buttonClasses('ghost')}>
            back to start
          </Link>
        </>
      }
    >
      <p>
        <span aria-hidden="true">&gt; </span>
        That request was refused.
      </p>
      <p>
        <span aria-hidden="true">&gt; </span>
        Signing in again resolves this in almost every case. If it keeps happening, your sessions
        may have been revoked deliberately — a password change or a recovery does that to every
        device.
      </p>
    </StatusScreen>
  );
}
