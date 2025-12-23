import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import type { SymbolInfo, SymbolKind, ParseResult, ExportInfo, LanguageParser } from './types.js';
import { readFileContent, formatRange } from '../utils/fileReader.js';
import { getCachedResult, setCachedResult } from './cache.js';
import { registerParser } from './registry.js';

const tsParser = new Parser();
tsParser.setLanguage(TypeScript.typescript);

const tsxParser = new Parser();
tsxParser.setLanguage(TypeScript.tsx);

function getParser(filePath: string): Parser {
  return filePath.endsWith('.tsx') || filePath.endsWith('.jsx') ? tsxParser : tsParser;
}

function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop() ?? '';
  return ext;
}

function extractSignature(node: Parser.SyntaxNode, sourceCode: string): string {
  const startLine = node.startPosition.row;
  const lines = sourceCode.split('\n');
  let sig = lines[startLine] ?? '';

  const braceIdx = sig.indexOf('{');
  if (braceIdx !== -1) {
    sig = sig.slice(0, braceIdx).trim();
  }

  return sig.trim();
}

function nodeToSymbol(
  node: Parser.SyntaxNode,
  kind: SymbolKind,
  filePath: string,
  sourceCode: string
): SymbolInfo | null {
  let nameNode: Parser.SyntaxNode | null = null;

  switch (node.type) {
    case 'function_declaration':
    case 'class_declaration':
    case 'interface_declaration':
    case 'type_alias_declaration':
    case 'enum_declaration':
      nameNode = node.childForFieldName('name');
      break;
    case 'lexical_declaration':
    case 'variable_declaration': {
      const declarator = node.namedChildren.find(
        (c) => c.type === 'variable_declarator'
      );
      nameNode = declarator?.childForFieldName('name') ?? null;
      break;
    }
    case 'method_definition':
      nameNode = node.childForFieldName('name');
      break;
  }

  if (!nameNode) return null;

  const name = nameNode.text;
  const location = {
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startCol: node.startPosition.column,
    endCol: node.endPosition.column,
  };

  return {
    name,
    kind,
    file: filePath,
    location,
    range: formatRange(location.startLine, location.endLine),
    signature: extractSignature(node, sourceCode),
    language: getLanguage(filePath),
  };
}

function getDeclarationKind(node: Parser.SyntaxNode): 'const' | 'let' | 'var' {
  const kindNode = node.children.find(
    (c) => c.type === 'const' || c.type === 'let' || c.type === 'var'
  );
  return (kindNode?.type as 'const' | 'let' | 'var') ?? 'const';
}

function isArrowFunctionComponent(node: Parser.SyntaxNode): boolean {
  if (node.type !== 'lexical_declaration') return false;

  const declarator = node.namedChildren.find((c) => c.type === 'variable_declarator');
  if (!declarator) return false;

  const nameNode = declarator.childForFieldName('name');
  if (!nameNode) return false;

  const name = nameNode.text;
  if (!/^[A-Z]/.test(name)) return false;

  const value = declarator.childForFieldName('value');
  if (!value) return false;

  return value.type === 'arrow_function';
}

function collectSymbols(
  node: Parser.SyntaxNode,
  filePath: string,
  sourceCode: string,
  symbols: SymbolInfo[]
): void {
  let kind: SymbolKind | null = null;
  let shouldProcess = false;

  switch (node.type) {
    case 'function_declaration':
      kind = 'function';
      shouldProcess = true;
      break;
    case 'class_declaration':
      kind = 'class';
      shouldProcess = true;
      break;
    case 'interface_declaration':
      kind = 'interface';
      shouldProcess = true;
      break;
    case 'type_alias_declaration':
      kind = 'type';
      shouldProcess = true;
      break;
    case 'enum_declaration':
      kind = 'enum';
      shouldProcess = true;
      break;
    case 'lexical_declaration':
      if (isArrowFunctionComponent(node)) {
        kind = 'function_component';
      } else {
        kind = getDeclarationKind(node);
      }
      shouldProcess = true;
      break;
    case 'variable_declaration':
      kind = 'var';
      shouldProcess = true;
      break;
    case 'method_definition': {
      const kindText = node.children.find(
        (c) => c.type === 'get' || c.type === 'set'
      )?.type;
      kind = kindText === 'get' ? 'getter' : kindText === 'set' ? 'setter' : 'method';
      shouldProcess = true;
      break;
    }
  }

  if (shouldProcess && kind) {
    const symbol = nodeToSymbol(node, kind, filePath, sourceCode);
    if (symbol) {
      symbols.push(symbol);
    }
  }

  for (const child of node.namedChildren) {
    collectSymbols(child, filePath, sourceCode, symbols);
  }
}

function collectExports(
  node: Parser.SyntaxNode,
  exports: ExportInfo[]
): void {
  if (node.type === 'export_statement') {
    const location = {
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startCol: node.startPosition.column,
      endCol: node.endPosition.column,
    };

    // export * from './x'
    const namespaceExport = node.namedChildren.find((c) => c.type === 'namespace_export');
    if (namespaceExport) {
      const sourceNode = node.namedChildren.find((c) => c.type === 'string');
      exports.push({
        kind: 'all',
        source: sourceNode?.text.slice(1, -1),
        location,
      });
      return;
    }

    // export { a, b } from './x' 或 export { a, b }
    const exportClause = node.namedChildren.find((c) => c.type === 'export_clause');
    if (exportClause) {
      const sourceNode = node.namedChildren.find((c) => c.type === 'string');
      const source = sourceNode?.text.slice(1, -1);

      for (const specifier of exportClause.namedChildren) {
        if (specifier.type === 'export_specifier') {
          const nameNode = specifier.childForFieldName('name');
          const aliasNode = specifier.childForFieldName('alias');

          exports.push({
            kind: 'named',
            localName: nameNode?.text,
            exportedName: aliasNode?.text ?? nameNode?.text,
            source,
            location,
          });
        }
      }
      return;
    }

    // export default xxx
    const defaultKeyword = node.children.find((c) => c.type === 'default');
    if (defaultKeyword) {
      const valueNode = node.namedChildren.find(
        (c) => c.type === 'identifier' || c.type === 'call_expression'
      );
      exports.push({
        kind: 'default',
        localName: valueNode?.type === 'identifier' ? valueNode.text : undefined,
        exportedName: 'default',
        location,
      });
      return;
    }

    // export function/class/const 等直接导出
    const declaration = node.namedChildren.find((c) =>
      ['function_declaration', 'class_declaration', 'lexical_declaration',
       'variable_declaration', 'interface_declaration', 'type_alias_declaration',
       'enum_declaration'].includes(c.type)
    );
    if (declaration) {
      let name: string | undefined;
      if (declaration.type === 'lexical_declaration' || declaration.type === 'variable_declaration') {
        const declarator = declaration.namedChildren.find((c) => c.type === 'variable_declarator');
        name = declarator?.childForFieldName('name')?.text;
      } else {
        name = declaration.childForFieldName('name')?.text;
      }
      if (name) {
        exports.push({
          kind: 'named',
          localName: name,
          exportedName: name,
          location,
        });
      }
    }
    return;
  }

  for (const child of node.namedChildren) {
    collectExports(child, exports);
  }
}

export function parseFile(filePath: string): ParseResult {
  // 检查缓存
  const cached = getCachedResult(filePath);
  if (cached) {
    return cached;
  }

  const sourceCode = readFileContent(filePath);
  if (!sourceCode) {
    return { symbols: [], exports: [], errors: [`Failed to read file: ${filePath}`] };
  }

  try {
    const parser = getParser(filePath);
    const tree = parser.parse(sourceCode);
    const symbols: SymbolInfo[] = [];
    const exports: ExportInfo[] = [];

    collectSymbols(tree.rootNode, filePath, sourceCode, symbols);
    collectExports(tree.rootNode, exports);

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
  symbolName: string,
  symbolType?: SymbolKind
): SymbolInfo[] {
  const result = parseFile(filePath);

  return result.symbols.filter((s) => {
    const nameMatch = s.name === symbolName || s.name.includes(symbolName);
    const typeMatch = !symbolType || s.kind === symbolType;
    return nameMatch && typeMatch;
  });
}

export const typescriptParser: LanguageParser = {
  language: 'typescript',
  extensions: ['.ts', '.tsx', '.js', '.jsx'],
  parseFile,
  parseFileForSymbol,
};

registerParser(typescriptParser);
