import Parser from 'tree-sitter';
import { createRequire } from 'module';
import path from 'path';
import type { SymbolInfo, SymbolKind, ParseResult, ExportInfo, LanguageParser } from './types.js';
import { readFileContent, formatRange } from '../utils/fileReader.js';
import { getCachedResult, setCachedResult } from './cache.js';
import { registerParser } from './registry.js';

const require = createRequire(import.meta.url);
const nodeGypBuild = require('node-gyp-build');
const cssPkgPath = path.dirname(require.resolve('tree-sitter-css/package.json'));
const CSS = nodeGypBuild(cssPkgPath);

const cssParser = new Parser();
cssParser.setLanguage(CSS);

function extractSelectorName(node: Parser.SyntaxNode): string {
  // 提取选择器文本，清理空白
  return node.text.replace(/\s+/g, ' ').trim();
}

function collectSymbols(
  node: Parser.SyntaxNode,
  filePath: string,
  sourceCode: string,
  symbols: SymbolInfo[]
): void {
  // 规则集（选择器）
  if (node.type === 'rule_set') {
    const selectorsNode = node.childForFieldName('selectors') || node.namedChildren[0];
    if (selectorsNode) {
      const selectorText = extractSelectorName(selectorsNode);
      // 只记录 class 和 id 选择器
      if (selectorText.startsWith('.') || selectorText.startsWith('#')) {
        symbols.push({
          name: selectorText.split(/[,\s]/)[0], // 取第一个选择器
          kind: 'selector',
          file: filePath,
          location: {
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            startCol: node.startPosition.column,
            endCol: node.endPosition.column,
          },
          range: formatRange(node.startPosition.row + 1, node.endPosition.row + 1),
          signature: selectorText.length > 60 ? selectorText.substring(0, 60) + '...' : selectorText,
          language: 'css',
        });
      }
    }
  }

  // @keyframes
  if (node.type === 'keyframes_statement') {
    const nameNode = node.childForFieldName('name') || node.namedChildren.find(c => c.type === 'keyframes_name');
    if (nameNode) {
      symbols.push({
        name: nameNode.text,
        kind: 'keyframes',
        file: filePath,
        location: {
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          startCol: node.startPosition.column,
          endCol: node.endPosition.column,
        },
        range: formatRange(node.startPosition.row + 1, node.endPosition.row + 1),
        signature: `@keyframes ${nameNode.text}`,
        language: 'css',
      });
    }
  }

  // CSS 自定义属性（变量）在 :root 或其他地方声明
  if (node.type === 'declaration') {
    const propertyNode = node.childForFieldName('property') || node.namedChildren[0];
    if (propertyNode && propertyNode.text.startsWith('--')) {
      symbols.push({
        name: propertyNode.text,
        kind: 'variable',
        file: filePath,
        location: {
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          startCol: node.startPosition.column,
          endCol: node.endPosition.column,
        },
        range: formatRange(node.startPosition.row + 1, node.endPosition.row + 1),
        signature: node.text.length > 60 ? node.text.substring(0, 60) + '...' : node.text,
        language: 'css',
      });
    }
  }

  for (const child of node.namedChildren) {
    collectSymbols(child, filePath, sourceCode, symbols);
  }
}

export function parseFile(filePath: string): ParseResult {
  const cached = getCachedResult(filePath);
  if (cached) {
    return cached;
  }

  const sourceCode = readFileContent(filePath);
  if (!sourceCode) {
    return { symbols: [], exports: [], errors: [`Failed to read file: ${filePath}`] };
  }

  try {
    const tree = cssParser.parse(sourceCode);
    const symbols: SymbolInfo[] = [];
    const exports: ExportInfo[] = [];

    collectSymbols(tree.rootNode, filePath, sourceCode, symbols);

    const result: ParseResult = { symbols, exports, errors: [] };
    setCachedResult(filePath, result);
    return result;
  } catch (err) {
    return {
      symbols: [],
      exports: [],
      errors: [`Failed to parse file: ${filePath} - ${err}`],
    };
  }
}

export function parseFileForSymbol(
  filePath: string,
  query: string,
  type?: SymbolKind
): SymbolInfo[] {
  const { symbols } = parseFile(filePath);
  return symbols.filter((s) => {
    const nameMatch = s.name.toLowerCase().includes(query.toLowerCase());
    const typeMatch = !type || s.kind === type;
    return nameMatch && typeMatch;
  });
}

export const cssParserInstance: LanguageParser = {
  language: 'css',
  extensions: ['.css', '.less', '.sass', '.scss'],
  parseFile,
  parseFileForSymbol,
};

registerParser(cssParserInstance);
