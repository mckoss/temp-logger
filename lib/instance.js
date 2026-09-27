import { mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import lockfile from 'proper-lockfile';

// One writer per database, including launches on different HTTP ports.
export function lockDatabase(path) {
  if (path === ':memory:') return () => {};
  mkdirSync(dirname(path), { recursive: true });
  closeSync(openSync(path, 'a'));
  try {
    return lockfile.lockSync(path, { stale: 10000 });
  } catch (err) {
    if (err.code === 'ELOCKED') throw new Error(`Another logger instance is already using ${path}`);
    throw err;
  }
}
