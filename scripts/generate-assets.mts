/**
 * Render the static image assets.
 *
 *   pnpm assets
 *
 * Produces the PWA icons and the link-preview banner from SVG sources defined
 * here, using sharp — which is already present as a Next dependency, so this
 * costs no new supply-chain surface on a project where that matters.
 *
 * The outputs are committed. Generating them at request time would mean either
 * shipping a rasteriser to the edge or rendering the same fixed image on every
 * share, and neither is worth it for artwork that changes about once a year.
 *
 * Every input is fixed, so re-running should produce no diff.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = resolve(repoRoot, 'apps/web/public');

const BLACK = '#000000';
const GREEN = '#00FF41';
const MUTED = '#7A7A7A';

/** The mark: a bracketed C, reading as both a terminal prompt and a vault. */
function markSvg(size: number, stroke: number): string {
  const inset = size * 0.18;
  const radius = size / 2 - inset;
  return `
    <path d="M ${size / 2 + radius * 0.72} ${size / 2 - radius * 0.72}
             A ${radius} ${radius} 0 1 0 ${size / 2 + radius * 0.72} ${size / 2 + radius * 0.72}"
          fill="none" stroke="${GREEN}" stroke-width="${stroke}" stroke-linecap="square"/>
  `;
}

function iconSvg(size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" fill="${BLACK}"/>
    ${markSvg(size, Math.max(2, size * 0.1))}
  </svg>`;
}

/**
 * The link-preview banner.
 *
 * 1200x630 is what the major platforms crop to. Everything important stays well
 * inside that, because several of them crop further on mobile.
 *
 * The text is deliberately the guarantee rather than a tagline: a link to a
 * password manager is worth exactly as much trust as the claim it makes, and
 * this is the one line worth reading before clicking.
 */
function bannerSvg(): string {
  // Rendering happens in librsvg, which has no access to the web fonts the site
  // uses. Naming JetBrains Mono here would silently fall back to a serif face
  // and produce a wordmark that looks nothing like the product, so the generic
  // `monospace` family is named directly and the result is what ships.
  const MONO = 'monospace';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <rect width="1200" height="630" fill="${BLACK}"/>

    <defs>
      <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
        <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#0F0F0F" stroke-width="1"/>
      </pattern>
      <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="9" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <rect width="1200" height="630" fill="url(#grid)"/>
    <rect x="24" y="24" width="1152" height="582" fill="none" stroke="#1A1A1A" stroke-width="2"/>

    <!-- Mark and wordmark share a baseline, so they read as one lockup. -->
    <g transform="translate(96, 118)" filter="url(#glow)">
      ${markSvg(96, 11)}
    </g>

    <text x="212" y="192" font-family="${MONO}" font-size="82" font-weight="bold"
          letter-spacing="2" fill="${GREEN}" filter="url(#glow)">core</text>

    <text x="96" y="352" font-family="${MONO}" font-size="42" fill="#E6E6E6">
      Encrypted in your browser.
    </text>
    <text x="96" y="414" font-family="${MONO}" font-size="42" fill="#E6E6E6">
      Unreadable to the server.
    </text>

    <text x="96" y="510" font-family="${MONO}" font-size="27" fill="${GREEN}">
      $ passwords &#183; secrets &#183; .env
    </text>
    <text x="96" y="556" font-family="${MONO}" font-size="23" fill="${MUTED}">
      AES-256-GCM &#183; Argon2id &#183; self-hostable
    </text>
  </svg>`;
}

async function render(svg: string, file: string): Promise<void> {
  const output = resolve(publicDir, file);
  mkdirSync(dirname(output), { recursive: true });
  const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(output, png);
  console.warn(`${file}  ${(png.length / 1024).toFixed(1)} KB`);
}

const ICON_SIZES = [192, 512] as const;

for (const size of ICON_SIZES) {
  await render(iconSvg(size), `icon-${size}.png`);
}

// Maskable: the same mark with generous padding, so that a launcher cropping to
// a circle does not clip it.
await render(
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
     <rect width="512" height="512" fill="${BLACK}"/>
     <g transform="translate(128, 128)">${markSvg(256, 26)}</g>
   </svg>`,
  'icon-maskable-512.png',
);

await render(bannerSvg(), 'og.png');
