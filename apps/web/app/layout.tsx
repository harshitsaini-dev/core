import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ServiceWorker } from './service-worker';

/**
 * Metadata and link previews.
 *
 * The description doubles as the share card copy, so it states the guarantee
 * rather than a tagline. A link to a password manager is worth exactly as much
 * trust as the claim it makes, and that is the line worth reading before
 * clicking.
 *
 * `metadataBase` matters more than it looks: without it, Open Graph image URLs
 * are emitted relative, and every scraper that does not resolve them against
 * the page URL silently shows no preview at all.
 */

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

const DESCRIPTION =
  'A zero-knowledge password, secret and .env manager. Encrypted in your browser, unreadable to the server.';

export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: {
    default: 'Core',
    template: '%s — Core',
  },
  description: DESCRIPTION,
  applicationName: 'Core',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Core',
  },
  formatDetection: {
    // Left to itself, iOS turns anything resembling a phone number into a call
    // link — including the odd recovery code.
    telephone: false,
  },
  openGraph: {
    type: 'website',
    siteName: 'Core',
    title: 'Core',
    description: DESCRIPTION,
    url: APP_URL,
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'Core — encrypted in your browser, unreadable to the server.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Core',
    description: DESCRIPTION,
    images: ['/og.png'],
  },
  robots: {
    // The marketing page is fine to index. Everything behind it is a vault, and
    // the manifest below lists no deep links for a crawler to follow.
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  themeColor: '#000000',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
  // Room for the iOS home indicator and notch, which a full-height dark app
  // otherwise runs straight underneath.
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-bg text-fg min-h-dvh antialiased">
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
