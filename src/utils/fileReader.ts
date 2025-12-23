import * as fs from 'node:fs';
import { toAbsolute } from './pathResolver.js';

export interface RangeReadResult {
  file: string;
  range: string;
  startLine: number;
  endLine: number;
  code: string;
}

export function parseRange(rangeStr: string): { startLine: number; endLine: number } | null {
  const match = rangeStr.match(/^\[(\d+):(\d+)\]$/);
  if (!match) return null;
  return {
    startLine: parseInt(match[1], 10),
    endLine: parseInt(match[2], 10),
  };
}

export function formatRange(startLine: number, endLine: number): string {
  return `[${startLine}:${endLine}]`;
}

export function readFileContent(filePath: string): string | null {
  try {
    return fs.readFileSync(toAbsolute(filePath), 'utf-8');
  } catch {
    return null;
  }
}

export function readFileLines(filePath: string): string[] | null {
  const content = readFileContent(filePath);
  if (content === null) return null;
  return content.split('\n');
}

export function readRange(
  filePath: string,
  startLine: number,
  endLine: number,
  surround: number = 0
): RangeReadResult | null {
  const lines = readFileLines(filePath);
  if (!lines) return null;

  const totalLines = lines.length;
  const actualStart = Math.max(1, startLine - surround);
  const actualEnd = Math.min(totalLines, endLine + surround);

  const selectedLines = lines.slice(actualStart - 1, actualEnd);

  return {
    file: filePath,
    range: formatRange(actualStart, actualEnd),
    startLine: actualStart,
    endLine: actualEnd,
    code: selectedLines.join('\n'),
  };
}
