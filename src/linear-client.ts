import { LinearClient, Issue as LinearIssue } from '@linear/sdk';
import { Issue, BlockerRef, IssueComment, IssueLog, IssueSession, SessionExport } from './types.js';
import { ServiceConfig } from './config.js';
import { IssueTrackerClient, IssueCreateData, IssueUpdateData } from './issue-tracker.js';
import { WorkflowStore } from './workflow-store.js';
import { Logger } from './logger.js';

const log = new Logger('linear');

export class LinearIssueTrackerClient implements IssueTrackerClient {
  private client: LinearClient;
  private config: ServiceConfig;
  private projectId: string | null = null;

  constructor(config: ServiceConfig) {
    this.config = config;
    this.client = new LinearClient({
      apiKey: config.trackerApiKey,
    });
  }

  updateConfig(config: ServiceConfig): void {
    this.config = config;
    if (config.trackerApiKey !== this.config.trackerApiKey) {
      this.client = new LinearClient({
        apiKey: config.trackerApiKey,
      });
      this.projectId = null;
    }
  }

  setWorkflowStore(_store: WorkflowStore): void {}

  private async ensureProjectId(): Promise<string> {
    if (this.projectId) return this.projectId;

    const projectSlug = this.config.trackerProjectSlug;
    if (!projectSlug) {
      throw new Error('tracker.project_slug is required');
    }

    log.debug('Looking up project', { slug: projectSlug });

    const projects = await this.client.projects({ first: 100 });
    for (const project of projects.nodes) {
      if (project.slugId === projectSlug || project.name === projectSlug) {
        this.projectId = project.id;
        log.info('Found project', { id: project.id, name: project.name, slug: project.slugId });
        return project.id;
      }
    }

    throw new Error(`Project not found: ${projectSlug}`);
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    const projectId = await this.ensureProjectId();
    const activeStates = this.getAggregatedActiveStates();

    log.debug('Fetching candidate issues', { projectId, activeStates });

    const allIssues: Issue[] = [];
    let cursor: string | undefined;
    let hasNextPage = true;

    while (hasNextPage) {
      const result = await this.client.issues({
        filter: {
          project: { id: { eq: projectId } },
        },
        first: 50,
        after: cursor,
      });

      for (const linearIssue of result.nodes) {
        const state = await linearIssue.state;
        if (state && activeStates.includes(state.name.toLowerCase())) {
          const normalized = await this.normalizeIssue(linearIssue);
          allIssues.push(normalized);
        }
      }

      hasNextPage = result.pageInfo.hasNextPage;
      cursor = result.pageInfo.endCursor;
    }

    log.info('Fetched candidate issues', { count: allIssues.length });
    return allIssues;
  }

  private getAggregatedActiveStates(): string[] {
    return this.config.activeStates.map(s => s.toLowerCase());
  }

  async fetchIssuesByIds(issueIds: string[]): Promise<Map<string, Issue>> {
    const result = new Map<string, Issue>();

    for (const issueId of issueIds) {
      try {
        const linearIssue = await this.client.issue(issueId);
        const normalized = await this.normalizeIssue(linearIssue);
        result.set(issueId, normalized);
      } catch {
        log.warn('Failed to fetch issue', { issueId });
      }
    }

    return result;
  }

  async fetchTerminalIssues(): Promise<Issue[]> {
    const projectId = await this.ensureProjectId();
    const terminalStates = this.config.terminalStates.map(s => s.toLowerCase());

    log.debug('Fetching terminal issues for cleanup', { projectId, terminalStates });

    const allIssues: Issue[] = [];
    let cursor: string | undefined;
    let hasNextPage = true;

    while (hasNextPage) {
      const result = await this.client.issues({
        filter: {
          project: { id: { eq: projectId } },
        },
        first: 50,
        after: cursor,
      });

      for (const linearIssue of result.nodes) {
        const state = await linearIssue.state;
        if (state && terminalStates.includes(state.name.toLowerCase())) {
          const normalized = await this.normalizeIssue(linearIssue);
          allIssues.push(normalized);
        }
      }

      hasNextPage = result.pageInfo.hasNextPage;
      cursor = result.pageInfo.endCursor;
    }

    log.info('Fetched terminal issues', { count: allIssues.length });
    return allIssues;
  }

  private async normalizeIssue(linearIssue: LinearIssue): Promise<Issue> {
    const state = await linearIssue.state;
    const labels = await linearIssue.labels();
    const blockers = await this.fetchBlockers(linearIssue);

    return {
      id: linearIssue.id,
      identifier: linearIssue.identifier,
      title: linearIssue.title,
      description: linearIssue.description ?? null,
      priority: linearIssue.priority ?? null,
      state: state?.name ?? 'Unknown',
      branchName: linearIssue.branchName ?? null,
      url: linearIssue.url ?? null,
      labels: labels.nodes.map((l: { name: string }) => l.name.toLowerCase()),
      blockedBy: blockers,
      comments: [],
      workflowId: null,
      sessionId: null,
      workspacePath: null,
      model: null,
      createdAt: linearIssue.createdAt ?? null,
      updatedAt: linearIssue.updatedAt ?? null,
    };
  }

  private async fetchBlockers(linearIssue: LinearIssue): Promise<BlockerRef[]> {
    const blockers: BlockerRef[] = [];

    try {
      const inverseRelations = await linearIssue.inverseRelations();
      for (const relation of inverseRelations.nodes) {
        if (relation.type === 'blocks') {
          const blockingIssue = await relation.issue;
          if (blockingIssue) {
            const blockingState = await blockingIssue.state;
            blockers.push({
              id: blockingIssue.id,
              identifier: blockingIssue.identifier,
              state: blockingState?.name ?? null,
            });
          }
        }
      }
    } catch (err) {
      log.warn('Failed to fetch blockers for issue', {
        issueId: linearIssue.id,
        error: (err as Error).message,
      });
    }

    return blockers;
  }

  isTerminalState(state: string): boolean {
    return this.config.terminalStates.map(s => s.toLowerCase()).includes(state.toLowerCase());
  }

  isActiveState(state: string): boolean {
    return this.config.activeStates.map(s => s.toLowerCase()).includes(state.toLowerCase());
  }

  async fetchAllIssues(): Promise<Issue[]> {
    const projectId = await this.ensureProjectId();

    log.debug('Fetching all issues', { projectId });

    const allIssues: Issue[] = [];
    let cursor: string | undefined;
    let hasNextPage = true;

    while (hasNextPage) {
      const result = await this.client.issues({
        filter: {
          project: { id: { eq: projectId } },
        },
        first: 50,
        after: cursor,
      });

      for (const linearIssue of result.nodes) {
        const normalized = await this.normalizeIssue(linearIssue);
        allIssues.push(normalized);
      }

      hasNextPage = result.pageInfo.hasNextPage;
      cursor = result.pageInfo.endCursor;
    }

    log.info('Fetched all issues', { count: allIssues.length });
    return allIssues;
  }

  async createIssue(_data: IssueCreateData): Promise<Issue> {
    throw new Error('createIssue not implemented for Linear');
  }

  async updateIssue(_issueId: string, _data: IssueUpdateData): Promise<Issue | null> {
    throw new Error('updateIssue not implemented for Linear');
  }

  async deleteIssue(_issueId: string): Promise<boolean> {
    throw new Error('deleteIssue not implemented for Linear');
  }

  async updateIssueState(issueId: string, newState: string): Promise<void> {
    log.warn('updateIssueState not implemented for Linear', { issueId, newState });
  }

  async updateIssueSessionId(issueId: string, sessionId: string | null): Promise<void> {
    log.warn('updateIssueSessionId not implemented for Linear', { issueId, sessionId });
  }

  async updateIssueWorkspacePath(issueId: string, workspacePath: string | null): Promise<void> {
    log.warn('updateIssueWorkspacePath not implemented for Linear', { issueId, workspacePath });
  }

  async addComment(issueId: string, author: 'human' | 'agent', content: string): Promise<IssueComment> {
    log.warn('addComment not implemented for Linear', { issueId, author });
    return {
      id: `linear-comment-${Date.now()}`,
      author,
      content,
      createdAt: new Date(),
    };
  }

  async getComments(issueId: string): Promise<IssueComment[]> {
    log.warn('getComments not implemented for Linear', { issueId });
    return [];
  }

  async addLog(
    issueId: string,
    content: string,
    sessionId?: string | null,
    workflowId?: string | null
  ): Promise<IssueLog> {
    log.warn('addLog not implemented for Linear', { issueId });
    return {
      id: `linear-log-${Date.now()}`,
      issueId,
      sessionId: sessionId ?? null,
      workflowId: workflowId ?? null,
      content,
      createdAt: new Date(),
    };
  }

  async getLogs(issueId: string): Promise<IssueLog[]> {
    log.warn('getLogs not implemented for Linear', { issueId });
    return [];
  }

  async startWatching(_onChange: () => void): Promise<void> {
    log.debug('Linear mode: file watching not applicable');
  }

  async resolveIssueId(idOrIdentifier: string): Promise<string | null> {
    try {
      const issue = await this.client.issue(idOrIdentifier);
      if (issue) {
        return issue.id;
      }
    } catch {
      /* not found by id, try identifier search below */
    }

    try {
      const projectId = await this.ensureProjectId();
      const result = await this.client.issues({
        filter: {
          project: { id: { eq: projectId } },
        },
        first: 100,
      });

      for (const issue of result.nodes) {
        if (issue.identifier === idOrIdentifier) {
          return issue.id;
        }
      }
    } catch (err) {
      log.warn('Failed to resolve issue identifier', { idOrIdentifier, error: (err as Error).message });
    }

    return null;
  }

  async createSession(
    issueId: string,
    sessionId: string,
    workflowId: string | null,
    workflowName: string | null,
    workspacePath: string | null,
    _worktreeRoot?: string | null
  ): Promise<IssueSession> {
    log.warn('createSession not implemented for Linear', { issueId, sessionId });
    return {
      id: `linear-session-${Date.now()}`,
      issueId,
      sessionId,
      workflowId,
      workflowName,
      workspacePath,
      worktreeRoot: _worktreeRoot ?? null,
      isActive: true,
      createdAt: new Date(),
    };
  }

  async deactivateSession(sessionId: string): Promise<void> {
    log.warn('deactivateSession not implemented for Linear', { sessionId });
  }

  async getIssueSessions(issueId: string): Promise<IssueSession[]> {
    log.warn('getIssueSessions not implemented for Linear', { issueId });
    return [];
  }

  async saveSessionExport(
    _issueId: string,
    _markdownContent: string,
    _sessionCount: number
  ): Promise<SessionExport> {
    throw new Error('Session export not supported for Linear client');
  }

  async getSessionExport(_issueId: string): Promise<SessionExport | null> {
    throw new Error('Session export not supported for Linear client');
  }
}
