import { z } from 'zod';

/**
 * The developer environment manager.
 *
 * A project has environments, an environment has variables. Every name and
 * every value is encrypted before it leaves the browser — including the *keys*.
 * `STRIPE_SECRET_KEY` in the clear would tell an operator what a project
 * integrates with, and a list of key names across a few thousand users is a map
 * of who uses what. The value is the secret; the key is the metadata, and this
 * product does not leak metadata either.
 *
 * What the server does see: how many projects a user has, how many environments
 * each has, how many variables each of those holds, and when they changed. That
 * is the same shape of leak the vault has and it is written down in the threat
 * model rather than implied away.
 */

export interface DecryptedProject {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deletedAt: number | null;
}

export interface SyncedProject {
  readonly id: string;
  readonly nameEnc: string;
  readonly color: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deletedAt: number | null;
}

export interface DecryptedEnvironment {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SyncedEnvironment {
  readonly id: string;
  readonly projectId: string;
  readonly nameEnc: string;
  readonly sortOrder: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DecryptedEnvVar {
  readonly id: string;
  readonly environmentId: string;
  readonly key: string;
  readonly value: string;
  readonly note: string | null;
  readonly sortOrder: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deletedAt: number | null;
}

export interface SyncedEnvVar {
  readonly id: string;
  readonly environmentId: string;
  readonly keyEnc: string;
  readonly valueEnc: string;
  readonly noteEnc: string | null;
  readonly sortOrder: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deletedAt: number | null;
}

/** The environments a new project starts with. */
export const DEFAULT_ENVIRONMENTS = ['development', 'staging', 'production'] as const;

export const projectNameSchema = z.string().min(1).max(120);
export const environmentNameSchema = z.string().min(1).max(60);

/**
 * What a shell will accept as a variable name.
 *
 * Enforced at the point of entry rather than on export, because a key that
 * cannot be sourced is not useful to anyone and the moment to say so is while
 * it is being typed. Import is more forgiving — see `parseDotenv`.
 */
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidEnvKey(key: string): boolean {
  return ENV_KEY_PATTERN.test(key);
}

export interface ParsedVar {
  readonly key: string;
  readonly value: string;
}

export interface ParseResult {
  readonly vars: ParsedVar[];
  /** Lines that were not blank, not comments, and not understood. */
  readonly skipped: string[];
}

/**
 * Read a `.env` file.
 *
 * Written rather than pulled in, and the reason is the same one that governs
 * the rest of this project: the text being parsed is a file full of production
 * secrets, and it is parsed in the one origin that holds the vault keys. A
 * dependency here is a supply-chain path straight to them, for a hundred lines
 * of string handling.
 *
 * It handles what real files contain: `export` prefixes, single and double
 * quotes, escapes inside double quotes, `#` comments including trailing ones,
 * blank lines, empty values, and values that run across lines inside quotes.
 *
 * It is deliberately forgiving. A file that half-parses is more useful than a
 * refusal, so anything unrecognised is returned in `skipped` for the interface
 * to show rather than thrown away silently.
 */
export function parseDotenv(input: string): ParseResult {
  const vars: ParsedVar[] = [];
  const skipped: string[] = [];

  // Normalised first: a file written on Windows and pasted into a browser on a
  // Mac arrives with \r\n, and a trailing \r becomes part of the value.
  const text = input.replace(/\r\n?/g, '\n');

  let index = 0;

  while (index < text.length) {
    const lineEnd = text.indexOf('\n', index);
    const stop = lineEnd === -1 ? text.length : lineEnd;
    const line = text.slice(index, stop);
    const trimmed = line.trim();

    if (trimmed === '' || trimmed.startsWith('#')) {
      index = stop + 1;
      continue;
    }

    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const equals = withoutExport.indexOf('=');

    if (equals <= 0) {
      skipped.push(trimmed);
      index = stop + 1;
      continue;
    }

    const key = withoutExport.slice(0, equals).trim();
    if (!isValidEnvKey(key)) {
      skipped.push(trimmed);
      index = stop + 1;
      continue;
    }

    const rest = withoutExport.slice(equals + 1);
    const quote = rest.startsWith('"') ? '"' : rest.startsWith("'") ? "'" : null;

    if (!quote) {
      // Unquoted: a `#` starts a comment, and the value stops at it.
      const hash = rest.indexOf(' #');
      const raw = hash === -1 ? rest : rest.slice(0, hash);
      vars.push({ key, value: raw.trim() });
      index = stop + 1;
      continue;
    }

    // Quoted, and possibly spanning lines. Scan the whole remaining text rather
    // than this line, because a private key pasted into a `.env` is one value
    // across twenty-odd lines and losing it at the first newline is the most
    // annoying possible bug.
    const valueStart = index + line.indexOf(rest) + 1;
    const { value, end } = readQuoted(text, valueStart, quote);

    vars.push({ key, value });
    const nextBreak = text.indexOf('\n', end);
    index = nextBreak === -1 ? text.length : nextBreak + 1;
  }

  return { vars, skipped };
}

/**
 * Read a quoted value, returning where it ended.
 *
 * Escapes are interpreted inside double quotes and taken literally inside
 * single quotes, which is what every shell and every other dotenv reader does.
 */
function readQuoted(text: string, start: number, quote: '"' | "'"): { value: string; end: number } {
  let out = '';

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (char === '\\' && quote === '"') {
      const next = text[i + 1];
      if (next === undefined) break;
      out +=
        next === 'n'
          ? '\n'
          : next === 't'
            ? '\t'
            : next === 'r'
              ? '\r'
              : next === '\\'
                ? '\\'
                : next === '"'
                  ? '"'
                  : `\\${next}`;
      i += 1;
      continue;
    }

    if (char === quote) return { value: out, end: i + 1 };
    out += char;
  }

  // Unterminated. Take what there is rather than dropping the variable: the
  // person pasting can see the result and fix it.
  return { value: out, end: text.length };
}

/**
 * Whether a value has to be quoted to survive a round trip.
 *
 * Erring towards quoting is safe; erring away from it corrupts the file.
 */
function needsQuoting(value: string): boolean {
  return value === '' || /[\s"'#$`\\\n]/.test(value);
}

function quote(value: string): string {
  if (!needsQuoting(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/** Write a `.env` file. */
export function formatDotenv(vars: readonly ParsedVar[]): string {
  return vars.map((entry) => `${entry.key}=${quote(entry.value)}`).join('\n') + '\n';
}

/** Write the same thing as shell `export` lines, for pasting into a terminal. */
export function formatShellExport(vars: readonly ParsedVar[]): string {
  return vars.map((entry) => `export ${entry.key}=${quote(entry.value)}`).join('\n') + '\n';
}

/**
 * Merge an import into what is already there.
 *
 * Existing keys are updated and new ones added; nothing is removed. An import
 * that deleted the variables it did not mention would turn "add the two new
 * keys from staging" into "lose everything else", and the person doing it would
 * not find out until a deploy failed.
 */
export function mergeVars(
  existing: readonly DecryptedEnvVar[],
  incoming: readonly ParsedVar[],
): { updated: { id: string; value: string }[]; added: ParsedVar[] } {
  const byKey = new Map(
    existing.filter((entry) => entry.deletedAt === null).map((e) => [e.key, e]),
  );

  const updated: { id: string; value: string }[] = [];
  const added: ParsedVar[] = [];

  for (const entry of incoming) {
    const match = byKey.get(entry.key);
    if (!match) {
      added.push(entry);
      continue;
    }
    if (match.value !== entry.value) updated.push({ id: match.id, value: entry.value });
  }

  return { updated, added };
}

/** Mask a value for display: enough to recognise, not enough to use. */
export function maskValue(value: string): string {
  if (value.length <= 4) return '•'.repeat(Math.max(value.length, 1));
  return `${'•'.repeat(Math.min(value.length - 4, 24))}${value.slice(-4)}`;
}
