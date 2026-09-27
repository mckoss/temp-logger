// Plain JS ships directly: validate sources and the local browser dependency.
import { readdirSync, accessSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
for (const file of ['server.js', 'playwright.config.js', ...['lib', 'public', 'scripts', 'test/unit', 'test/e2e'].flatMap(dir =>
  readdirSync(dir).filter(name => name.endsWith('.js')).map(name => join(dir, name)))]) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
accessSync('node_modules/chart.js/dist/chart.umd.min.js');
console.log('Build verified: JavaScript syntax and local Chart.js asset. No bundling required.');
