import * as os from 'node:os';
import * as path from 'node:path';
import { WorkflowConfig, DEFAULTS } from './types.js';

function resolveEnvVar(value: string): string {
  if (value.startsWith('$')) {
    const envName = value.slice(1);
    const resolved = process.env[envName];
    return resolved ?? '';
  }
  return value;
}

function expandPath(pathStr: string): string {
  if (pathStr.startsWith('~')) {
    return path.join(os.homedir(), pathStr.slice(1));
  }
  if (pathStr.startsWith('$')) {
    const resolved = resolveEnvVar(pathStr);
    if (resolved) {
      return expandPath(resolved);
    }
  }
  return pathStr;
}

function toNumber(value: number | string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const num = typeof value === 'string' ? parseInt(value, 10) : value;
  return isNaN(num) ? defaultValue : num;
}

export class ServiceConfig {
  private config: WorkflowConfig;

  constructor(config: WorkflowConfig) {
    this.config = config;
  }

  update(config: WorkflowConfig): void {
    this.config = config;
  }

  get trackerKind(): 'linear' | 'local' {
    return this.config.tracker?.kind ?? 'local';
  }

  get trackerEndpoint(): string {
    return this.config.tracker?.endpoint ?? DEFAULTS.tracker.endpoint;
  }

  get trackerApiKey(): string {
    const key = this.config.tracker?.api_key;
    if (!key) {
      return process.env.LINEAR_API_KEY ?? '';
    }
    return resolveEnvVar(key);
  }

  get trackerProjectSlug(): string | undefined {
    return this.config.tracker?.project_slug;
  }

  get trackerIssuesPath(): string {
    const issuesPath = this.config.tracker?.issues_path;
    if (issuesPath) {
      return expandPath(issuesPath);
    }
    return path.join(process.cwd(), 'data', 'issues.db');
  }

  get dataDir(): string {
    return path.dirname(this.trackerIssuesPath);
  }

  get workflowsDir(): string {
    return path.join(this.dataDir, 'workflow');
  }

  get activeStates(): string[] {
    return [...DEFAULTS.tracker.activeStates];
  }

  get terminalStates(): string[] {
    return [...DEFAULTS.tracker.terminalStates];
  }

  get autoTransitionOnStart(): string | undefined {
    return this.config.tracker?.auto_transition?.on_start;
  }

  get autoTransitionOnComplete(): string | undefined {
    return this.config.tracker?.auto_transition?.on_complete;
  }

  get autoTransitionOnFailure(): string {
    return this.config.tracker?.auto_transition?.on_failure ?? 'Review';
  }

  get pollIntervalMs(): number {
    return toNumber(this.config.polling?.interval_ms, DEFAULTS.polling.intervalMs);
  }

  get workspaceRoot(): string {
    const root = this.config.workspace?.root;
    if (root) {
      return expandPath(root);
    }
    return path.join(os.tmpdir(), 'symphony_workspaces');
  }

  get hooksAfterCreate(): string | undefined {
    return this.config.hooks?.after_create;
  }

  get hooksBeforeRun(): string | undefined {
    return this.config.hooks?.before_run;
  }

  get hooksAfterRun(): string | undefined {
    return this.config.hooks?.after_run;
  }

  get hooksBeforeRemove(): string | undefined {
    return this.config.hooks?.before_remove;
  }

  get hooksTimeoutMs(): number {
    const timeout = this.config.hooks?.timeout_ms;
    if (timeout !== undefined && timeout > 0) {
      return timeout;
    }
    return DEFAULTS.hooks.timeoutMs;
  }

  get maxConcurrentAgents(): number {
    return toNumber(this.config.agent?.max_concurrent_agents, DEFAULTS.agent.maxConcurrentAgents);
  }

  get maxTurns(): number {
    return toNumber(this.config.agent?.max_turns, DEFAULTS.agent.maxTurns);
  }

  get maxRetries(): number {
    return toNumber(this.config.agent?.max_retries, DEFAULTS.agent.maxRetries);
  }

  get maxRetryBackoffMs(): number {
    return toNumber(this.config.agent?.max_retry_backoff_ms, DEFAULTS.agent.maxRetryBackoffMs);
  }

  get maxConcurrentAgentsByState(): Map<string, number> {
    const map = new Map<string, number>();
    const byState = this.config.agent?.max_concurrent_agents_by_state;
    if (byState) {
      for (const [state, limit] of Object.entries(byState)) {
        if (typeof limit === 'number' && limit > 0) {
          map.set(state.toLowerCase(), limit);
        }
      }
    }
    return map;
  }

  get opencodeModel(): string | undefined {
    const model = this.config.opencode?.model;
    if (!model) return undefined;
    if (Array.isArray(model)) {
      return model[0]; // Return first model as default
    }
    return model;
  }

  get opencodeModels(): string[] {
    const model = this.config.opencode?.model;
    if (!model) return [];
    if (Array.isArray(model)) {
      return model;
    }
    return [model];
  }

  isValidModel(modelName: string): boolean {
    const models = this.opencodeModels;
    if (models.length === 0) return true; // No restriction if no models specified
    return models.includes(modelName);
  }

  get opencodeAgent(): string | undefined {
    return this.config.opencode?.agent;
  }

  get turnTimeoutMs(): number {
    return this.config.opencode?.turn_timeout_ms ?? DEFAULTS.opencode.turnTimeoutMs;
  }

  get stallTimeoutMs(): number {
    return this.config.opencode?.stall_timeout_ms ?? DEFAULTS.opencode.stallTimeoutMs;
  }

  get idleTimeoutMs(): number {
    return this.config.opencode?.idle_timeout_ms ?? DEFAULTS.opencode.idleTimeoutMs;
  }

  get idlePromptMessage(): string {
    return this.config.opencode?.idle_prompt ?? DEFAULTS.opencode.idlePromptMessage;
  }

  get serverPort(): number | undefined {
    return this.config.server?.port;
  }

  validate(): ValidationResult {
    const errors: string[] = [];

    if (this.trackerKind === 'linear') {
      if (!this.trackerApiKey) {
        errors.push('tracker.api_key is required for Linear (or set LINEAR_API_KEY environment variable)');
      }
      if (!this.trackerProjectSlug) {
        errors.push('tracker.project_slug is required for Linear tracker');
      }
    } else if (this.trackerKind !== 'local') {
      errors.push(`tracker.kind "${this.trackerKind}" is not supported (use "local" or "linear")`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}
