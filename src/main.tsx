import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { checkBrowserAvailability, missingConfiguration, runCloudSdkProbe, runLocalSdkProbe } from './ai/sdk-readiness';
import './style.css';

function Readiness() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('No browser or model request has run.');
  const missing = missingConfiguration();

  async function run(operation: 'browser' | 'local' | 'cloud') {
    setBusy(true);
    setResult('Checking…');
    try {
      if (operation === 'browser') {
        setResult(await checkBrowserAvailability());
      } else {
        const answer = operation === 'local'
          ? await runLocalSdkProbe(progress => setResult(`Preparing device model: ${Math.round(progress * 100)}%`))
          : await runCloudSdkProbe();
        setResult(`Observed source: ${answer.inferenceSource}\nResponse: ${answer.text.slice(0, 400)}`);
      }
    } catch {
      setResult('The check did not complete. Verify Chrome support, Firebase configuration, AI Logic provisioning, and App Check registration. No successful inference is recorded.');
    } finally {
      setBusy(false);
    }
  }

  return <main>
    <p className="eyebrow">BlackOutBridge · development setup</p>
    <h1>Prepare the SDK before checkout development.</h1>
    <p>This screen checks the installed integration. Restaurant checkout, offline app caching, and POS recovery are not implemented yet.</p>
    <section aria-labelledby="configuration">
      <h2 id="configuration">Firebase configuration</h2>
      {missing.length ? <>
        <p>Local configuration is required before either Firebase model check.</p>
        <ul>{missing.map(name => <li key={name}><code>{name}</code></li>)}</ul>
      </> : <p>Configuration values are present. Account provisioning and model access still require a successful request.</p>}
    </section>
    <section aria-labelledby="checks">
      <h2 id="checks">Run readiness checks</h2>
      <p>Browser availability does not prove inference. Local preparation may download a large model. The cloud check sends a fixed diagnostic sentence through Firebase and uses your configured quota.</p>
      <div className="actions">
        <button disabled={busy} onClick={() => run('browser')}>Check browser availability</button>
        <button disabled={busy || missing.length > 0} onClick={() => run('local')}>Run local Firebase check</button>
        <button disabled={busy || missing.length > 0} onClick={() => run('cloud')}>Run cloud Firebase check</button>
      </div>
      <output aria-live="polite">{result}</output>
    </section>
  </main>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element missing');
createRoot(root).render(<StrictMode><Readiness /></StrictMode>);
