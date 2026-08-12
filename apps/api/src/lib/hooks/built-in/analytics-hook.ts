import { registerHook } from '../hook-runner.js';
import { getDb } from '../../../db/client.js';
import { recordChatAnalytics } from '../../../repositories/chatAnalytics.js';
import { log } from '../../logger.js';

registerHook({
  name: 'analytics',
  afterChat: async (ctx) => {
    if (!ctx.userId) return;
    try {
      await recordChatAnalytics(getDb(), {
        oxyUserId: ctx.userId,
        conversationId: ctx.conversationId,
        model: ctx.modelUsed,
        clarityModelId: ctx.model,
        provider: ctx.metadata.provider || 'unknown',
        promptTokens: ctx.tokenUsage.promptTokens,
        completionTokens: ctx.tokenUsage.completionTokens,
        totalTokens: ctx.tokenUsage.totalTokens,
        latencyMs: ctx.latencyMs,
        platform: ctx.platform,
        skillId: ctx.skillId,
      });
    } catch (error) {
      log.chat.error({ err: error }, 'Error saving analytics');
    }
  },
});
