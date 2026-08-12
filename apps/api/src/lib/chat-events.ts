export const CHAT_EVENT_VERSION = 1;

export type OxyStationChatEventName =
  | 'oxystation.reasoning'
  | 'oxystation.tool_result'
  | 'oxystation.title'
  | 'oxystation.agent';
