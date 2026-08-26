import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Prepare the local database before the suite runs.
 *
 * The prelogin timing test compares a lookup that finds a row against one that
 * does not. Without a seeded account both lookups miss, the test passes for the
 * wrong reason, and the property it claims to check goes unverified.
 */
export default function globalSetup(): void {
  const run = (args: string[]): void => {
    execFileSync('pnpm', args, {
      cwd: repoRoot,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
  };

  run(['db:migrate:local']);
  run(['db:seed']);
}
