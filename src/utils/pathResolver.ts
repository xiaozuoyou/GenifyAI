import * as path from 'node:path';
import * as fs from 'node:fs';

let workspaceRoot: string = process.cwd();

export function setWorkspaceRoot(root: string): void {
  workspaceRoot = path.resolve(root);
}

export function getWorkspaceRoot(): string {
  return workspaceRoot;
}

export function toAbsolute(relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    return relativePath;
  }
  return path.join(workspaceRoot, relativePath);
}

export function toRelative(absolutePath: string): string {
  return path.relative(workspaceRoot, absolutePath);
}

export function isWithinWorkspace(filePath: string): boolean {
  const absolute = toAbsolute(filePath);
  return absolute.startsWith(workspaceRoot);
}

export function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(toAbsolute(filePath)).isFile();
  } catch {
    return false;
  }
}
