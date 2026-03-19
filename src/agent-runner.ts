import { Issue, LiveSession, AgentEvent, AgentEventType, InputRequest, DEFAULTS, OPENCODE_SERVER_PORT } from './types.js';
import { ServiceConfig } from './config.js';
import { renderPrompt, getDefaultPrompt, getContinuationPrompt } from './prompt-renderer.js';
import { Logger } from './logger.js';
import { Platform, PlatformEvent, PlatformEventType, createPlatform, PlatformConfig } from './platform/index.js';

const log = new Logger('agent-runner');

export type WaitForInputFn = (request: InputRequest) => Promise<string>;

export interface AgentRunnerOptions {
  issue: Issue;
  workspacePath: string;
  promptTemplate: string;
  attempt: number | null;
  config: ServiceConfig;
  onEvent: (event: AgentEvent) => void;
  signal: AbortSignal;
  waitForInput?: WaitForInputFn;
  platform?: Platform;
  platformConfig?: PlatformConfig;
}

export interface AgentRunResult {
  success: boolean;
  turnCount: number;
  error?: string;
  session: LiveSession | null;
}

export class AgentRunner {
  private platform: Platform | null = null;
  private sessionId: string | null = null;
  private aborted = false;
  private gracefulShutdown = false;

  getPlatform(): Platform | null {
    return this.platform;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async sendMessage(message: string): Promise<boolean> {
    if (!this.platform || !this.sessionId) {
      log.warn('Cannot send message - no active session');
      return false;
    }

    return this.platform.sendMessage(this.sessionId, message);
  }

  async resumeSession(options: {
    sessionId: string;
    workspacePath: string;
    config: ServiceConfig;
    onEvent: (event: AgentEvent) => void;
    signal: AbortSignal;
    platform?: Platform;
    platformConfig?: PlatformConfig;
  }): Promise<boolean> {
    const { sessionId, workspacePath, config, onEvent, signal, platform, platformConfig } = options;

    try {
      signal.addEventListener('abort', () => {
        this.gracefulShutdown = true;
        this.aborted = true;
        this.cleanup();
      });

      this.platform = platform ?? this.createDefaultPlatform(config, platformConfig);

      log.info('Resuming session', { 
        sessionId, 
        workspacePath, 
        platform: this.platform.name 
      });

      const resumed = await this.platform.resumeSession({
        sessionId,
        workspacePath,
      });

      if (!resumed) {
        log.error('Platform failed to resume session', { sessionId });
        return false;
      }

      this.sessionId = sessionId;

      onEvent({
        type: 'session_started',
        timestamp: new Date(),
        sessionId: this.sessionId,
      });

      const continueMessage = 'Continue working on this issue. Pick up where you left off.';
      
      log.info('Sending continue prompt to resumed session', { sessionId });
      
      this.platform.sendMessage(sessionId, continueMessage).catch(err => {
        log.warn('Resume prompt failed (session may have ended)', { sessionId, error: (err as Error).message });
      });

      return true;
    } catch (err) {
      log.error('Failed to resume session', { sessionId, error: (err as Error).message });
      return false;
    }
  }

  async run(options: AgentRunnerOptions): Promise<AgentRunResult> {
    const { issue, workspacePath, promptTemplate, attempt, config, onEvent, signal, waitForInput, platform, platformConfig } = options;

    let turnCount = 0;
    let session: LiveSession | null = null;

    try {
      signal.addEventListener('abort', () => {
        this.gracefulShutdown = true;
        this.aborted = true;
        this.cleanup();
      });

      this.platform = platform ?? this.createDefaultPlatform(config, platformConfig);

      log.info('Creating agent session', {
        platform: this.platform.name,
        directory: workspacePath,
      });

      const template = promptTemplate || getDefaultPrompt();
      const renderedPrompt = await renderPrompt(template, { issue, attempt });

      log.info('Starting agent session', {
        issueId: issue.id,
        identifier: issue.identifier,
        workspacePath,
        platform: this.platform.name,
        promptLength: renderedPrompt.length,
        promptPreview: renderedPrompt.slice(0, 200) + (renderedPrompt.length > 200 ? '...' : ''),
      });

      this.sessionId = await this.platform.createSession({ workspacePath });
      
      if (!this.sessionId) {
        throw new Error('Failed to create session - no session ID returned');
      }
      
      session = this.createLiveSession(this.sessionId, this.platform.name);

      onEvent({
        type: 'session_started',
        timestamp: new Date(),
        sessionId: this.sessionId,
      });

      const maxTurns = DEFAULTS.agent.maxTurns;
      let continueLoop = true;

      while (continueLoop && turnCount < maxTurns && !this.aborted) {
        turnCount++;
        const isFirstTurn = turnCount === 1;

        const prompt = isFirstTurn ? renderedPrompt : getContinuationPrompt(turnCount);

        log.debug('Starting turn', {
          sessionId: this.sessionId,
          turn: turnCount,
          isFirstTurn,
        });

        try {
          const turnResult = await this.runTurn(prompt, config, session, onEvent);

          if (turnResult.completed) {
            continueLoop = false;
          } else if (turnResult.needsInput) {
            onEvent({
              type: 'turn_input_required',
              timestamp: new Date(),
              sessionId: this.sessionId,
            });

            if (waitForInput) {
              log.info('Waiting for user input', { issueId: issue.id, sessionId: this.sessionId });
              
              const inputRequest: InputRequest = {
                issueId: issue.id,
                issueIdentifier: issue.identifier,
                sessionId: this.sessionId!,
                requestedAt: new Date(),
                prompt: turnResult.inputPrompt,
                context: turnResult.inputContext,
              };

              try {
                const userInput = await waitForInput(inputRequest);
                log.info('Received user input', { issueId: issue.id, inputLength: userInput.length });
                
                let context: { requestId?: string } = {};
                try {
                  if (turnResult.inputContext) context = JSON.parse(turnResult.inputContext);
                } catch {}

                if (context.requestId && this.platform) {
                  log.info('Replying to question', { requestId: context.requestId });
                  await this.platform.replyToQuestion(this.sessionId!, context.requestId, [userInput]);
                  
                  const inputTurnResult = await this.runTurn('', config, session, onEvent);
                  
                  if (inputTurnResult.completed) {
                    continueLoop = false;
                  } else if (inputTurnResult.error) {
                    return {
                      success: false,
                      turnCount,
                      error: inputTurnResult.error,
                      session,
                    };
                  }
                } else {
                  log.warn('No question requestId found, sending as regular prompt');
                  const inputTurnResult = await this.runTurn(userInput, config, session, onEvent);
                  
                  if (inputTurnResult.completed) {
                    continueLoop = false;
                  } else if (inputTurnResult.error) {
                    return {
                      success: false,
                      turnCount,
                      error: inputTurnResult.error,
                      session,
                    };
                  }
                }
              } catch (inputErr) {
                log.error('Failed waiting for input', { error: (inputErr as Error).message });
                return {
                  success: false,
                  turnCount,
                  error: `Input wait failed: ${(inputErr as Error).message}`,
                  session,
                };
              }
            } else {
              log.warn('Input required but no waitForInput handler provided', { issueId: issue.id });
              continueLoop = false;
            }
          } else if (turnResult.error) {
            onEvent({
              type: 'turn_failed',
              timestamp: new Date(),
              sessionId: this.sessionId,
              payload: { error: turnResult.error },
            });
            return {
              success: false,
              turnCount,
              error: turnResult.error,
              session,
            };
          }

          if (this.gracefulShutdown) {
            continueLoop = false;
          }
        } catch (err) {
          const errorMessage = (err as Error).message;
          log.error('Turn failed', { error: errorMessage, turn: turnCount });

          onEvent({
            type: 'turn_failed',
            timestamp: new Date(),
            sessionId: this.sessionId,
            payload: { error: errorMessage },
          });

          return {
            success: false,
            turnCount,
            error: errorMessage,
            session,
          };
        }
      }

      if (this.aborted) {
        onEvent({
          type: 'turn_cancelled',
          timestamp: new Date(),
          sessionId: this.sessionId,
        });

        return {
          success: false,
          turnCount,
          error: 'Aborted',
          session,
        };
      }

      onEvent({
        type: 'turn_completed',
        timestamp: new Date(),
        sessionId: this.sessionId,
        usage: session ? {
          inputTokens: session.inputTokens,
          outputTokens: session.outputTokens,
          totalTokens: session.totalTokens,
        } : undefined,
      });

      return {
        success: true,
        turnCount,
        session,
      };

    } catch (err) {
      const errorMessage = (err as Error).message;
      log.error('Agent run failed', { error: errorMessage });

      onEvent({
        type: 'startup_failed',
        timestamp: new Date(),
        payload: { error: errorMessage },
      });

      return {
        success: false,
        turnCount,
        error: errorMessage,
        session,
      };
    } finally {
      await this.cleanup();
    }
  }

  private async runTurn(
    prompt: string,
    config: ServiceConfig,
    session: LiveSession | null,
    onEvent: (event: AgentEvent) => void
  ): Promise<{ completed: boolean; needsInput: boolean; error?: string; inputPrompt?: string; inputContext?: string }> {
    if (!this.platform || !this.sessionId) {
      throw new Error('Platform or session not initialized');
    }

    const handlePlatformEvent = (platformEvent: PlatformEvent) => {
      if (session) {
        session.lastEvent = platformEvent.type;
        session.lastEventTimestamp = platformEvent.timestamp;
        
        if (platformEvent.tokens) {
          session.inputTokens += platformEvent.tokens.input;
          session.outputTokens += platformEvent.tokens.output;
          session.totalTokens += platformEvent.tokens.input + platformEvent.tokens.output;
        }
      }

      const agentEvent: AgentEvent = {
        type: this.mapPlatformEventToAgentEvent(platformEvent.type),
        timestamp: platformEvent.timestamp,
        sessionId: platformEvent.sessionId,
        payload: platformEvent.rawPayload,
      };

      onEvent(agentEvent);
    };

    const result = await this.platform.runTurn(this.sessionId, {
      prompt,
      timeoutMs: config.turnTimeoutMs,
      stallTimeoutMs: config.stallTimeoutMs,
      onEvent: handlePlatformEvent,
    });

    return {
      completed: result.completed,
      needsInput: result.needsInput,
      error: result.error,
      inputPrompt: result.inputPrompt,
      inputContext: result.inputContext,
    };
  }

  private mapPlatformEventToAgentEvent(platformEventType: PlatformEventType): AgentEventType {
    const mapping: Record<PlatformEventType, AgentEventType> = {
      'session_started': 'session_started',
      'session_idle': 'session_updated',
      'session_error': 'session_error',
      'message_updated': 'message_updated',
      'message_completed': 'other_message',
      'tool_started': 'other_message',
      'tool_completed': 'other_message',
      'file_edited': 'file_edited',
      'turn_completed': 'step_finish',
      'question_asked': 'other_message',
      'unknown': 'other_message',
    };

    return mapping[platformEventType] ?? 'other_message';
  }

  private createDefaultPlatform(config: ServiceConfig, platformConfig?: PlatformConfig): Platform {
    const resolvedConfig: PlatformConfig = platformConfig ?? {
      type: 'opencode',
      opencode: {
        server_port: OPENCODE_SERVER_PORT,
        model: config.opencodeModel,
        agent: config.opencodeAgent,
      },
    };

    return createPlatform(resolvedConfig);
  }

  private createLiveSession(sessionId: string, platformName: string): LiveSession {
    return {
      sessionId,
      opencodeServerPid: platformName === 'opencode' ? null : `platform:${platformName}`,
      lastEvent: null,
      lastEventTimestamp: null,
      lastEventMessage: '',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      turnCount: 0,
    };
  }

  private async cleanup(): Promise<void> {
    if (this.platform && this.sessionId) {
      try {
        await this.platform.abortSession(this.sessionId);
      } catch (err) {
        log.debug('Failed to abort agent session during cleanup', {
          sessionId: this.sessionId,
          error: (err as Error).message,
        });
      }
    }
    this.platform = null;
    this.sessionId = null;
  }
}
