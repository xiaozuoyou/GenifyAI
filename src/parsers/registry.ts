import type { LanguageParser, SupportedLanguage } from './types.js';

const parsers: Map<string, LanguageParser> = new Map();

export function registerParser(parser: LanguageParser): void {
  for (const ext of parser.extensions) {
    parsers.set(ext, parser);
  }
}

export function getParserForFile(filePath: string): LanguageParser | null {
  const ext = filePath.substring(filePath.lastIndexOf('.'));
  return parsers.get(ext) || null;
}

export function getSupportedExtensions(): string[] {
  return Array.from(parsers.keys());
}

export function getLanguageForFile(filePath: string): SupportedLanguage | null {
  const parser = getParserForFile(filePath);
  return parser?.language || null;
}
