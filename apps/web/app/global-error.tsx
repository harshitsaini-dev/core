'use client';

/**
 * The last resort.
 *
 * Replaces the root layout, so it cannot use any of the app's providers or
 * shared components — if one of those is what failed, importing it here would
 * fail again and leave a blank page. Everything is inlined for that reason,
 * including the styles.
 */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#000000',
          color: '#e6e6e6',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          padding: '1.5rem',
        }}
      >
        <div
          style={{
            border: '1px solid #1a1a1a',
            background: '#0a0a0a',
            padding: '2rem',
            maxWidth: '32rem',
          }}
        >
          <p style={{ color: '#00a82b', fontSize: '0.75rem', letterSpacing: '0.1em', margin: 0 }}>
            $ core 500
          </p>
          <h1
            style={{
              color: '#00ff41',
              fontSize: '1.25rem',
              margin: '0.75rem 0 0',
              textShadow: '0 0 8px rgba(0, 255, 65, 0.45)',
            }}
          >
            core could not start
          </h1>
          <p style={{ fontSize: '0.875rem', lineHeight: 1.6, color: '#7a7a7a' }}>
            &gt; The application failed before it could render. Your vault is unaffected — nothing
            readable is stored server-side.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              minHeight: '44px',
              marginTop: '1.5rem',
              padding: '0.5rem 1rem',
              background: 'transparent',
              border: '1px solid #00ff41',
              color: '#00ff41',
              font: 'inherit',
              fontSize: '0.875rem',
              cursor: 'pointer',
            }}
          >
            reload
          </button>
        </div>
      </body>
    </html>
  );
}
