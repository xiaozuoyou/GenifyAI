import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import { getWorkspaceRoot } from '../utils/pathResolver.js';
import { getIgnorePatterns } from '../utils/ignore.js';

export interface RipgrepMatch {
  file: string;
  line: number;
  column: number;
  text: string;
}

export interface RipgrepOptions {
  scope?: string;
  extensions?: string[];
  ignorePatterns?: string[];
  maxResults?: number;
}

export async function searchPattern(
  pattern: string,
  options: RipgrepOptions = {}
): Promise<RipgrepMatch[]> {
  const {
    scope,
    extensions = ['ts', 'tsx', 'js', 'jsx', 'sol', 'html', 'htm', 'css', 'less', 'sass', 'scss', 'py', 'pyw', 'vue'],
    ignorePatterns = getIgnorePatterns(),
    maxResults = 1000,
  } = options;

  const searchPath = scope ? path.join(getWorkspaceRoot(), scope) : getWorkspaceRoot();

  const args: string[] = [
    '--json',
    '--line-number',
    '--column',
    '--no-heading',
    `--max-count=${maxResults}`,
  ];

  for (const ext of extensions) {
    args.push('--glob', `*.${ext}`);
  }

  for (const ignore of ignorePatterns) {
    args.push('--glob', `!${ignore}`);
  }

  args.push('--', pattern, searchPath);

  return new Promise((resolve, reject) => {
    const results: RipgrepMatch[] = [];
    const rg = spawn(rgPath, args);

    let stdout = '';
    let stderr = '';

    rg.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    rg.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    rg.on('close', (code) => {
      if (code !== 0 && code !== 1) {
        console.error(`[ripgrep] stderr: ${stderr}`);
      }

      const lines = stdout.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const json = JSON.parse(line);
          if (json.type === 'match') {
            const data = json.data;
            results.push({
              file: path.relative(getWorkspaceRoot(), data.path.text),
              line: data.line_number,
              column: data.submatches[0]?.start ?? 0,
              text: data.lines.text.trim(),
            });
          }
        } catch {
          // ignore parse errors
        }
      }

      resolve(results);
    });

    rg.on('error', reject);
  });
}

export async function searchFiles(
  pattern: string,
  options: RipgrepOptions = {}
): Promise<string[]> {
  const matches = await searchPattern(pattern, options);
  const files = new Set(matches.map((m) => m.file));
  return Array.from(files);
}
