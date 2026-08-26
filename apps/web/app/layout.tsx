import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Core — zero-knowledge vault',
  description:
    'A zero-knowledge password, secret and .env manager. Encrypted in your browser, unreadable to the server.',
  applicationName: 'Core',
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = {
  themeColor: '#000000',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-bg text-fg antialiased">{children}</body>
    </html>
  );
}
