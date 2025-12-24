import { z } from 'zod';
import { searchFiles } from '../search/ripgrep.js';
import { parseFileForSymbol } from '../parsers/index.js';
import { resolveSymbolThroughExports } from '../parsers/exportResolver.js';
import type { SymbolInfo, SymbolKind } from '../parsers/types.js';

export const searchSymbolSchema = z.object({
  query: z.string().describe('Symbol name to search for'),
  type: z
    .enum([
      // TypeScript/JavaScript
      'function',
      'class',
      'interface',
      'type',
      'enum',
      'const',
      'let',
      'var',
      'function_component',
      'class_component',
      'hook',
      'method',
      'getter',
      'setter',
      // Solidity
      'contract',
      'library',
      'sol_interface',
      'struct',
      'event',
      'modifier',
      'error',
      'mapping',
      // HTML
      'element',
      'component',
      // CSS/Less/Sass
      'selector',
      'variable',
      'mixin',
      'keyframes',
      // Python
      'decorator',
    ])
    .optional()
    .describe('Optional filter by symbol type'),
  scope: z.string().optional().describe('Search scope (directory path)'),
  limit: z.number().optional().default(20).describe('Maximum number of results'),
  followExports: z.boolean().optional().default(true).describe('Follow export chains to find original definitions'),
});

export type SearchSymbolInput = z.infer<typeof searchSymbolSchema>;

export async function searchSymbol(input: SearchSymbolInput): Promise<SymbolInfo[]> {
  const { query, type, scope, limit = 20, followExports = true } = input;

  // 1. ripgrep 粗筛：找到包含 query 的文件
  const candidateFiles = await searchFiles(query, { scope });

  if (candidateFiles.length === 0) {
    return [];
  }

  // 2. Tree-sitter 精筛：解析每个文件，提取匹配的符号定义
  const allSymbols: SymbolInfo[] = [];
  const seen = new Set<string>();

  for (const file of candidateFiles) {
    const symbols = parseFileForSymbol(file, query, type as SymbolKind | undefined);

    for (const symbol of symbols) {
      const key = `${symbol.file}:${symbol.name}:${symbol.location.startLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      allSymbols.push(symbol);
    }

    // 3. 如果启用导出跟随，尝试解析重导出
    if (followExports) {
      const resolved = resolveSymbolThroughExports(file, query);
      if (resolved) {
        const key = `${resolved.file}:${resolved.name}:${resolved.location.startLine}`;
        if (!seen.has(key)) {
          seen.add(key);
          allSymbols.push(resolved);
        }
      }
    }

    // 提前终止
    if (allSymbols.length >= limit * 2) {
      break;
    }
  }

  // 4. 排序：优先完全匹配，然后按文件路径深度
  const sorted = allSymbols.sort((a, b) => {
    // 完全匹配优先
    const aExact = a.name === query ? 0 : 1;
    const bExact = b.name === query ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;

    // 文件路径深度浅的优先
    const aDepth = a.file.split('/').length;
    const bDepth = b.file.split('/').length;
    return aDepth - bDepth;
  });

  return sorted.slice(0, limit);
}
