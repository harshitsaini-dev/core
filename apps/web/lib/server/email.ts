/**
 * Sending email.
 *
 * Three features want this — a magic link after a lockout, a code for a
 * sign-in from somewhere new, and an alert when something notable happens to an
 * account — and all three share one property that shapes this file: **email is
 * not a dependency.**
 *
 * Every one of them is a notification or a second path. None of them is how the
 * vault opens, and none of them holds anything worth reading if intercepted: no
 * password, no key, no item, not even a count. So a send that fails is logged
 * and the request continues, exactly like the audit log next door. A password
 * manager that returns 500 because a third party had a bad minute is worse than
 * one that quietly did not warn you about a sign-in you already knew about.
 *
 * It is also entirely optional. An instance with no `RESEND_API_KEY` is a
 * working instance with three features switched off, not a broken one — which
 * is the right default for something anybody can self-host in fifteen minutes.
 */

export interface EmailConfig {
  readonly apiKey: string | undefined;
  readonly from: string | undefined;
}

/** Whether this instance can send at all. */
export function emailEnabled(config: EmailConfig): boolean {
  return Boolean(config.apiKey && config.from);
}

export interface Email {
  readonly to: string;
  readonly subject: string;
  /**
   * Plain text, and only plain text.
   *
   * No HTML, and that is a decision rather than an omission. An HTML mail from
   * a password manager is a mail with a styled button in it, which is the exact
   * shape of the phishing it would be teaching people to click. Text that says
   * where it came from and what it is asking, with the link visible as a link,
   * is harder to imitate convincingly.
   */
  readonly text: string;
}

/**
 * Send, and never let sending decide the request.
 *
 * Returns whether it went, for a caller that wants to say "check your email"
 * only when there is something to check. Never throws.
 */
export async function send(config: EmailConfig, email: Email): Promise<boolean> {
  if (!emailEnabled(config)) return false;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey ?? ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.from,
        to: [email.to],
        subject: email.subject,
        text: email.text,
      }),
      // A hung third party must not hold a Worker open. The features here are
      // all notifications; none of them is worth waiting on.
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      // The address is not logged. A log line naming who was emailed is a log
      // of who has an account, which is the thing every other decision on the
      // auth path is arranged to withhold.
      console.warn(`email send refused with ${response.status}`);
      return false;
    }

    return true;
  } catch {
    console.warn('email send failed; the request itself is unaffected');
    return false;
  }
}
