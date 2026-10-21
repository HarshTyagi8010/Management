import type { StorageConfig } from '../config.js';
import { disabledStorage, LocalObjectStorage, type ObjectStorage } from './storage.js';

export function createStorage(config: StorageConfig): ObjectStorage {
  return config.driver === 'local' ? new LocalObjectStorage(config.dir) : disabledStorage;
}
