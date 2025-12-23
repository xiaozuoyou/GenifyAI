import { z } from 'zod';
import * as path from 'node:path';
import { searchSymbol } from './searchSymbol.js';
import { lookupAlias } from './registerAlias.js';
import { searchPattern } from '../search/ripgrep.js';
import { parseFile } from '../parsers/index.js';
import { getWorkspaceRoot } from '../utils/pathResolver.js';
import type { SymbolInfo } from '../parsers/types.js';
import { formatRange } from '../utils/fileReader.js';
import { glob } from '../search/glob.js';

export const searchFuzzySchema = z.object({
  query: z.string().describe('Natural language query, alias, or fuzzy keyword'),
  scope: z.string().optional().describe('Search scope (directory path)'),
  limit: z.number().optional().default(20).describe('Maximum number of results'),
});

export type SearchFuzzyInput = z.infer<typeof searchFuzzySchema>;

export interface FuzzyResult {
  file: string;
  range: string;
  symbol?: string;
  kind?: string;
  score: number;
  reasons: string[];
}

function normalizeQuery(query: string): string[] {
  const variants: string[] = [query];

  // 小写
  variants.push(query.toLowerCase());

  // 去空格
  variants.push(query.replace(/\s+/g, ''));

  // kebab-case -> camelCase
  const kebabToCamel = query.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  variants.push(kebabToCamel);

  // camelCase -> kebab-case
  const camelToKebab = query.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  variants.push(camelToKebab);

  // PascalCase
  const pascal = query.charAt(0).toUpperCase() + query.slice(1);
  variants.push(pascal);

  return [...new Set(variants)];
}

function parseTarget(target: string): { file: string; symbol?: string } {
  const hashIdx = target.indexOf('#');
  if (hashIdx !== -1) {
    return {
      file: target.slice(0, hashIdx),
      symbol: target.slice(hashIdx + 1),
    };
  }
  return { file: target };
}

async function aliasRecall(query: string): Promise<FuzzyResult[]> {
  const targets = lookupAlias(query);
  const results: FuzzyResult[] = [];

  for (const target of targets) {
    const { file, symbol } = parseTarget(target);
    const parseResult = parseFile(file);

    if (symbol) {
      const matched = parseResult.symbols.find((s) => s.name === symbol);
      if (matched) {
        results.push({
          file: matched.file,
          range: matched.range,
          symbol: matched.name,
          kind: matched.kind,
          score: 1.0,
          reasons: ['alias_hit'],
        });
      }
    } else if (parseResult.symbols.length > 0) {
      const first = parseResult.symbols[0];
      results.push({
        file,
        range: formatRange(1, 100),
        symbol: first.name,
        kind: first.kind,
        score: 0.95,
        reasons: ['alias_hit'],
      });
    }
  }

  return results;
}

async function symbolRecall(
  query: string,
  scope?: string,
  limit?: number
): Promise<FuzzyResult[]> {
  const variants = normalizeQuery(query);
  const allResults: FuzzyResult[] = [];
  const seen = new Set<string>();

  for (const variant of variants) {
    const symbols = await searchSymbol({ query: variant, scope, limit: limit ?? 20, followExports: true });

    for (const sym of symbols) {
      const key = `${sym.file}:${sym.name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const isExact = sym.name === query || sym.name.toLowerCase() === query.toLowerCase();

      allResults.push({
        file: sym.file,
        range: sym.range,
        symbol: sym.name,
        kind: sym.kind,
        score: isExact ? 0.9 : 0.7,
        reasons: isExact ? ['definition_exact'] : ['definition_match'],
      });
    }
  }

  return allResults;
}

async function fileNameRecall(query: string, scope?: string): Promise<FuzzyResult[]> {
  const variants = normalizeQuery(query);
  const results: FuzzyResult[] = [];
  const seen = new Set<string>();

  for (const variant of variants) {
    const files = await glob(`**/*${variant}*`, scope);

    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);

      const basename = path.basename(file, path.extname(file));
      const isExact =
        basename.toLowerCase() === variant.toLowerCase() ||
        basename.toLowerCase().includes(variant.toLowerCase());

      results.push({
        file,
        range: '[1:50]',
        score: isExact ? 0.6 : 0.4,
        reasons: ['filename_match'],
      });
    }
  }

  return results;
}

async function textRecall(
  query: string,
  scope?: string
): Promise<FuzzyResult[]> {
  const matches = await searchPattern(query, { scope, maxResults: 50 });
  const results: FuzzyResult[] = [];
  const seen = new Set<string>();

  for (const match of matches) {
    const key = `${match.file}:${match.line}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const startLine = Math.max(1, match.line - 5);
    const endLine = match.line + 10;

    results.push({
      file: match.file,
      range: formatRange(startLine, endLine),
      score: 0.3,
      reasons: ['text_hit'],
    });
  }

  return results;
}

function mergeAndSort(results: FuzzyResult[], limit: number): FuzzyResult[] {
  // 按 file+range 去重，保留最高分
  const map = new Map<string, FuzzyResult>();

  for (const r of results) {
    const key = `${r.file}:${r.range}`;
    const existing = map.get(key);

    if (!existing || r.score > existing.score) {
      if (existing) {
        r.reasons = [...new Set([...r.reasons, ...existing.reasons])];
      }
      map.set(key, r);
    } else {
      existing.reasons = [...new Set([...existing.reasons, ...r.reasons])];
    }
  }

  const merged = Array.from(map.values());
  merged.sort((a, b) => b.score - a.score);

  return merged.slice(0, limit);
}

export async function searchFuzzy(input: SearchFuzzyInput): Promise<FuzzyResult[]> {
  const { query, scope, limit = 20 } = input;

  // 并行执行多路召回
  const [aliasResults, symbolResults, fileResults, textResults] = await Promise.all([
    aliasRecall(query),
    symbolRecall(query, scope, limit),
    fileNameRecall(query, scope),
    textRecall(query, scope),
  ]);

  const allResults = [
    ...aliasResults,
    ...symbolResults,
    ...fileResults,
    ...textResults,
  ];

  return mergeAndSort(allResults, limit);
}
