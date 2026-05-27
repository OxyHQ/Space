/**
 * Tool Pipeline — unified assembly of all tool sources for chat contexts.
 *
 * Assembles the generic tool set:
 *   1. Web search tools (webSearch, webScraper, browse)
 *   2. Utility tools (getCurrentDate, generateFile)
 */

import type { ToolSet } from 'ai';
import {
  getCurrentDateTool,
  webSearchTool,
  browseTool,
  webScraperTool,
  generateFileTool,
} from './tools/index.js';
import type { SSEEmitter } from './sse-emitter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ForUserOptions {
  userId: string;
  accessToken?: string;
  isDirectSession: boolean;
  requestId?: string;
  /** SSE emitter for tools that need to push events */
  sseEmitter?: SSEEmitter;
}

export interface ForUserResult {
  tools: ToolSet;
  /** Maps sanitized tool names back to original names (for Google Gemini compat) */
  toolNameMapping: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Tool Pipeline
// ---------------------------------------------------------------------------

export class ToolPipeline {
  /**
   * Assemble the complete tool set for a chat user session.
   */
  static async forUser(_opts: ForUserOptions): Promise<ForUserResult> {
    const toolNameMapping = new Map<string, string>();

    // Search and utility tools (always available)
    const tools: ToolSet = {
      getCurrentDate: getCurrentDateTool,
      webSearch: webSearchTool,
      webScraper: webScraperTool,
      browse: browseTool,
      generateFile: generateFileTool,
    };

    return { tools, toolNameMapping };
  }
}
