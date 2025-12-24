import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
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

const tsParser = new Parser();
tsParser.setLanguage(TypeScript.typescript);

const tsxParser = new Parser();
tsxParser.setLanguage(TypeScript.tsx);

const cssParser = new Parser();
cssParser.setLanguage(CSS);

interface SfcBlock {
  content: string;
  startLine: number;
  lang?: string;
}

function extractSfcBlocks(sourceCode: string): {
  script?: SfcBlock;
  template?: SfcBlock;
  style?: SfcBlock;
} {
  const result: { script?: SfcBlock; template?: SfcBlock; style?: SfcBlock } = {};

  // 提取 <script> 块
  const scriptMatch = sourceCode.match(/<script([^>]*)>([\s\S]*?)<\/script>/i);
  if (scriptMatch) {
    const attrs = scriptMatch[1];
    const content = scriptMatch[2];
    const startIdx = sourceCode.indexOf(scriptMatch[0]);
    const startLine = sourceCode.slice(0, startIdx).split('\n').length;
    const langMatch = attrs.match(/lang=["']?(\w+)["']?/);

    result.script = {
      content,
      startLine,
      lang: langMatch?.[1],
    };
  }

  // 提取 <template> 块
  const templateMatch = sourceCode.match(/<template([^>]*)>([\s\S]*?)<\/template>/i);
  if (templateMatch) {
    const content = templateMatch[2];
    const startIdx = sourceCode.indexOf(templateMatch[0]);
    const startLine = sourceCode.slice(0, startIdx).split('\n').length;

    result.template = {
      content,
      startLine,
    };
  }

  // 提取 <style> 块
  const styleMatch = sourceCode.match(/<style([^>]*)>([\s\S]*?)<\/style>/i);
  if (styleMatch) {
    const attrs = styleMatch[1];
    const content = styleMatch[2];
    const startIdx = sourceCode.indexOf(styleMatch[0]);
    const startLine = sourceCode.slice(0, startIdx).split('\n').length;
    const langMatch = attrs.match(/lang=["']?(\w+)["']?/);

    result.style = {
      content,
      startLine,
      lang: langMatch?.[1],
    };
  }

  return result;
}

function isPascalCase(name: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(name);
}

function collectTemplateComponents(
  templateContent: string,
  filePath: string,
  baseOffset: number,
  symbols: SymbolInfo[]
): void {
  // 匹配 PascalCase 组件标签
  const tagRegex = /<([A-Z][a-zA-Z0-9]*)[^>]*\/?>/g;
  let match;

  while ((match = tagRegex.exec(templateContent)) !== null) {
    const tagName = match[1];
    const beforeMatch = templateContent.slice(0, match.index);
    const lineNum = beforeMatch.split('\n').length;

    symbols.push({
      name: tagName,
      kind: 'component',
      file: filePath,
      location: {
        startLine: lineNum + baseOffset,
        endLine: lineNum + baseOffset,
        startCol: 0,
        endCol: match[0].length,
      },
      range: formatRange(lineNum + baseOffset, lineNum + baseOffset),
      signature: `<${tagName}>`,
      language: 'vue',
    });
  }
}

function extractSignature(node: Parser.SyntaxNode, sourceCode: string): string {
  const startLine = node.startPosition.row;
  const lines = sourceCode.split('\n');
  let sig = lines[startLine] ?? '';
  const braceIdx = sig.indexOf('{');
  if (braceIdx !== -1) sig = sig.slice(0, braceIdx).trim();
  return sig.trim();
}

function isHookName(name: string): boolean {
  return /^use[A-Z]/.test(name);
}

function collectScriptSymbols(
  node: Parser.SyntaxNode,
  filePath: string,
  sourceCode: string,
  baseOffset: number,
  symbols: SymbolInfo[],
  exports: ExportInfo[]
): void {
  let kind: SymbolKind | null = null;
  let shouldProcess = false;

  switch (node.type) {
    case 'function_declaration': {
      const nameNode = node.childForFieldName('name');
      const name = nameNode?.text ?? '';
      kind = isHookName(name) ? 'hook' : isPascalCase(name) ? 'function_component' : 'function';
      shouldProcess = true;
      break;
    }
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
    case 'lexical_declaration': {
      const declarator = node.namedChildren.find(c => c.type === 'variable_declarator');
      const nameNode = declarator?.childForFieldName('name');
      const name = nameNode?.text ?? '';
      const value = declarator?.childForFieldName('value');

      if (value?.type === 'arrow_function' && isPascalCase(name)) {
        kind = 'function_component';
      } else if (isHookName(name) && value?.type === 'arrow_function') {
        kind = 'hook';
      } else {
        const kindNode = node.children.find(c => c.type === 'const' || c.type === 'let');
        kind = (kindNode?.type as 'const' | 'let') ?? 'const';
      }
      shouldProcess = true;
      break;
    }
    case 'method_definition': {
      const kindText = node.children.find(c => c.type === 'get' || c.type === 'set')?.type;
      kind = kindText === 'get' ? 'getter' : kindText === 'set' ? 'setter' : 'method';
      shouldProcess = true;
      break;
    }
    case 'pair': {
      const keyNode = node.childForFieldName('key');
      const valueNode = node.childForFieldName('value');
      const key = keyNode?.text;

      if (key && valueNode) {
        if (valueNode.type === 'function' || valueNode.type === 'arrow_function') {
          const loc = {
            startLine: node.startPosition.row + 1 + baseOffset,
            endLine: node.endPosition.row + 1 + baseOffset,
            startCol: node.startPosition.column,
            endCol: node.endPosition.column,
          };
          symbols.push({
            name: key,
            kind: 'method',
            file: filePath,
            location: loc,
            range: formatRange(loc.startLine, loc.endLine),
            signature: `${key}()`,
            language: 'vue',
          });
        }
      }
      break;
    }
    case 'call_expression': {
      const callee = node.childForFieldName('function');
      const calleeName = callee?.text;

      if (calleeName === 'defineProps' || calleeName === 'withDefaults') {
        collectDefinePropsSymbols(node, filePath, baseOffset, symbols);
      } else if (calleeName === 'defineEmits') {
        collectDefineEmitsSymbols(node, filePath, baseOffset, symbols);
      } else if (calleeName === 'computed') {
        collectComputedSymbol(node, filePath, baseOffset, symbols);
      } else if (calleeName === 'watch' || calleeName === 'watchEffect') {
        collectWatchSymbol(node, filePath, baseOffset, symbols, calleeName);
      }
      break;
    }
  }

  if (shouldProcess && kind) {
    let nameNode: Parser.SyntaxNode | null = null;
    switch (node.type) {
      case 'function_declaration':
      case 'class_declaration':
      case 'interface_declaration':
      case 'type_alias_declaration':
      case 'enum_declaration':
        nameNode = node.childForFieldName('name');
        break;
      case 'lexical_declaration': {
        const declarator = node.namedChildren.find(c => c.type === 'variable_declarator');
        nameNode = declarator?.childForFieldName('name') ?? null;
        break;
      }
      case 'method_definition':
        nameNode = node.childForFieldName('name');
        break;
    }

    if (nameNode) {
      const loc = {
        startLine: node.startPosition.row + 1 + baseOffset,
        endLine: node.endPosition.row + 1 + baseOffset,
        startCol: node.startPosition.column,
        endCol: node.endPosition.column,
      };
      symbols.push({
        name: nameNode.text,
        kind,
        file: filePath,
        location: loc,
        range: formatRange(loc.startLine, loc.endLine),
        signature: extractSignature(node, sourceCode),
        language: 'vue',
      });
    }
  }

  collectExports(node, exports, baseOffset);

  for (const child of node.namedChildren) {
    collectScriptSymbols(child, filePath, sourceCode, baseOffset, symbols, exports);
  }
}

function collectDefinePropsSymbols(
  node: Parser.SyntaxNode,
  filePath: string,
  baseOffset: number,
  symbols: SymbolInfo[]
): void {
  const args = node.childForFieldName('arguments');
  if (!args) return;

  const typeArgs = node.namedChildren.find(c => c.type === 'type_arguments');
  if (typeArgs) {
    const typeLiteral = typeArgs.namedChildren.find(c => c.type === 'object_type');
    if (typeLiteral) {
      for (const prop of typeLiteral.namedChildren) {
        if (prop.type === 'property_signature') {
          const nameNode = prop.childForFieldName('name');
          if (nameNode) {
            const loc = {
              startLine: prop.startPosition.row + 1 + baseOffset,
              endLine: prop.endPosition.row + 1 + baseOffset,
              startCol: prop.startPosition.column,
              endCol: prop.endPosition.column,
            };
            symbols.push({
              name: nameNode.text,
              kind: 'props',
              file: filePath,
              location: loc,
              range: formatRange(loc.startLine, loc.endLine),
              signature: prop.text,
              language: 'vue',
            });
          }
        }
      }
    }
  }

  const objArg = args.namedChildren.find(c => c.type === 'object');
  if (objArg) {
    for (const pair of objArg.namedChildren) {
      if (pair.type === 'pair' || pair.type === 'shorthand_property_identifier') {
        const keyNode = pair.type === 'pair' ? pair.childForFieldName('key') : pair;
        if (keyNode) {
          const loc = {
            startLine: pair.startPosition.row + 1 + baseOffset,
            endLine: pair.endPosition.row + 1 + baseOffset,
            startCol: pair.startPosition.column,
            endCol: pair.endPosition.column,
          };
          symbols.push({
            name: keyNode.text,
            kind: 'props',
            file: filePath,
            location: loc,
            range: formatRange(loc.startLine, loc.endLine),
            signature: `prop: ${keyNode.text}`,
            language: 'vue',
          });
        }
      }
    }
  }
}

function collectDefineEmitsSymbols(
  node: Parser.SyntaxNode,
  filePath: string,
  baseOffset: number,
  symbols: SymbolInfo[]
): void {
  const args = node.childForFieldName('arguments');
  if (!args) return;

  const arrArg = args.namedChildren.find(c => c.type === 'array');
  if (arrArg) {
    for (const elem of arrArg.namedChildren) {
      if (elem.type === 'string') {
        const name = elem.text.slice(1, -1);
        const loc = {
          startLine: elem.startPosition.row + 1 + baseOffset,
          endLine: elem.endPosition.row + 1 + baseOffset,
          startCol: elem.startPosition.column,
          endCol: elem.endPosition.column,
        };
        symbols.push({
          name,
          kind: 'emits',
          file: filePath,
          location: loc,
          range: formatRange(loc.startLine, loc.endLine),
          signature: `emit: ${name}`,
          language: 'vue',
        });
      }
    }
  }
}

function collectComputedSymbol(
  node: Parser.SyntaxNode,
  filePath: string,
  baseOffset: number,
  symbols: SymbolInfo[]
): void {
  const parent = node.parent;
  if (parent?.type === 'variable_declarator') {
    const nameNode = parent.childForFieldName('name');
    if (nameNode) {
      const decl = parent.parent;
      const loc = {
        startLine: (decl ?? node).startPosition.row + 1 + baseOffset,
        endLine: (decl ?? node).endPosition.row + 1 + baseOffset,
        startCol: (decl ?? node).startPosition.column,
        endCol: (decl ?? node).endPosition.column,
      };
      symbols.push({
        name: nameNode.text,
        kind: 'computed',
        file: filePath,
        location: loc,
        range: formatRange(loc.startLine, loc.endLine),
        signature: `computed: ${nameNode.text}`,
        language: 'vue',
      });
    }
  }
}

function collectWatchSymbol(
  node: Parser.SyntaxNode,
  filePath: string,
  baseOffset: number,
  symbols: SymbolInfo[],
  watchType: string
): void {
  const args = node.childForFieldName('arguments');
  if (!args) return;

  const firstArg = args.namedChildren[0];
  if (!firstArg) return;

  let watchTarget = '';
  if (firstArg.type === 'identifier') {
    watchTarget = firstArg.text;
  } else if (firstArg.type === 'arrow_function' || firstArg.type === 'function') {
    watchTarget = '() => ...';
  } else if (firstArg.type === 'array') {
    watchTarget = '[...]';
  }

  const loc = {
    startLine: node.startPosition.row + 1 + baseOffset,
    endLine: node.endPosition.row + 1 + baseOffset,
    startCol: node.startPosition.column,
    endCol: node.endPosition.column,
  };
  symbols.push({
    name: watchTarget || watchType,
    kind: 'watch',
    file: filePath,
    location: loc,
    range: formatRange(loc.startLine, loc.endLine),
    signature: `${watchType}(${watchTarget})`,
    language: 'vue',
  });
}

function collectOptionsApiSymbols(
  node: Parser.SyntaxNode,
  filePath: string,
  sourceCode: string,
  baseOffset: number,
  symbols: SymbolInfo[]
): void {
  if (node.type !== 'pair') {
    for (const child of node.namedChildren) {
      collectOptionsApiSymbols(child, filePath, sourceCode, baseOffset, symbols);
    }
    return;
  }

  const keyNode = node.childForFieldName('key');
  const valueNode = node.childForFieldName('value');
  const key = keyNode?.text;

  if (!key || !valueNode) return;

  if (key === 'computed' && valueNode.type === 'object') {
    for (const pair of valueNode.namedChildren) {
      if (pair.type === 'pair' || pair.type === 'method_definition') {
        const nameNode = pair.type === 'pair'
          ? pair.childForFieldName('key')
          : pair.childForFieldName('name');
        if (nameNode) {
          const loc = {
            startLine: pair.startPosition.row + 1 + baseOffset,
            endLine: pair.endPosition.row + 1 + baseOffset,
            startCol: pair.startPosition.column,
            endCol: pair.endPosition.column,
          };
          symbols.push({
            name: nameNode.text,
            kind: 'computed',
            file: filePath,
            location: loc,
            range: formatRange(loc.startLine, loc.endLine),
            signature: `computed: ${nameNode.text}`,
            language: 'vue',
          });
        }
      }
    }
  } else if (key === 'watch' && valueNode.type === 'object') {
    for (const pair of valueNode.namedChildren) {
      if (pair.type === 'pair' || pair.type === 'method_definition') {
        const nameNode = pair.type === 'pair'
          ? pair.childForFieldName('key')
          : pair.childForFieldName('name');
        if (nameNode) {
          const loc = {
            startLine: pair.startPosition.row + 1 + baseOffset,
            endLine: pair.endPosition.row + 1 + baseOffset,
            startCol: pair.startPosition.column,
            endCol: pair.endPosition.column,
          };
          symbols.push({
            name: nameNode.text,
            kind: 'watch',
            file: filePath,
            location: loc,
            range: formatRange(loc.startLine, loc.endLine),
            signature: `watch: ${nameNode.text}`,
            language: 'vue',
          });
        }
      }
    }
  } else if (key === 'props') {
    if (valueNode.type === 'array') {
      for (const elem of valueNode.namedChildren) {
        if (elem.type === 'string') {
          const name = elem.text.slice(1, -1);
          const loc = {
            startLine: elem.startPosition.row + 1 + baseOffset,
            endLine: elem.endPosition.row + 1 + baseOffset,
            startCol: elem.startPosition.column,
            endCol: elem.endPosition.column,
          };
          symbols.push({
            name,
            kind: 'props',
            file: filePath,
            location: loc,
            range: formatRange(loc.startLine, loc.endLine),
            signature: `prop: ${name}`,
            language: 'vue',
          });
        }
      }
    } else if (valueNode.type === 'object') {
      for (const pair of valueNode.namedChildren) {
        const nameNode = pair.type === 'pair' ? pair.childForFieldName('key') : null;
        if (nameNode) {
          const loc = {
            startLine: pair.startPosition.row + 1 + baseOffset,
            endLine: pair.endPosition.row + 1 + baseOffset,
            startCol: pair.startPosition.column,
            endCol: pair.endPosition.column,
          };
          symbols.push({
            name: nameNode.text,
            kind: 'props',
            file: filePath,
            location: loc,
            range: formatRange(loc.startLine, loc.endLine),
            signature: `prop: ${nameNode.text}`,
            language: 'vue',
          });
        }
      }
    }
  } else if (key === 'emits') {
    if (valueNode.type === 'array') {
      for (const elem of valueNode.namedChildren) {
        if (elem.type === 'string') {
          const name = elem.text.slice(1, -1);
          const loc = {
            startLine: elem.startPosition.row + 1 + baseOffset,
            endLine: elem.endPosition.row + 1 + baseOffset,
            startCol: elem.startPosition.column,
            endCol: elem.endPosition.column,
          };
          symbols.push({
            name,
            kind: 'emits',
            file: filePath,
            location: loc,
            range: formatRange(loc.startLine, loc.endLine),
            signature: `emit: ${name}`,
            language: 'vue',
          });
        }
      }
    }
  } else if (key === 'methods' && valueNode.type === 'object') {
    for (const pair of valueNode.namedChildren) {
      if (pair.type === 'pair' || pair.type === 'method_definition') {
        const nameNode = pair.type === 'pair'
          ? pair.childForFieldName('key')
          : pair.childForFieldName('name');
        if (nameNode) {
          const loc = {
            startLine: pair.startPosition.row + 1 + baseOffset,
            endLine: pair.endPosition.row + 1 + baseOffset,
            startCol: pair.startPosition.column,
            endCol: pair.endPosition.column,
          };
          symbols.push({
            name: nameNode.text,
            kind: 'method',
            file: filePath,
            location: loc,
            range: formatRange(loc.startLine, loc.endLine),
            signature: `${nameNode.text}()`,
            language: 'vue',
          });
        }
      }
    }
  }
}

function collectExports(
  node: Parser.SyntaxNode,
  exports: ExportInfo[],
  baseOffset: number
): void {
  if (node.type !== 'export_statement') return;

  const location = {
    startLine: node.startPosition.row + 1 + baseOffset,
    endLine: node.endPosition.row + 1 + baseOffset,
    startCol: node.startPosition.column,
    endCol: node.endPosition.column,
  };

  const defaultKeyword = node.children.find(c => c.type === 'default');
  if (defaultKeyword) {
    exports.push({
      kind: 'default',
      exportedName: 'default',
      location,
    });
    return;
  }

  const declaration = node.namedChildren.find(c =>
    ['function_declaration', 'class_declaration', 'lexical_declaration'].includes(c.type)
  );
  if (declaration) {
    let name: string | undefined;
    if (declaration.type === 'lexical_declaration') {
      const declarator = declaration.namedChildren.find(c => c.type === 'variable_declarator');
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
}

function collectCssSymbols(
  node: Parser.SyntaxNode,
  filePath: string,
  baseOffset: number,
  symbols: SymbolInfo[]
): void {
  if (node.type === 'rule_set') {
    const selectors = node.childForFieldName('selectors');
    if (selectors) {
      const selectorText = selectors.text.split('\n')[0].trim();
      const loc = {
        startLine: node.startPosition.row + 1 + baseOffset,
        endLine: node.endPosition.row + 1 + baseOffset,
        startCol: node.startPosition.column,
        endCol: node.endPosition.column,
      };
      symbols.push({
        name: selectorText,
        kind: 'selector',
        file: filePath,
        location: loc,
        range: formatRange(loc.startLine, loc.endLine),
        signature: selectorText,
        language: 'vue',
      });
    }
  }

  for (const child of node.namedChildren) {
    collectCssSymbols(child, filePath, baseOffset, symbols);
  }
}

export function parseFile(filePath: string): ParseResult {
  const cached = getCachedResult(filePath);
  if (cached) return cached;

  const sourceCode = readFileContent(filePath);
  if (!sourceCode) {
    return { symbols: [], exports: [], errors: [`Failed to read file: ${filePath}`] };
  }

  try {
    const blocks = extractSfcBlocks(sourceCode);
    const symbols: SymbolInfo[] = [];
    const exports: ExportInfo[] = [];

    // 解析 script 块
    if (blocks.script) {
      const { content, startLine, lang } = blocks.script;
      const parser = lang === 'tsx' ? tsxParser : tsParser;
      const scriptTree = parser.parse(content);
      collectScriptSymbols(
        scriptTree.rootNode,
        filePath,
        content,
        startLine,
        symbols,
        exports
      );
      collectOptionsApiSymbols(
        scriptTree.rootNode,
        filePath,
        content,
        startLine,
        symbols
      );
    }

    // 解析 template 块中的组件引用
    if (blocks.template) {
      collectTemplateComponents(
        blocks.template.content,
        filePath,
        blocks.template.startLine,
        symbols
      );
    }

    // 解析 style 块
    if (blocks.style) {
      const { content, startLine } = blocks.style;
      const styleTree = cssParser.parse(content);
      collectCssSymbols(styleTree.rootNode, filePath, startLine, symbols);
    }

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
  return symbols.filter(s => {
    const nameMatch = s.name.toLowerCase().includes(query.toLowerCase());
    const typeMatch = !type || s.kind === type;
    return nameMatch && typeMatch;
  });
}

export const vueParserInstance: LanguageParser = {
  language: 'vue',
  extensions: ['.vue'],
  parseFile,
  parseFileForSymbol,
};

registerParser(vueParserInstance);
