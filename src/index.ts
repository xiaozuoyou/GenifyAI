#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { searchSymbol, searchSymbolSchema } from './tools/searchSymbol.js';
import { readRange, readRangeSchema } from './tools/readRange.js';
import { registerAlias, registerAliasSchema } from './tools/registerAlias.js';
import { searchFuzzy, searchFuzzySchema } from './tools/searchFuzzy.js';
import { setWorkspaceRoot } from './utils/pathResolver.js';

const server = new Server(
  {
    name: 'genifyai',
    version: '0.1.3',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 列出可用工具
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'search_symbol',
        description:
          'Search for symbol definitions (function, class, interface, type, enum, const, etc.) in the codebase. Returns precise locations using AST parsing.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Symbol name to search for',
            },
            type: {
              type: 'string',
              enum: [
                'function',
                'class',
                'interface',
                'type',
                'enum',
                'const',
                'let',
                'var',
                'function_component',
                'class_component',
                'hook',
                'method',
                'getter',
                'setter',
              ],
              description: 'Optional filter by symbol type',
            },
            scope: {
              type: 'string',
              description: 'Search scope (directory path relative to workspace)',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results (default: 20)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'read_range',
        description:
          'Read a specific line range from a file. Use this to examine code at locations returned by search_symbol.',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'File path relative to workspace root',
            },
            range: {
              type: 'string',
              description:
                'Line range in format "[startLine:endLine]" (1-based, inclusive)',
              pattern: '^\\[\\d+:\\d+\\]$',
            },
            surround: {
              type: 'number',
              description: 'Number of surrounding context lines (default: 0)',
            },
          },
          required: ['filePath', 'range'],
        },
      },
      {
        name: 'register_alias',
        description:
          'Register an alias/nickname for a code location. Use this when natural language terms do not appear in code.',
        inputSchema: {
          type: 'object',
          properties: {
            term: {
              type: 'string',
              description: 'Alias or nickname (e.g., "flip card", "反转卡片")',
            },
            target: {
              type: 'string',
              description:
                'Target in format "relativePath#SymbolName" or "relativePath"',
            },
          },
          required: ['term', 'target'],
        },
      },
      {
        name: 'search_fuzzy',
        description:
          'Fuzzy search using natural language, aliases, or keywords. Returns ranked candidates with scores and reasons.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Natural language query, alias, or fuzzy keyword',
            },
            scope: {
              type: 'string',
              description: 'Search scope (directory path relative to workspace)',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results (default: 20)',
            },
          },
          required: ['query'],
        },
      },
    ],
  };
});

// 处理工具调用
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'search_symbol': {
        const input = searchSymbolSchema.parse(args);
        const results = await searchSymbol(input);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      }

      case 'read_range': {
        const input = readRangeSchema.parse(args);
        const result = readRange(input);

        if (!result) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: 'Failed to read file or invalid range' }),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'register_alias': {
        const input = registerAliasSchema.parse(args);
        const result = registerAlias(input);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'search_fuzzy': {
        const input = searchFuzzySchema.parse(args);
        const results = await searchFuzzy(input);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      }

      default:
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: `Unknown tool: ${name}` }),
            },
          ],
          isError: true,
        };
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[genifyai] Error in tool ${name}:`, errorMessage);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: errorMessage }),
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  // 设置工作区根目录
  setWorkspaceRoot(process.cwd());

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[genifyai] Server started');
}

main().catch((err) => {
  console.error('[genifyai] Fatal error:', err);
  process.exit(1);
});
