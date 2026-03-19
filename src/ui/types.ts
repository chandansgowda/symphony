export interface IssueSession {
  id: string;
  issueId: string;
  sessionId: string;
  workflowId: string | null;
  workflowName: string | null;
  workspacePath: string | null;
  worktreeRoot: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  workflowId?: string;
  model?: string | null;
  sessionId?: string;
  workspacePath?: string;
  labels?: string[];
  sessions?: IssueSession[];
  comments?: Comment[];
}

export interface Comment {
  id: string;
  author: 'human' | 'agent';
  content: string;
  createdAt: string;
}

export interface WorkflowConfig {
  tracker?: {
    active_states?: string[];
    terminal_states?: string[];
  };
  workspace?: {
    root?: string;
  };
  agent?: {
    max_concurrent_agents?: number;
  };
  opencode?: {
    model?: string;
    secondary_model?: string;
    agent?: string;
  };
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  promptTemplate: string;
  isDefault: boolean;
  isPrivate?: boolean;
  config?: WorkflowConfig;
  maxConcurrentAgents?: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentLogEntry {
  type: 'message' | 'file' | 'status' | 'input' | 'error' | 'comment' | 'subagent';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface RunningAgent {
  issueId: string;
  identifier: string;
  startedAt: number;
  sessionId?: string;
  workspacePath?: string;
  worktreeRoot?: string;
  workflowWorkspaceRoot?: string;
}

export interface InputRequest {
  issueId: string;
  issueIdentifier: string;
  prompt: string;
  context?: string;
}

export interface OrchestratorStatus {
  running: boolean;
  runningAgents: RunningAgent[];
  pendingInputRequests: Record<string, InputRequest>;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatSession {
  sessionId?: string;
  workspacePath?: string;
  serverPort?: number;
}

export interface SessionExport {
  id: string;
  issueId: string;
  markdownContent: string;
  sessionCount: number;
  createdAt: string;
  updatedAt: string;
}

export type ViewType = 'issues' | 'workflows' | 'logs' | 'settings' | 'archive';

export type ThemeMode = 'system' | 'light' | 'dark';

export interface LocalSettings {
  privateWorkflowsDir?: string | null;
  privateWorkflowsEnabled?: boolean;
  workflowBadgeMode?: 'dot' | 'border';
  theme?: ThemeMode;
  safeExecute?: boolean;
}

export type KanbanColumnState = 'Backlog' | 'Todo' | 'In Progress' | 'Review' | 'Done';

export const KANBAN_COLUMNS: KanbanColumnState[] = ['Backlog', 'Todo', 'In Progress', 'Review', 'Done'];

export interface AppState {
  issues: Issue[];
  workflows: Workflow[];
  runningAgents: RunningAgent[];
  pendingInputRequests: Record<string, InputRequest>;
  currentView: ViewType;
  selectedIssueId: string | null;
  selectedWorkflowId: string | null;
  agentLogCache: Record<string, AgentLogEntry[]>;
  logs: string[];
  chatMessages: ChatMessage[];
  chatSession: ChatSession | null;
  isChatOpen: boolean;
  isGenerating: boolean;
  workflowBadgeMode: 'dot' | 'border';
}
