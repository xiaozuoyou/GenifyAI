import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getWorkspaceRoot } from '../utils/pathResolver.js';

const ALIAS_DIR = '.genifyai';
const ALIAS_FILE = 'aliases.json';

export const registerAliasSchema = z.object({
  term: z.string().describe('Alias or nickname (e.g., "反转卡片")'),
  target: z
    .string()
    .describe('Target in format "relativePath#SymbolName" or "relativePath"'),
});

export type RegisterAliasInput = z.infer<typeof registerAliasSchema>;

export interface AliasEntry {
  term: string;
  targets: string[];
}

export interface AliasStore {
  aliases: AliasEntry[];
}

function getAliasFilePath(): string {
  return path.join(getWorkspaceRoot(), ALIAS_DIR, ALIAS_FILE);
}

function ensureAliasDir(): void {
  const dirPath = path.join(getWorkspaceRoot(), ALIAS_DIR);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function loadAliases(): AliasStore {
  const filePath = getAliasFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as AliasStore;
    }
  } catch {
    // ignore parse errors
  }
  return { aliases: [] };
}

function saveAliases(store: AliasStore): void {
  ensureAliasDir();
  const filePath = getAliasFilePath();
  // 按 term 排序保持稳定
  store.aliases.sort((a, b) => a.term.localeCompare(b.term));
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8');
}

export function registerAlias(input: RegisterAliasInput): { success: boolean; message: string } {
  const { term, target } = input;
  const store = loadAliases();

  const existing = store.aliases.find((a) => a.term === term);

  if (existing) {
    if (!existing.targets.includes(target)) {
      existing.targets.push(target);
    }
  } else {
    store.aliases.push({ term, targets: [target] });
  }

  saveAliases(store);

  return {
    success: true,
    message: `Alias "${term}" -> "${target}" registered`,
  };
}

export function lookupAlias(term: string): string[] {
  const store = loadAliases();
  const entry = store.aliases.find((a) => a.term === term);
  return entry?.targets ?? [];
}

export function getAllAliases(): AliasEntry[] {
  return loadAliases().aliases;
}
