'use client';

import {
  OLD_PASSWORD_DAYS,
  duplicateItems,
  oldPasswords,
  reusedPasswords,
  withPassword,
  withoutPassword,
} from '@core/shared';
import type { DecryptedItem, DuplicateGroup, HealthEntry } from '@core/shared';
import { Button, Checkbox, Panel, Warning } from '@core/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { breachCount, useBreachSettings } from '@/lib/client/breach';
import { estimate } from '@/lib/client/strength';

/**
 * The security checkup.
 *
 * Every check here runs in the browser over decrypted items, because the server
 * holds ciphertext and could not tell a weak password from a strong one, or two
 * identical ones from two different ones. That is the product working as
 * intended rather than a limitation being worked around.
 *
 * One rule governs the whole file: a report may name an item, never a secret.
 * A "reused passwords" list that showed the reused value would be a ranked list
 * of the passwords worth stealing first, on screen in a room with other people
 * in it. `HealthEntry` carries an id and a title and nothing else, and the
 * weak-password pass below builds its entries the same way rather than putting
 * whole items through.
 */

/** A finding, and the items it applies to. */
interface Finding {
  readonly id: string;
  readonly title: string;
  /** What is wrong, in one line, addressed to the person who can fix it. */
  readonly detail: string;
  readonly tone: 'danger' | 'warning' | 'muted';
  readonly entries: readonly HealthEntry[];
}

const TONES = {
  danger: 'text-danger',
  warning: 'text-warning',
  muted: 'text-muted',
} as const;

/**
 * Weak passwords, scored with the estimator the signup form already uses.
 *
 * Scoring is the slow part of this screen — zxcvbn loads roughly 800 KB of
 * wordlists and then does real work per password — so it runs once, off the
 * render path, and reports progress as it goes. A vault of four hundred logins
 * should show a count that moves rather than a screen that looks frozen.
 */
function useWeakPasswords(items: readonly DecryptedItem[]): {
  readonly weak: readonly HealthEntry[];
  readonly scanned: number;
  readonly total: number;
} {
  const candidates = useMemo(() => withPassword(items), [items]);

  const [weak, setWeak] = useState<readonly HealthEntry[]>([]);
  const [scanned, setScanned] = useState(0);

  // Identifies the run in flight. If the vault changes while a scan is running
  // a new one starts, and the old one must not be allowed to publish its
  // answer — that would report findings about items that no longer exist.
  const run = useRef(0);

  useEffect(() => {
    const ticket = ++run.current;
    setWeak([]);
    setScanned(0);

    void (async () => {
      const found: HealthEntry[] = [];

      for (const [index, item] of candidates.entries()) {
        if (item.data.type !== 'login') continue;

        const { title, username, password } = item.data.fields;
        if (!password) continue;

        // Title and username go in as user inputs: a password built out of the
        // site's own name is exactly the pattern zxcvbn is there to notice.
        const inputs = [title, username ?? ''].filter(Boolean);
        const strength = await estimate(password, inputs);

        if (ticket !== run.current) return;

        if (strength.score < 3) found.push({ id: item.id, title });
        setScanned(index + 1);
      }

      if (ticket !== run.current) return;
      setWeak(found);
    })();

    // Abandon the run rather than cancel it: the loop checks its ticket after
    // every await and stops on its own.
    return () => {
      run.current++;
    };
  }, [candidates]);

  return { weak, scanned, total: candidates.length };
}

function collectFindings(
  weak: readonly HealthEntry[],
  breached: readonly HealthEntry[],
  reused: readonly { readonly items: readonly HealthEntry[] }[],
  old: readonly HealthEntry[],
  missing: readonly HealthEntry[],
  duplicates: readonly DuplicateGroup[],
): Finding[] {
  const findings: Finding[] = [];

  if (breached.length > 0) {
    // First, above everything else. A password already published in a corpus is
    // not weak in theory — it is on a list somebody is working through.
    findings.push({
      id: 'breached',
      title: 'found in a published breach',
      detail:
        'These appear in leaked data. Not "could be guessed" — already known, and already in the lists attackers try first. Change them.',
      tone: 'danger',
      entries: breached,
    });
  }

  if (weak.length > 0) {
    findings.push({
      id: 'weak',
      title: 'weak passwords',
      detail: 'A wordlist would reach these. No key derivation saves a password a guesser knows.',
      tone: 'danger',
      entries: weak,
    });
  }

  for (const [index, group] of reused.entries()) {
    findings.push({
      id: `reused-${index}`,
      title: `${group.items.length} accounts share one password`,
      detail: 'One breach anywhere makes all of them a breach. Give each its own.',
      tone: 'danger',
      entries: group.items,
    });
  }

  if (old.length > 0) {
    findings.push({
      id: 'old',
      title: 'unchanged in over a year',
      detail:
        'Reported, not judged — an old password is not a bad one. This is here to surface the one set years ago and forgotten.',
      tone: 'warning',
      entries: old,
    });
  }

  for (const [index, group] of duplicates.entries()) {
    // Below the password findings on purpose: two copies of one account is a
    // mess rather than a risk, and putting it above a breached password would
    // be wrong about which of the two matters.
    findings.push({
      id: `duplicate-${index}`,
      title: `${group.title} is stored ${group.items.length} times`,
      detail:
        'One account written down more than once — usually an import that ran twice. Open them and keep the one that still works; if the passwords differ, one of these is stale.',
      tone: 'muted',
      entries: group.items,
    });
  }

  if (missing.length > 0) {
    findings.push({
      id: 'missing',
      title: 'logins stored without a password',
      detail:
        'Usually fine and on purpose. Seen in bulk the day after an import, it means a column was mapped wrong.',
      tone: 'muted',
      entries: missing,
    });
  }

  return findings;
}

/**
 * Passwords found in a published breach corpus.
 *
 * Runs only when it has been switched on, and the switch is the disclosure: it
 * is the only part of the product that reaches past the vault's own server.
 *
 * One request per distinct hash prefix, and a failure is reported rather than
 * swallowed. A breach check that quietly returned "nothing found" when the
 * service was unreachable would be the worst possible failure mode — it reads
 * exactly like good news.
 */
function useBreachedPasswords(items: readonly DecryptedItem[], enabled: boolean) {
  const candidates = useMemo(() => withPassword(items), [items]);

  const [breached, setBreached] = useState<readonly HealthEntry[]>([]);
  const [checked, setChecked] = useState(0);
  const [failed, setFailed] = useState(false);

  const run = useRef(0);

  useEffect(() => {
    const ticket = ++run.current;
    setBreached([]);
    setChecked(0);
    setFailed(false);

    if (!enabled) return undefined;

    void (async () => {
      const found: HealthEntry[] = [];

      for (const [index, item] of candidates.entries()) {
        if (item.data.type !== 'login') continue;

        const { title, password } = item.data.fields;
        if (!password) continue;

        try {
          const count = await breachCount(password);
          if (ticket !== run.current) return;
          if (count > 0) found.push({ id: item.id, title });
        } catch {
          if (ticket !== run.current) return;
          setFailed(true);
          return;
        }

        setChecked(index + 1);
      }

      if (ticket !== run.current) return;
      setBreached(found);
    })();

    return () => {
      run.current++;
    };
  }, [candidates, enabled]);

  return { breached, checked, total: candidates.length, failed };
}

export function CheckupPanel({
  items,
  onOpen,
  onBack,
}: {
  readonly items: readonly DecryptedItem[];
  readonly onOpen: (id: string) => void;
  readonly onBack: () => void;
}) {
  const { weak, scanned, total } = useWeakPasswords(items);

  const breachEnabled = useBreachSettings((settings) => settings.enabled);
  const setBreachEnabled = useBreachSettings((settings) => settings.setEnabled);
  const hydrateBreach = useBreachSettings((settings) => settings.hydrate);

  useEffect(() => {
    hydrateBreach();
  }, [hydrateBreach]);

  const {
    breached,
    checked,
    total: breachTotal,
    failed: breachFailed,
  } = useBreachedPasswords(items, breachEnabled);

  const reused = useMemo(() => reusedPasswords(items), [items]);
  const old = useMemo(() => oldPasswords(items), [items]);
  const missing = useMemo(() => withoutPassword(items), [items]);
  const duplicates = useMemo(() => duplicateItems(items), [items]);

  const scanning = total > 0 && scanned < total;
  const findings = collectFindings(weak, breached, reused, old, missing, duplicates);

  return (
    <Panel className="mt-6" data-testid="checkup">
      <h2 className="text-accent typewriter mb-2 font-mono text-sm tracking-widest uppercase">
        security checkup
      </h2>
      <p className="text-muted mb-6 font-mono text-xs">
        <span aria-hidden="true">&gt; </span>
        Run here, on decrypted items. The server could not do any of this.
      </p>

      <div className="border-line mb-6 border p-4" data-testid="breach-opt-in">
        <Checkbox
          name="breach-check"
          checked={breachEnabled}
          onChange={(event) => setBreachEnabled(event.target.checked)}
          label="also check against published breach data"
          data-testid="breach-toggle"
        />
        {/*
          The switch is the disclosure, so what it turns on is spelled out
          under it rather than in a help page. This is the only part of the
          product that reaches past the vault's own server, and somebody
          agreeing to that should be able to see exactly what leaves.
        */}
        <p className="text-muted mt-3 font-mono text-xs leading-relaxed">
          <span aria-hidden="true">&gt; </span>
          Sends the first five characters of each password&apos;s SHA-1 to Have I Been Pwned,
          through this server. The password is never sent and cannot be worked out from those five
          characters — they name a bucket of roughly a million. It is still the one thing here that
          reaches past your own vault, so it is off until you ask.
        </p>
      </div>

      {breachEnabled && breachFailed ? (
        <div className="mb-6" data-testid="breach-failed">
          <Warning title="the breach service did not answer">
            No result rather than a clean bill. A check that reported &quot;nothing found&quot; when
            it could not reach the service would read exactly like good news.
          </Warning>
        </div>
      ) : null}

      {breachEnabled && !breachFailed && checked < breachTotal ? (
        <p className="text-muted mb-6 font-mono text-xs" data-testid="breach-progress">
          <span aria-hidden="true">&gt; </span>
          checking breach data, {checked} of {breachTotal}…
        </p>
      ) : null}

      {scanning ? (
        <p className="text-muted font-mono text-xs" data-testid="checkup-progress">
          <span aria-hidden="true">&gt; </span>
          checking {scanned} of {total}…
        </p>
      ) : findings.length === 0 ? (
        <p className="text-accent font-mono text-sm" data-testid="checkup-clear">
          <span aria-hidden="true">&gt; </span>
          Nothing reused, nothing weak, nothing older than {OLD_PASSWORD_DAYS} days
          {breachEnabled && !breachFailed ? ', nothing in a published breach' : ''}.
        </p>
      ) : (
        <ul className="space-y-6" data-testid="checkup-findings">
          {findings.map((finding) => (
            <li key={finding.id} className="border-line border p-4" data-testid="checkup-finding">
              <p className={`${TONES[finding.tone]} font-mono text-xs tracking-widest uppercase`}>
                {finding.title}
              </p>
              <p className="text-muted mt-2 font-mono text-xs leading-relaxed">{finding.detail}</p>

              <ul className="border-line mt-3 border-t">
                {finding.entries.map((entry) => (
                  <li key={entry.id} className="border-line border-b">
                    {/*
                      The row opens the item. A checkup that only says what is
                      wrong leaves the work of finding each one by hand, which
                      is how a list of twelve problems gets read once and acted
                      on never.
                    */}
                    <button
                      type="button"
                      onClick={() => onOpen(entry.id)}
                      className="text-fg hover:text-accent w-full truncate px-1 py-3 text-left font-mono text-sm"
                      data-testid="checkup-entry"
                    >
                      {entry.title}
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      <Button
        type="button"
        variant="ghost"
        onClick={onBack}
        className="mt-6"
        data-testid="checkup-back"
      >
        back
      </Button>
    </Panel>
  );
}
