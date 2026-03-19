import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2';
import { OPENCODE_SERVER_PORT } from './types.js';
import { WorkflowStore } from './workflow-store.js';
import { Logger } from './logger.js';
import { Liquid } from 'liquidjs';
import path from 'path';

const log = new Logger('chat-manager');

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface ChatResponse {
  message: string;
  sessionId: string;
}

export type ChatEventCallback = (event: ChatEvent) => void;

export interface ChatEvent {
  type: 'message_start' | 'message_delta' | 'message_complete' | 'error';
  content?: string;
  sessionId?: string;
  error?: string;
}

interface ModelConfig {
  providerID: string;
  modelID: string;
}

export class ChatManager {
  private client: OpencodeClient | null = null;
  private sessionId: string | null = null;
  private workflowStore: WorkflowStore;
  private workspacePath: string;
  private messageHistory: ChatMessage[] = [];
  private isProcessing = false;
  private liquid: Liquid;
  private modelConfig: ModelConfig | undefined;

  constructor(options: {
    workflowStore: WorkflowStore;
    dataDir: string;
  }) {
    this.workflowStore = options.workflowStore;
    this.liquid = new Liquid();
    this.workspacePath = path.resolve(process.cwd());
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  isReady(): boolean {
    return this.client !== null && this.sessionId !== null;
  }

  getHistory(): ChatMessage[] {
    return [...this.messageHistory];
  }

  private async ensureSession(): Promise<void> {
    if (this.client && this.sessionId) {
      // Session already exists
      return;
    }

    const serverUrl = `http://127.0.0.1:${OPENCODE_SERVER_PORT}`;
    log.info('Creating chat session', { serverUrl, workspacePath: this.workspacePath });

    this.client = createOpencodeClient({
      baseUrl: serverUrl,
      directory: this.workspacePath,
    });

    const sessionResponse = await this.client.session.create();
    this.sessionId = sessionResponse.data?.id ?? null;

    if (!this.sessionId) {
      throw new Error('Failed to create chat session');
    }

    log.info('Chat session created', { sessionId: this.sessionId });
  }

  private async getChatWorkflowConfig(): Promise<{ template: string; model?: ModelConfig }> {
    const workflow = await this.workflowStore.getWorkflow('chat');
    if (!workflow) {
      return { template: '{{ message }}' };
    }

    let model: ModelConfig | undefined;
    const opencode = workflow.config?.opencode as { model?: string } | undefined;
    if (opencode?.model) {
      const slashIndex = opencode.model.indexOf('/');
      if (slashIndex > 0) {
        model = {
          providerID: opencode.model.substring(0, slashIndex),
          modelID: opencode.model.substring(slashIndex + 1),
        };
      }
    }

    return { template: workflow.promptTemplate, model };
  }

  async sendMessage(message: string, onEvent?: ChatEventCallback): Promise<ChatResponse> {
    if (this.isProcessing) {
      throw new Error('Chat is currently processing a message');
    }

    this.isProcessing = true;

    try {
      await this.ensureSession();

      if (!this.client || !this.sessionId) {
        throw new Error('Failed to establish chat session');
      }

      const { template, model } = await this.getChatWorkflowConfig();
      this.modelConfig = model;
      
      const allWorkflows = await this.workflowStore.listWorkflows();
      const workflowsForTemplate = allWorkflows.map(w => ({
        id: w.id,
        name: w.name,
        description: w.description ?? 'No description',
      }));
      
      const renderedPrompt = await this.liquid.parseAndRender(template, { 
        message,
        workflows: workflowsForTemplate,
      });
      
      if (model) {
        log.info('Using chat workflow model', { model: `${model.providerID}/${model.modelID}` });
      }

      // Store user message in history
      this.messageHistory.push({
        role: 'user',
        content: message,
        timestamp: new Date(),
      });

      log.info('Sending chat message', { 
        sessionId: this.sessionId, 
        messageLength: message.length,
      });

      // Notify start
      if (onEvent) {
        onEvent({ type: 'message_start', sessionId: this.sessionId ?? undefined });
      }

      // Subscribe to events first
      const eventStream = await this.client.event.subscribe();

      // Send the prompt
      const promptPromise = this.client.session.prompt({
        sessionID: this.sessionId,
        parts: [{ type: 'text', text: renderedPrompt }],
        model: this.modelConfig,
      });

      let responseContent = '';
      let completed = false;

      const timeoutMs = 120000;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Chat response timed out after ${timeoutMs}ms`)), timeoutMs);
      });

      const processEvents = async () => {
        try {
          for await (const event of eventStream.stream) {
            if (completed) break;

            log.debug('Chat event received', { type: event.type, event: JSON.stringify(event).slice(0, 500) });

            if (event.type === 'message.updated') {
              const payload = event as unknown as { 
                properties?: { 
                  parts?: Array<{ type: string; text?: string; toolName?: string }>;
                  role?: string;
                } 
              };
              
              if (payload.properties?.role === 'assistant') {
                const textParts = payload.properties.parts?.filter(p => p.type === 'text') ?? [];
                const newContent = textParts.map(p => p.text ?? '').join('');
                
                const toolParts = payload.properties.parts?.filter(p => p.type === 'tool_use') ?? [];
                if (toolParts.length > 0) {
                  log.debug('Tool usage detected', { tools: toolParts.map(p => p.toolName) });
                }
                
                if (newContent.length > responseContent.length) {
                  const delta = newContent.slice(responseContent.length);
                  responseContent = newContent;
                  
                  if (onEvent) {
                    onEvent({ type: 'message_delta', content: delta, sessionId: this.sessionId ?? undefined });
                  }
                }
              }
            }

            if (event.type === 'session.updated') {
              const status = (event as unknown as { properties?: { status?: { type?: string } } }).properties?.status;
              log.debug('Session status update', { statusType: status?.type });
              if (status?.type === 'idle') {
                completed = true;
                break;
              }
            }

            if (event.type === 'session.error') {
              const errorProps = (event as unknown as { properties?: { error?: { message?: string } } }).properties;
              const errorMessage = errorProps?.error?.message ?? 'Session error';
              
              log.error('Session error event received', { 
                sessionId: this.sessionId,
                error: errorMessage,
              });
              
              if (onEvent) {
                onEvent({ 
                  type: 'error', 
                  error: errorMessage,
                  sessionId: this.sessionId ?? undefined,
                });
              }
              
              completed = true;
              break;
            }
          }
        } catch (err) {
          log.error('Event processing failed', { 
            sessionId: this.sessionId,
            error: (err as Error).message,
            stack: (err as Error).stack,
          });
          
          if (onEvent) {
            onEvent({ 
              type: 'error', 
              error: (err as Error).message,
              sessionId: this.sessionId ?? undefined,
            });
          }
          
          completed = true;
        }
      };

      const eventProcessingPromise = processEvents();

      // promptPromise returns complete response when agent finishes - use as primary completion signal
      const promptResult = await Promise.race([
        promptPromise,
        timeoutPromise,
      ]);

      completed = true;

      if (promptResult.data) {
        const parts = promptResult.data.parts ?? [];
        const textParts = parts.filter((p: { type: string }) => p.type === 'text');
        const finalContent = textParts.map((p: { type: string; text?: string }) => p.text ?? '').join('');
        
        if (finalContent.length > responseContent.length) {
          const delta = finalContent.slice(responseContent.length);
          responseContent = finalContent;
          
          if (onEvent && delta) {
            onEvent({ type: 'message_delta', content: delta, sessionId: this.sessionId ?? undefined });
          }
        }
      }

      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      try {
        await eventStream.stream.return?.(undefined);
      } catch (_streamCloseErr) {}

      eventProcessingPromise.catch(() => {});

      this.messageHistory.push({
        role: 'assistant',
        content: responseContent,
        timestamp: new Date(),
      });

      if (onEvent) {
        onEvent({ type: 'message_complete', content: responseContent, sessionId: this.sessionId ?? undefined });
      }

      log.info('Chat response received', { 
        sessionId: this.sessionId, 
        responseLength: responseContent.length,
      });

      return {
        message: responseContent,
        sessionId: this.sessionId,
      };

    } catch (err) {
      const error = (err as Error).message;
      log.error('Chat message failed', { error });
      
      if (onEvent) {
        onEvent({ type: 'error', error });
      }

      // Clear session on error to force recreation
      this.sessionId = null;
      this.client = null;

      throw err;
    } finally {
      this.isProcessing = false;
    }
  }

  async resetSession(): Promise<void> {
    log.info('Resetting chat session', { sessionId: this.sessionId });
    
    if (this.client && this.sessionId) {
      try {
        await this.client.session.abort({ sessionID: this.sessionId });
      } catch (err) {
        log.debug('Failed to abort chat session during cleanup', {
          sessionId: this.sessionId,
          error: (err as Error).message,
        });
      }
    }

    this.client = null;
    this.sessionId = null;
    this.messageHistory = [];
  }

  close(): void {
    this.resetSession();
  }
}
