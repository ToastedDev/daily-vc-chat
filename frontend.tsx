import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import type {
  ChatMessage,
  DeletedMessage,
  DiscordEditedMessage,
  HistoryMessage,
  Message,
} from "./types";

type ConnectionState = "connecting" | "connected" | "disconnected";

interface ChatState {
  messages: ChatMessage[];
}

type ChatAction =
  | { type: "history"; payload: ChatMessage[] }
  | { type: "add-message"; payload: ChatMessage }
  | { type: "edit"; payload: DiscordEditedMessage }
  | { type: "delete"; payload: DeletedMessage };

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "history":
      return {
        messages: [...action.payload].sort((a, b) => a.timestamp - b.timestamp),
      };
    case "add-message": {
      const next = [...state.messages, action.payload];
      return {
        messages: next.slice(-100),
      };
    }
    case "edit": {
      const next = state.messages.map((m) =>
        m.id === action.payload.id
          ? { ...m, content: action.payload.content, edited: true }
          : m
      );
      return { messages: next };
    }
    case "delete": {
      const next = state.messages.filter(
        (m) =>
          !(
            m.platform === action.payload.platform && m.id === action.payload.id
          )
      );
      return { messages: next };
    }
    default:
      return state;
  }
}

const GROUP_WINDOW_MS = 5 * 60 * 1000;

interface MessageGroup {
  id: string;
  first: ChatMessage;
  messages: ChatMessage[];
}

function groupMessages(messages: ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let current: MessageGroup | null = null;

  for (const message of messages) {
    if (!current) {
      current = {
        id: message.id,
        first: message,
        messages: [message],
      };
      groups.push(current);
      continue;
    }

    const last: ChatMessage | undefined =
      current.messages[current.messages.length - 1];
    if (!last) {
      continue;
    }

    const sameAuthor =
      message.platform === last.platform &&
      message.author.name === last.author.name;
    const withinWindow =
      Math.abs(current?.first.timestamp - message.timestamp) <= GROUP_WINDOW_MS;

    if (sameAuthor && withinWindow) {
      current.messages.push(message);
    } else {
      current = {
        id: message.id,
        first: message,
        messages: [message],
      };
      groups.push(current);
    }
  }

  return groups;
}

function formatTime(timestamp: number) {
  const d = new Date(timestamp);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function useChatSocket(onMessage: (msg: Message) => void) {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const pingIntervalRef = useRef<number | null>(null);
  const retryRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    function cleanupSocket() {
      if (socketRef.current) {
        socketRef.current.onopen = null;
        socketRef.current.onclose = null;
        socketRef.current.onmessage = null;
        socketRef.current.onerror = null;
        socketRef.current.close();
        socketRef.current = null;
      }
    }

    function cleanupPing() {
      if (pingIntervalRef.current !== null) {
        window.clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
    }

    function connect() {
      if (cancelled) return;

      cleanupSocket();
      cleanupPing();
      setConnectionState("connecting");

      const url = new URL("/ws", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

      const ws = new WebSocket(url.toString());
      socketRef.current = ws;
      const connectStartedAt = performance.now();

      ws.onopen = () => {
        if (cancelled) return;
        setConnectionState("connected");
        setRetryCount(0);
        setLatencyMs(Math.round(performance.now() - connectStartedAt));

        // lightweight synthetic ping to keep a rough sense of latency
        const interval = window.setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const before = performance.now();
          try {
            ws.send('{"type":"ping"}');
          } catch {
            return;
          }
          setLatencyMs(Math.round(performance.now() - before));
        }, 15000);
        pingIntervalRef.current = interval;
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string) as Message;
          if ((data as any).type === "ping") {
            return;
          }
          onMessage(data);
        } catch {
          // ignore malformed payloads
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        cleanupPing();
        setConnectionState("disconnected");
        retryRef.current += 1;
        setRetryCount(retryRef.current);
        const baseDelay = Math.min(5000, 500 * retryRef.current);
        const jitter = Math.random() * 400;
        window.setTimeout(connect, baseDelay + jitter);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      cancelled = true;
      cleanupPing();
      cleanupSocket();
    };
  }, [onMessage]);

  return { connectionState, latencyMs, retryCount };
}

const App: React.FC = () => {
  const [state, dispatch] = useReducer(chatReducer, { messages: [] });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const isNearBottomRef = useRef(true);

  const handleIncoming = useCallback((msg: Message) => {
    if (msg.type === "history") {
      dispatch({ type: "history", payload: (msg as HistoryMessage).messages });
      return;
    }
    if (msg.type === "message") {
      dispatch({ type: "add-message", payload: msg as ChatMessage });
      return;
    }
    if (msg.type === "edit") {
      dispatch({ type: "edit", payload: msg as DiscordEditedMessage });
      return;
    }
    if (msg.type === "delete") {
      dispatch({
        type: "delete",
        payload: msg as DeletedMessage,
      });
    }
  }, []);

  const { connectionState, latencyMs, retryCount } =
    useChatSocket(handleIncoming);

  const grouped = useMemo(
    () => groupMessages(state.messages),
    [state.messages]
  );

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || !isNearBottomRef.current) return;
    container.scrollTop = container.scrollHeight;
  }, [state.messages]);

  const handleScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    const threshold = 80;
    const distanceToBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    isNearBottomRef.current = distanceToBottom <= threshold;
  };

  const hasMessages = state.messages.length > 0;

  return (
    <div className="app-shell">
      <div className="app-shell-inner">
        <div className="connection-indicator-minimal" title="Connection status">
          <span
            className={
              "connection-dot " +
              (connectionState === "connected"
                ? "connection-dot--ok"
                : connectionState === "connecting"
                ? "connection-dot--connecting"
                : "connection-dot--down")
            }
          />
          {latencyMs != null && <span>{`${latencyMs}ms`}</span>}
        </div>
        <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
          <>
            {!hasMessages && (
              <div className="chat-empty-state">
                <div className="chat-empty-orbit">
                  <div className="chat-empty-dot" />
                </div>
                <div className="chat-empty-text-strong">
                  Waiting for the first message.
                </div>
                <div className="chat-empty-text-soft">
                  As soon as someone speaks, it appears here.
                </div>
              </div>
            )}

            {hasMessages && (
              <>
                {grouped.map((group) => (
                  <MessageGroupRow key={group.id} group={group} />
                ))}
              </>
            )}
          </>
        </div>

        {connectionState === "disconnected" && (
          <div className="toast-reconnect">
            <span className="toast-reconnect-dot" />
            <span>
              {`Connection lost. Retrying${
                retryCount > 1 ? ` (x${retryCount})` : ""
              }…`}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

interface MessageGroupRowProps {
  group: MessageGroup;
}

const MessageGroupRow: React.FC<MessageGroupRowProps> = ({ group }) => {
  const { first, messages } = group;

  const platformClass =
    first.platform === "youtube"
      ? "message-platform-pill message-platform-pill--youtube"
      : "message-platform-pill message-platform-pill--discord";

  return (
    <div className="message-group">
      {messages.map((msg, index) =>
        index === 0 ? (
          <div key={msg.id} className="message-row message-row--lead">
            <div className="message-avatar-col">
              <div className="message-avatar">
                <img src={first.author.avatar} alt={first.author.name} />
              </div>
            </div>
            <div className="message-body">
              <div className="message-meta-row">
                <span className="message-author">{first.author.name}</span>
                <span className="message-timestamp">
                  {formatTime(first.timestamp)}
                </span>
                <span className={platformClass}>
                  {first.platform === "youtube" ? "YouTube" : "Discord"}
                </span>
              </div>
              <div className="message-line">
                {msg.content}
                {msg.platform === "discord" && msg.edited && (
                  <small className="message-edited">(edited)</small>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div key={msg.id} className="message-row message-row--cont">
            <div className="message-avatar-col">
              <span className="message-cont-time">
                {formatTime(msg.timestamp)}
              </span>
            </div>
            <div className="message-body">
              <div className="message-line">
                {msg.content}
                {msg.platform === "discord" && msg.edited && (
                  <small className="message-edited">(edited)</small>
                )}
              </div>
            </div>
          </div>
        )
      )}
    </div>
  );
};

const container = document.getElementById("root");
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
