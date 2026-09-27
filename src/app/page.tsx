import { AnalyzeForm } from './AnalyzeForm';
import { Disclaimer } from './components/Disclaimer';
import { ImmersiveEntrance } from './components/ImmersiveEntrance';

export const dynamic = 'force-dynamic';

export default function Home() {
  return (
    <ImmersiveEntrance environment={process.env.SEAL_ENV ?? 'development'}>
      <AnalyzeForm />
      <div className="reading-notes">
        <Disclaimer />
      </div>
    </ImmersiveEntrance>
  );
}
