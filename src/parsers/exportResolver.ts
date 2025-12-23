import * as path from 'node:path';
import * as fs from 'node:fs';
import { parseFile } from './index.js';
import type { SymbolInfo, ExportInfo } from './types.js';
import { getWorkspaceRoot, toAbsolute } from '../utils/pathResolver.js';

const MAX_DEPTH = 10;

function resolveModulePath(fromFile: string, importPath: string): string | null {
  const dir = path.dirname(toAbsolute(fromFile));
  const extensions = ['.ts', '.tsx', '.js', '.jsx', ''];

  for (const ext of extensions) {
    const candidate = path.join(dir, importPath + ext);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.relative(getWorkspaceRoot(), candidate);
    }
  }

  // 尝试 index 文件
  for (const ext of extensions) {
    const candidate = path.join(dir, importPath, 'index' + ext);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.relative(getWorkspaceRoot(), candidate);
    }
  }

  return null;
}

export interface ResolvedExport {
  originalFile: string;
  originalName: string;
  resolvedFile: string;
  resolvedSymbol?: SymbolInfo;
  exportChain: string[];
}

export function followExport(
  filePath: string,
  exportedName: string,
  visited: Set<string> = new Set(),
  depth: number = 0
): ResolvedExport | null {
  if (depth > MAX_DEPTH) return null;

  const key = `${filePath}:${exportedName}`;
  if (visited.has(key)) return null;
  visited.add(key);

  const result = parseFile(filePath);
  if (result.errors.length > 0) return null;

  // 1. 先在本地符号中查找
  const localSymbol = result.symbols.find((s) => s.name === exportedName);
  if (localSymbol) {
    return {
      originalFile: filePath,
      originalName: exportedName,
      resolvedFile: filePath,
      resolvedSymbol: localSymbol,
      exportChain: [filePath],
    };
  }

  // 2. 查找导出语句
  for (const exp of result.exports) {
    // export { X } from './x' 或 export { X as Y } from './x'
    if (exp.kind === 'named' && exp.exportedName === exportedName && exp.source) {
      const targetFile = resolveModulePath(filePath, exp.source);
      if (targetFile) {
        const resolved = followExport(targetFile, exp.localName ?? exportedName, visited, depth + 1);
        if (resolved) {
          resolved.exportChain.unshift(filePath);
          return resolved;
        }
      }
    }

    // export * from './x'
    if (exp.kind === 'all' && exp.source) {
      const targetFile = resolveModulePath(filePath, exp.source);
      if (targetFile) {
        const resolved = followExport(targetFile, exportedName, visited, depth + 1);
        if (resolved) {
          resolved.exportChain.unshift(filePath);
          return resolved;
        }
      }
    }

    // export default X - 当查找 'default' 时
    if (exp.kind === 'default' && exportedName === 'default') {
      if (exp.localName) {
        const localSymbol = result.symbols.find((s) => s.name === exp.localName);
        if (localSymbol) {
          return {
            originalFile: filePath,
            originalName: exportedName,
            resolvedFile: filePath,
            resolvedSymbol: localSymbol,
            exportChain: [filePath],
          };
        }
      }
    }
  }

  return null;
}

export function resolveSymbolThroughExports(
  filePath: string,
  symbolName: string
): SymbolInfo | null {
  const resolved = followExport(filePath, symbolName);
  return resolved?.resolvedSymbol ?? null;
}

export function getAllReexportedSymbols(
  filePath: string,
  visited: Set<string> = new Set(),
  depth: number = 0
): SymbolInfo[] {
  if (depth > MAX_DEPTH) return [];

  if (visited.has(filePath)) return [];
  visited.add(filePath);

  const result = parseFile(filePath);
  if (result.errors.length > 0) return [];

  const symbols: SymbolInfo[] = [...result.symbols];

  // 跟随 export * from
  for (const exp of result.exports) {
    if (exp.kind === 'all' && exp.source) {
      const targetFile = resolveModulePath(filePath, exp.source);
      if (targetFile) {
        const reexported = getAllReexportedSymbols(targetFile, visited, depth + 1);
        symbols.push(...reexported);
      }
    }
  }

  return symbols;
}
