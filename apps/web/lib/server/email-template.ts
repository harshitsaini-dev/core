/**
 * What an email from Core looks like.
 *
 * One rule, and it is the reason this file is small: **a link is never a
 * button.** Every URL appears in full, as text, exactly as it does in the plain
 * version. A styled call-to-action in a mail from a password manager teaches
 * the one habit that gets people phished — click the nice button in the message
 * that says something is wrong with your account — and a product whose entire
 * pitch is "nobody can open this but you" should not be the one teaching it.
 *
 * Everything else here is presentation, and the constraints on that come from
 * email clients rather than taste:
 *
 *   - Inline styles only. Gmail strips `<style>` blocks and most clients ignore
 *     anything they have not seen before.
 *   - No images, no fonts, no tracking pixel. Nothing loads from anywhere, so
 *     nothing is blocked, and reading the mail tells this server nothing.
 *   - A table for the frame, because centred `div`s are still not reliable in
 *     Outlook.
 *   - A dark shell with the product's own colours, but readable text sizes: a
 *     terminal look is worth having and 11px monospace on a phone is not.
 *
 * Sent alongside the plain text rather than instead of it. A client that shows
 * text gets the version written for it, unchanged.
 */

const BG = '#000000';
const SURFACE = '#0a0a0a';
const LINE = '#1a1a1a';
const ACCENT = '#00ff41';
const FG = '#e6e6e6';
const MUTED = '#7a7a7a';

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace";

function escape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * A URL, shown as itself.
 *
 * Linked so it is clickable, and labelled with the address rather than with
 * words. Somebody can read where it goes before they decide, which is the whole
 * difference between this and a button that says "Unlock my account".
 */
function urlLine(url: string): string {
  const safe = escape(url);
  return (
    `<p style="margin:0 0 20px;font-family:${MONO};font-size:13px;line-height:1.7;` +
    `word-break:break-all;">` +
    `<a href="${safe}" style="color:${ACCENT};text-decoration:underline;">${safe}</a>` +
    `</p>`
  );
}

function paragraph(text: string): string {
  return (
    `<p style="margin:0 0 16px;font-family:${MONO};font-size:14px;line-height:1.7;` +
    `color:${FG};">${escape(text)}</p>`
  );
}

/**
 * Wrap paragraphs in the shell.
 *
 * Paragraphs are given already split, and any line that is a bare URL becomes a
 * link to itself. That keeps the two versions of every message in step: the
 * plain text is the source, and this renders it rather than restating it, so
 * they cannot drift into saying different things.
 */
export function renderEmail(subject: string, body: string): string {
  const blocks = body
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => (/^https?:\/\/\S+$/.test(block) ? urlLine(block) : paragraph(block)))
    .join('');

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:${BG};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:${SURFACE};border:1px solid ${LINE};">
            <tr>
              <td style="padding:28px 28px 8px;">
                <p style="margin:0 0 4px;font-family:${MONO};font-size:16px;font-weight:bold;color:${ACCENT};">core_</p>
                <p style="margin:0 0 24px;font-family:${MONO};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${MUTED};">${escape(subject)}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 28px 8px;">${blocks}</td>
            </tr>
            <tr>
              <td style="padding:8px 28px 28px;border-top:1px solid ${LINE};">
                <p style="margin:16px 0 0;font-family:${MONO};font-size:11px;line-height:1.7;color:${MUTED};">
                  Core never asks for your master password by email, and nobody here can read what
                  is in your vault. If a message claiming to be from Core asks you to reply with a
                  password, it is not from Core.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
