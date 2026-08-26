import { StatusScreen, buttonClasses } from '@core/ui';
import Link from 'next/link';

/**
 * 404.
 *
 * Says nothing about whether the address might have existed. On most sites that
 * distinction is harmless; here, a 404 that reads differently for a real vault
 * than for an invented one would be an enumeration oracle wearing a friendly
 * face.
 */
export default function NotFound() {
  return (
    <StatusScreen
      code="404"
      title="no such path"
      actions={
        <Link href="/" className={buttonClasses()}>
          back to start
        </Link>
      }
    >
      <p>
        <span aria-hidden="true">&gt; </span>
        That address does not resolve to anything.
      </p>
      <p>
        <span aria-hidden="true">&gt; </span>
        If you followed a link here, it was either mistyped or points at something that has since
        been removed.
      </p>
    </StatusScreen>
  );
}
