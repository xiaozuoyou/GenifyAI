import type { ParseResult, SymbolInfo, SymbolKind } from './types.js';
import { getParserForFile, getSupportedExtensions, getLanguageForFile, registerParser } from './registry.js';

// 导入各语言解析器以触发注册
import './typescript.js';
import './solidity.js';
import './html.js';
import './css.js';
import './python.js';
import './vue.js';

export function parseFile(filePath: string): ParseResult {
  const parser = getParserForFile(filePath);
  if (!parser) {
    return { symbols: [], exports: [], errors: [`Unsupported file type: ${filePath}`] };
  }
  return parser.parseFile(filePath);
}

export function parseFileForSymbol(filePath: string, query: string, type?: SymbolKind): SymbolInfo[] {
  const parser = getParserForFile(filePath);
  if (!parser) {
    return [];
  }
  return parser.parseFileForSymbol(filePath, query, type);
}

export { getParserForFile, getSupportedExtensions, getLanguageForFile, registerParser };
