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

/**
 * Note on why this does not also warm the routes.
 *
 * Global setup runs before the web server is guaranteed to be listening, so a
 * warm-up here would race it. The action timeout is generous instead, which
 * handles cold compilation without adding an ordering dependency that would
 * fail intermittently in a different way.
 */
