/**
 * Symphony Domain Types
 * Based on the Symphony Service Specification
 */

import { z } from 'zod';

// ============================================================================
// Issue Model (Section 4.1.1)
// ============================================================================

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface IssueComment {
  id: string;
  author: 'human' | 'agent';
  content: string;
  createdAt: Date;
}

export interface IssueLog {
  id: string;
  issueId: string;
  sessionId: string | null;
  workflowId: string | null;
  content: string;
  createdAt: Date;
}

export interface IssueSession {
  id: string;
  issueId: string;
  sessionId: string;
  workflowId: string | null;
  workflowName: string | null;
  workspacePath: string | null;
  worktreeRoot: string | null;
  isActive: boolean;
  createdAt: Date;
}

export interface SessionExport {
  id: string;
  issueId: string;
  markdownContent: string;
  sessionCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  blockedBy: BlockerRef[];
  comments: IssueComment[];
  workflowId: string | null;
  model: string | null;
  sessionId: string | null;
  workspacePath: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

// ============================================================================
// Stored Workflow (for multi-workflow support)
// ============================================================================

export interface StoredWorkflow {
  id: string;
  name: string;
  description: string | null;
  promptTemplate: string;
  config: WorkflowConfig;
  isDefault: boolean;
  isPrivate: boolean;
  maxConcurrentAgents: number;
  color?: string;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Workflow Definition (Section 4.1.2)
// ============================================================================

export interface WorkflowDefinition {
  config: WorkflowConfig;
  promptTemplate: string;
}

// ============================================================================
// Workflow Config Schema (Section 5.3)
// ============================================================================

export const AutoTransitionConfigSchema = z.object({
  on_start: z.string().optional(),
  on_complete: z.string().optional(),
  on_failure: z.string().optional(),
});

export const TrackerConfigSchema = z.object({
  kind: z.enum(['linear', 'local']).optional(),
  endpoint: z.string().optional(),
  api_key: z.string().optional(),
  project_slug: z.string().optional(),
  issues_path: z.string().optional(),
  auto_transition: AutoTransitionConfigSchema.optional(),
});

export const PollingConfigSchema = z.object({
  interval_ms: z.union([z.number(), z.string()]).optional(),
});

export const WorkspaceConfigSchema = z.object({
  root: z.string().optional(),
});

export const HooksConfigSchema = z.object({
  after_create: z.string().optional(),
  before_run: z.string().optional(),
  after_run: z.string().optional(),
  before_remove: z.string().optional(),
  timeout_ms: z.number().optional(),
});

export const AgentConfigSchema = z.object({
  max_concurrent_agents: z.union([z.number(), z.string()]).optional(),
  max_turns: z.union([z.number(), z.string()]).optional(),
  max_retries: z.union([z.number(), z.string()]).optional(),
  max_retry_backoff_ms: z.union([z.number(), z.string()]).optional(),
  max_concurrent_agents_by_state: z.record(z.number()).optional(),
});

export const OpenCodeConfigSchema = z.object({
  model: z.union([z.string(), z.array(z.string())]).optional(),
  secondary_model: z.string().optional(),
  agent: z.string().optional(),
  turn_timeout_ms: z.number().optional(),
  stall_timeout_ms: z.number().optional(),
  idle_timeout_ms: z.number().optional(),
  idle_prompt: z.string().optional(),
});

export const WorkflowConfigSchema = z.object({
  tracker: TrackerConfigSchema.optional(),
  polling: PollingConfigSchema.optional(),
  workspace: WorkspaceConfigSchema.optional(),
  hooks: HooksConfigSchema.optional(),
  agent: AgentConfigSchema.optional(),
  opencode: OpenCodeConfigSchema.optional(),
}).passthrough();

export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;
export type TrackerConfig = z.infer<typeof TrackerConfigSchema>;
export type PollingConfig = z.infer<typeof PollingConfigSchema>;
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type HooksConfig = z.infer<typeof HooksConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type OpenCodeConfig = z.infer<typeof OpenCodeConfigSchema>;

// ============================================================================
// Workspace (Section 4.1.4)
// ============================================================================

export interface Workspace {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
}

// ============================================================================
// Run Attempt (Section 4.1.5)
// ============================================================================

export type RunAttemptStatus =
  | 'preparing_workspace'
  | 'building_prompt'
  | 'launching_agent'
  | 'initializing_session'
  | 'streaming_turn'
  | 'finishing'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'stalled'
  | 'canceled_by_reconciliation';

export interface RunAttempt {
  issueId: string;
  issueIdentifier: string;
  attempt: number | null;
  workspacePath: string;
  startedAt: Date;
  status: RunAttemptStatus;
  error?: string;
}

// ============================================================================
// Live Session (Section 4.1.6)
// ============================================================================

export interface LiveSession {
  sessionId: string;
  opencodeServerPid: string | null;
  lastEvent: string | null;
  lastEventTimestamp: Date | null;
  lastEventMessage: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turnCount: number;
}

// ============================================================================
// Retry Entry (Section 4.1.7)
// ============================================================================

export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  timerHandle: ReturnType<typeof setTimeout>;
  error: string | null;
}

// ============================================================================
// Running Entry (Orchestrator tracking)
// ============================================================================

export interface RunningEntry {
  issueId: string;
  issueIdentifier: string;
  issue: Issue;
  workflowId: string;
  workspacePath: string;
  worktreeRoot: string | null;
  startedAt: Date;
  attempt: number | null;
  session: LiveSession | null;
  abortController: AbortController;
  runner?: { sendMessage: (message: string) => Promise<boolean> };
  handoverRequested?: boolean;
  handoverDeadline?: Date | null;
  handoverTimer?: ReturnType<typeof setTimeout> | null;
  /** Timestamp when an idle prompt was last sent to this session */
  idlePromptSentAt?: Date | null;
}

// ============================================================================
// Orchestrator Runtime State (Section 4.1.8)
// ============================================================================

export interface OrchestratorState {
  pollIntervalMs: number;
  maxConcurrentAgents: number;
  running: Map<string, RunningEntry>;
  runningByWorkflow: Map<string, number>;
  claimed: Set<string>;
  retryAttempts: Map<string, RetryEntry>;
  completed: Set<string>;
  totals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    runtimeSeconds: number;
  };
}

// ============================================================================
// Agent Events (Section 10.4)
// ============================================================================

export type AgentEventType =
  | 'session_started'
  | 'startup_failed'
  | 'turn_completed'
  | 'turn_failed'
  | 'turn_cancelled'
  | 'turn_ended_with_error'
  | 'turn_input_required'
  | 'notification'
  | 'message_updated'
  | 'file_edited'
  | 'session_updated'
  | 'session_error'
  | 'step_finish'
  | 'other_message'
  | 'malformed';

export interface AgentEvent {
  type: AgentEventType;
  timestamp: Date;
  sessionId?: string;
  issueId?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  payload?: unknown;
}

// ============================================================================
// Rich Log Details (structured content for UI rendering)
// ============================================================================

export interface ToolActivity {
  toolName: string;
  status: 'started' | 'completed' | 'failed';
  arguments?: Record<string, unknown>;
}

export interface SubagentInfo {
  type: 'explore' | 'librarian' | 'oracle' | 'metis' | 'momus' | 'unknown';
  description: string;
  taskId?: string;
  status: 'spawned' | 'running' | 'completed' | 'failed';
}

export interface RichLogDetails {
  /** Extracted message text content from assistant messages */
  messageContent?: string;
  /** Delta text (new content since last update) */
  deltaContent?: string;
  /** Tool activities detected in this event */
  toolActivities?: ToolActivity[];
  /** Subagent spawn/status information */
  subagents?: SubagentInfo[];
  /** File path for file_edited events */
  filePath?: string;
  /** Error message for error events */
  errorMessage?: string;
  /** Token usage information */
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };
  /** Raw payload for advanced inspection */
  rawPayload?: unknown;
}

// ============================================================================
// Agent Log Entry (for drill-down logs per agent)
// ============================================================================

export interface AgentLogEntry {
  timestamp: Date;
  type: AgentEventType | 'log';
  message: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  details?: RichLogDetails;
}

// ============================================================================
// Input Request (for agent input collection from dashboard)
// ============================================================================

export interface InputRequest {
  issueId: string;
  issueIdentifier: string;
  sessionId: string;
  requestedAt: Date;
  prompt?: string;
  context?: string;
}

// ============================================================================
// Validation Errors (Section 5.5)
// ============================================================================

export type WorkflowErrorType =
  | 'missing_workflow_file'
  | 'workflow_parse_error'
  | 'workflow_front_matter_not_a_map'
  | 'template_parse_error'
  | 'template_render_error';

export class WorkflowError extends Error {
  constructor(
    public readonly type: WorkflowErrorType,
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}

// ============================================================================
// Service Configuration Defaults (Section 6.4)
// ============================================================================

// ============================================================================
// OpenCode Server Configuration
// ============================================================================

export const OPENCODE_SERVER_PORT = parseInt(process.env.OPENCODE_SERVER_PORT ?? '4096', 10);

export const DEFAULTS = {
  tracker: {
    endpoint: 'https://api.linear.app/graphql',
    activeStates: ['Todo', 'In Progress'],
    terminalStates: ['Closed', 'Duplicate', 'Done', 'Archived'],
  },
  polling: {
    intervalMs: 30000,
  },
  workspace: {
    // Will be set dynamically to <system-temp>/symphony_workspaces
  },
  hooks: {
    timeoutMs: 60000,
  },
  agent: {
    maxConcurrentAgents: 10,
    maxTurns: 20,
    maxRetries: 3,
    maxRetryBackoffMs: 300000,
  },
  opencode: {
    turnTimeoutMs: 3600000,
    stallTimeoutMs: 300000,
    idleTimeoutMs: 120000,
    idlePromptMessage: 'Symphony orchestrator: Session appears idle. If your work is complete, please call symphony_handover or move the issue to Done. If you are still working, please continue.',
  },
  continuationRetryDelayMs: 1000,
  failureRetryBaseMs: 10000,
} as const;
