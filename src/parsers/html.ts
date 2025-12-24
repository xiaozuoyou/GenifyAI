import Parser from 'tree-sitter';
import { createRequire } from 'module';
import path from 'path';
import type { SymbolInfo, SymbolKind, ParseResult, ExportInfo, LanguageParser } from './types.js';
import { readFileContent, formatRange } from '../utils/fileReader.js';
import { getCachedResult, setCachedResult } from './cache.js';
import { registerParser } from './registry.js';

const require = createRequire(import.meta.url);
const nodeGypBuild = require('node-gyp-build');
const htmlPkgPath = path.dirname(require.resolve('tree-sitter-html/package.json'));
const HTML = nodeGypBuild(htmlPkgPath);

const htmlParser = new Parser();
htmlParser.setLanguage(HTML);

function isCustomElement(tagName: string): boolean {
  return tagName.includes('-');
}

function getAttributeValue(node: Parser.SyntaxNode, attrName: string): string | null {
  for (const child of node.namedChildren) {
    if (child.type === 'attribute') {
      const name = child.childForFieldName('name')?.text;
      if (name === attrName) {
        const value = child.childForFieldName('value');
        if (value) {
          let text = value.text;
          // 去掉引号
          if ((text.startsWith('"') && text.endsWith('"')) ||
              (text.startsWith("'") && text.endsWith("'"))) {
            text = text.slice(1, -1);
          }
          return text;
        }
      }
    }
  }
  return null;
}

function collectSymbols(
  node: Parser.SyntaxNode,
  filePath: string,
  sourceCode: string,
  symbols: SymbolInfo[]
): void {
  if (node.type === 'element' || node.type === 'self_closing_tag') {
    const startTag = node.type === 'element'
      ? node.childForFieldName('start_tag') || node.namedChildren[0]
      : node;

    if (startTag) {
      const tagNameNode = startTag.namedChildren.find(c => c.type === 'tag_name');
      const tagName = tagNameNode?.text;

      if (tagName) {
        const id = getAttributeValue(startTag, 'id');
        const className = getAttributeValue(startTag, 'class');

        // 记录有 id 的元素
        if (id) {
          symbols.push({
            name: `#${id}`,
            kind: 'element',
            file: filePath,
            location: {
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              startCol: node.startPosition.column,
              endCol: node.endPosition.column,
            },
            range: formatRange(node.startPosition.row + 1, node.endPosition.row + 1),
            signature: `<${tagName} id="${id}">`,
            language: 'html',
          });
        }

        // 记录自定义组件/Web Components
        if (isCustomElement(tagName)) {
          symbols.push({
            name: tagName,
            kind: 'component',
            file: filePath,
            location: {
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              startCol: node.startPosition.column,
              endCol: node.endPosition.column,
            },
            range: formatRange(node.startPosition.row + 1, node.endPosition.row + 1),
            signature: `<${tagName}${className ? ` class="${className}"` : ''}>`,
            language: 'html',
          });
        }
      }
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
    const tree = htmlParser.parse(sourceCode);
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

export const htmlParserInstance: LanguageParser = {
  language: 'html',
  extensions: ['.html', '.htm'],
  parseFile,
  parseFileForSymbol,
};

registerParser(htmlParserInstance);
