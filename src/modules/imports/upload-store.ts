// src/modules/imports/upload-store.ts
// Temporary on-disk holding area for statements waiting for a background worker.
//
// - Lives under UPLOAD_TEMP_DIR (outside any publicly served directory), files are mode 0600.
// - Named by batch UUID only: client-supplied names never touch the filesystem.
// - Deleted as soon as the batch reaches a terminal state (COMPLETED, or FAILED for good).
// - A sweeper (sweepOrphans) removes files left behind by crashes.

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env';
import { UUID_RE } from '../../shared/validation/pagination.schema';

const dir = () => path.resolve(env.UPLOAD_TEMP_DIR);

function fileFor(batchId: string): string {
  if (!UUID_RE.test(batchId)) throw new Error('Invalid batch id'); // guards path traversal
  return path.join(dir(), `${batchId}.csv`);
}

export async function saveUpload(batchId: string, data: Buffer): Promise<void> {
  await mkdir(dir(), { recursive: true });
  await writeFile(fileFor(batchId), data, { mode: 0o600 });
}

/** Returns null if the file is gone (worker restarted on a clean volume, swept, ...). */
export async function loadUpload(batchId: string): Promise<Buffer | null> {
  try {
    return await readFile(fileFor(batchId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function deleteUpload(batchId: string): Promise<void> {
  await rm(fileFor(batchId), { force: true });
}

/** Deletes temp files older than `maxAgeMs`. Returns how many were removed. */
export async function sweepOrphans(maxAgeMs: number): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(dir());
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith('.csv')) continue;
    const full = path.join(dir(), name);
    const info = await stat(full).catch(() => null);
    if (info && Date.now() - info.mtimeMs > maxAgeMs) {
      await rm(full, { force: true });
      removed++;
    }
  }
  return removed;
}
