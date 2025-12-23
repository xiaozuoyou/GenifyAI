import * as fs from 'node:fs';
import * as path from 'node:path';
import { getWorkspaceRoot } from './pathResolver.js';

const DEFAULT_IGNORE = [
  'node_modules',
  'dist',
  'build',
  '.git',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  '*.min.js',
  '*.bundle.js',
];

let customIgnorePatterns: string[] | null = null;
let ignoreFileWatchTime: number = 0;

function loadIgnoreFile(): string[] {
  const ignoreFilePath = path.join(getWorkspaceRoot(), '.gitignore');

  try {
    const stat = fs.statSync(ignoreFilePath);

    // 检查文件是否变更
    if (customIgnorePatterns !== null && stat.mtimeMs === ignoreFileWatchTime) {
      return customIgnorePatterns;
    }

    const content = fs.readFileSync(ignoreFilePath, 'utf-8');
    const patterns = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));

    customIgnorePatterns = patterns;
    ignoreFileWatchTime = stat.mtimeMs;
    return patterns;
  } catch {
    customIgnorePatterns = [];
    return [];
  }
}

export function getIgnorePatterns(): string[] {
  const custom = loadIgnoreFile();
  return [...DEFAULT_IGNORE, ...custom];
}

export function shouldIgnorePath(relativePath: string): boolean {
  const patterns = getIgnorePatterns();
  const parts = relativePath.split(path.sep);

  for (const pattern of patterns) {
    // 简单的 glob 匹配
    if (pattern.startsWith('*.')) {
      // 扩展名匹配
      const ext = pattern.slice(1);
      if (relativePath.endsWith(ext)) {
        return true;
      }
    } else if (pattern.includes('*')) {
      // 通配符匹配
      const regex = new RegExp(
        '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
      );
      if (regex.test(relativePath) || parts.some((p) => regex.test(p))) {
        return true;
      }
    } else {
      // 目录/文件名精确匹配
      if (parts.includes(pattern)) {
        return true;
      }
      // 路径前缀匹配
      if (relativePath.startsWith(pattern + '/') || relativePath === pattern) {
        return true;
      }
    }
  }

  return false;
}

export function resetIgnoreCache(): void {
  customIgnorePatterns = null;
  ignoreFileWatchTime = 0;
}
