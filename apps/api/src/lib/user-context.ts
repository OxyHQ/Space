/**
 * User Context Builder
 *
 * Shared utility for building user context (name, memory, preferences, language)
 * from Oxy user data and UserMemory. Used by both chat-completions and voice realtime.
 */

import { oxyClient } from '../middleware/auth.js';
import { log } from './logger.js';

export interface UserContext {
  userName: string | null;
  language: string | null;
  contextString: string;
}

/**
 * Build user context string from Oxy profile.
 * Returns the user's name and a context string.
 * User memory was removed during Clarity pruning.
 */
export async function buildUserContext(userId: string): Promise<UserContext> {
  let userName: string | null = null;
  const language: string | null = null;
  let contextString = '';

  // Fetch user name from Oxy
  try {
    const user = await oxyClient.getUserById(userId);
    userName = user?.name?.full || user?.name?.first || user?.username || null;
    if (userName) {
      contextString += `\nThe user's name is ${userName}.`;
    }
  } catch { /* user lookup optional */ }

  return { userName, language, contextString };
}
