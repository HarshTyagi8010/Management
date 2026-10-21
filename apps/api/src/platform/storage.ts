import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Object storage (architecture §10). Keys are random and generated here, never
 * derived from user input. The S3 implementation arrives with deployment
 * (Phase 12); until then production has no storage and document rendering is off.
 */
export interface ObjectStorage {
  readonly enabled: boolean;
  newKey(extension: 'pdf' | 'png' | 'jpg'): string;
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}

const KEY = /^[a-f0-9]{32}\.(pdf|png|jpg)$/;

function assertKey(key: string) {
  // Defence in depth: a key can never contain a path separator or "..".
  if (!KEY.test(key)) throw new Error('Invalid storage key');
}

/** Development and test storage on the local disk (PROJECT_ROOT/.artifacts/storage by default). */
export class LocalObjectStorage implements ObjectStorage {
  readonly enabled = true;
  constructor(private readonly root: string) {}

  newKey(extension: 'pdf' | 'png' | 'jpg') {
    return `${randomBytes(16).toString('hex')}.${extension}`;
  }

  private file(key: string) {
    assertKey(key);
    return path.join(this.root, key.slice(0, 2), key);
  }

  async put(key: string, bytes: Buffer) {
    const target = this.file(key);
    await mkdir(path.dirname(target), { recursive: true });
    // Write then rename, so a reader never sees a half-written file.
    const temp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temp, bytes, { flag: 'wx' });
    await rename(temp, target);
  }

  async get(key: string) {
    return readFile(this.file(key));
  }
}

export const disabledStorage: ObjectStorage = {
  enabled: false,
  newKey: () => {
    throw new Error('Storage is not configured');
  },
  put: async () => {
    throw new Error('Storage is not configured');
  },
  get: async () => {
    throw new Error('Storage is not configured');
  },
};
