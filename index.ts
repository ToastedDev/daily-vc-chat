import { Client as DiscordClient, GatewayIntentBits } from "discord.js";
import { Masterchat, stringify } from "masterchat";
import index from "./index.html";
import type { ChatMessage, Message } from "./types";

const YOUTUBE_PLAYLIST_ID = "PLGVNE7EtnBD4mn5GZB5Rw6AIbdm7lXwcT";
const DISCORD_CHANNEL_ID = "1415867512398282813";

const clients = new Set<Bun.ServerWebSocket>();

let messageBuffer: ChatMessage[] = [];
const MAX_BUFFER_SIZE = 100;

function addToBuffer(message: ChatMessage) {
  messageBuffer.push(message);
  if (messageBuffer.length > MAX_BUFFER_SIZE) {
    messageBuffer.splice(0, messageBuffer.length - MAX_BUFFER_SIZE);
  }
}

function broadcastMessage(message: Message) {
  const payload = JSON.stringify(message);
  clients.forEach((client) => {
    client.send(payload);
  });
}

function removeFromBuffer(id: string) {
  messageBuffer = messageBuffer.filter((message) => message.id !== id);
}

function editInBuffer(id: string, content: string) {
  messageBuffer = messageBuffer.map((message) =>
    message.id === id ? { ...message, content, edited: true } : message
  );
}

function broadcastChatMessage(message: ChatMessage) {
  addToBuffer(message);
  broadcastMessage(message);
}

async function startDiscord() {
  const discord = new DiscordClient({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  discord.on("clientReady", () => {
    console.log("Discord bot is ready");
  });

  discord.on("messageCreate", (message) => {
    if (!message.inGuild() || message.channelId !== DISCORD_CHANNEL_ID) return;
    broadcastChatMessage({
      type: "message",
      platform: "discord",
      id: message.id,
      timestamp: message.createdTimestamp,
      author: {
        name: message.member?.displayName ?? message.author.displayName,
        avatar:
          message.member?.displayAvatarURL() ??
          message.author.displayAvatarURL(),
      },
      content: message.content,
      attachments: message.attachments.map((attachment) => attachment.url),
    });
  });

  discord.on("messageUpdate", (oldMessage, newMessage) => {
    if (
      !newMessage.inGuild() ||
      newMessage.channelId !== DISCORD_CHANNEL_ID ||
      !messageBuffer.find((m) => m.id === newMessage.id)
    )
      return;
    broadcastMessage({
      type: "edit",
      platform: "discord",
      id: newMessage.id,
      timestamp: newMessage.editedTimestamp!,
      content: newMessage.content,
    });
    editInBuffer(newMessage.id, newMessage.content);
  });

  discord.on("messageDelete", (message) => {
    if (!message.inGuild() || message.channelId !== DISCORD_CHANNEL_ID) return;
    broadcastMessage({
      type: "delete",
      platform: "discord",
      id: message.id,
    });
    removeFromBuffer(message.id);
  });

  discord.login(process.env.DISCORD_TOKEN);
}

async function fetchYouTube(
  url: string,
  params: Record<string, string> = {}
): Promise<any> {
  const query = new URLSearchParams(params);
  if (process.env.YOUTUBE_API_KEY) {
    query.set("key", process.env.YOUTUBE_API_KEY);
  }

  const response = await fetch(
    `${process.env.YOUTUBE_API_URL}/${url}?${query.toString()}`
  );
  return response.json();
}

async function getLatestStreamId(): Promise<string | undefined> {
  const streamIds = (await fetchYouTube("playlistItems", {
    playlistId: YOUTUBE_PLAYLIST_ID,
    part: "snippet",
    fields: "items/snippet/resourceId/videoId",
    maxResults: "50",
  }).then((data: any) =>
    data.items.map((item: any) => item.snippet.resourceId.videoId)
  )) as string[];

  const streams = await fetchYouTube("videos", {
    id: streamIds.join(","),
    part: "snippet",
  });
  return streams.items.find(
    (stream: any) =>
      stream.snippet.liveBroadcastContent === "live" ||
      stream.snippet.liveBroadcastContent === "upcoming"
  )?.id;
}

async function startMasterchat() {
  const currentStreamId = await getLatestStreamId();
  if (!currentStreamId) return;

  const masterchat = await Masterchat.init(currentStreamId, {
    credentials: process.env.YOUTUBE_TOKEN,
  });
  masterchat.on("actions", (actions) => {
    for (const action of actions) {
      switch (action.type) {
        case "addChatItemAction":
          {
            const chat = action;
            broadcastChatMessage({
              type: "message",
              platform: "youtube",
              id: chat.id,
              timestamp: chat.timestamp.getTime(),
              author: {
                name: chat.authorName ?? "Unknown",
                avatar: chat.authorPhoto,
              },
              content: stringify(chat.message!),
            });
          }
          break;
        case "markChatItemAsDeletedAction": {
          const chat = action;
          broadcastMessage({
            type: "delete",
            platform: "youtube",
            id: chat.targetId,
          });
          removeFromBuffer(chat.targetId);
        }
      }
    }
  });

  masterchat.listen({ ignoreFirstResponse: true });

  console.log("YouTube bot is ready");
}

await Promise.all([startDiscord(), startMasterchat()]);

const { hostname, port } = Bun.serve({
  routes: {
    "/*": index,
    "/ws": (req, server) => {
      const upgraded = server.upgrade(req);
      if (!upgraded) {
        return new Response("Upgrade failed", { status: 400 });
      }
    },
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      if (messageBuffer.length > 0) {
        ws.send(
          JSON.stringify({
            type: "history",
            messages: messageBuffer,
          })
        );
      }
    },
    message() {},
    close(ws) {
      clients.delete(ws);
    },
  },
  hostname: "0.0.0.0",
  port: 1111,
});
console.log(`Listening on http://${hostname}:${port}`);
