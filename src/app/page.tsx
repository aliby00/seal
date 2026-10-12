import { AnalyzeForm } from './AnalyzeForm';
import { Disclaimer } from './components/Disclaimer';
import { ScannerEntrance } from './components/ScannerEntrance';

export const dynamic = 'force-dynamic';

export default function Home() {
  return (
    <ScannerEntrance environment={process.env.SEAL_ENV ?? 'development'}>
      <AnalyzeForm />
      <div className="reading-notes">
        <Disclaimer />
      </div>
    </ScannerEntrance>
  );
}
