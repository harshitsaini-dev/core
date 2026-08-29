import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openVault } from './helpers/vault';
import { openPanel } from './helpers/vault-nav';

/**
 * Importing one-time codes out of Google Authenticator.
 *
 * The decoding of a QR image belongs to the browser, so `BarcodeDetector` is
 * stubbed here to hand back whatever the uploaded file contains. What that
 * leaves under test is everything this project actually wrote: the protobuf
 * payload is understood, a batch split across several codes accumulates, codes
 * this app cannot generate are refused rather than half-imported, and what
 * lands in the vault produces a working item.
 *
 * The payloads below were built with the same wire format Google emits and are
 * checked against the parser's own unit tests.
 */

const BATCH_ONE =
  'otpauth-migration://offline?data=Ci0KCgECAwQFBgcICQoSF0dpdEh1YjprYXlhQGV4YW1wbGUuY29tGgZHaXRIdWIKJQoKCwwNDg8QERITFBIMT2xkQmFuazprYXlhGgdPbGRCYW5rMAE%3D';
const BATCH_TWO =
  'otpauth-migration://offline?data=CjEKChUWFxgZGhscHR4SGUZhc3RtYWlsOmtheWFAZXhhbXBsZS5jb20aCEZhc3RtYWls';
const BATCH_ONE_AGAIN =
  'otpauth-migration://offline?data=Ci0KCgECAwQFBgcICQoSF0dpdEh1YjprYXlhQGV4YW1wbGUuY29tGgZHaXRIdWI%3D';

/** Stand in for the browser's own decoder: the file's bytes are the code. */
async function stubDetector(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class FakeDetector {
      async detect(source: Blob): Promise<{ rawValue: string }[]> {
        const text = await source.text();
        return text.startsWith('otpauth') ? [{ rawValue: text }] : [];
      }
    }

    Object.defineProperty(window, 'BarcodeDetector', { value: FakeDetector, writable: true });
  });
}

async function scan(page: Page, uri: string): Promise<void> {
  await page
    .getByTestId('google-import')
    .getByTestId('scan-file')
    .setInputFiles({ name: 'export.png', mimeType: 'image/png', buffer: Buffer.from(uri) });
}

async function openImport(page: Page): Promise<void> {
  await openPanel(page, 'open-csv-import');
  await expect(page.getByTestId('google-import')).toBeVisible();
}

test.describe('google authenticator import', () => {
  test.slow();

  test.beforeEach(async ({ page }) => {
    await stubDetector(page);
  });

  test('reads an export code and saves what it found', async ({ page }) => {
    await openVault(page, 'gauth-basic');
    await openImport(page);
    await scan(page, BATCH_ONE);

    await expect(page.getByTestId('google-preview')).toContainText('GitHub');
    await expect(page.getByTestId('google-preview')).toContainText('kaya@example.com');

    await page.getByTestId('google-run').click();

    await expect(page.getByTestId('item-list')).toContainText('GitHub', { timeout: 30_000 });
  });

  test('an imported code really generates', async ({ page }) => {
    // The point of the whole feature. A row named after the site that shows no
    // number, or the wrong one, would have imported nothing worth having.
    await openVault(page, 'gauth-generates');
    await openImport(page);
    await scan(page, BATCH_ONE);
    await page.getByTestId('google-run').click();

    await expect(page.getByTestId('item-list')).toContainText('GitHub', { timeout: 30_000 });
    await page.getByText('GitHub').first().click();

    await expect(page.getByTestId('totp-code')).toHaveText(/\d{3} ?\d{3}/, { timeout: 30_000 });
  });

  test('will not import a counter-based code as if it were time-based', async ({ page }) => {
    // Google exports these and this app does not generate them. Importing one
    // would produce an item that shows a number and never the right one, which
    // is worse than not importing it.
    await openVault(page, 'gauth-hotp');
    await openImport(page);
    await scan(page, BATCH_ONE);

    await expect(page.getByTestId('google-summary')).toContainText('1 code(s) to import');
    await expect(page.getByTestId('google-summary')).toContainText('counter-based');
    await expect(page.getByTestId('google-preview')).toContainText('counter-based, skipped');

    await page.getByTestId('google-run').click();
    await expect(page.getByTestId('item-list')).toContainText('GitHub', { timeout: 30_000 });
    await expect(page.getByTestId('item-list')).not.toContainText('OldBank');
  });

  test('a batch split across several codes adds up', async ({ page }) => {
    // Google splits a long list into several QR codes. Replacing the previous
    // scan instead of adding to it would silently import only the last one.
    await openVault(page, 'gauth-batch');
    await openImport(page);

    await scan(page, BATCH_ONE);
    await expect(page.getByTestId('google-summary')).toContainText('1 code(s)');

    await scan(page, BATCH_TWO);
    await expect(page.getByTestId('google-summary')).toContainText('2 code(s)');
    await expect(page.getByTestId('google-preview')).toContainText('GitHub');
    await expect(page.getByTestId('google-preview')).toContainText('Fastmail');
  });

  test('scanning the same code twice does not duplicate it', async ({ page }) => {
    await openVault(page, 'gauth-dupe');
    await openImport(page);

    await scan(page, BATCH_ONE);
    await scan(page, BATCH_ONE_AGAIN);

    await expect(page.getByTestId('google-summary')).toContainText('1 code(s) to import');
    await expect(page.getByTestId('google-preview').getByText('GitHub')).toHaveCount(1);
  });

  test('says what a wrong code is rather than importing nothing quietly', async ({ page }) => {
    await openVault(page, 'gauth-wrong');
    await openImport(page);

    // A plain otpauth:// link — the thing somebody would reasonably try first.
    await scan(page, 'otpauth://totp/GitHub:kaya?secret=JBSWY3DPEHPK3PXP');

    await expect(page.getByTestId('google-error')).toContainText('Transfer accounts');
    await expect(page.getByTestId('google-preview')).toHaveCount(0);
  });
});
