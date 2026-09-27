import { detectBackend } from '../lib/sensors.js';
const backend = await detectBackend();
if (backend.name === 'none') {
  console.error(`No sensors available. On an Apple Silicon Mac, run: ${backend.hint}`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ backend: backend.name, ...await backend.sample() }, null, 2));
}
