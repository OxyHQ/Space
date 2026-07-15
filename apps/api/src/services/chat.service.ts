/**
 * Chat Service — Business Logic for the Internal Chat API
 *
 * Extracted from routes/chat.ts to separate business logic from HTTP handling.
 * The route handler orchestrates streaming and SSE; this module handles:
 *   - System prompt construction (personalization, skills, agents, memory)
 *   - Tool set building (user-specific tools, MCP, admin tools)
 *   - User context loading (credits, memory, profile)
 *   - Credit lifecycle (reservation, finalization)
 */

import { type ToolSet } from 'ai';
import { resolveModel, getDefaultClarityModel } from '../lib/chat-core.js';
import { markKeyCreditExhausted, getClarityModel, getModelMappingsForTier } from '../lib/gateway-client.js';
import { getCurrentDateTool, webSearchTool, browseTool, webScraperTool, generateFileTool } from '../lib/tools/index.js';
import { oxyClient } from '../middleware/auth.js';
import type { User as OxyUser } from '@oxyhq/core';
import { getOrCreateUserCredits } from '../lib/user-credits-helpers.js';
import { processMessagesForPlatform } from '../lib/message-processor.js';
import { reserveCredits, type CreditReservation } from '../lib/credits-manager.js';
import { estimateMessageTokens } from '../lib/token-counter.js';
import { getUserTier } from '../middleware/api-key-rate-limit.js';
import { runBeforeChatHooks } from '../lib/hooks/index.js';
import { log } from '../lib/logger.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { wrapToolsWithTruncation, getToolResultBudget } from '../lib/tools/result-truncation.js';
import { BILLING_RE, AUTH_RE } from '../lib/constants.js';

// ── Inline type for recalled memory (previously from deleted lib/memory/recall.ts) ──
export interface RecalledMemory {
  key: string;
  value: string;
  category?: string;
  score: number;
}

// ── Types ──

export interface ChatRequestParams {
  messages: any[];
  conversationId?: string;
  requestedModel?: string;
  thinkingMode?: boolean;
  userId?: string;
  platform: 'app' | 'telegram';
}

export interface UserContext {
  oxyUser: OxyUser | null;
  userTier?: string;
  creditReservation: CreditReservation | null;
}

export interface ChatSetupResult {
  userContext: UserContext;
  systemPrompt: string;
  tools: ToolSet;
  processedMessages: any[];
  compactedMessages: any[];
  systemPromptTokens: number;
  modelContextTokens: number;
  recalledMemories?: RecalledMemory[];
}

// ── System Prompt Builder ──

export async function buildChatSystemPrompt(
  oxyUser?: OxyUser | null,
  platform: 'app' | 'telegram' = 'app',
  skillPrompt?: string | null,
  recalledMemories?: RecalledMemory[],
  agentPrompt?: string | null
): Promise<string> {
  let prompt = await loadPrompt(platform === 'telegram' ? 'clarity-telegram' : 'clarity-app');

  if (skillPrompt) {
    prompt = `${skillPrompt}\n\n---\n\n${prompt}`;
  }

  if (agentPrompt) {
    prompt = `# ACTIVE AGENT\n\n${agentPrompt}\n\n---\n\n${prompt}`;
  }

  const userContextParts: string[] = [];

  if (oxyUser) {
    if (oxyUser.name?.full || oxyUser.name?.first) {
      const fullName = oxyUser.name.full || [oxyUser.name.first, oxyUser.name.middle, oxyUser.name.last].filter(Boolean).join(' ');
      if (fullName && fullName !== 'User') {
        userContextParts.push(`The user's name is ${fullName}.`);
      }
    }
    if (oxyUser.username) userContextParts.push(`The user's username is @${oxyUser.username}.`);
    if (oxyUser.location) userContextParts.push(`The user is located in ${oxyUser.location}.`);
    if (oxyUser.bio) userContextParts.push(`About the user: ${oxyUser.bio}`);
    if (oxyUser.website) userContextParts.push(`The user's website: ${oxyUser.website}`);
  }

  if (recalledMemories && recalledMemories.length > 0) {
    const memoryItems = recalledMemories.map(m => `- ${m.key}: ${m.value}`).join('\n');
    userContextParts.push(`\nRelevant things to remember about the user:\n${memoryItems}`);
  }

  if (userContextParts.length > 0) {
    log.chat.info({ userContext: userContextParts }, 'Personalization applied');
    prompt = `# USER CONTEXT\n\n${userContextParts.join('\n')}\n\n---\n\n${prompt}`;
  }

  return prompt;
}

// ── User Context Loading ──

export async function loadUserContext(userId: string): Promise<UserContext> {
  let oxyUser: OxyUser | null = null;
  let userTier: string | undefined;
  let creditReservation: CreditReservation | null = null;

  try {
    const [userCredits, tier] = await Promise.all([
      getOrCreateUserCredits(userId),
      getUserTier(userId),
    ]);

    userTier = tier;

    await userCredits.refreshCreditsIfNeeded();
    creditReservation = await reserveCredits(userId);
  } catch (error) {
    log.chat.error({ err: error }, 'Error loading user data');
  }

  try {
    oxyUser = await oxyClient.getUserById(userId) as OxyUser;
  } catch (e) {
    log.chat.error({ err: e }, 'Could not fetch Oxy user profile');
  }

  return { oxyUser, userTier, creditReservation };
}

// ── Skill & Agent Prompt Loading ──

/**
 * Skill loading was removed during Clarity pruning (Skill model deleted).
 */
export async function loadSkillPrompt(_skillId: string): Promise<string | null> {
  return null;
}

/**
 * Agent prompt loading was removed during Clarity pruning (Agent model deleted).
 */
export async function loadAgentPrompt(_agentId: string): Promise<string | null> {
  return null;
}

// ── Tool Set Building ──

export interface BuildToolsOptions {
  userId?: string;
}

export async function buildChatTools(_opts: BuildToolsOptions): Promise<ToolSet> {
  const tools: ToolSet = {
    getCurrentDate: getCurrentDateTool,
    webSearch: webSearchTool,
    webScraper: webScraperTool,
    browse: browseTool,
    generateFile: generateFileTool,
  };

  return tools;
}

// ── Error Classification Helpers ──

export function classifyProviderError(errMsg: string, statusCode?: number): { isBilling: boolean; isAuth: boolean } {
  return {
    isBilling: BILLING_RE.test(errMsg) || statusCode === 402,
    isAuth: AUTH_RE.test(errMsg) || statusCode === 401 || statusCode === 403,
  };
}

export async function handleKeyExhaustion(keyId: string, provider: string, reason: string): Promise<void> {
  try {
    await markKeyCreditExhausted(keyId);
    log.chat.warn({ keyId, provider, reason }, 'Marked key as exhausted');
  } catch { /* ignore */ }
}

// ── Message Processing ──

export function processAndCompactMessages(
  messages: any[],
  platform: 'app' | 'telegram',
  modelContextTokens: number,
): { processedMessages: any[]; compactedMessages: any[] } {
  const processedMessages = processMessagesForPlatform(
    messages.filter(m => m && m.role).map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })),
    platform
  );

  // Simple token-budget trimming: keep newest messages that fit within 60% of context
  const historyBudget = Math.floor(modelContextTokens * 0.6);
  let tokenCount = 0;
  const compactedMessages: any[] = [];
  for (let i = processedMessages.length - 1; i >= 0; i--) {
    const msg = processedMessages[i];
    const content = typeof msg.content === 'string' ? msg.content : '';
    const msgTokens = estimateMessageTokens(msg.role || 'user', content);
    if (tokenCount + msgTokens > historyBudget) break;
    tokenCount += msgTokens;
    compactedMessages.unshift(msg);
  }

  return { processedMessages, compactedMessages };
}

// ── Context Window Check ──

export function checkContext(
  messages: any[],
  systemPrompt: string,
  modelContextTokens: number,
): { fits: boolean; estimatedTokens?: number; contextLimit?: number; usage?: number } {
  let totalTokens = estimateMessageTokens('system', systemPrompt);
  for (const msg of messages) {
    const content = typeof msg.content === 'string' ? msg.content : '';
    totalTokens += estimateMessageTokens(msg.role || 'user', content);
  }
  const usage = totalTokens / modelContextTokens;
  return {
    fits: totalTokens <= modelContextTokens,
    estimatedTokens: totalTokens,
    contextLimit: modelContextTokens,
    usage,
  };
}

// ── Tool Wrapping ──

export function wrapTools(tools: ToolSet, modelContextTokens: number): ToolSet {
  const toolResultBudget = getToolResultBudget(modelContextTokens);
  return wrapToolsWithTruncation(tools, toolResultBudget);
}

// ── Model Resolution ──

export async function resolveModelForChat(
  requestedModel: string | undefined,
  failedKeyIds?: Set<string>,
): Promise<Awaited<ReturnType<typeof resolveModel>> | null> {
  const clarityModelId = requestedModel || getDefaultClarityModel();
  let resolved = await resolveModel(clarityModelId, undefined, failedKeyIds?.size ? failedKeyIds : undefined);

  // Fallback to clarity-fast if primary model unavailable
  if (!resolved && clarityModelId !== 'clarity-fast') {
    log.chat.info('No providers for requested model, trying clarity-fast fallback');
    try {
      resolved = await resolveModel('clarity-fast');
    } catch { /* ignore */ }
  }

  return resolved;
}

export async function getModelContextWindow(clarityModelId: string): Promise<number> {
  const clarityModel = await getClarityModel(clarityModelId);
  if (!clarityModel) return 128_000;
  const tierMappings = await getModelMappingsForTier(clarityModel.tier);
  return (tierMappings[0]?.capabilities?.maxContextTokens as number) || 128_000;
}

// ── Before-Chat Hooks ──

export async function runPreChatHooks(params: {
  userId: string;
  conversationId?: string;
  messages: any[];
  model: string;
  skillId?: string;
  platform: 'app' | 'telegram';
}): Promise<RecalledMemory[] | undefined> {
  try {
    const hookResult = await runBeforeChatHooks({
      ...params,
      metadata: {},
    });
    const recalled = hookResult.metadata?.recalledMemories as RecalledMemory[] | undefined;
    if (recalled?.length) {
      log.chat.info({ recalled: recalled.length }, 'Memory recall');
    }
    return recalled;
  } catch (e) {
    log.chat.error({ err: e }, 'beforeChat hooks error');
    return undefined;
  }
}
