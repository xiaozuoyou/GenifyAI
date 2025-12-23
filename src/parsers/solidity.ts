import Parser from 'tree-sitter';
import { createRequire } from 'module';
import path from 'path';
import type { SymbolInfo, SymbolKind, ParseResult, ExportInfo, LanguageParser } from './types.js';
import { readFileContent, formatRange } from '../utils/fileReader.js';
import { getCachedResult, setCachedResult } from './cache.js';
import { registerParser } from './registry.js';

// tree-sitter-solidity 包缺少 bindings/node/index.js，需要手动加载
const require = createRequire(import.meta.url);
const nodeGypBuild = require('node-gyp-build');
const solidityPkgPath = path.dirname(require.resolve('tree-sitter-solidity/package.json'));
const Solidity = nodeGypBuild(solidityPkgPath);

const solParser = new Parser();
solParser.setLanguage(Solidity);

type SolNodeType = Parser.SyntaxNode['type'];

const NODE_KIND_MAP: Partial<Record<SolNodeType, SymbolKind>> = {
  contract_declaration: 'contract',
  library_declaration: 'library',
  interface_declaration: 'sol_interface',
  function_definition: 'function',
  constructor_definition: 'function',
  fallback_receive_definition: 'function',
  modifier_definition: 'modifier',
  event_definition: 'event',
  error_declaration: 'error',
  struct_declaration: 'struct',
  enum_declaration: 'enum',
  state_variable_declaration: 'const',
  user_defined_type_definition: 'type',
};

function getSymbolName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName('name');
  if (nameNode) {
    return nameNode.text;
  }

  // 特殊处理：constructor/fallback/receive 没有名字节点
  if (node.type === 'constructor_definition') {
    return 'constructor';
  }
  if (node.type === 'fallback_receive_definition') {
    const kind = node.children[0]?.text;
    return kind === 'fallback' ? 'fallback' : 'receive';
  }

  // state_variable_declaration 的名字在第一个 identifier 子节点
  if (node.type === 'state_variable_declaration') {
    for (const child of node.children) {
      if (child.type === 'identifier') {
        return child.text;
      }
    }
  }

  return null;
}

function getSignature(node: Parser.SyntaxNode, sourceCode: string): string {
  const startLine = node.startPosition.row;
  const lines = sourceCode.split('\n');
  let sig = lines[startLine]?.trim() || '';

  // 截取到 { 或行尾
  const braceIdx = sig.indexOf('{');
  if (braceIdx !== -1) {
    sig = sig.substring(0, braceIdx).trim();
  }

  return sig.length > 100 ? sig.substring(0, 100) + '...' : sig;
}

function collectSymbols(
  node: Parser.SyntaxNode,
  filePath: string,
  sourceCode: string,
  symbols: SymbolInfo[]
): void {
  const kind = NODE_KIND_MAP[node.type as SolNodeType];

  if (kind) {
    const name = getSymbolName(node);
    if (name) {
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
        signature: getSignature(node, sourceCode),
        language: 'solidity',
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
    const tree = solParser.parse(sourceCode);
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

export const solidityParser: LanguageParser = {
  language: 'solidity',
  extensions: ['.sol'],
  parseFile,
  parseFileForSymbol,
};

registerParser(solidityParser);
