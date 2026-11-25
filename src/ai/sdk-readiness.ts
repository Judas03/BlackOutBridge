import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, InferenceSource } from 'firebase/ai';

export type ProbeResult = { inferenceSource: InferenceSource; text: string };

const requiredEnvironment = {
  VITE_FIREBASE_API_KEY: import.meta.env.VITE_FIREBASE_API_KEY,
  VITE_FIREBASE_AUTH_DOMAIN: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  VITE_FIREBASE_PROJECT_ID: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  VITE_FIREBASE_APP_ID: import.meta.env.VITE_FIREBASE_APP_ID,
  VITE_RECAPTCHA_ENTERPRISE_SITE_KEY: import.meta.env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY,
};

export function missingConfiguration(): string[] {
  return Object.entries(requiredEnvironment)
    .filter(([, value]) => typeof value !== 'string' || !value.trim() || value.startsWith('REPLACE_WITH_'))
    .map(([name]) => name);
}

let ai: ReturnType<typeof getAI> | undefined;

function getConfiguredAI() {
  if (ai) return ai;
  if (missingConfiguration().length) throw new Error('CONFIGURATION_REQUIRED');
  const app = initializeApp({
    apiKey: requiredEnvironment.VITE_FIREBASE_API_KEY,
    authDomain: requiredEnvironment.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: requiredEnvironment.VITE_FIREBASE_PROJECT_ID,
    appId: requiredEnvironment.VITE_FIREBASE_APP_ID,
  });
  // A boolean enables the SDK's local token flow; no token string is embedded.
  if (import.meta.env.DEV && import.meta.env.VITE_USE_APPCHECK_DEBUG === 'true') {
    const debugHost = self as typeof self & { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean };
    debugHost.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(requiredEnvironment.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY),
    isTokenAutoRefreshEnabled: true,
  });
  ai = getAI(app, { backend: new GoogleAIBackend(), useLimitedUseAppCheckTokens: true });
  return ai;
}

export async function checkBrowserAvailability(): Promise<string> {
  const browser = globalThis as typeof globalThis & {
    LanguageModel?: { availability(): Promise<string> };
  };
  if (!browser.LanguageModel) return 'Browser model API unavailable. Check supported Chrome and its setup.';
  const availability = await browser.LanguageModel.availability();
  return `Browser reports: ${availability}. This is an availability check, not a Firebase inference result.`;
}

export async function runLocalSdkProbe(onProgress: (fraction: number) => void): Promise<ProbeResult> {
  const model = getGenerativeModel(getConfiguredAI(), { mode: InferenceMode.ONLY_ON_DEVICE });
  // Invoke from a user click, before any await that would lose user activation.
  await model.initializeDeviceModel(onProgress);
  const result = await model.generateContent('Reply with exactly: BlackOutBridge ready.');
  if (result.response.inferenceSource !== InferenceSource.ON_DEVICE) throw new Error('UNEXPECTED_INFERENCE_SOURCE');
  return { inferenceSource: result.response.inferenceSource, text: result.response.text() };
}

export async function runCloudSdkProbe(): Promise<ProbeResult> {
  const model = getGenerativeModel(getConfiguredAI(), { mode: InferenceMode.ONLY_IN_CLOUD });
  const result = await model.generateContent('Reply with exactly: BlackOutBridge ready.');
  if (result.response.inferenceSource !== InferenceSource.IN_CLOUD) throw new Error('UNEXPECTED_INFERENCE_SOURCE');
  return { inferenceSource: result.response.inferenceSource, text: result.response.text() };
}
