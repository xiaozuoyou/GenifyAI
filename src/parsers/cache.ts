import * as fs from 'node:fs';
import type { ParseResult } from './types.js';
import { toAbsolute } from '../utils/pathResolver.js';

interface CacheEntry {
  mtime: number;
  result: ParseResult;
}

const cache = new Map<string, CacheEntry>();

export function getCachedResult(filePath: string): ParseResult | null {
  const entry = cache.get(filePath);
  if (!entry) return null;

  const absolutePath = toAbsolute(filePath);
  try {
    const stat = fs.statSync(absolutePath);
    const currentMtime = stat.mtimeMs;

    if (currentMtime === entry.mtime) {
      return entry.result;
    }

    // mtime 变化，缓存失效
    cache.delete(filePath);
    return null;
  } catch {
    cache.delete(filePath);
    return null;
  }
}

export function setCachedResult(filePath: string, result: ParseResult): void {
  const absolutePath = toAbsolute(filePath);
  try {
    const stat = fs.statSync(absolutePath);
    cache.set(filePath, {
      mtime: stat.mtimeMs,
      result,
    });
  } catch {
    // 文件不存在，不缓存
  }
}

export function invalidateCache(filePath?: string): void {
  if (filePath) {
    cache.delete(filePath);
  } else {
    cache.clear();
  }
}

export function getCacheStats(): { size: number; files: string[] } {
  return {
    size: cache.size,
    files: Array.from(cache.keys()),
  };
}
