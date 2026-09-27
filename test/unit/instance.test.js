import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lockDatabase } from '../../lib/instance.js';

it('blocks duplicate database writers and permits reopening after release', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temp-logger-lock-'));
  try {
    const path = join(dir, 'test.db');
    const release = lockDatabase(path);
    try { assert.throws(() => lockDatabase(path), /Another logger instance/); }
    finally { release(); }
    lockDatabase(path)();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
