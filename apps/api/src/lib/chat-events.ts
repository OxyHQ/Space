export const CHAT_EVENT_VERSION = 1;

export type OxySpaceChatEventName =
  | 'oxyspace.reasoning'
  | 'oxyspace.tool_result'
  | 'oxyspace.title'
  | 'oxyspace.agent';
