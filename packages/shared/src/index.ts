/**
 * Constants and types shared between the client, the API routes and the
 * cryptography package. Nothing here may import anything.
 */

/** Terminal theme tokens. The single source of truth for the palette. */
export const THEME = {
  background: '#000000',
  surface: '#0A0A0A',
  border: '#1A1A1A',
  accent: '#00FF41',
  accentDim: '#00A82B',
  text: '#E6E6E6',
  muted: '#7A7A7A',
  danger: '#FF3B30',
  warning: '#FFB020',
} as const;

/**
 * Argon2id parameters. Stored per user in the database so that they can be
 * raised over time without locking existing accounts out.
 */
export interface KdfParams {
  readonly algorithm: 'argon2id' | 'pbkdf2-sha512';
  /** Memory cost in KiB. Argon2id only. */
  readonly memoryKiB: number;
  /** Time cost (passes). Argon2id only. */
  readonly iterations: number;
  /** Parallelism. Argon2id only. */
  readonly parallelism: number;
}

export const DEFAULT_KDF_PARAMS: KdfParams = {
  algorithm: 'argon2id',
  memoryKiB: 65_536,
  iterations: 3,
  parallelism: 1,
};

export const PBKDF2_FALLBACK_PARAMS: KdfParams = {
  algorithm: 'pbkdf2-sha512',
  memoryKiB: 0,
  iterations: 600_000,
  parallelism: 1,
};

/** Domain-separation strings. Changing any of these breaks existing vaults. */
export const KDF_CONTEXT = {
  auth: 'core.auth.v1',
  encryption: 'core.enc.v1',
} as const;

export const HKDF_INFO = {
  blindIndex: 'core.blind-index.v1',
  device: 'core.device.v1',
} as const;

/** Byte lengths used throughout. */
export const SIZES = {
  salt: 16,
  iv: 12,
  key: 32,
  blindIndex: 16,
} as const;

/** Prefix of the ciphertext envelope: `v1.<iv>.<ciphertext+tag>`. */
export const ENVELOPE_VERSION = 'v1';

export type VaultItemType = 'login' | 'note' | 'card' | 'identity' | 'ssh';
