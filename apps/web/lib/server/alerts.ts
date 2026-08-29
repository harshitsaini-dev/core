import { users } from '@core/db';
import { eq } from 'drizzle-orm';
import type { Database } from '@core/db';
import type { Bytes } from '@core/crypto';
import type { EmailConfig } from './email';
import { emailEnabled, send } from './email';
import { thresholdInWords, windowInWords } from './lockout';
import { emailDecrypt } from './secrets';

/**
 * Telling somebody that something happened to their account.
 *
 * The events here are the ones a person can act on and would want to know
 * about within minutes: a password changed, an account locked by repeated
 * failures, a session token replayed. Not sign-ins.
 *
 * **Sign-ins are deliberately not alerted on**, and that is the whole design of
 * this file. A password manager that emails on every sign-in trains its user to
 * delete those emails unread, and the one that mattered arrives in the same
 * pile. Three events a year that each demand attention are worth more than
 * three hundred that do not.
 *
 * What the mail contains is also constrained. No item, no count, no address, no
 * device — those would make an intercepted alert worth reading. It says which
 * account, what happened, roughly where, and what to do. Somebody who did the
 * thing recognises it; somebody who did not now knows.
 *
 * The numbers come from `lockout.ts` rather than being written out here. They
 * were prose once, and lowering the threshold left this email telling people
 * that ten attempts had failed when five had — which is worse than saying
 * nothing, because somebody reading it would reasonably conclude a stranger
 * had made the other five.
 */

/** The events worth interrupting somebody for. */
export type Alert = 'password_changed' | 'account_locked' | 'session_reuse_detected';

function capitalise(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

const WORDING: Record<Alert, { subject: string; body: (where: string) => string }> = {
  password_changed: {
    subject: 'Your Core master password was changed',
    body: (where) =>
      `The master password on your Core vault was changed${where}.\n\n` +
      'Every other session was signed out as part of that change.\n\n' +
      'If this was you, nothing further is needed.\n\n' +
      'If it was not, your Emergency Kit is the only thing that can take the ' +
      'vault back — nobody here can reset it for you, and nobody here can read ' +
      'what is in it.',
  },
  account_locked: {
    subject: 'Your Core account was locked after repeated failures',
    body: (where) =>
      `${capitalise(thresholdInWords())} sign-in attempts failed in a row${where}, so the ` +
      `account is locked for ${windowInWords()} minutes. It unlocks itself; there is ` +
      'nothing to do.\n\n' +
      'If that was you mistyping, you can ignore this.\n\n' +
      'If it was not, somebody is guessing. They did not get in — the lock is ' +
      'what stopped them — but a master password being guessed at is worth ' +
      'changing to one that is longer.',
  },
  session_reuse_detected: {
    subject: 'A signed-out session token was used on your Core account',
    body: (where) =>
      `A session token that had already been replaced was presented${where}.\n\n` +
      'That means a copy of it was in circulation, so every session was ' +
      'revoked and every device now needs the master password again.\n\n' +
      'This can happen innocently — a browser restoring a tab from a backup, ' +
      'for instance. It can also mean a token was taken. If you were not ' +
      'expecting it, change your master password.',
  },
};

/**
 * Send an alert, and never let sending decide the request.
 *
 * Looks the address up here rather than taking one, so a caller cannot pass the
 * wrong person's. The events that trigger this all know a user id and none of
 * them knows an address.
 *
 * The address is stored encrypted under a key derived from the pepper — not
 * under the user's Account Key, which the server never has. That asymmetry is
 * deliberate and is what makes this feature possible at all: an address the
 * server genuinely could not read would mean an instance that genuinely could
 * not warn anybody. It is documented where it is written, in the signup route.
 */
export async function alert(
  db: Database,
  config: EmailConfig,
  pepper: Bytes,
  userId: string,
  event: Alert,
  country: string | null,
): Promise<void> {
  if (!emailEnabled(config)) return;

  try {
    const rows = await db
      .select({ emailEnc: users.emailEnc })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const stored = rows[0]?.emailEnc;
    if (!stored) return;

    const address = await emailDecrypt(pepper, stored);

    // "from IN" or nothing. A country is coarse enough to be useful and vague
    // enough to be safe in a mail somebody else might read; an IP address in an
    // alert is a home address in an email.
    const where = country ? ` from ${country}` : '';
    const wording = WORDING[event];

    await send(config, {
      to: address,
      subject: wording.subject,
      text: `${wording.body(where)}\n\n— Core\n`,
    });
  } catch {
    console.warn(`could not send the ${event} alert; the request is unaffected`);
  }
}
