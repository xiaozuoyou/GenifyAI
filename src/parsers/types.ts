export type SymbolKind =
  // TypeScript/JavaScript
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'const'
  | 'let'
  | 'var'
  | 'function_component'
  | 'class_component'
  | 'hook'
  | 'method'
  | 'getter'
  | 'setter'
  // Solidity
  | 'contract'
  | 'library'
  | 'sol_interface'
  | 'struct'
  | 'event'
  | 'modifier'
  | 'error'
  | 'mapping'
  // HTML
  | 'element'
  | 'component'
  // CSS/Less/Sass
  | 'selector'
  | 'variable'
  | 'mixin'
  | 'keyframes';

export interface SymbolLocation {
  startLine: number;
  endLine: number;
  startCol: number;
  endCol: number;
}

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  file: string;
  location: SymbolLocation;
  range: string;
  signature: string;
  language: string;
}

export interface ParseResult {
  symbols: SymbolInfo[];
  exports: ExportInfo[];
  errors: string[];
}

export type ExportKind = 'named' | 'default' | 'all';

export interface ExportInfo {
  kind: ExportKind;
  localName?: string;
  exportedName?: string;
  source?: string;
  location: SymbolLocation;
}

export type SupportedLanguage = 'typescript' | 'solidity' | 'html' | 'css';

export interface LanguageParser {
  language: SupportedLanguage;
  extensions: string[];
  parseFile(filePath: string): ParseResult;
  parseFileForSymbol(filePath: string, query: string, type?: SymbolKind): SymbolInfo[];
}
