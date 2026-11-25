import assert from 'node:assert/strict';
import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, InferenceSource } from 'firebase/ai';
import Dexie from 'dexie';
import { z } from 'zod';

for (const api of [initializeApp, initializeAppCheck, ReCaptchaEnterpriseProvider, getAI, getGenerativeModel, GoogleAIBackend, Dexie]) {
  assert.equal(typeof api, 'function');
}
assert.equal(typeof z.object, 'function');
for (const name of ['ONLY_ON_DEVICE', 'ONLY_IN_CLOUD', 'PREFER_ON_DEVICE', 'PREFER_IN_CLOUD']) {
  assert.equal(typeof InferenceMode[name], 'string');
}
assert.notEqual(InferenceSource.ON_DEVICE, InferenceSource.IN_CLOUD);
assert.equal(typeof InferenceSource.ON_DEVICE, 'string');
assert.equal(typeof InferenceSource.IN_CLOUD, 'string');
console.log('SDK imports verified: Firebase app, App Check, hybrid AI modes/source, Dexie, and Zod.');
console.log('No Firebase application was initialized and no model request or account action was performed.');
