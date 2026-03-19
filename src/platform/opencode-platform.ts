import { createOpencodeClient, type OpencodeClient, type QuestionRequest } from '@opencode-ai/sdk/v2';
import {
  Platform,
  PlatformSession,
  PlatformEvent,
  PlatformEventType,
  CreateSessionOptions,
  ResumeSessionOptions,
  RunTurnOptions,
  TurnResult,
  PlatformConfig,
} from './types.js';
import { Logger } from '../logger.js';
import { OPENCODE_SERVER_PORT } from '../types.js';

const log = new Logger('opencode-platform');

interface ModelConfig {
  providerID: string;
  modelID: string;
}

interface ActiveSession {
  id: string;
  client: OpencodeClient;
  session: PlatformSession;
  model?: ModelConfig;
  agent?: string;
}

export class OpenCodePlatform implements Platform {
  readonly name = 'opencode';
  
  private serverPort: number;
  private sessions: Map<string, ActiveSession> = new Map();
  private defaultModel?: ModelConfig;
  private defaultAgent?: string;

  constructor(config: PlatformConfig) {
    this.serverPort = config.opencode?.server_port ?? OPENCODE_SERVER_PORT;
    
    // Parse model string into providerID/modelID format
    // Format: "provider/model" (e.g., "anthropic/claude-sonnet-4-20250514")
    if (config.opencode?.model) {
      const modelStr = config.opencode.model;
      const slashIndex = modelStr.indexOf('/');
      if (slashIndex > 0) {
        this.defaultModel = {
          providerID: modelStr.substring(0, slashIndex),
          modelID: modelStr.substring(slashIndex + 1),
        };
      } else {
        // If no slash, assume it's just a model ID with no specific provider
        // The OpenCode server will use the default provider
        log.warn('Model string should be in "provider/model" format', { model: modelStr });
      }
    }
    
    this.defaultAgent = config.opencode?.agent;
  }

  async createSession(options: CreateSessionOptions): Promise<string> {
    const serverUrl = `http://127.0.0.1:${this.serverPort}`;
    
    log.info('Creating OpenCode session', {
      serverUrl,
      workspacePath: options.workspacePath,
    });

    const client = createOpencodeClient({
      baseUrl: serverUrl,
      directory: options.workspacePath,
    });

    const response = await client.session.create();
    const sessionId = response.data?.id;

    if (!sessionId) {
      log.error('Session creation failed - no session ID', { response });
      throw new Error('Failed to create OpenCode session - no session ID returned');
    }

    const session: PlatformSession = {
      id: sessionId,
      workspacePath: options.workspacePath,
      createdAt: new Date(),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      turnCount: 0,
      lastEventType: null,
      lastEventTimestamp: null,
    };

    this.sessions.set(sessionId, { 
      id: sessionId, 
      client, 
      session,
      model: this.defaultModel,
      agent: this.defaultAgent,
    });

    log.info('OpenCode session created', { 
      sessionId, 
      model: this.defaultModel ? `${this.defaultModel.providerID}/${this.defaultModel.modelID}` : undefined,
      agent: this.defaultAgent,
    });
    return sessionId;
  }

  async resumeSession(options: ResumeSessionOptions): Promise<boolean> {
    const serverUrl = `http://127.0.0.1:${this.serverPort}`;

    log.info('Resuming OpenCode session', {
      sessionId: options.sessionId,
      serverUrl,
      workspacePath: options.workspacePath,
    });

    try {
      const client = createOpencodeClient({
        baseUrl: serverUrl,
        directory: options.workspacePath,
      });

      const session: PlatformSession = {
        id: options.sessionId,
        workspacePath: options.workspacePath,
        createdAt: new Date(),
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        turnCount: 0,
        lastEventType: null,
        lastEventTimestamp: null,
      };

      this.sessions.set(options.sessionId, { 
        id: options.sessionId, 
        client, 
        session,
        model: this.defaultModel,
        agent: this.defaultAgent,
      });

      return true;
    } catch (err) {
      log.error('Failed to resume session', { sessionId: options.sessionId, error: (err as Error).message });
      return false;
    }
  }

  async runTurn(sessionId: string, options: RunTurnOptions): Promise<TurnResult> {
    const activeSession = this.sessions.get(sessionId);
    if (!activeSession) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const { client, session, model, agent } = activeSession;
    const { prompt, timeoutMs, stallTimeoutMs, onEvent } = options;

    let lastActivityTime = Date.now();
    let completed = false;
    let needsInput = false;
    let inputPrompt: string | undefined;
    let inputContext: string | undefined;
    let error: string | undefined;

    const stallChecker = stallTimeoutMs > 0 ? setInterval(() => {
      const elapsed = Date.now() - lastActivityTime;
      if (elapsed > stallTimeoutMs) {
        log.warn('Session stalled', { sessionId, elapsed, stallTimeoutMs });
        error = `Session stalled after ${elapsed}ms of inactivity`;
      }
    }, 5000) : null;

    try {
      log.debug('Subscribing to event stream...', { sessionId });
      const eventStream = await client.event.subscribe();

      log.info('Sending prompt to session', {
        sessionId,
        promptLength: prompt.length,
        promptPreview: prompt.slice(0, 150) + (prompt.length > 150 ? '...' : ''),
        model: model ? `${model.providerID}/${model.modelID}` : undefined,
        agent,
      });

      const promptPromise = client.session.prompt({
        sessionID: sessionId,
        parts: [{ type: 'text', text: prompt }],
        model,
        agent,
        // When a model is explicitly set, override the agent's default variant
        // to prevent the server from appending suffixes like "-high" to the model ID
        ...(model ? { variant: '' } : {}),
      }).catch((err: Error) => {
        log.error('Prompt API call failed', { sessionId, error: err.message });
        throw err;
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Turn timed out after ${timeoutMs}ms`)), timeoutMs);
      });

      const processEvents = async () => {
        for await (const event of eventStream.stream) {
          if (error) break;

          lastActivityTime = Date.now();

          const platformEvent = this.mapEvent(sessionId, event);
          this.updateSessionFromEvent(session, platformEvent, event);
          onEvent(platformEvent);

          if (event.type === 'session.updated') {
            const status = (event as unknown as { properties?: { status?: { type?: string } } }).properties?.status;
            if (status?.type === 'idle') {
              log.info('Session completed (idle status)', { sessionId });
              completed = true;
              break;
            }
          }

          if (event.type === 'session.error') {
            const errorProps = (event as unknown as { properties?: { error?: { name?: string; message?: string } } }).properties;
            const errorName = errorProps?.error?.name;
            
            if (errorName === 'MessageAbortedError') {
              log.debug('Session aborted (expected during stall/cancel)', { sessionId, errorName });
              break;
            }
            
            error = errorProps?.error?.message ?? JSON.stringify(errorProps);
            log.error('Session error event received', { sessionId, error });
            break;
          }

          if (event.type === 'question.asked') {
            const questionEvent = event as unknown as { properties: QuestionRequest };
            const questionRequest = questionEvent.properties;

            if (questionRequest.questions.length > 0) {
              const firstQuestion = questionRequest.questions[0];
              inputPrompt = firstQuestion.question;
              inputContext = JSON.stringify({
                requestId: questionRequest.id,
                sessionId: questionRequest.sessionID,
                header: firstQuestion.header,
                options: firstQuestion.options,
                multiple: firstQuestion.multiple,
                custom: firstQuestion.custom,
                allQuestions: questionRequest.questions,
              });
              needsInput = true;
              log.info('Input required from user', { sessionId, prompt: inputPrompt });
              break;
            }
          }
        }
      };

      await Promise.race([
        Promise.all([processEvents(), promptPromise]),
        timeoutPromise,
      ]);

      session.turnCount++;

      return { completed, needsInput, error, inputPrompt, inputContext };

    } finally {
      if (stallChecker) clearInterval(stallChecker);
    }
  }

  async sendMessage(sessionId: string, message: string): Promise<boolean> {
    const activeSession = this.sessions.get(sessionId);
    if (!activeSession) {
      log.warn('Cannot send message - session not found', { sessionId });
      return false;
    }

    const { model, agent } = activeSession;
    log.info('Sending message to session', { sessionId, messageLength: message.length });

    activeSession.client.session.prompt({
      sessionID: sessionId,
      parts: [{ type: 'text', text: message }],
      model,
      agent,
      ...(model ? { variant: '' } : {}),
    }).catch((err: Error) => {
      log.error('Failed to send message to session', { sessionId, error: err.message });
    });

    return true;
  }

  async replyToQuestion(sessionId: string, questionId: string, answers: string[]): Promise<void> {
    const activeSession = this.sessions.get(sessionId);
    if (!activeSession) {
      throw new Error(`Session ${sessionId} not found`);
    }

    log.info('Replying to question', { sessionId, questionId });

    await activeSession.client.question.reply({
      requestID: questionId,
      answers: [answers],
    });
  }

  async abortSession(sessionId: string): Promise<void> {
    const activeSession = this.sessions.get(sessionId);
    if (!activeSession) {
      return;
    }

    try {
      await activeSession.client.session.abort({ sessionID: sessionId });
    } catch {
      // Ignore abort errors
    }

    this.sessions.delete(sessionId);
    log.info('Session aborted', { sessionId });
  }

  getSession(sessionId: string): PlatformSession | null {
    return this.sessions.get(sessionId)?.session ?? null;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const testClient = createOpencodeClient({
        baseUrl: `http://127.0.0.1:${this.serverPort}`,
        directory: process.cwd(),
      });
      
      // Try to list sessions as a health check
      await testClient.session.list();
      return true;
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    for (const [sessionId] of this.sessions) {
      await this.abortSession(sessionId);
    }
    this.sessions.clear();
  }

  private mapEvent(sessionId: string, event: { type: string }): PlatformEvent {
    const eventTypeMap: Record<string, PlatformEventType> = {
      'message.updated': 'message_updated',
      'message.completed': 'message_completed',
      'file.edited': 'file_edited',
      'session.updated': 'session_idle',
      'session.error': 'session_error',
      'step-finish': 'turn_completed',
      'question.asked': 'question_asked',
    };

    const platformEvent: PlatformEvent = {
      type: eventTypeMap[event.type] ?? 'unknown',
      timestamp: new Date(),
      sessionId,
      rawPayload: event,
    };

    const payload = event as unknown as { 
      properties?: { 
        parts?: Array<{ type: string; text?: string }>;
        path?: string;
        error?: { name?: string; message?: string };
      };
      tokens?: { input: number; output: number };
    };

    if (payload.tokens) {
      platformEvent.tokens = {
        input: payload.tokens.input,
        output: payload.tokens.output,
      };
    }

    if (payload.properties?.parts) {
      const textParts = payload.properties.parts.filter(p => p.type === 'text');
      if (textParts.length > 0) {
        platformEvent.messageContent = textParts.map(p => p.text ?? '').join('');
      }
    }

    if (payload.properties?.path) {
      platformEvent.filePath = payload.properties.path;
    }

    if (payload.properties?.error) {
      platformEvent.error = {
        name: payload.properties.error.name ?? 'UnknownError',
        message: payload.properties.error.message ?? 'Unknown error',
      };
    }

    return platformEvent;
  }

  private updateSessionFromEvent(
    session: PlatformSession,
    platformEvent: PlatformEvent,
    rawEvent: { type: string }
  ): void {
    session.lastEventType = platformEvent.type;
    session.lastEventTimestamp = platformEvent.timestamp;

    if (platformEvent.tokens) {
      session.inputTokens += platformEvent.tokens.input;
      session.outputTokens += platformEvent.tokens.output;
      session.totalTokens += platformEvent.tokens.input + platformEvent.tokens.output;
    }

    if (rawEvent.type === 'step-finish') {
      const stepFinish = rawEvent as unknown as { tokens?: { input: number; output: number } };
      if (stepFinish.tokens) {
        session.inputTokens += stepFinish.tokens.input;
        session.outputTokens += stepFinish.tokens.output;
        session.totalTokens += stepFinish.tokens.input + stepFinish.tokens.output;
      }
    }
  }
}
