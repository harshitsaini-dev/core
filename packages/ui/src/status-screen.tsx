import type { ReactNode } from 'react';
import { Panel } from './primitives.js';

/**
 * The screen shown when something has gone wrong.
 *
 * One component for every failure state, because the alternative is four
 * near-identical pages that drift apart until a 404 and a 500 disagree about
 * what the product looks like.
 *
 * Two rules it follows:
 *
 *   1. **Say what happened and what to do next.** A code alone tells a user
 *      nothing they can act on.
 *
 *   2. **Never guess at a cause.** On a zero-knowledge product an error screen
 *      that speculates — "this vault may not exist", "your session may have
 *      been revoked" — hands a probing visitor exactly the distinctions the API
 *      is built to withhold. These screens describe the *response*, not the
 *      account.
 */

export interface StatusScreenProps {
  /** Shown as the terminal command that failed, e.g. `core: 404`. */
  code: string;
  title: string;
  children: ReactNode;
  /** Optional recovery actions. */
  actions?: ReactNode;
}

export function StatusScreen({ code, title, children, actions }: StatusScreenProps) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 py-16">
      <Panel>
        <p className="text-accent-dim font-mono text-xs tracking-widest uppercase">
          <span aria-hidden="true">$ </span>
          core {code}
        </p>

        <h1 className="text-accent text-glow mt-3 text-xl font-bold tracking-tight">{title}</h1>

        <div className="text-muted mt-4 space-y-3 font-mono text-sm leading-relaxed">
          {children}
        </div>

        {actions ? <div className="mt-8 flex flex-wrap gap-3">{actions}</div> : null}
      </Panel>
    </main>
  );
}
