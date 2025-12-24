import Parser from 'tree-sitter';
import { createRequire } from 'module';
import path from 'path';
import type { SymbolInfo, SymbolKind, ParseResult, ExportInfo, LanguageParser } from './types.js';
import { readFileContent, formatRange } from '../utils/fileReader.js';
import { getCachedResult, setCachedResult } from './cache.js';
import { registerParser } from './registry.js';

const require = createRequire(import.meta.url);
const nodeGypBuild = require('node-gyp-build');
const pythonPkgPath = path.dirname(require.resolve('tree-sitter-python/package.json'));
const Python = nodeGypBuild(pythonPkgPath);

const pyParser = new Parser();
pyParser.setLanguage(Python);

function getFunctionName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName('name');
  return nameNode?.text || null;
}

function getClassName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName('name');
  return nameNode?.text || null;
}

function getFunctionSignature(node: Parser.SyntaxNode, sourceCode: string): string {
  const nameNode = node.childForFieldName('name');
  const paramsNode = node.childForFieldName('parameters');
  const returnType = node.childForFieldName('return_type');

  let sig = 'def ';
  if (nameNode) sig += nameNode.text;
  if (paramsNode) sig += paramsNode.text;
  if (returnType) sig += ' -> ' + returnType.text;
  return sig;
}

function getClassSignature(node: Parser.SyntaxNode): string {
  const nameNode = node.childForFieldName('name');
  const superclass = node.childForFieldName('superclasses');

  let sig = 'class ';
  if (nameNode) sig += nameNode.text;
  if (superclass) sig += superclass.text;
  return sig;
}

function collectSymbols(
  node: Parser.SyntaxNode,
  filePath: string,
  sourceCode: string,
  symbols: SymbolInfo[],
  inClass: boolean = false
): void {
  // 函数定义
  if (node.type === 'function_definition') {
    const name = getFunctionName(node);
    if (name) {
      const kind: SymbolKind = inClass ? 'method' : 'function';
      symbols.push({
        name,
        kind,
        file: filePath,
        location: {
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          startCol: node.startPosition.column,
          endCol: node.endPosition.column,
        },
        range: formatRange(node.startPosition.row + 1, node.endPosition.row + 1),
        signature: getFunctionSignature(node, sourceCode),
        language: 'python',
      });
    }
  }

  // 类定义
  if (node.type === 'class_definition') {
    const name = getClassName(node);
    if (name) {
      symbols.push({
        name,
        kind: 'class',
        file: filePath,
        location: {
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          startCol: node.startPosition.column,
          endCol: node.endPosition.column,
        },
        range: formatRange(node.startPosition.row + 1, node.endPosition.row + 1),
        signature: getClassSignature(node),
        language: 'python',
      });
    }

    // 递归处理类内部的方法
    const body = node.childForFieldName('body');
    if (body) {
      for (const child of body.namedChildren) {
        collectSymbols(child, filePath, sourceCode, symbols, true);
      }
    }
    return;
  }

  // 装饰器定义（decorated_definition）
  if (node.type === 'decorated_definition') {
    const definition = node.namedChildren.find(
      (c) => c.type === 'function_definition' || c.type === 'class_definition'
    );

    if (definition) {
      const decorators = node.namedChildren.filter((c) => c.type === 'decorator');
      const name = definition.type === 'function_definition'
        ? getFunctionName(definition)
        : getClassName(definition);

      if (name && decorators.length > 0) {
        const decoratorNames = decorators.map((d) => d.text).join('\n');
        const kind: SymbolKind = inClass
          ? 'method'
          : (definition.type === 'function_definition' ? 'decorator' : 'class');

        symbols.push({
          name,
          kind,
          file: filePath,
          location: {
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            startCol: node.startPosition.column,
            endCol: node.endPosition.column,
          },
          range: formatRange(node.startPosition.row + 1, node.endPosition.row + 1),
          signature: decoratorNames + '\n' + (
            definition.type === 'function_definition'
              ? getFunctionSignature(definition, sourceCode)
              : getClassSignature(definition)
          ),
          language: 'python',
        });
      }

      // 如果是被装饰的类，继续处理类内部
      if (definition.type === 'class_definition') {
        const body = definition.childForFieldName('body');
        if (body) {
          for (const child of body.namedChildren) {
            collectSymbols(child, filePath, sourceCode, symbols, true);
          }
        }
      }
    }
    return;
  }

  // 递归处理子节点
  for (const child of node.namedChildren) {
    collectSymbols(child, filePath, sourceCode, symbols, inClass);
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
    const tree = pyParser.parse(sourceCode);
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

export const pythonParserInstance: LanguageParser = {
  language: 'python',
  extensions: ['.py', '.pyw'],
  parseFile,
  parseFileForSymbol,
};

registerParser(pythonParserInstance);
