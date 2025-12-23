import * as fs from 'node:fs';
import * as path from 'node:path';
import { getWorkspaceRoot } from '../utils/pathResolver.js';
import { shouldIgnorePath } from '../utils/ignore.js';

function matchPattern(filename: string, pattern: string): boolean {
  // 简单的 glob 匹配：支持 * 和 **
  const regex = pattern
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*')
    .replace(/\?/g, '.');

  return new RegExp(`^${regex}$`, 'i').test(filename);
}

async function walkDir(
  dir: string,
  pattern: string,
  results: string[],
  maxResults: number
): Promise<void> {
  if (results.length >= maxResults) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= maxResults) break;

    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(getWorkspaceRoot(), fullPath);

    if (shouldIgnorePath(relativePath)) continue;

    if (entry.isDirectory()) {
      await walkDir(fullPath, pattern, results, maxResults);
    } else if (entry.isFile()) {
      if (matchPattern(relativePath, pattern)) {
        results.push(relativePath);
      }
    }
  }
}

export async function glob(
  pattern: string,
  scope?: string,
  maxResults: number = 100
): Promise<string[]> {
  const searchRoot = scope
    ? path.join(getWorkspaceRoot(), scope)
    : getWorkspaceRoot();

  const results: string[] = [];
  await walkDir(searchRoot, pattern, results, maxResults);

  return results;
}
