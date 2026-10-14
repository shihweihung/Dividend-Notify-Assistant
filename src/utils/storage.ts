// Safe localStorage wrapper that gracefully falls back to memory storage
// if cookies/storage are disabled, quota is exceeded, or running in restricted mobile in-app browsers (LINE, FB Messenger, Safari Private)

class MemoryStorage {
  private data: Record<string, string> = {};

  getItem(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null;
  }

  setItem(key: string, value: string): void {
    this.data[key] = String(value);
  }

  removeItem(key: string): void {
    delete this.data[key];
  }

  clear(): void {
    this.data = {};
  }
}

const memoryFallback = new MemoryStorage();

function isLocalStorageAvailable(): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return false;
    }
    const testKey = '__storage_test__';
    window.localStorage.setItem(testKey, testKey);
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

const hasStorage = isLocalStorageAvailable();

export const safeStorage = {
  getItem(key: string): string | null {
    try {
      if (hasStorage) {
        return window.localStorage.getItem(key);
      }
    } catch (e) {
      console.warn(`[safeStorage] Error reading ${key} from localStorage:`, e);
    }
    return memoryFallback.getItem(key);
  },

  setItem(key: string, value: string): void {
    try {
      if (hasStorage) {
        window.localStorage.setItem(key, value);
        return;
      }
    } catch (e) {
      console.warn(`[safeStorage] Error writing ${key} to localStorage:`, e);
    }
    memoryFallback.setItem(key, value);
  },

  removeItem(key: string): void {
    try {
      if (hasStorage) {
        window.localStorage.removeItem(key);
        return;
      }
    } catch (e) {
      console.warn(`[safeStorage] Error removing ${key} from localStorage:`, e);
    }
    memoryFallback.removeItem(key);
  },

  clear(): void {
    try {
      if (hasStorage) {
        window.localStorage.clear();
      }
    } catch (e) {
      console.warn('[safeStorage] Error clearing localStorage:', e);
    }
    memoryFallback.clear();
  }
};
