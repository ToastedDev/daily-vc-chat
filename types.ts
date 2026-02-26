export type Message =
  | ChatMessage
  | DeletedMessage
  | HistoryMessage
  | DiscordEditedMessage;

export type ChatMessage = YouTubeMessage | DiscordMessage;

export interface YouTubeMessage {
  type: "message";
  platform: "youtube";
  id: string;
  timestamp: number;
  author: {
    name: string;
    avatar: string;
  };
  content: string;
}

export interface HistoryMessage {
  type: "history";
  messages: ChatMessage[];
}

export interface DiscordMessage {
  type: "message";
  platform: "discord";
  id: string;
  timestamp: number;
  author: {
    name: string;
    avatar: string;
  };
  content: string;
  attachments: string[];
  edited?: boolean;
}

export interface DiscordEditedMessage {
  type: "edit";
  platform: "discord";
  id: string;
  timestamp: number;
  content: string;
}

export interface DeletedMessage {
  type: "delete";
  platform: "discord" | "youtube";
  id: string;
}
