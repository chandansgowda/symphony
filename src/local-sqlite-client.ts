import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Issue, BlockerRef, IssueComment, IssueLog, IssueSession, SessionExport } from './types.js';
import { ServiceConfig } from './config.js';
import { IssueTrackerClient, IssueCreateData, IssueUpdateData } from './issue-tracker.js';
import { WorkflowStore } from './workflow-store.js';
import { Logger } from './logger.js';

const log = new Logger('local-sqlite');

// Debounce interval for file change notifications (ms)
const WATCH_DEBOUNCE_MS = 100;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS issues (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    priority INTEGER,
    state TEXT NOT NULL,
    branch_name TEXT,
    url TEXT,
    labels TEXT,
    workflow_id TEXT,
    model TEXT,
    session_id TEXT,
    workspace_path TEXT,
    created_at TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS blockers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id TEXT NOT NULL,
    blocker_id TEXT,
    blocker_identifier TEXT,
    blocker_state TEXT,
    FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL,
    author TEXT NOT NULL CHECK (author IN ('human', 'agent')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS session_logs (
    id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL,
    session_id TEXT,
    workflow_id TEXT,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS issue_sessions (
    id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    workflow_id TEXT,
    workflow_name TEXT,
    workspace_path TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS session_exports (
    id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL,
    markdown_content TEXT NOT NULL,
    session_count INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_issues_state ON issues(state);
  CREATE INDEX IF NOT EXISTS idx_issues_identifier ON issues(identifier);
  CREATE INDEX IF NOT EXISTS idx_blockers_issue_id ON blockers(issue_id);
  CREATE INDEX IF NOT EXISTS idx_comments_issue_id ON comments(issue_id);
  CREATE INDEX IF NOT EXISTS idx_session_logs_issue_id ON session_logs(issue_id);
  CREATE INDEX IF NOT EXISTS idx_issue_sessions_issue_id ON issue_sessions(issue_id);
  CREATE INDEX IF NOT EXISTS idx_session_exports_issue_id ON session_exports(issue_id);
`;

export class LocalSqliteClient implements IssueTrackerClient {
  private config: ServiceConfig;
  private dbPath: string;
  private db: Database.Database | null = null;
  private lastLoggedState: string | null = null;
  private fileWatcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: ServiceConfig) {
    this.config = config;
    this.dbPath = config.trackerIssuesPath;
    this.initializeDb();
  }

  private initializeDb(): void {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);

    // Migration: Add workspace_path column if it doesn't exist
    const columns = this.db.prepare(`PRAGMA table_info(issues)`).all() as Array<{ name: string }>;
    const hasWorkspacePath = columns.some(col => col.name === 'workspace_path');
    if (!hasWorkspacePath) {
      this.db.exec(`ALTER TABLE issues ADD COLUMN workspace_path TEXT`);
      log.info('Migrated database: added workspace_path column');
    }

    // Migration: Add content column to session_logs if it doesn't exist
    const sessionLogColumns = this.db.prepare(`PRAGMA table_info(session_logs)`).all() as Array<{ name: string }>;
    const hasContent = sessionLogColumns.some(col => col.name === 'content');
    if (!hasContent) {
      this.db.exec(`ALTER TABLE session_logs ADD COLUMN content TEXT NOT NULL DEFAULT ''`);
      log.info('Migrated database: added content column to session_logs');
    }

    // Migration: Add model column to issues if it doesn't exist
    const hasModel = columns.some(col => col.name === 'model');
    if (!hasModel) {
      this.db.exec(`ALTER TABLE issues ADD COLUMN model TEXT`);
      log.info('Migrated database: added model column to issues');
    }

    // Migration: Add worktree_root column to issue_sessions if it doesn't exist
    const sessionColumns = this.db.prepare(`PRAGMA table_info(issue_sessions)`).all() as Array<{ name: string }>;
    const hasWorktreeRoot = sessionColumns.some(col => col.name === 'worktree_root');
    if (!hasWorktreeRoot) {
      this.db.exec(`ALTER TABLE issue_sessions ADD COLUMN worktree_root TEXT`);
      log.info('Migrated database: added worktree_root column to issue_sessions');
    }

    const migrated = this.db.prepare(`
      UPDATE issues SET state = 'Done', updated_at = ? 
      WHERE state IN ('Cancelled', 'Canceled')
    `).run(new Date().toISOString());
    if (migrated.changes > 0) {
      log.info('Migrated Cancelled issues to Done', { count: migrated.changes });
    }

    log.info('SQLite database initialized', { path: this.dbPath });
  }

  private getDb(): Database.Database {
    if (!this.db) {
      this.initializeDb();
    }
    return this.db!;
  }

  updateConfig(config: ServiceConfig): void {
    this.config = config;
    if (config.trackerIssuesPath !== this.dbPath) {
      if (this.db) {
        this.db.close();
        this.db = null;
      }
      this.dbPath = config.trackerIssuesPath;
      this.lastLoggedState = null;
      this.initializeDb();
    }
  }

  setWorkflowStore(_store: WorkflowStore): void {}

  private loadIssue(row: Record<string, unknown>): Issue {
    const db = this.getDb();
    const issueId = row.id as string;

    const blockerRows = db.prepare(`
      SELECT blocker_id, blocker_identifier, blocker_state
      FROM blockers WHERE issue_id = ?
    `).all(issueId) as Array<Record<string, unknown>>;

    const blockers: BlockerRef[] = blockerRows.map(b => ({
      id: b.blocker_id as string | null,
      identifier: b.blocker_identifier as string | null,
      state: b.blocker_state as string | null,
    }));

    const commentRows = db.prepare(`
      SELECT id, author, content, created_at
      FROM comments WHERE issue_id = ?
      ORDER BY created_at ASC
    `).all(issueId) as Array<Record<string, unknown>>;

    const comments: IssueComment[] = commentRows.map(c => ({
      id: c.id as string,
      author: c.author as 'human' | 'agent',
      content: c.content as string,
      createdAt: new Date(c.created_at as string),
    }));

    let labels: string[] = [];
    if (row.labels) {
      try {
        labels = JSON.parse(row.labels as string);
      } catch {
        labels = [];
      }
    }

    return {
      id: row.id as string,
      identifier: row.identifier as string,
      title: row.title as string,
      description: (row.description as string) ?? null,
      priority: (row.priority as number) ?? null,
      state: row.state as string,
      branchName: (row.branch_name as string) ?? null,
      url: (row.url as string) ?? null,
      labels: labels.map(l => l.toLowerCase()),
      blockedBy: blockers,
      comments,
      workflowId: (row.workflow_id as string) ?? null,
      sessionId: (row.session_id as string) ?? null,
      workspacePath: (row.workspace_path as string) ?? null,
      model: (row.model as string) ?? null,
      createdAt: row.created_at ? new Date(row.created_at as string) : null,
      updatedAt: row.updated_at ? new Date(row.updated_at as string) : null,
    };
  }

  private loadAllIssues(excludeTerminal: boolean = true): Issue[] {
    const db = this.getDb();
    
    let query = 'SELECT * FROM issues';
    const params: string[] = [];

    if (excludeTerminal) {
      const terminalStates = this.config.terminalStates.map(s => s.toLowerCase());
      if (terminalStates.length > 0) {
        const placeholders = terminalStates.map(() => '?').join(', ');
        query += ` WHERE LOWER(state) NOT IN (${placeholders})`;
        params.push(...terminalStates);
      }
    }

    const rows = db.prepare(query).all(...params) as Array<Record<string, unknown>>;
    return rows.map(row => this.loadIssue(row));
  }

  async fetchAllIssues(): Promise<Issue[]> {
    return this.loadAllIssues(false);
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    const allIssues = this.loadAllIssues(true);
    const activeStates = this.getAggregatedActiveStates();

    const candidates = allIssues.filter(issue =>
      activeStates.includes(issue.state.toLowerCase())
    );

    const currentState = `${allIssues.length}:${candidates.length}`;
    if (currentState !== this.lastLoggedState) {
      log.info('Fetched candidate issues', {
        total: allIssues.length,
        candidates: candidates.length,
        activeStates,
      });
      this.lastLoggedState = currentState;
    } else {
      log.debug('.');
    }

    return candidates;
  }

  private getAggregatedActiveStates(): string[] {
    return this.config.activeStates.map(s => s.toLowerCase());
  }

  async fetchIssuesByIds(issueIds: string[]): Promise<Map<string, Issue>> {
    const db = this.getDb();
    const result = new Map<string, Issue>();

    if (issueIds.length === 0) return result;

    const placeholders = issueIds.map(() => '?').join(', ');
    const rows = db.prepare(`SELECT * FROM issues WHERE id IN (${placeholders})`).all(...issueIds) as Array<Record<string, unknown>>;

    for (const row of rows) {
      const issue = this.loadIssue(row);
      result.set(issue.id, issue);
    }

    return result;
  }

  async fetchTerminalIssues(): Promise<Issue[]> {
    const db = this.getDb();
    const terminalStates = this.config.terminalStates.map(s => s.toLowerCase());
    
    if (terminalStates.length === 0) return [];

    const placeholders = terminalStates.map(() => '?').join(', ');
    const rows = db.prepare(`SELECT * FROM issues WHERE LOWER(state) IN (${placeholders})`).all(...terminalStates) as Array<Record<string, unknown>>;

    return rows.map(row => this.loadIssue(row));
  }

  isTerminalState(state: string): boolean {
    return this.config.terminalStates.map(s => s.toLowerCase()).includes(state.toLowerCase());
  }

  isActiveState(state: string): boolean {
    return this.config.activeStates.map(s => s.toLowerCase()).includes(state.toLowerCase());
  }

  async createIssue(data: IssueCreateData): Promise<Issue> {
    const db = this.getDb();
    const now = new Date().toISOString();
    const id = data.id ?? `issue-${Date.now()}`;
    const identifier = data.identifier ?? `TASK-${Date.now()}`;

    db.prepare(`
      INSERT INTO issues (
        id, identifier, title, description, priority, state,
        branch_name, url, labels, workflow_id, session_id, model,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      identifier,
      data.title,
      data.description ?? null,
      data.priority ?? null,
      data.state,
      data.branchName ?? null,
      data.url ?? null,
      JSON.stringify(data.labels ?? []),
      data.workflowId ?? null,
      null,
      data.model ?? null,
      now,
      now
    );

    log.info('Created issue', { id, identifier });

    return {
      id,
      identifier,
      title: data.title,
      description: data.description ?? null,
      priority: data.priority ?? null,
      state: data.state,
      branchName: data.branchName ?? null,
      url: data.url ?? null,
      labels: data.labels ?? [],
      blockedBy: [],
      comments: [],
      workflowId: data.workflowId ?? null,
      sessionId: null,
      workspacePath: null,
      model: data.model ?? null,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };
  }

  async updateIssue(issueId: string, data: IssueUpdateData): Promise<Issue | null> {
    const db = this.getDb();
    const now = new Date().toISOString();

    const row = db.prepare(`SELECT * FROM issues WHERE id = ? OR identifier = ?`).get(issueId, issueId) as Record<string, unknown> | undefined;
    if (!row) return null;

    const updates: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (data.title !== undefined) { updates.push('title = ?'); values.push(data.title); }
    if (data.description !== undefined) { updates.push('description = ?'); values.push(data.description); }
    if (data.priority !== undefined) { updates.push('priority = ?'); values.push(data.priority); }
    if (data.state !== undefined) { updates.push('state = ?'); values.push(data.state); }
    if (data.branchName !== undefined) { updates.push('branch_name = ?'); values.push(data.branchName); }
    if (data.url !== undefined) { updates.push('url = ?'); values.push(data.url); }
    if (data.labels !== undefined) { updates.push('labels = ?'); values.push(JSON.stringify(data.labels)); }
    if (data.workflowId !== undefined) { updates.push('workflow_id = ?'); values.push(data.workflowId); }
    if (data.model !== undefined) { updates.push('model = ?'); values.push(data.model); }

    values.push(row.id);
    db.prepare(`UPDATE issues SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    log.info('Updated issue', { issueId: row.id });

    const updatedRow = db.prepare(`SELECT * FROM issues WHERE id = ?`).get(row.id) as Record<string, unknown>;
    return this.loadIssue(updatedRow);
  }

  async deleteIssue(issueId: string): Promise<boolean> {
    const db = this.getDb();
    const result = db.prepare(`DELETE FROM issues WHERE id = ? OR identifier = ?`).run(issueId, issueId);
    
    if (result.changes > 0) {
      log.info('Deleted issue', { issueId });
      return true;
    }
    return false;
  }

  async updateIssueState(issueId: string, newState: string): Promise<void> {
    const db = this.getDb();
    const now = new Date().toISOString();

    db.prepare(`UPDATE issues SET state = ?, updated_at = ? WHERE id = ?`).run(newState, now, issueId);
    log.info('Updated issue state', { issueId, newState });
  }

  async updateIssueSessionId(issueId: string, sessionId: string | null): Promise<void> {
    const db = this.getDb();
    const now = new Date().toISOString();

    db.prepare(`UPDATE issues SET session_id = ?, updated_at = ? WHERE id = ?`).run(sessionId, now, issueId);
    log.info('Updated issue session_id', { issueId, sessionId });
  }

  async updateIssueWorkspacePath(issueId: string, workspacePath: string | null): Promise<void> {
    const db = this.getDb();
    const now = new Date().toISOString();

    db.prepare(`UPDATE issues SET workspace_path = ?, updated_at = ? WHERE id = ?`).run(workspacePath, now, issueId);
    log.info('Updated issue workspace_path', { issueId, workspacePath });
  }

  async addComment(issueId: string, author: 'human' | 'agent', content: string): Promise<IssueComment> {
    const db = this.getDb();
    const now = new Date().toISOString();
    const commentId = `comment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    db.prepare(`
      INSERT INTO comments (id, issue_id, author, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(commentId, issueId, author, content, now);

    db.prepare(`UPDATE issues SET updated_at = ? WHERE id = ?`).run(now, issueId);

    log.info('Added comment to issue', { issueId, author, commentId });

    return {
      id: commentId,
      author,
      content,
      createdAt: new Date(now),
    };
  }

  async getComments(issueId: string): Promise<IssueComment[]> {
    const db = this.getDb();
    const rows = db.prepare(`
      SELECT id, author, content, created_at
      FROM comments WHERE issue_id = ?
      ORDER BY created_at ASC
    `).all(issueId) as Array<Record<string, unknown>>;

    return rows.map(c => ({
      id: c.id as string,
      author: c.author as 'human' | 'agent',
      content: c.content as string,
      createdAt: new Date(c.created_at as string),
    }));
  }

  async addLog(issueId: string, content: string, sessionId?: string | null, workflowId?: string | null): Promise<IssueLog> {
    const db = this.getDb();
    const now = new Date().toISOString();
    const logId = `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    db.prepare(`
      INSERT INTO session_logs (id, issue_id, session_id, workflow_id, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(logId, issueId, sessionId ?? null, workflowId ?? null, content, now);

    db.prepare(`UPDATE issues SET updated_at = ? WHERE id = ?`).run(now, issueId);

    log.info('Added session log to issue', { issueId, logId });

    return {
      id: logId,
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
      SELECT id, issue_id, session_id, workflow_id, content, created_at
      FROM session_logs WHERE issue_id = ?
      ORDER BY created_at ASC
    `).all(issueId) as Array<Record<string, unknown>>;

    return rows.map(l => ({
      id: l.id as string,
      issueId: l.issue_id as string,
      sessionId: l.session_id as string | null,
      workflowId: l.workflow_id as string | null,
      content: l.content as string,
      createdAt: new Date(l.created_at as string),
    }));
  }

  async startWatching(onChange: () => void): Promise<void> {
    this.stopWatching();
    
    const dbDir = path.dirname(this.dbPath);
    const dbFileName = path.basename(this.dbPath);
    const walFileName = `${dbFileName}-wal`;
    
    try {
      this.fileWatcher = fs.watch(dbDir, (_eventType, filename) => {
        // On macOS, filename can be null for directory watches - treat as potential match
        if (!filename || filename === dbFileName || filename === walFileName) {
          if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
          }
          this.debounceTimer = setTimeout(() => {
            log.debug('Database file changed, notifying listeners');
            onChange();
          }, WATCH_DEBOUNCE_MS);
        }
      });
      
      log.info('Started watching database for changes', { path: this.dbPath });
    } catch (err) {
      log.warn('Failed to watch database file', { error: (err as Error).message });
    }
  }

  private stopWatching(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
  }

  async resolveIssueId(idOrIdentifier: string): Promise<string | null> {
    const db = this.getDb();
    const row = db.prepare(`SELECT id FROM issues WHERE id = ? OR identifier = ?`).get(idOrIdentifier, idOrIdentifier) as { id: string } | undefined;
    return row?.id ?? null;
  }

  // ============================================================================
  // Session History Management
  // ============================================================================

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
      INSERT INTO issue_sessions (id, issue_id, session_id, workflow_id, workflow_name, workspace_path, worktree_root, is_active, created_at)
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

  async getSessionsWithoutWorktreeRoot(): Promise<Array<{ id: string; workspacePath: string }>> {
    const db = this.getDb();
    const rows = db.prepare(`
      SELECT id, workspace_path FROM issue_sessions
      WHERE worktree_root IS NULL AND workspace_path IS NOT NULL
    `).all() as Array<Record<string, unknown>>;
    return rows.map(row => ({
      id: row.id as string,
      workspacePath: row.workspace_path as string,
    }));
  }

  async updateSessionWorktreeRoot(sessionId: string, worktreeRoot: string): Promise<void> {
    const db = this.getDb();
    db.prepare(`UPDATE issue_sessions SET worktree_root = ? WHERE id = ?`).run(worktreeRoot, sessionId);
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
      SELECT id, issue_id, session_id, workflow_id, workflow_name, workspace_path, worktree_root, is_active, created_at
      FROM issue_sessions WHERE issue_id = ?
      ORDER BY created_at DESC
    `).all(issueId) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      id: row.id as string,
      issueId: row.issue_id as string,
      sessionId: row.session_id as string,
      workflowId: row.workflow_id as string | null,
      workflowName: row.workflow_name as string | null,
      workspacePath: row.workspace_path as string | null,
      worktreeRoot: row.worktree_root as string | null,
      isActive: (row.is_active as number) === 1,
      createdAt: new Date(row.created_at as string),
    }));
  }

  async saveSessionExport(issueId: string, markdownContent: string, sessionCount: number): Promise<SessionExport> {
    const db = this.getDb();
    const now = new Date().toISOString();
    
    const existing = db.prepare(`SELECT id FROM session_exports WHERE issue_id = ?`).get(issueId) as { id: string } | undefined;
    
    if (existing) {
      db.prepare(`
        UPDATE session_exports SET markdown_content = ?, session_count = ?, updated_at = ?
        WHERE issue_id = ?
      `).run(markdownContent, sessionCount, now, issueId);
      
      log.info('Updated session export', { issueId, sessionCount });
      
      return {
        id: existing.id,
        issueId,
        markdownContent,
        sessionCount,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      };
    }
    
    const id = `export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    
    db.prepare(`
      INSERT INTO session_exports (id, issue_id, markdown_content, session_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, issueId, markdownContent, sessionCount, now, now);
    
    log.info('Created session export', { id, issueId, sessionCount });
    
    return {
      id,
      issueId,
      markdownContent,
      sessionCount,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };
  }

  async getSessionExport(issueId: string): Promise<SessionExport | null> {
    const db = this.getDb();
    const row = db.prepare(`
      SELECT id, issue_id, markdown_content, session_count, created_at, updated_at
      FROM session_exports WHERE issue_id = ?
    `).get(issueId) as Record<string, unknown> | undefined;
    
    if (!row) return null;
    
    return {
      id: row.id as string,
      issueId: row.issue_id as string,
      markdownContent: row.markdown_content as string,
      sessionCount: row.session_count as number,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  close(): void {
    this.stopWatching();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
