import { describe, expect, it } from 'vitest';
import { SIGNUP_TEST_HEADER, codeForResponse, verificationRequired } from './signup-codes';

/**
 * The two rules that decide whether an address has to be proved, and whether a
 * code ever leaves the server in the response rather than in an email.
 *
 * Small enough to test without a database on purpose. The danger of a test-mode
 * flag is not what it does when it is on — it is being on when nobody meant it
 * to be, and that is a question about these two functions and nothing else.
 */

describe('verificationRequired', () => {
  it('requires a code wherever mail can be sent', () => {
    expect(verificationRequired(true, false, null)).toBe(true);
  });

  it('does not require one where mail cannot be sent', () => {
    // A self-hosted instance with no provider has no way to deliver a code, and
    // refusing every signup there would be an instance nobody can use.
    expect(verificationRequired(false, false, null)).toBe(false);
  });

  it('ignores the test header unless the environment turned it on', () => {
    // The whole safety of this rests here. In production the variable is unset,
    // so the header is inert no matter what a client sends.
    expect(verificationRequired(false, false, 'required')).toBe(false);
  });

  it('honours the header only in test mode, and only that value', () => {
    expect(verificationRequired(false, true, 'required')).toBe(true);
    expect(verificationRequired(false, true, 'yes')).toBe(false);
    expect(verificationRequired(false, true, null)).toBe(false);
  });
});

describe('codeForResponse', () => {
  it('never returns the code outside test mode', () => {
    // Outside test mode a signup code exists in exactly one place: the email.
    // Returning it here would make the whole flow decorative — anybody could
    // read the code for an address they do not own.
    expect(codeForResponse(false, '123456')).toBeUndefined();
  });

  it('returns it in test mode, which is the only reason test mode exists', () => {
    expect(codeForResponse(true, '123456')).toBe('123456');
  });
});

describe('the test header', () => {
  it('is namespaced so it cannot collide with anything a proxy sets', () => {
    expect(SIGNUP_TEST_HEADER).toBe('x-core-signup-test');
  });
});
