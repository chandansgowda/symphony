import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import type { ChatMessage, ChatSession } from '../types.js';
import { api, createChatEventSource, ChatEventSourceController } from '../api.js';
import { safeMarkdown, generateListKey, buildSessionUrl } from '../utils/helpers.js';

interface ChatPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onOpen: () => void;
}

export function ChatPanel({ isOpen, onClose, onOpen }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [currentAssistantMessage, setCurrentAssistantMessage] = useState('');
  const [chatSession, setChatSession] = useState<ChatSession | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [queuedCount, setQueuedCount] = useState(0);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sseRef = useRef<ChatEventSourceController | null>(null);
  const messageQueueRef = useRef<string[]>([]);
  const isProcessingRef = useRef(false);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, currentAssistantMessage, scrollToBottom]);

  const processSingleMessage = useCallback(async (text: string) => {
    setIsGenerating(true);
    setCurrentAssistantMessage('');

    try {
      const response = await api.sendChatMessage(text);
      if (response?.message) {
        setCurrentAssistantMessage('');
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === 'assistant' && last.content === response.message) {
            return prev;
          }
          return [...prev, { role: 'assistant', content: response.message }];
        });
        if (response.sessionId) {
          setChatSession((prev) => ({ ...prev, sessionId: response.sessionId }));
        }
      }
    } catch (err) {
      console.error('Failed to send:', (err as Error).message);
      setCurrentAssistantMessage('');
    }
  }, []);

  const drainQueue = useCallback(async () => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;

    while (messageQueueRef.current.length > 0) {
      const next = messageQueueRef.current.shift()!;
      setQueuedCount(messageQueueRef.current.length);
      await processSingleMessage(next);
    }

    isProcessingRef.current = false;
    setIsGenerating(false);
  }, [processSingleMessage]);

  useEffect(() => {
    if (!isOpen) return;

    api.getChatHistory().then(setMessages).catch((err) => {
      console.error('Failed to fetch chat history:', (err as Error).message);
    });
    api.getChatSession().then(setChatSession).catch((err) => {
      console.error('Failed to fetch chat session:', (err as Error).message);
    });

    if (sseRef.current) sseRef.current.close();

    sseRef.current = createChatEventSource({
      onMessageStart: () => {
        setIsGenerating(true);
        setCurrentAssistantMessage('');
      },
      onMessageDelta: (content, sessionId) => {
        setCurrentAssistantMessage((prev) => prev + content);
        if (sessionId) {
          setChatSession((prev) => ({ ...prev, sessionId }));
        }
      },
      onMessageComplete: () => {
        setCurrentAssistantMessage((prev) => {
          const completedMessage = prev;
          if (completedMessage) {
            setMessages((msgs) => [...msgs, { role: 'assistant', content: completedMessage }]);
          }
          return '';
        });
        if (messageQueueRef.current.length === 0) {
          setIsGenerating(false);
        }
      },
      onError: (error) => {
        console.error('Chat error:', error);
        setIsGenerating(false);
        setCurrentAssistantMessage('');
        messageQueueRef.current = [];
        setQueuedCount(0);
        isProcessingRef.current = false;
      },
    });

    return () => {
      sseRef.current?.close();
      sseRef.current = null;
    };
  }, [isOpen]);

  const handleSend = useCallback(() => {
    const text = inputValue.trim();
    if (!text) return;

    // Always show the user's message immediately
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    setInputValue('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    messageQueueRef.current.push(text);
    setQueuedCount(messageQueueRef.current.length);
    drainQueue();
  }, [inputValue, drainQueue]);

  const handleNewChat = async () => {
    messageQueueRef.current = [];
    setQueuedCount(0);
    isProcessingRef.current = false;

    try {
      await api.resetChat();
      setMessages([]);
      setChatSession(null);
      setCurrentAssistantMessage('');
      setIsGenerating(false);
    } catch (err) {
      console.error('Failed to reset chat:', (err as Error).message);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextareaInput = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }
  };

  const sessionLink = chatSession?.sessionId && chatSession?.workspacePath
    ? buildSessionUrl(chatSession.serverPort ?? 4096, chatSession.workspacePath, chatSession.sessionId)
    : null;

  const isSendDisabled = !inputValue.trim();

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 z-40"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <div className={`fixed bottom-4 right-4 z-50 chat-container${isOpen ? ' chat-panel-open' : ''}`}>
        {isOpen && (
          <div
            className="chat-panel mb-3 rounded-xl shadow-2xl flex flex-col overflow-hidden active"
            style={{ 
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-primary)'
            }}
          >
          <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-blue-600 to-blue-700 text-white">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm">Symphony Chat</span>
              {sessionLink && (
                <a
                  href={sessionLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-200 hover:text-white text-xs underline"
                >
                  session
                </a>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleNewChat}
                className="px-2 py-1 text-xs bg-blue-500 hover:bg-blue-400 rounded transition-colors"
                title="New Chat"
              >
                + New
              </button>
              <button
                onClick={onClose}
                className="flex items-center justify-center w-7 h-7 rounded hover:bg-blue-500 transition-colors"
                title="Close"
                aria-label="Close chat"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>

          <div 
            className="flex-1 overflow-y-auto p-4 space-y-3"
            style={{ background: 'var(--bg-primary)' }}
          >
            {messages.length === 0 && !currentAssistantMessage && (
              <div 
                className="text-center text-sm mt-8"
                style={{ color: 'var(--text-muted)' }}
              >
                Ask Symphony anything...
              </div>
            )}
            {messages.map((msg, i) => (
              <div
                key={generateListKey(msg.content, i, 'chat-msg')}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                    msg.role === 'user'
                      ? 'bg-blue-600 text-white rounded-br-sm'
                      : 'rounded-bl-sm shadow-sm'
                  }`}
                  style={msg.role === 'assistant' ? {
                    background: 'var(--bg-secondary)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border-primary)'
                  } : undefined}
                  {...(msg.role === 'assistant'
                    ? {
                        dangerouslySetInnerHTML: {
                          __html: safeMarkdown(msg.content),
                        },
                      }
                    : { children: msg.content })}
                />
              </div>
            ))}
            {currentAssistantMessage && (
              <div className="flex justify-start">
                <div
                  className="max-w-[85%] rounded-lg px-3 py-2 text-sm rounded-bl-sm shadow-sm"
                  style={{
                    background: 'var(--bg-secondary)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border-primary)'
                  }}
                  dangerouslySetInnerHTML={{
                    __html: safeMarkdown(currentAssistantMessage),
                  }}
                />
              </div>
            )}
            {isGenerating && !currentAssistantMessage && (
              <div className="flex justify-start">
                <div 
                  className="rounded-lg px-4 py-3 shadow-sm flex gap-1.5"
                  style={{
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-primary)'
                  }}
                >
                  <span
                    className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
                    style={{ animationDelay: '0ms' }}
                  />
                  <span
                    className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
                    style={{ animationDelay: '150ms' }}
                  />
                  <span
                    className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
                    style={{ animationDelay: '300ms' }}
                  />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div 
            className="p-3"
            style={{
              borderTop: '1px solid var(--border-primary)',
              background: 'var(--bg-secondary)'
            }}
          >
            {queuedCount > 0 && (
              <div
                className="text-xs mb-2 px-1"
                style={{ color: 'var(--text-muted)' }}
              >
                {queuedCount} message{queuedCount > 1 ? 's' : ''} queued
              </div>
            )}
            <div className="flex gap-2 items-end">
              <textarea
                ref={textareaRef}
                value={inputValue}
                onInput={(e) => {
                  setInputValue((e.target as HTMLTextAreaElement).value);
                  handleTextareaInput();
                }}
                onKeyDown={handleKeyDown}
                placeholder="Type a message..."
                rows={1}
                className="flex-1 resize-none rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                style={{ 
                  maxHeight: '120px',
                  border: '1px solid var(--border-primary)',
                  background: 'var(--bg-input)',
                  color: 'var(--text-primary)'
                }}
              />
              <button
                onClick={handleSend}
                disabled={isSendDisabled}
                className={`p-2 rounded-lg transition-colors ${
                  isSendDisabled
                    ? 'cursor-not-allowed'
                    : 'bg-blue-600 hover:bg-blue-700 text-white'
                }`}
                style={isSendDisabled ? {
                  background: 'var(--bg-tertiary)',
                  color: 'var(--text-muted)'
                } : undefined}
                title={isGenerating ? 'Queue message' : 'Send'}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

        <button
          onClick={() => {
            if (isOpen) {
              onClose();
            } else {
              onOpen();
            }
          }}
          className="chat-fab ml-auto flex items-center justify-center rounded-full shadow-lg transition-all hover:scale-105"
          style={{
            width: '56px',
            height: '56px',
            background: 'linear-gradient(135deg, #3b82f6, #2563eb)',
          }}
          title={isOpen ? 'Close chat' : 'Open chat'}
        >
        {isOpen ? (
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        ) : (
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        )}
      </button>
      </div>
    </>
  );
}
