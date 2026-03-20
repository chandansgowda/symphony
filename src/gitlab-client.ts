import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { Issue, IssueComment, IssueLog, IssueSession, SessionExport } from './types.js';
import { ServiceConfig } from './config.js';
import { IssueTrackerClient, IssueCreateData, IssueUpdateData } from './issue-tracker.js';
import { WorkflowStore } from './workflow-store.js';
import { Logger } from './logger.js';

const log = new Logger('gitlab');

const SIDECAR_SCHEMA = `
  CREATE TABLE IF NOT EXISTS issue_meta (
    gitlab_id TEXT PRIMARY KEY,
    session_id TEXT,
    workspace_path TEXT,
    workflow_id TEXT,
    model TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    gitlab_id TEXT NOT NULL,
    author TEXT NOT NULL CHECK (author IN ('human', 'agent')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS session_logs (
    id TEXT PRIMARY KEY,
    gitlab_id TEXT NOT NULL,
    session_id TEXT,
    workflow_id TEXT,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS issue_sessions (
    id TEXT PRIMARY KEY,
    gitlab_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    workflow_id TEXT,
    workflow_name TEXT,
    workspace_path TEXT,
    worktree_root TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS session_exports (
    id TEXT PRIMARY KEY,
    gitlab_id TEXT NOT NULL UNIQUE,
    markdown_content TEXT NOT NULL,
    session_count INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_comments_gitlab_id ON comments(gitlab_id);
  CREATE INDEX IF NOT EXISTS idx_logs_gitlab_id ON session_logs(gitlab_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_gitlab_id ON issue_sessions(gitlab_id);
  CREATE INDEX IF NOT EXISTS idx_exports_gitlab_id ON session_exports(gitlab_id);
`;

interface GlabIssue {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: string;
  web_url: string;
  labels: string[];
  assignees: Array<{ username: string; id: number }>;
  created_at: string;
  updated_at: string;
}

interface GlabNote {
  id: number;
  body: string;
  author: { username: string };
  created_at: string;
  system: boolean;
}

export class GitLabIssueTrackerClient implements IssueTrackerClient {
  private config: ServiceConfig;
  private db: Database.Database | null = null;
  private sidecarPath: string;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastIssueSig: string = '';

  constructor(config: ServiceConfig) {
    this.config = config;
    this.sidecarPath = path.join(
      path.dirname(config.trackerIssuesPath),
      'gitlab-sidecar.db'
    );
    this.initSidecar();
  }

  private initSidecar(): void {
    const dir = path.dirname(this.sidecarPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(this.sidecarPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SIDECAR_SCHEMA);
    log.info('GitLab sidecar DB initialized', { path: this.sidecarPath });
  }

  private getDb(): Database.Database {
    if (!this.db) this.initSidecar();
    return this.db!;
  }

  updateConfig(config: ServiceConfig): void {
    this.config = config;
  }

  setWorkflowStore(_store: WorkflowStore): void {}

  private get projectPath(): string {
    const p = this.config.trackerProjectPath;
    if (!p) throw new Error('GitLab tracker.project_path is not configured');
    return p;
  }

  private get gitlabHost(): string {
    return this.config.trackerGitLabHost;
  }

  private get apiToken(): string {
    return this.config.trackerApiKey;
  }

  private runGlab(args: string[]): string {
    const cmd = ['glab', ...args].join(' ');
    log.debug('Running glab', { cmd });
    try {
      return childProcess.execSync(cmd, {
        env: {
          ...process.env,
          GITLAB_TOKEN: this.apiToken,
          GITLAB_HOST: this.gitlabHost,
          GL_HOST: this.gitlabHost,
        },
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (err) {
      const execErr = err as childProcess.SpawnSyncReturns<string>;
      const stderr = execErr.stderr ?? '';
      throw new Error(`glab ${args[0]} failed: ${stderr || (err as Error).message}`);
    }
  }

  private listGlabIssues(state: 'opened' | 'closed' | 'all' = 'opened'): GlabIssue[] {
    try {
      const output = this.runGlab([
        'issue', 'list',
        '--state', state,
        '--output', 'json',
        '--repo', this.projectPath,
        '--per-page', '100',
      ]);
      return JSON.parse(output) as GlabIssue[];
    } catch (err) {
      log.error('Failed to list GitLab issues', { error: (err as Error).message });
      return [];
    }
  }

  private getGlabIssue(iid: string | number): GlabIssue | null {
    try {
      const output = this.runGlab([
        'issue', 'view', String(iid),
        '--output', 'json',
        '--repo', this.projectPath,
      ]);
      return JSON.parse(output) as GlabIssue;
    } catch (err) {
      log.warn('Failed to get GitLab issue', { iid, error: (err as Error).message });
      return null;
    }
  }

  private getGlabIssueNotes(iid: string | number): GlabNote[] {
    try {
      const output = this.runGlab([
        'api',
        `projects/${encodeURIComponent(this.projectPath)}/issues/${iid}/notes`,
        '--field', 'per_page=100',
      ]);
      const notes = JSON.parse(output) as GlabNote[];
      return notes.filter(n => !n.system);
    } catch (err) {
      log.warn('Failed to get issue notes', { iid, error: (err as Error).message });
      return [];
    }
  }

  private mapStateToSymphony(glabIssue: GlabIssue): string {
    const labels = glabIssue.labels.map(l => l.toLowerCase());

    for (const active of this.config.activeStates) {
      if (labels.includes(active.toLowerCase())) return active;
    }
    for (const terminal of this.config.terminalStates) {
      if (labels.includes(terminal.toLowerCase())) return terminal;
    }

    if (glabIssue.state === 'closed') return 'Done';
    return this.config.activeStates[0] ?? 'Todo';
  }

  private normalizeIssue(glabIssue: GlabIssue): Issue {
    const db = this.getDb();
    const gitlabId = String(glabIssue.id);
    const meta = db.prepare('SELECT * FROM issue_meta WHERE gitlab_id = ?').get(gitlabId) as Record<string, unknown> | undefined;

    return {
      id: gitlabId,
      identifier: `${this.projectPath}#${glabIssue.iid}`,
      title: glabIssue.title,
      description: glabIssue.description ?? null,
      priority: null,
      state: this.mapStateToSymphony(glabIssue),
      branchName: null,
      url: glabIssue.web_url,
      labels: glabIssue.labels.map(l => l.toLowerCase()),
      blockedBy: [],
      comments: [],
      workflowId: (meta?.workflow_id as string) ?? null,
      model: (meta?.model as string) ?? null,
      sessionId: (meta?.session_id as string) ?? null,
      workspacePath: (meta?.workspace_path as string) ?? null,
      created: Math.floor(new Date(glabIssue.created_at).getTime() / 1000),
      lastModified: Math.floor(new Date(glabIssue.updated_at).getTime() / 1000),
    };
  }

  async fetchAllIssues(): Promise<Issue[]> {
    const issues = this.listGlabIssues('all');
    return issues.map(i => this.normalizeIssue(i));
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    const issues = this.listGlabIssues('opened');
    const activeStates = this.config.activeStates.map(s => s.toLowerCase());
    const candidates = issues
      .map(i => this.normalizeIssue(i))
      .filter(i => activeStates.includes(i.state.toLowerCase()));

    log.info('Fetched candidate issues', { total: issues.length, candidates: candidates.length, activeStates });
    return candidates;
  }

  async fetchIssuesByIds(issueIds: string[]): Promise<Map<string, Issue>> {
    const result = new Map<string, Issue>();
    for (const id of issueIds) {
      const glabIssue = this.getGlabIssue(id);
      if (glabIssue) {
        const issue = this.normalizeIssue(glabIssue);
        result.set(id, issue);
      }
    }
    return result;
  }

  async fetchTerminalIssues(): Promise<Issue[]> {
    const issues = this.listGlabIssues('closed');
    const terminalStates = this.config.terminalStates.map(s => s.toLowerCase());
    return issues
      .map(i => this.normalizeIssue(i))
      .filter(i => terminalStates.includes(i.state.toLowerCase()));
  }

  isTerminalState(state: string): boolean {
    return this.config.terminalStates.map(s => s.toLowerCase()).includes(state.toLowerCase());
  }

  isActiveState(state: string): boolean {
    return this.config.activeStates.map(s => s.toLowerCase()).includes(state.toLowerCase());
  }

  async createIssue(data: IssueCreateData): Promise<Issue> {
    const args = [
      'issue', 'create',
      '--title', data.title,
      '--repo', this.projectPath,
    ];
    if (data.description) {
      args.push('--description', data.description);
    }
    if (data.labels && data.labels.length > 0) {
      args.push('--label', data.labels.join(','));
    }

    const output = this.runGlab(args);
    const urlMatch = output.match(/https?:\/\/\S+/);
    const iidMatch = output.match(/\/issues\/(\d+)/);
    const iid = iidMatch ? parseInt(iidMatch[1], 10) : null;

    if (!iid) {
      throw new Error(`Failed to parse issue IID from glab output: ${output}`);
    }

    const glabIssue = this.getGlabIssue(iid);
    if (!glabIssue) {
      throw new Error(`Failed to fetch newly created issue #${iid}`);
    }

    if (data.workflowId || data.model) {
      const db = this.getDb();
      const now = new Date().toISOString();
      const gitlabId = String(glabIssue.id);
      db.prepare(`
        INSERT OR REPLACE INTO issue_meta (gitlab_id, workflow_id, model, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(gitlabId, data.workflowId ?? null, data.model ?? null, now);
    }

    log.info('Created GitLab issue', { iid, url: urlMatch?.[0] });
    return this.normalizeIssue(glabIssue);
  }

  async updateIssue(issueId: string, data: IssueUpdateData): Promise<Issue | null> {
    const glabIssue = this.getGlabIssue(issueId);
    if (!glabIssue) return null;

    const args = ['issue', 'update', String(glabIssue.iid), '--repo', this.projectPath];
    if (data.title !== undefined) args.push('--title', data.title);
    if (data.description !== undefined) args.push('--description', data.description ?? '');
    if (data.labels !== undefined) args.push('--label', data.labels.join(','));

    if (args.length > 5) {
      this.runGlab(args);
    }

    if (data.state !== undefined) {
      await this.updateIssueStateOnGitLab(glabIssue.iid, data.state);
    }

    if (data.workflowId !== undefined || data.model !== undefined) {
      const db = this.getDb();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO issue_meta (gitlab_id, workflow_id, model, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(gitlab_id) DO UPDATE SET
          workflow_id = COALESCE(excluded.workflow_id, workflow_id),
          model = COALESCE(excluded.model, model),
          updated_at = excluded.updated_at
      `).run(
        issueId,
        data.workflowId ?? null,
        data.model ?? null,
        now
      );
    }

    const updated = this.getGlabIssue(glabIssue.iid);
    return updated ? this.normalizeIssue(updated) : null;
  }

  async deleteIssue(issueId: string): Promise<boolean> {
    const glabIssue = this.getGlabIssue(issueId);
    if (!glabIssue) return false;

    try {
      this.runGlab(['issue', 'delete', String(glabIssue.iid), '--repo', this.projectPath, '--yes']);
      log.info('Deleted GitLab issue', { issueId, iid: glabIssue.iid });
      return true;
    } catch (err) {
      log.error('Failed to delete GitLab issue', { issueId, error: (err as Error).message });
      return false;
    }
  }

  private async updateIssueStateOnGitLab(iid: number, newState: string): Promise<void> {
    const terminalStates = this.config.terminalStates.map(s => s.toLowerCase());
    const activeStates = this.config.activeStates.map(s => s.toLowerCase());

    if (terminalStates.includes(newState.toLowerCase())) {
      try {
        this.runGlab(['issue', 'close', String(iid), '--repo', this.projectPath]);
      } catch (err) {
        log.warn('Failed to close GitLab issue', { iid, error: (err as Error).message });
      }
    } else if (activeStates.includes(newState.toLowerCase())) {
      try {
        this.runGlab(['issue', 'reopen', String(iid), '--repo', this.projectPath]);
      } catch (err) {
        log.warn('Failed to reopen GitLab issue', { iid, error: (err as Error).message });
      }

      const labelsArg = newState;
      try {
        this.runGlab(['issue', 'update', String(iid), '--repo', this.projectPath, '--label', labelsArg]);
      } catch (err) {
        log.warn('Failed to update state label on GitLab issue', { iid, newState, error: (err as Error).message });
      }
    }
  }

  async updateIssueState(issueId: string, newState: string): Promise<void> {
    const glabIssue = this.getGlabIssue(issueId);
    if (!glabIssue) {
      log.warn('Issue not found for state update', { issueId });
      return;
    }
    await this.updateIssueStateOnGitLab(glabIssue.iid, newState);
    log.info('Updated GitLab issue state', { issueId, iid: glabIssue.iid, newState });
  }

  async updateIssueSessionId(issueId: string, sessionId: string | null): Promise<void> {
    const db = this.getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO issue_meta (gitlab_id, session_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(gitlab_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at
    `).run(issueId, sessionId, now);
    log.info('Updated session_id for GitLab issue', { issueId, sessionId });
  }

  async updateIssueWorkspacePath(issueId: string, workspacePath: string | null): Promise<void> {
    const db = this.getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO issue_meta (gitlab_id, workspace_path, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(gitlab_id) DO UPDATE SET workspace_path = excluded.workspace_path, updated_at = excluded.updated_at
    `).run(issueId, workspacePath, now);
    log.info('Updated workspace_path for GitLab issue', { issueId, workspacePath });
  }

  async addComment(issueId: string, author: 'human' | 'agent', content: string): Promise<IssueComment> {
    const db = this.getDb();
    const now = new Date().toISOString();
    const id = `comment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    db.prepare(`
      INSERT INTO comments (id, gitlab_id, author, content, created_at) VALUES (?, ?, ?, ?, ?)
    `).run(id, issueId, author, content, now);

    if (author === 'agent') {
      const glabIssue = this.getGlabIssue(issueId);
      if (glabIssue) {
        try {
          this.runGlab([
            'issue', 'note', String(glabIssue.iid),
            '--message', content,
            '--repo', this.projectPath,
          ]);
        } catch (err) {
          log.warn('Failed to post comment to GitLab', { issueId, error: (err as Error).message });
        }
      }
    }

    log.info('Added comment to GitLab issue', { issueId, author, id });
    return { id, author, content, createdAt: new Date(now) };
  }

  async getComments(issueId: string): Promise<IssueComment[]> {
    const db = this.getDb();
    const rows = db.prepare(`
      SELECT id, author, content, created_at FROM comments WHERE gitlab_id = ? ORDER BY created_at ASC
    `).all(issueId) as Array<Record<string, unknown>>;

    const localComments: IssueComment[] = rows.map(r => ({
      id: r.id as string,
      author: r.author as 'human' | 'agent',
      content: r.content as string,
      createdAt: new Date(r.created_at as string),
    }));

    const glabIssue = this.getGlabIssue(issueId);
    if (!glabIssue) return localComments;

    const notes = this.getGlabIssueNotes(glabIssue.iid);
    const localIds = new Set(localComments.map(c => c.content));

    const remoteComments: IssueComment[] = notes
      .filter(n => !localIds.has(n.body))
      .map(n => ({
        id: `gitlab-note-${n.id}`,
        author: 'human' as const,
        content: n.body,
        createdAt: new Date(n.created_at),
      }));

    return [...localComments, ...remoteComments].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
    );
  }

  async addLog(
    issueId: string,
    content: string,
    sessionId?: string | null,
    workflowId?: string | null
  ): Promise<IssueLog> {
    const db = this.getDb();
    const now = new Date().toISOString();
    const id = `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    db.prepare(`
      INSERT INTO session_logs (id, gitlab_id, session_id, workflow_id, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, issueId, sessionId ?? null, workflowId ?? null, content, now);

    return {
      id,
      issueId,
      sessionId: sessionId ?? null,
      workflowId: workflowId ?? null,
      content,
      createdAt: new Date(now),
    };
  }

  async getLogs(issueId: string): Promise<IssueLog[]> {
    const db = this.getDb();
    const rows = db.prepare(`
      SELECT id, gitlab_id, session_id, workflow_id, content, created_at
      FROM session_logs WHERE gitlab_id = ? ORDER BY created_at ASC
    `).all(issueId) as Array<Record<string, unknown>>;

    return rows.map(r => ({
      id: r.id as string,
      issueId: r.gitlab_id as string,
      sessionId: r.session_id as string | null,
      workflowId: r.workflow_id as string | null,
      content: r.content as string,
      createdAt: new Date(r.created_at as string),
    }));
  }

  async startWatching(onChange: () => void): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    const poll = async () => {
      try {
        const issues = this.listGlabIssues('opened');
        const sig = issues.map(i => `${i.id}:${i.updated_at}:${i.state}`).join('|');
        if (sig !== this.lastIssueSig) {
          this.lastIssueSig = sig;
          log.debug('GitLab issues changed, notifying listeners');
          onChange();
        }
      } catch (err) {
        log.warn('Poll failed', { error: (err as Error).message });
      }
    };

    this.pollTimer = setInterval(poll, this.config.pollIntervalMs);
    log.info('Started polling GitLab for changes', { intervalMs: this.config.pollIntervalMs });
  }

  async resolveIssueId(idOrIdentifier: string): Promise<string | null> {
    const iidMatch = idOrIdentifier.match(/#(\d+)$/) ?? idOrIdentifier.match(/^(\d+)$/);
    if (iidMatch) {
      const glabIssue = this.getGlabIssue(iidMatch[1]);
      return glabIssue ? String(glabIssue.id) : null;
    }

    const issues = this.listGlabIssues('all');
    const match = issues.find(
      i => String(i.id) === idOrIdentifier || `${this.projectPath}#${i.iid}` === idOrIdentifier
    );
    return match ? String(match.id) : null;
  }

  async createSession(
    issueId: string,
    sessionId: string,
    workflowId: string | null,
    workflowName: string | null,
    workspacePath: string | null,
    worktreeRoot?: string | null
  ): Promise<IssueSession> {
    const db = this.getDb();
    const now = new Date().toISOString();
    const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    db.prepare(`
      INSERT INTO issue_sessions (id, gitlab_id, session_id, workflow_id, workflow_name, workspace_path, worktree_root, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(id, issueId, sessionId, workflowId, workflowName, workspacePath, worktreeRoot ?? null, now);

    log.info('Created session record', { id, issueId, sessionId });

    return {
      id,
      issueId,
      sessionId,
      workflowId,
      workflowName,
      workspacePath,
      worktreeRoot: worktreeRoot ?? null,
      isActive: true,
      createdAt: new Date(now),
    };
  }

  async deactivateSession(sessionId: string): Promise<void> {
    const db = this.getDb();
    const result = db.prepare(`UPDATE issue_sessions SET is_active = 0 WHERE session_id = ?`).run(sessionId);
    if (result.changes > 0) {
      log.info('Deactivated session', { sessionId });
    }
  }

  async getIssueSessions(issueId: string): Promise<IssueSession[]> {
    const db = this.getDb();
    const rows = db.prepare(`
      SELECT id, gitlab_id, session_id, workflow_id, workflow_name, workspace_path, worktree_root, is_active, created_at
      FROM issue_sessions WHERE gitlab_id = ? ORDER BY created_at DESC
    `).all(issueId) as Array<Record<string, unknown>>;

    return rows.map(r => ({
      id: r.id as string,
      issueId: r.gitlab_id as string,
      sessionId: r.session_id as string,
      workflowId: r.workflow_id as string | null,
      workflowName: r.workflow_name as string | null,
      workspacePath: r.workspace_path as string | null,
      worktreeRoot: r.worktree_root as string | null,
      isActive: (r.is_active as number) === 1,
      createdAt: new Date(r.created_at as string),
    }));
  }

  async saveSessionExport(
    issueId: string,
    markdownContent: string,
    sessionCount: number
  ): Promise<SessionExport> {
    const db = this.getDb();
    const now = new Date().toISOString();

    const existing = db.prepare(`SELECT id FROM session_exports WHERE gitlab_id = ?`).get(issueId) as { id: string } | undefined;

    if (existing) {
      db.prepare(`
        UPDATE session_exports SET markdown_content = ?, session_count = ?, updated_at = ? WHERE gitlab_id = ?
      `).run(markdownContent, sessionCount, now, issueId);
      return { id: existing.id, issueId, markdownContent, sessionCount, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    const id = `export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(`
      INSERT INTO session_exports (id, gitlab_id, markdown_content, session_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, issueId, markdownContent, sessionCount, now, now);

    log.info('Created session export', { id, issueId, sessionCount });
    return { id, issueId, markdownContent, sessionCount, createdAt: new Date(now), updatedAt: new Date(now) };
  }

  async getSessionExport(issueId: string): Promise<SessionExport | null> {
    const db = this.getDb();
    const row = db.prepare(`
      SELECT id, gitlab_id, markdown_content, session_count, created_at, updated_at
      FROM session_exports WHERE gitlab_id = ?
    `).get(issueId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: row.id as string,
      issueId: row.gitlab_id as string,
      markdownContent: row.markdown_content as string,
      sessionCount: row.session_count as number,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
