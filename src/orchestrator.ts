import { Issue, OrchestratorState, RunningEntry, AgentEvent, AgentLogEntry, InputRequest, DEFAULTS, RichLogDetails, SubagentInfo, OpenCodeConfig } from './types.js';
import { ServiceConfig } from './config.js';
import { IssueTrackerClient } from './issue-tracker.js';
import { WorkspaceManager } from './workspace-manager.js';
import { AgentRunner, AgentRunResult } from './agent-runner.js';
import { WorkflowStore } from './workflow-store.js';
import { Logger } from './logger.js';
import { PlatformConfig } from './platform/index.js';
import { ConnectorManager } from './connector-manager.js';
import { ConnectorEvent, AgentStartedEvent, AgentCompletedEvent, AgentFailedEvent, AgentLogEvent, InputRequestedEvent, IssueStateChangedEvent } from './connector.js';

const log = new Logger('orchestrator');

export type AgentLogCallback = (issueId: string, entry: AgentLogEntry) => void;
export type InputRequestCallback = (request: InputRequest) => void;
export type InputResponseResolver = (response: string) => void;
export type IssueUpdatedCallback = () => void;

export interface OrchestratorOptions {
  config: ServiceConfig;
  promptTemplate: string;
  issueTracker: IssueTrackerClient;
  workspaceManager: WorkspaceManager;
  workflowStore: WorkflowStore;
  onAgentLog?: AgentLogCallback;
  onInputRequest?: InputRequestCallback;
}

export class Orchestrator {
  private config: ServiceConfig;
  private promptTemplate: string;
  private issueTracker: IssueTrackerClient;
  private workspaceManager: WorkspaceManager;
  private workflowStore: WorkflowStore;
  private state: OrchestratorState;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private onAgentLog: AgentLogCallback | null = null;
  private onInputRequest: InputRequestCallback | null = null;
  private onIssueUpdated: IssueUpdatedCallback | null = null;
  private pendingInputResolvers: Map<string, InputResponseResolver> = new Map();
  private connectorManager: ConnectorManager | null = null;

  constructor(options: OrchestratorOptions) {
    this.config = options.config;
    this.promptTemplate = options.promptTemplate;
    this.issueTracker = options.issueTracker;
    this.workspaceManager = options.workspaceManager;
    this.workflowStore = options.workflowStore;
    this.state = this.createInitialState();
    this.onAgentLog = options.onAgentLog ?? null;
    this.onInputRequest = options.onInputRequest ?? null;
  }

  setAgentLogCallback(callback: AgentLogCallback): void {
    this.onAgentLog = callback;
  }

  setInputRequestCallback(callback: InputRequestCallback): void {
    this.onInputRequest = callback;
  }

  setIssueUpdatedCallback(callback: IssueUpdatedCallback): void {
    this.onIssueUpdated = callback;
  }

  setConnectorManager(manager: ConnectorManager): void {
    this.connectorManager = manager;
  }

  private emitConnectorEvent(event: ConnectorEvent): void {
    this.connectorManager?.emit(event);
  }

  submitInput(issueId: string, input: string): boolean {
    const resolver = this.pendingInputResolvers.get(issueId);
    if (resolver) {
      resolver(input);
      this.pendingInputResolvers.delete(issueId);
      return true;
    }
    return false;
  }

  hasPendingInput(issueId: string): boolean {
    return this.pendingInputResolvers.has(issueId);
  }

  private createInitialState(): OrchestratorState {
    return {
      maxConcurrentAgents: this.config.maxConcurrentAgents,
      running: new Map(),
      runningByWorkflow: new Map(),
      claimed: new Set(),
      retryAttempts: new Map(),
      completed: new Set(),
      totals: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        runtimeSeconds: 0,
      },
    };
  }

  updateConfig(config: ServiceConfig, promptTemplate: string): void {
    this.config = config;
    this.promptTemplate = promptTemplate;
    this.state.maxConcurrentAgents = config.maxConcurrentAgents;
    this.issueTracker.updateConfig(config);
    this.workspaceManager.updateConfig(config);
    log.info('Config updated');
  }

  async start(): Promise<void> {
    if (this.running) return;

    log.info('Starting orchestrator');
    this.running = true;

    await this.startupCleanup();
    await this.tick();
  }

  stop(): void {
    log.info('Stopping orchestrator');
    this.running = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    for (const [issueId, entry] of this.state.running) {
      log.info('Aborting running session', { issueId, identifier: entry.issueIdentifier });
      entry.abortController.abort();
    }

    for (const [issueId, retry] of this.state.retryAttempts) {
      clearTimeout(retry.timerHandle);
      this.state.retryAttempts.delete(issueId);
    }
  }

  private async startupCleanup(): Promise<void> {
    log.info('Running startup cleanup');

    try {
      const terminalIssues = await this.issueTracker.fetchTerminalIssues();
      const identifiers = terminalIssues.map(i => i.identifier);
      await this.workspaceManager.cleanupTerminalWorkspaces(identifiers);
    } catch (err) {
      log.warn('Startup cleanup failed', { error: (err as Error).message });
    }

    this.backfillSessionWorktreeRoots().catch(err => {
      log.warn('Session worktree root backfill failed', { error: (err as Error).message });
    });

    await this.resumeInProgressSessions();
  }

  private async backfillSessionWorktreeRoots(): Promise<void> {
    if (!('getSessionsWithoutWorktreeRoot' in this.issueTracker)) return;
    const client = this.issueTracker as unknown as {
      getSessionsWithoutWorktreeRoot: () => Promise<Array<{ id: string; workspacePath: string }>>;
      updateSessionWorktreeRoot: (id: string, root: string) => Promise<void>;
    };
    try {
      const sessions = await client.getSessionsWithoutWorktreeRoot();
      if (sessions.length === 0) return;
      log.info('Backfilling worktree roots for sessions', { count: sessions.length });
      for (const session of sessions) {
        const root = await this.workspaceManager.getGitWorktreeRoot(session.workspacePath);
        if (root) {
          await client.updateSessionWorktreeRoot(session.id, root);
        }
      }
      log.info('Worktree root backfill complete', { count: sessions.length });
    } catch (err) {
      log.warn('Failed to backfill worktree roots', { error: (err as Error).message });
    }
  }

  private async resumeInProgressSessions(): Promise<void> {
    log.info('Checking for sessions to resume');

    try {
      const candidates = await this.issueTracker.fetchCandidateIssues();
      const issuesWithSessions = candidates.filter(issue => 
        issue.sessionId && 
        this.issueTracker.isActiveState(issue.state) &&
        !this.state.running.has(issue.id)
      );

      if (issuesWithSessions.length === 0) {
        log.info('No sessions to resume');
        return;
      }

      log.info('Found sessions to resume', { count: issuesWithSessions.length });

      for (const issue of issuesWithSessions) {
        if (!issue.sessionId) continue;

        try {
          const workflowId = issue.workflowId ?? 'default-workflow';
          const workflow = await this.workflowStore.getWorkflow(workflowId);
          const workflowWorkspaceRoot = workflow?.config?.workspace?.root;
          
          const workspace = await this.workspaceManager.ensureWorkspace(issue.identifier, workflowWorkspaceRoot);
          await this.resumeSession(issue, workspace.path, issue.sessionId);
        } catch (err) {
          log.warn('Failed to resume session for issue', { 
            issueId: issue.id, 
            identifier: issue.identifier, 
            error: (err as Error).message 
          });
          if (issue.sessionId) {
            await this.issueTracker.deactivateSession(issue.sessionId);
          }
          await this.issueTracker.updateIssueSessionId(issue.id, null);
        }
      }
    } catch (err) {
      log.warn('Failed to resume in-progress sessions', { error: (err as Error).message });
    }
  }

  private async resumeSession(issue: Issue, workspacePath: string, sessionId: string): Promise<void> {
    const workflowId = issue.workflowId ?? 'default-workflow';
    
    log.info('Resuming session', { issueId: issue.id, identifier: issue.identifier, workflowId, sessionId });

    this.state.claimed.add(issue.id);

    const worktreeRoot = await this.workspaceManager.getGitWorktreeRoot(workspacePath);
    const abortController = new AbortController();

    const entry: RunningEntry = {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issue,
      workflowId,
      workspacePath,
      worktreeRoot,
      startedAt: new Date(),
      attempt: null,
      session: {
        sessionId,
        opencodeServerPid: null,
        lastEvent: null,
        lastEventTimestamp: new Date(),
        lastEventMessage: '',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        turnCount: 0,
      },
      abortController,
    };

    this.state.running.set(issue.id, entry);
    this.incrementWorkflowCount(workflowId);

    const onStartState = this.config.autoTransitionOnStart ?? 'In Progress';
    if (issue.state.toLowerCase() !== onStartState.toLowerCase()) {
      await this.issueTracker.updateIssueState(issue.id, onStartState);
      entry.issue = { ...entry.issue, state: onStartState };
      this.onIssueUpdated?.();
    }

    const runner = new AgentRunner();
    entry.runner = runner;

    const emitAgentLog = (type: AgentLogEntry['type'], message: string, level: AgentLogEntry['level'], details?: RichLogDetails) => {
      const logEntry: AgentLogEntry = {
        timestamp: new Date(),
        type,
        message,
        level,
        details,
      };
      if (this.onAgentLog) {
        this.onAgentLog(issue.id, logEntry);
      }
      this.emitConnectorEvent({
        type: 'agent_log',
        timestamp: logEntry.timestamp,
        issueId: issue.id,
        entry: logEntry,
      } as AgentLogEvent);
    };

    emitAgentLog('log', `Resuming session ${sessionId} for ${issue.identifier}`, 'info', { rawPayload: { workspacePath, sessionId } });

    // Build platformConfig from workflow settings (same as runAgent)
    let platformConfig: PlatformConfig | undefined;
    if (issue.workflowId) {
      const workflow = await this.workflowStore.getWorkflowFresh(issue.workflowId);
      if (workflow?.config?.opencode) {
        const workflowOpencode = workflow.config.opencode as OpenCodeConfig;
        let selectedModel = this.resolveIssueModel(issue, workflow.config);
        platformConfig = {
          type: 'opencode',
          opencode: {
            model: selectedModel,
            agent: workflowOpencode.agent ?? this.config.opencodeAgent,
          },
        };
        if (selectedModel || workflowOpencode.agent) {
          emitAgentLog('log', `Using workflow model config`, 'info', { 
            rawPayload: { 
              model: selectedModel, 
              agent: workflowOpencode.agent,
            } 
          });
        }
      }
    }

    const onEvent = (event: AgentEvent) => {
      const entry = this.state.running.get(issue.id);
      if (entry?.session) {
        entry.session.lastEvent = event.type;
        entry.session.lastEventTimestamp = event.timestamp;

        if (event.usage) {
          entry.session.inputTokens = event.usage.inputTokens;
          entry.session.outputTokens = event.usage.outputTokens;
          entry.session.totalTokens = event.usage.totalTokens;
        }
      }

      const eventLevel = this.getEventLogLevel(event.type);
      const eventMessage = this.formatEventMessage(event);
      const richDetails = this.extractRichDetails(event);
      emitAgentLog(event.type, eventMessage, eventLevel, richDetails);
    };

    const success = await runner.resumeSession({
      sessionId,
      workspacePath,
      config: this.config,
      onEvent,
      signal: abortController.signal,
      platformConfig,
    });

    if (!success) {
      log.warn('Session resume failed, clearing session_id', { issueId: issue.id });
      this.decrementWorkflowCount(workflowId);
      this.state.running.delete(issue.id);
      this.state.claimed.delete(issue.id);
      await this.issueTracker.deactivateSession(sessionId);
      await this.issueTracker.updateIssueSessionId(issue.id, null);
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      await this.reconcile();

      const validation = this.config.validate();
      if (!validation.valid) {
        log.error('Config validation failed, skipping dispatch', { errors: validation.errors });
      } else {
        await this.dispatch();
      }
    } catch (err) {
      log.error('Tick failed', { error: (err as Error).message });
    }

    this.scheduleTick();
  }

  private scheduleTick(): void {
    if (!this.running) return;

    this.pollTimer = setTimeout(() => {
      this.tick();
    }, DEFAULTS.polling.intervalMs);
  }

  private async reconcile(): Promise<void> {
    if (this.state.running.size === 0) return;

    log.debug('Reconciling running issues', { count: this.state.running.size });

    await this.checkForIdleSessions();
    await this.checkForStalls();
    await this.refreshTrackerStates();
  }

  private async checkForStalls(): Promise<void> {
    const stallTimeoutMs = this.config.stallTimeoutMs;
    if (stallTimeoutMs <= 0) return;

    const now = Date.now();

    for (const [issueId, entry] of this.state.running) {
      const lastActivity = entry.session?.lastEventTimestamp ?? entry.startedAt;
      const elapsed = now - lastActivity.getTime();

      if (elapsed > stallTimeoutMs) {
        log.warn('Session stalled, terminating', {
          issueId,
          identifier: entry.issueIdentifier,
          elapsed,
          stallTimeoutMs,
        });

        entry.abortController.abort();
        this.state.running.delete(issueId);
        this.scheduleRetry(issueId, entry.issueIdentifier, entry.attempt ?? 0, 'Session stalled');
      }
    }
  }

  private async checkForIdleSessions(): Promise<void> {
    const idleTimeoutMs = this.config.idleTimeoutMs;
    if (idleTimeoutMs <= 0) return;

    const now = Date.now();

    for (const [issueId, entry] of this.state.running) {
      if (entry.handoverRequested) continue;
      if (!entry.runner) continue;

      const lastActivity = entry.session?.lastEventTimestamp ?? entry.startedAt;
      const elapsed = now - lastActivity.getTime();

      if (elapsed < idleTimeoutMs) continue;

      const alreadyPrompted = entry.idlePromptSentAt && 
        (now - entry.idlePromptSentAt.getTime()) < idleTimeoutMs;
      if (alreadyPrompted) continue;

      log.info('Session idle, sending completion prompt', {
        issueId,
        identifier: entry.issueIdentifier,
        elapsed,
        idleTimeoutMs,
      });

      entry.idlePromptSentAt = new Date();
      entry.runner.sendMessage(this.config.idlePromptMessage).catch((err) => {
        log.warn('Failed to send idle prompt', {
          issueId,
          error: (err as Error).message,
        });
      });
    }
  }

  private async refreshTrackerStates(): Promise<void> {
    const runningIds = Array.from(this.state.running.keys());
    if (runningIds.length === 0) return;

    try {
      const currentIssues = await this.issueTracker.fetchIssuesByIds(runningIds);

      for (const [issueId, entry] of this.state.running) {
        const current = currentIssues.get(issueId);

        if (!current) {
          log.info('Issue not found in tracker, requesting graceful shutdown', { issueId, identifier: entry.issueIdentifier });
          this.requestHandover(entry);
          await this.moveToFailureState(issueId, entry.issueIdentifier, 'Issue not found in tracker during refresh');
          continue;
        }

        if (this.issueTracker.isTerminalState(current.state)) {
          log.info('Issue became terminal, initiating graceful handover', {
            issueId,
            identifier: entry.issueIdentifier,
            state: current.state,
          });
          this.requestHandover(entry);
          this.releaseClaim(issueId);
          await this.workspaceManager.removeWorkspace(entry.issueIdentifier);
          continue;
        }

        if (!this.issueTracker.isActiveState(current.state)) {
          log.info('Issue state changed externally, initiating graceful handover', {
            issueId,
            identifier: entry.issueIdentifier,
            state: current.state,
          });
          this.requestHandover(entry);
          this.releaseClaim(issueId);
          continue;
        }
      }
    } catch (err) {
      log.warn('Failed to refresh tracker states', { error: (err as Error).message });
    }
  }

  private requestHandover(entry: RunningEntry): void {
    if (entry.handoverRequested) return;

    entry.handoverRequested = true;

    const graceMs = 30000;

    if (entry.runner) {
      entry.runner.sendMessage('Symphony orchestrator: shutdown incoming. You have 30 seconds to finish work and call symphony_handover.').catch(() => {});
    }

    entry.handoverDeadline = new Date(Date.now() + graceMs);

    entry.handoverTimer = setTimeout(() => {
      entry.abortController.abort();
      this.state.running.delete(entry.issueId);
    }, graceMs);
  }

  private async dispatch(): Promise<void> {
    const candidates = await this.issueTracker.fetchCandidateIssues();
    const eligible = this.filterEligible(candidates);
    const sorted = this.sortByPriority(eligible);

    let availableSlots = this.getAvailableSlots();

    log.debug('Dispatch cycle', {
      candidates: candidates.length,
      eligible: eligible.length,
      availableSlots,
    });

    for (const issue of sorted) {
      if (availableSlots <= 0) break;

      const stateLimit = this.getStateConcurrencyLimit(issue.state);
      const currentForState = this.countRunningByState(issue.state);

      if (currentForState >= stateLimit) {
        log.debug('State limit reached, skipping', {
          issueId: issue.id,
          state: issue.state,
          current: currentForState,
          limit: stateLimit,
        });
        continue;
      }

      const workflowId = issue.workflowId ?? 'default-workflow';
      const workflowLimit = await this.getWorkflowConcurrencyLimit(workflowId);
      const currentForWorkflow = this.state.runningByWorkflow.get(workflowId) ?? 0;

      if (currentForWorkflow >= workflowLimit) {
        log.debug('Workflow limit reached, skipping', {
          issueId: issue.id,
          workflowId,
          current: currentForWorkflow,
          limit: workflowLimit,
        });
        continue;
      }

      await this.startRun(issue, null);
      availableSlots--;
    }
  }

  private filterEligible(issues: Issue[]): Issue[] {
    return issues.filter(issue => {
      if (!issue.id || !issue.identifier || !issue.title || !issue.state) {
        return false;
      }

      if (this.state.claimed.has(issue.id)) {
        return false;
      }

      if (this.state.running.has(issue.id)) {
        return false;
      }

      if (issue.state.toLowerCase() === 'todo') {
        const hasNonTerminalBlocker = issue.blockedBy.some(blocker => {
          if (!blocker.state) return true;
          return !this.issueTracker.isTerminalState(blocker.state);
        });

        if (hasNonTerminalBlocker) {
          log.debug('Issue has non-terminal blockers, skipping', {
            issueId: issue.id,
            identifier: issue.identifier,
            blockers: issue.blockedBy,
          });
          return false;
        }
      }

      return true;
    });
  }

  private sortByPriority(issues: Issue[]): Issue[] {
    return [...issues].sort((a, b) => {
      const priorityA = a.priority ?? 999;
      const priorityB = b.priority ?? 999;
      if (priorityA !== priorityB) return priorityA - priorityB;

      const createdA = a.createdAt?.getTime() ?? 0;
      const createdB = b.createdAt?.getTime() ?? 0;
      if (createdA !== createdB) return createdA - createdB;

      return a.identifier.localeCompare(b.identifier);
    });
  }

  private getAvailableSlots(): number {
    return Math.max(this.state.maxConcurrentAgents - this.state.running.size, 0);
  }

  private getStateConcurrencyLimit(state: string): number {
    const byState = this.config.maxConcurrentAgentsByState;
    return byState.get(state.toLowerCase()) ?? this.state.maxConcurrentAgents;
  }

  private countRunningByState(state: string): number {
    const normalizedState = state.toLowerCase();
    let count = 0;
    for (const entry of this.state.running.values()) {
      if (entry.issue.state.toLowerCase() === normalizedState) {
        count++;
      }
    }
    return count;
  }

  private async getWorkflowConcurrencyLimit(workflowId: string): Promise<number> {
    const workflow = await this.workflowStore.getWorkflow(workflowId);
    if (workflow) {
      return workflow.maxConcurrentAgents;
    }
    const defaultWorkflow = await this.workflowStore.getDefaultWorkflow();
    return defaultWorkflow?.maxConcurrentAgents ?? 1;
  }

  private incrementWorkflowCount(workflowId: string): void {
    const current = this.state.runningByWorkflow.get(workflowId) ?? 0;
    this.state.runningByWorkflow.set(workflowId, current + 1);
  }

  private decrementWorkflowCount(workflowId: string): void {
    const current = this.state.runningByWorkflow.get(workflowId) ?? 0;
    if (current <= 1) {
      this.state.runningByWorkflow.delete(workflowId);
    } else {
      this.state.runningByWorkflow.set(workflowId, current - 1);
    }
  }

  private async startRun(issue: Issue, attempt: number | null): Promise<void> {
    const workflowId = issue.workflowId ?? 'default-workflow';
    
    log.info('Starting run', {
      issueId: issue.id,
      identifier: issue.identifier,
      workflowId,
      attempt,
    });

    this.state.claimed.add(issue.id);

    try {
      const workflow = await this.workflowStore.getWorkflow(workflowId);
      const workflowWorkspaceRoot = workflow?.config?.workspace?.root;
      
      const workspace = await this.workspaceManager.ensureWorkspace(issue.identifier, workflowWorkspaceRoot);
      await this.workspaceManager.runBeforeRunHook(workspace.path);

      const worktreeRoot = await this.workspaceManager.getGitWorktreeRoot(workspace.path);
      const abortController = new AbortController();

      const entry: RunningEntry = {
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        issue,
        workflowId,
        workspacePath: workspace.path,
        worktreeRoot,
        startedAt: new Date(),
        attempt,
        session: null,
        abortController,
      };

      this.state.running.set(issue.id, entry);
      this.incrementWorkflowCount(workflowId);

      const onStartState = this.config.autoTransitionOnStart ?? 'In Progress';
      if (issue.state.toLowerCase() !== onStartState.toLowerCase()) {
        const fromState = issue.state;
        await this.issueTracker.updateIssueState(issue.id, onStartState);
        entry.issue = { ...entry.issue, state: onStartState };
        this.onIssueUpdated?.();
        this.emitConnectorEvent({
          type: 'issue_state_changed',
          timestamp: new Date(),
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          fromState,
          toState: onStartState,
        } as IssueStateChangedEvent);
      }

      this.emitConnectorEvent({
        type: 'agent_started',
        timestamp: new Date(),
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        workflowId,
        workspacePath: workspace.path,
      } as AgentStartedEvent);

      this.runAgent(issue, workspace.path, attempt, abortController.signal);

    } catch (err) {
      log.error('Failed to start run', {
        issueId: issue.id,
        identifier: issue.identifier,
        error: (err as Error).message,
      });

      this.scheduleRetry(issue.id, issue.identifier, (attempt ?? 0) + 1, (err as Error).message);
    }
  }

  private async runAgent(
    issue: Issue,
    workspacePath: string,
    attempt: number | null,
    signal: AbortSignal
  ): Promise<void> {
    const runner = new AgentRunner();

    // Store runner in the entry for sending messages later
    const entry = this.state.running.get(issue.id);
    if (entry) {
      entry.runner = runner;
    }

    const emitAgentLog = (type: AgentLogEntry['type'], message: string, level: AgentLogEntry['level'], details?: RichLogDetails) => {
      const logEntry: AgentLogEntry = {
        timestamp: new Date(),
        type,
        message,
        level,
        details,
      };
      if (this.onAgentLog) {
        this.onAgentLog(issue.id, logEntry);
      }
      this.emitConnectorEvent({
        type: 'agent_log',
        timestamp: logEntry.timestamp,
        issueId: issue.id,
        entry: logEntry,
      } as AgentLogEvent);
    };

    emitAgentLog('log', `Starting agent run for ${issue.identifier}`, 'info', { rawPayload: { workspacePath, attempt } });

    const onEvent = (event: AgentEvent) => {
      const entry = this.state.running.get(issue.id);
      if (entry && event.sessionId) {
        if (!entry.session) {
          entry.session = {
            sessionId: event.sessionId,
            opencodeServerPid: null,
            lastEvent: null,
            lastEventTimestamp: null,
            lastEventMessage: '',
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            turnCount: 0,
          };
          this.onIssueUpdated?.();
          // Persist session_id and workspace_path to issue for resumption on restart
          this.issueTracker.updateIssueSessionId(issue.id, event.sessionId).catch(err => {
            log.warn('Failed to persist session_id', { issueId: issue.id, error: (err as Error).message });
          });
          this.issueTracker.updateIssueWorkspacePath(issue.id, workspacePath).catch(err => {
            log.warn('Failed to persist workspace_path', { issueId: issue.id, error: (err as Error).message });
          });
          // Create the session record immediately with worktreeRoot=null so the UI
          // can show the session link right away, without waiting for the git worktree
          // root lookup (which can take many seconds and was causing ~50s link delay).
          this.workflowStore.getWorkflow(entry.workflowId).then(workflow => {
            const workflowName = workflow?.name ?? entry.workflowId;
            const sessionId = event.sessionId!;
            this.issueTracker.createSession(
              issue.id,
              sessionId,
              entry.workflowId,
              workflowName,
              workspacePath,
              null
            ).then(() => {
              this.workspaceManager.getGitWorktreeRoot(workspacePath).then(worktreeRoot => {
                if (worktreeRoot && 'updateSessionWorktreeRoot' in this.issueTracker) {
                  const client = this.issueTracker as unknown as { updateSessionWorktreeRoot: (id: string, root: string) => Promise<void> };
                  client.updateSessionWorktreeRoot(sessionId, worktreeRoot).catch((err: Error) => {
                    log.warn('Failed to backfill worktree root', { issueId: issue.id, error: err.message });
                  });
                }
              }).catch((err: Error) => {
                log.warn('Failed to get git worktree root for backfill', { issueId: issue.id, error: err.message });
              });
            }).catch(err => {
              log.warn('Failed to create session record', { issueId: issue.id, error: (err as Error).message });
            });
          }).catch(err => {
            log.warn('Failed to get workflow for session record', { issueId: issue.id, error: (err as Error).message });
          });
        }
        entry.session.lastEvent = event.type;
        entry.session.lastEventTimestamp = event.timestamp;

        if (event.usage) {
          entry.session.inputTokens = event.usage.inputTokens;
          entry.session.outputTokens = event.usage.outputTokens;
          entry.session.totalTokens = event.usage.totalTokens;
        }
      }

      const eventLevel = this.getEventLogLevel(event.type);
      const eventMessage = this.formatEventMessage(event);
      const richDetails = this.extractRichDetails(event);
      emitAgentLog(event.type, eventMessage, eventLevel, richDetails);

      log.debug('Agent event', {
        issueId: issue.id,
        eventType: event.type,
      });
    };

    const waitForInput = async (request: InputRequest): Promise<string> => {
      return new Promise((resolve, reject) => {
        this.pendingInputResolvers.set(issue.id, resolve);
        
        if (request.prompt) {
          this.issueTracker.addComment(issue.id, 'agent', request.prompt).catch(err => {
            log.warn('Failed to add agent comment', { error: (err as Error).message });
          });
        }
        
        if (this.onInputRequest) {
          this.onInputRequest(request);
        }

        this.emitConnectorEvent({
          type: 'input_requested',
          timestamp: new Date(),
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          request,
        } as InputRequestedEvent);
        
        emitAgentLog('log', `Waiting for user input: ${request.prompt ?? 'No prompt'}`, 'info', { 
          rawPayload: {
            sessionId: request.sessionId,
            hasContext: !!request.context,
          },
        });

        signal.addEventListener('abort', () => {
          this.pendingInputResolvers.delete(issue.id);
          reject(new Error('Agent aborted while waiting for input'));
        }, { once: true });
      });
    };

    try {
      let promptTemplate = this.promptTemplate;
      let platformConfig: PlatformConfig | undefined;
      
      if (issue.workflowId) {
        const workflow = await this.workflowStore.getWorkflowFresh(issue.workflowId);
        if (workflow) {
          promptTemplate = workflow.promptTemplate;
          emitAgentLog('log', `Using workflow: ${workflow.name}`, 'info', { rawPayload: { workflowId: workflow.id } });
          
          if (workflow.config?.opencode) {
            const workflowOpencode = workflow.config.opencode as OpenCodeConfig;
            let selectedModel = this.resolveIssueModel(issue, workflow.config);
            platformConfig = {
              type: 'opencode',
              opencode: {
                model: selectedModel,
                agent: workflowOpencode.agent ?? this.config.opencodeAgent,
              },
            };
            if (selectedModel || workflowOpencode.agent) {
              emitAgentLog('log', `Using workflow model config`, 'info', { 
                rawPayload: { 
                  model: selectedModel, 
                  agent: workflowOpencode.agent,
                } 
              });
            }
          }
        } else {
          emitAgentLog('log', `Workflow ${issue.workflowId} not found, using default`, 'warn');
        }
      }
      
      const result = await runner.run({
        issue,
        workspacePath,
        promptTemplate,
        attempt,
        config: this.config,
        onEvent,
        signal,
        waitForInput,
        platformConfig,
      });

      if (result.success) {
        emitAgentLog('log', `Agent run completed successfully (${result.turnCount} turns)`, 'info', {
          tokenUsage: result.session ? {
            input: result.session.inputTokens ?? 0,
            output: result.session.outputTokens ?? 0,
            total: result.session.totalTokens ?? 0,
          } : undefined,
          rawPayload: { turnCount: result.turnCount },
        });
      } else {
        emitAgentLog('log', `Agent run failed: ${result.error}`, 'error', { errorMessage: result.error });
      }

      await this.handleRunComplete(issue, result, attempt);

    } catch (err) {
      const errorMsg = (err as Error).message;
      emitAgentLog('log', `Agent run crashed: ${errorMsg}`, 'error', { errorMessage: errorMsg });
      
      log.error('Agent run failed', {
        issueId: issue.id,
        error: errorMsg,
      });

      await this.handleRunComplete(issue, {
        success: false,
        turnCount: 0,
        error: errorMsg,
        session: null,
      }, attempt);
    }
  }

  private getEventLogLevel(eventType: string): AgentLogEntry['level'] {
    switch (eventType) {
      case 'startup_failed':
      case 'turn_failed':
      case 'turn_ended_with_error':
      case 'session_error':
        return 'error';
      case 'turn_cancelled':
        return 'warn';
      case 'message_updated':
      case 'file_edited':
        return 'debug';
      default:
        return 'info';
    }
  }

  private formatEventMessage(event: AgentEvent): string {
    switch (event.type) {
      case 'session_started':
        return `Session started (${event.sessionId})`;
      case 'startup_failed':
        return 'Failed to start agent session';
      case 'turn_completed':
        return `Turn completed (tokens: ${event.usage?.totalTokens ?? 0})`;
      case 'turn_failed':
        return 'Turn failed';
      case 'turn_cancelled':
        return 'Turn cancelled';
      case 'turn_input_required':
        return 'Waiting for input';
      case 'message_updated':
        return 'Agent message updated';
      case 'file_edited':
        return 'File edited';
      case 'session_updated':
        return 'Session state updated';
      case 'session_error':
        return 'Session error';
      default:
        return `Event: ${event.type}`;
    }
  }

  private extractRichDetails(event: AgentEvent): RichLogDetails {
    const details: RichLogDetails = {
      rawPayload: event.payload,
    };

    if (event.usage) {
      details.tokenUsage = {
        input: event.usage.inputTokens,
        output: event.usage.outputTokens,
        total: event.usage.totalTokens,
      };
    }

    const payload = event.payload as { properties?: { parts?: Array<{ type: string; text?: string; toolName?: string; input?: unknown }>; path?: string; error?: { message?: string } } } | undefined;
    
    if (!payload?.properties) {
      return details;
    }

    const props = payload.properties;

    if (event.type === 'message_updated' && props.parts) {
      const textParts = props.parts.filter(p => p.type === 'text');
      const toolParts = props.parts.filter(p => p.type === 'tool_use');

      if (textParts.length > 0) {
        details.messageContent = textParts.map(p => p.text ?? '').join('');
      }

      if (toolParts.length > 0) {
        details.toolActivities = toolParts.map(p => ({
          toolName: p.toolName ?? 'unknown',
          status: 'started' as const,
          arguments: p.input as Record<string, unknown> | undefined,
        }));

        const subagents: SubagentInfo[] = [];
        for (const tool of toolParts) {
          if (tool.toolName === 'task') {
            const input = tool.input as { subagent_type?: string; category?: string; description?: string } | undefined;
            if (input) {
              const agentType = input.subagent_type ?? input.category ?? 'unknown';
              const knownTypes = ['explore', 'librarian', 'oracle', 'metis', 'momus'];
              subagents.push({
                type: knownTypes.includes(agentType) ? agentType as SubagentInfo['type'] : 'unknown',
                description: input.description ?? `${agentType} task`,
                status: 'spawned',
              });
            }
          }
        }
        if (subagents.length > 0) {
          details.subagents = subagents;
        }
      }
    }

    if (event.type === 'file_edited' && props.path) {
      details.filePath = props.path;
    }

    if ((event.type === 'session_error' || event.type === 'turn_failed') && props.error?.message) {
      details.errorMessage = props.error.message;
    }

    return details;
  }

  private async handleRunComplete(issue: Issue, result: AgentRunResult, attempt: number | null): Promise<void> {
    const entry = this.state.running.get(issue.id);
    const sessionId = entry?.session?.sessionId;

    if (entry) {
      const runtime = (Date.now() - entry.startedAt.getTime()) / 1000;
      this.state.totals.runtimeSeconds += runtime;

      if (result.session) {
        this.state.totals.inputTokens += result.session.inputTokens;
        this.state.totals.outputTokens += result.session.outputTokens;
        this.state.totals.totalTokens += result.session.totalTokens;
      }

      this.decrementWorkflowCount(entry.workflowId);
      this.state.running.delete(issue.id);
    }

    try {
      await this.workspaceManager.runAfterRunHook(this.workspaceManager.getWorkspacePath(issue.identifier));
    } catch {
    }

    if (sessionId) {
      await this.issueTracker.deactivateSession(sessionId);
    }

    if (result.success) {
      log.info('Run completed successfully', {
        issueId: issue.id,
        identifier: issue.identifier,
        turnCount: result.turnCount,
      });

      this.emitConnectorEvent({
        type: 'agent_completed',
        timestamp: new Date(),
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        turnCount: result.turnCount,
        tokenUsage: result.session ? {
          input: result.session.inputTokens,
          output: result.session.outputTokens,
          total: result.session.totalTokens,
        } : undefined,
      } as AgentCompletedEvent);

      const onCompleteState = this.config.autoTransitionOnComplete;
      if (onCompleteState) {
        await this.issueTracker.updateIssueState(issue.id, onCompleteState);
        this.onIssueUpdated?.();
        this.state.claimed.delete(issue.id);
      } else {
        this.scheduleContinuationRetry(issue.id, issue.identifier);
      }
    } else {
      log.warn('Run failed', {
        issueId: issue.id,
        identifier: issue.identifier,
        error: result.error,
      });

      const wasAbortedExternally = result.error === 'Aborted' && !entry;

      this.emitConnectorEvent({
        type: 'agent_failed',
        timestamp: new Date(),
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        error: result.error ?? 'Unknown error',
        attempt,
        willRetry: !wasAbortedExternally && (attempt ?? 0) + 1 <= this.config.maxRetries,
      } as AgentFailedEvent);

      if (wasAbortedExternally) {
        log.info('Run was aborted externally, skipping retry', {
          issueId: issue.id,
          identifier: issue.identifier,
        });
        this.state.claimed.delete(issue.id);
        return;
      }

      this.scheduleRetry(issue.id, issue.identifier, (attempt ?? 0) + 1, result.error ?? 'Unknown error');
    }
  }

  private scheduleContinuationRetry(issueId: string, identifier: string): void {
    this.cancelExistingRetry(issueId);

    const dueAtMs = Date.now() + DEFAULTS.continuationRetryDelayMs;

    const timerHandle = setTimeout(() => {
      this.handleRetry(issueId);
    }, DEFAULTS.continuationRetryDelayMs);

    this.state.retryAttempts.set(issueId, {
      issueId,
      identifier,
      attempt: 1,
      dueAtMs,
      timerHandle,
      error: null,
    });

    log.debug('Scheduled continuation retry', { issueId, identifier, dueAtMs });
  }

  private scheduleRetry(issueId: string, identifier: string, attempt: number, error: string): void {
    this.cancelExistingRetry(issueId);

    const maxRetries = this.config.maxRetries;
    
    if (attempt > maxRetries) {
      log.warn('Max retries exceeded, moving to failure state', {
        issueId,
        identifier,
        attempt,
        maxRetries,
        error,
      });
      this.moveToFailureState(issueId, identifier, `Max retries (${maxRetries}) exceeded. Last error: ${error}`);
      return;
    }

    const maxBackoff = this.config.maxRetryBackoffMs;
    const delay = Math.min(DEFAULTS.failureRetryBaseMs * Math.pow(2, attempt - 1), maxBackoff);
    const dueAtMs = Date.now() + delay;

    const timerHandle = setTimeout(() => {
      this.handleRetry(issueId);
    }, delay);

    this.state.retryAttempts.set(issueId, {
      issueId,
      identifier,
      attempt,
      dueAtMs,
      timerHandle,
      error,
    });

    log.info('Scheduled retry', { issueId, identifier, attempt, maxRetries, delay, error });
  }

  private async moveToFailureState(issueId: string, identifier: string, reason: string): Promise<void> {
    const failureState = this.config.autoTransitionOnFailure;
    
    try {
      await this.issueTracker.updateIssueState(issueId, failureState);
      log.info('Moved issue to failure state', { issueId, identifier, failureState, reason });

      this.emitConnectorEvent({
        type: 'issue_state_changed',
        timestamp: new Date(),
        issueId,
        issueIdentifier: identifier,
        fromState: 'In Progress',
        toState: failureState,
      } as IssueStateChangedEvent);
      
      try {
        await this.issueTracker.addComment(issueId, 'agent', `⚠️ Agent run failed and moved to ${failureState}.\n\nReason: ${reason}`);
      } catch (commentErr) {
        log.warn('Failed to add failure comment', { issueId, error: (commentErr as Error).message });
      }
      
      this.onIssueUpdated?.();
    } catch (err) {
      log.error('Failed to move issue to failure state', {
        issueId,
        identifier,
        failureState,
        error: (err as Error).message,
      });
    }
    
    this.releaseClaim(issueId);
  }

  private cancelExistingRetry(issueId: string): void {
    const existing = this.state.retryAttempts.get(issueId);
    if (existing) {
      clearTimeout(existing.timerHandle);
      this.state.retryAttempts.delete(issueId);
    }
  }

  private async handleRetry(issueId: string): Promise<void> {
    const retry = this.state.retryAttempts.get(issueId);
    if (!retry) return;

    this.state.retryAttempts.delete(issueId);

    log.debug('Handling retry', { issueId, identifier: retry.identifier, attempt: retry.attempt });

    try {
      // Use fetchIssuesByIds instead of fetchCandidateIssues to find the issue
      // regardless of its current state. This prevents race conditions where
      // refreshTrackerStates() might have changed the state between failure and retry.
      const issuesMap = await this.issueTracker.fetchIssuesByIds([issueId]);
      const issue = issuesMap.get(issueId);

      if (!issue) {
        log.warn('Issue not found during retry, moving to failure state', { 
          issueId, 
          identifier: retry.identifier,
          lastError: retry.error,
        });
        await this.moveToFailureState(
          issueId, 
          retry.identifier, 
          `Issue not found during retry. Last error: ${retry.error ?? 'Unknown'}`
        );
        return;
      }

      // Check if the issue is still in a retryable state (active, not terminal)
      if (this.issueTracker.isTerminalState(issue.state)) {
        log.info('Issue is in terminal state during retry, skipping', {
          issueId,
          identifier: retry.identifier,
          state: issue.state,
        });
        this.state.claimed.delete(issueId);
        return;
      }

      if (!this.issueTracker.isActiveState(issue.state)) {
        log.warn('Issue no longer in active state during retry, moving to failure state', { 
          issueId, 
          identifier: retry.identifier,
          state: issue.state,
          lastError: retry.error,
        });
        await this.moveToFailureState(
          issueId, 
          retry.identifier, 
          `Issue state changed to "${issue.state}" during retry. Last error: ${retry.error ?? 'Unknown'}`
        );
        return;
      }

      if (this.getAvailableSlots() <= 0) {
        log.debug('No slots available for retry, rescheduling', { issueId });
        this.scheduleRetry(issueId, retry.identifier, retry.attempt, 'no available orchestrator slots');
        return;
      }

      await this.startRun(issue, retry.attempt);

    } catch (err) {
      log.error('Retry handling failed', {
        issueId,
        error: (err as Error).message,
      });

      this.scheduleRetry(issueId, retry.identifier, retry.attempt + 1, (err as Error).message);
    }
  }

  private releaseClaim(issueId: string): void {
    const entry = this.state.running.get(issueId);
    if (entry) {
      this.decrementWorkflowCount(entry.workflowId);
    }
    this.state.claimed.delete(issueId);
    this.state.running.delete(issueId);
    this.cancelExistingRetry(issueId);
  }

  getState(): Readonly<OrchestratorState> {
    return this.state;
  }

  getStatus(): OrchestratorStatus {
    return {
      running: this.running,
      activeRuns: this.state.running.size,
      pendingRetries: this.state.retryAttempts.size,
      claimedIssues: this.state.claimed.size,
      totals: { ...this.state.totals },
      runningIssues: Array.from(this.state.running.values()).map(e => ({
        id: e.issueId,
        identifier: e.issueIdentifier,
        startedAt: e.startedAt,
        state: e.issue.state,
        sessionId: e.session?.sessionId ?? null,
        workspacePath: e.workspacePath,
        worktreeRoot: e.worktreeRoot,
      })),
    };
  }

  async sendCommentToSession(issueId: string, comment: string): Promise<boolean> {
    const entry = this.state.running.get(issueId);
    if (!entry) {
      log.debug('Cannot send comment - issue not running', { issueId });
      return false;
    }

    if (!entry.runner) {
      log.debug('Cannot send comment - no runner available', { issueId });
      return false;
    }

    const message = `\n\n---\n**New Comment from Human:**\n${comment}\n---\n\nPlease acknowledge this comment and incorporate any instructions into your current work.`;
    
    log.info('Forwarding comment to running session', { issueId, identifier: entry.issueIdentifier });
    return await entry.runner.sendMessage(message);
  }

  async terminateSession(issueId: string, graceMs = 30000): Promise<boolean> {
    const entry = this.state.running.get(issueId);
    if (!entry) {
      log.debug('No running session to terminate', { issueId });
      await this.issueTracker.updateIssueSessionId(issueId, null);
      return false;
    }

    const sessionId = entry.session?.sessionId;

    log.info('Terminating session via handover', { 
      issueId, 
      identifier: entry.issueIdentifier,
      graceMs,
    });

    if (entry.handoverRequested) {
      log.debug('Handover already in progress', { issueId });
      if (sessionId) {
        await this.issueTracker.deactivateSession(sessionId);
      }
      await this.issueTracker.updateIssueSessionId(issueId, null);
      return true;
    }

    entry.handoverRequested = true;

    if (entry.runner) {
      entry.runner.sendMessage(
        `Symphony orchestrator: Handover initiated. Session terminating in ${graceMs / 1000} seconds.`
      ).catch(() => {});
    }

    entry.handoverDeadline = new Date(Date.now() + graceMs);

    if (entry.handoverTimer) {
      clearTimeout(entry.handoverTimer);
    }

    entry.handoverTimer = setTimeout(async () => {
      log.info('Grace period expired, aborting session', { issueId, identifier: entry.issueIdentifier });
      entry.abortController.abort();
      this.releaseClaim(issueId);
      if (sessionId) {
        await this.issueTracker.deactivateSession(sessionId);
      }
      await this.issueTracker.updateIssueSessionId(issueId, null);
    }, graceMs);

    if (sessionId) {
      await this.issueTracker.deactivateSession(sessionId);
    }
    await this.issueTracker.updateIssueSessionId(issueId, null);

    return true;
  }

  private resolveIssueModel(issue: Issue, workflowConfig: any): string | undefined {
    if (issue.model) {
      const serviceConfig = new ServiceConfig(workflowConfig);
      if (serviceConfig.isValidModel(issue.model)) {
        return issue.model;
      }
      log.warn('Issue model not in workflow models, using workflow default', {
        issueId: issue.id,
        requestedModel: issue.model,
        availableModels: serviceConfig.opencodeModels,
      });
    }
    
    const workflowOpencode = workflowConfig.opencode as OpenCodeConfig | undefined;
    const modelConfig = workflowOpencode?.model;
    
    if (!modelConfig) {
      return this.config.opencodeModel;
    }
    
    if (Array.isArray(modelConfig)) {
      return modelConfig[0] ?? this.config.opencodeModel;
    }
    
    return modelConfig ?? this.config.opencodeModel;
  }
}

export interface OrchestratorStatus {
  running: boolean;
  activeRuns: number;
  pendingRetries: number;
  claimedIssues: number;
  totals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    runtimeSeconds: number;
  };
  runningIssues: Array<{
    id: string;
    identifier: string;
    startedAt: Date;
    state: string;
    sessionId: string | null;
    workspacePath: string;
    worktreeRoot: string | null;
  }>;
}
