import { z } from 'zod';
import { parseRange, readRange as readFileRange, type RangeReadResult } from '../utils/fileReader.js';
import { fileExists, toRelative } from '../utils/pathResolver.js';

export const readRangeSchema = z.object({
  filePath: z.string().describe('File path (relative to workspace root)'),
  range: z
    .string()
    .regex(/^\[\d+:\d+\]$/)
    .describe('Line range in format "[startLine:endLine]" (1-based, inclusive)'),
  surround: z
    .number()
    .optional()
    .default(0)
    .describe('Number of surrounding context lines'),
});

export type ReadRangeInput = z.infer<typeof readRangeSchema>;

export interface ReadRangeResult extends RangeReadResult {
  warning?: string;
}

export function readRange(input: ReadRangeInput): ReadRangeResult | null {
  const { filePath, range, surround = 0 } = input;

  if (!fileExists(filePath)) {
    return null;
  }

  const parsed = parseRange(range);
  if (!parsed) {
    return null;
  }

  const { startLine, endLine } = parsed;

  if (startLine > endLine) {
    return null;
  }

  const result = readFileRange(filePath, startLine, endLine, surround);

  if (!result) {
    return null;
  }

  // 转换为相对路径
  result.file = toRelative(result.file);

  return result;
}
