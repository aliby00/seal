import { AnalyzeForm } from './AnalyzeForm';
import { Disclaimer } from './components/Disclaimer';

const ENV = process.env.SEAL_ENV ?? 'development';

export default function Home() {
  return (
    <main style={{ maxWidth: '44rem', margin: '0 auto', padding: '4rem 1.25rem' }}>
      {ENV !== 'production' && (
        <p
          style={{
            display: 'inline-block',
            margin: '0 0 2rem',
            padding: '0.25rem 0.6rem',
            border: '1px solid var(--line)',
            borderRadius: '999px',
            color: 'var(--muted)',
            fontSize: '0.75rem',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          {ENV}
        </p>
      )}

      <h1 style={{ margin: '0 0 0.75rem', fontSize: '2rem', letterSpacing: '-0.02em' }}>SEAL</h1>

      <p style={{ margin: '0 0 2.5rem', color: 'var(--muted)' }}>
        L&apos;agent qui explique, là où les autres se contentent de noter.
      </p>

      <AnalyzeForm />
      <Disclaimer />
    </main>
  );
}
