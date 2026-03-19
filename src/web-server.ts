import express, { Response } from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'fs';
import { uniqueNamesGenerator, adjectives, animals } from 'unique-names-generator';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { Orchestrator } from './orchestrator.js';
import { ServiceConfig } from './config.js';
import { IssueTrackerClient } from './issue-tracker.js';
import { WorkflowStore } from './workflow-store.js';
import { LocalConfigStore } from './local-config-store.js';
import { getLogs, setLogStreamCallback } from './log-buffer.js';
import { Logger } from './logger.js';
import { AgentLogEntry, InputRequest, StoredWorkflow, Issue, IssueSession, IssueComment, IssueLog } from './types.js';
import { ChatManager, ChatEvent } from './chat-manager.js';

const log = new Logger('web');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const getUiDir = (): string => {
  if (__dirname.endsWith('/src') || __dirname.endsWith('\\src')) {
    return join(__dirname, '..', 'dist', 'ui');
  }
  return join(__dirname, 'ui');
};

const uiDir = getUiDir();

interface WebServerOptions {
  port: number;
  orchestrator: Orchestrator;
  config: ServiceConfig;
  workflowStore: WorkflowStore;
  localConfigStore: LocalConfigStore;
  issueTracker: IssueTrackerClient;
}

export class WebServer {
  private app: express.Application;
  private port: number;
  private orchestrator: Orchestrator;
  private config: ServiceConfig;
  private workflowStore: WorkflowStore;
  private localConfigStore: LocalConfigStore;
  private issueTracker: IssueTrackerClient;
  private chatManager: ChatManager;
  private sseClients: Set<Response> = new Set();
  private chatSseClients: Set<Response> = new Set();
  private agentLogs: Map<string, AgentLogEntry[]> = new Map();
  private maxAgentLogEntries = 200;

  constructor(options: WebServerOptions) {
    this.port = options.port;
    this.orchestrator = options.orchestrator;
    this.config = options.config;
    this.workflowStore = options.workflowStore;
    this.localConfigStore = options.localConfigStore;
    this.issueTracker = options.issueTracker;
    this.app = express();
    this.chatManager = new ChatManager({
      config: this.config,
      workflowStore: this.workflowStore,
      dataDir: this.config.dataDir,
    });

    this.setupMiddleware();
    this.setupRoutes();
    this.setupLogCapture();
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use((_req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
      next();
    });
  }

  private setupRoutes(): void {
    this.app.get('/', (_req, res) => {
      res.send(this.getDashboardHTML());
    });

    this.app.get('/ui/bundle.js', (_req, res) => {
      const bundlePath = join(uiDir, 'bundle.js');
      if (existsSync(bundlePath)) {
        try {
          res.type('application/javascript');
          res.send(readFileSync(bundlePath, 'utf-8'));
        } catch (err) {
          log.error('Failed to read bundle.js', { error: (err as Error).message });
          res.status(500).send('Failed to read bundle');
        }
      } else {
        res.status(404).send('Bundle not found');
      }
    });

    this.app.get('/ui/styles.css', (_req, res) => {
      const stylesPath = join(uiDir, 'styles.css');
      if (existsSync(stylesPath)) {
        try {
          res.type('text/css');
          res.send(readFileSync(stylesPath, 'utf-8'));
        } catch (err) {
          log.error('Failed to read styles.css', { error: (err as Error).message });
          res.status(500).send('Failed to read styles');
        }
      } else {
        res.status(404).send('Styles not found');
      }
    });

    this.app.get('/api/status', (_req, res) => {
      const status = this.orchestrator.getStatus();
      const frontendStatus = {
        running: status.running,
        runningAgents: status.runningIssues.map((issue) => ({
          issueId: issue.id,
          identifier: issue.identifier,
          startedAt: new Date(issue.startedAt).getTime(),
          sessionId: issue.sessionId ?? undefined,
          workspacePath: issue.workspacePath,
          worktreeRoot: issue.worktreeRoot ?? undefined,
        })),
        pendingInputRequests: {},
      };
      res.json(frontendStatus);
    });

    this.app.get('/api/generate-identifier', (_req, res) => {
      const identifier = uniqueNamesGenerator({
        dictionaries: [adjectives, animals],
        separator: '-',
        length: 2,
      });
      res.json({ identifier });
    });

    this.app.get('/api/issues', async (_req, res) => {
      try {
        const issues = await this.issueTracker.fetchAllIssues();
        const issuesWithSessions = await Promise.all(
          issues.map(async (issue) => {
            const sessions = await this.issueTracker.getIssueSessions(issue.id);
            return {
              ...issue,
              sessions: sessions.map(s => ({
                id: s.id,
                issueId: s.issueId,
                sessionId: s.sessionId,
                workflowId: s.workflowId,
                workflowName: s.workflowName,
                workspacePath: s.workspacePath,
                worktreeRoot: s.worktreeRoot,
                isActive: s.isActive,
                createdAt: s.createdAt.toISOString(),
              })),
            };
          })
        );
        res.json(issuesWithSessions);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.post('/api/issues', async (req, res) => {
      try {
        const randomId = uniqueNamesGenerator({
          dictionaries: [adjectives, animals],
          separator: '-',
          length: 2,
        });
        
        const issue = await this.issueTracker.createIssue({
          id: req.body.id,
          identifier: req.body.identifier || randomId,
          title: req.body.title,
          description: req.body.description,
          state: req.body.state || 'Backlog',
          branchName: req.body.branch_name,
          url: req.body.url,
          labels: req.body.labels,
          workflowId: req.body.workflowId || req.body.workflow_id,
          model: req.body.model ?? null,
        });
        
        this.broadcastIssuesUpdated();
        res.json(issue);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.put('/api/issues/:id', async (req, res) => {
      try {
        const issue = await this.issueTracker.updateIssue(req.params.id, {
          title: req.body.title,
          description: req.body.description,
          state: req.body.state,
          branchName: req.body.branch_name,
          url: req.body.url,
          labels: req.body.labels,
          workflowId: req.body.workflowId || req.body.workflow_id,
          model: req.body.model !== undefined ? req.body.model : undefined,
        });
        
        if (!issue) {
          res.status(404).json({ error: 'Issue not found' });
          return;
        }
        
        this.broadcastIssuesUpdated();
        res.json(issue);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.get('/api/issues/:id/comments', async (req, res) => {
      try {
        const issueId = await this.issueTracker.resolveIssueId(req.params.id);
        if (!issueId) {
          res.status(404).json({ error: 'Issue not found' });
          return;
        }
        const comments = await this.issueTracker.getComments(issueId);
        res.json(comments);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.post('/api/issues/:id/comments', async (req, res) => {
      try {
        const issueId = await this.issueTracker.resolveIssueId(req.params.id);
        if (!issueId) {
          res.status(404).json({ error: 'Issue not found' });
          return;
        }
        const author = req.body.author || 'human';
        const content = req.body.content;
        
        const comment = await this.issueTracker.addComment(issueId, author, content);
        
        this.broadcastIssuesUpdated();
        this.broadcast({ type: 'comments_updated', data: { issueId } });
        
        if (author === 'human') {
          await this.orchestrator.sendCommentToSession(issueId, content);
        }
        
        res.json(comment);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.post('/api/issues/:id/archive', async (req, res) => {
      try {
        const issueId = await this.issueTracker.resolveIssueId(req.params.id);
        if (!issueId) {
          res.status(404).json({ error: 'Issue not found' });
          return;
        }
        
        const issue = await this.issueTracker.updateIssue(issueId, { state: 'Archived' });
        
        this.broadcastIssuesUpdated();
        res.json({ success: true, issue });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.get('/api/issues/archived', async (_req, res) => {
      try {
        const allIssues = await this.issueTracker.fetchAllIssues();
        const archivedIssues = allIssues
          .filter(issue => issue.state === 'Archived')
          .sort((a, b) => {
            // Sort by createdAt descending (newest first)
            const aTime = a.createdAt?.getTime() ?? 0;
            const bTime = b.createdAt?.getTime() ?? 0;
            return bTime - aTime;
          });
        const issuesWithSessionsAndComments = await Promise.all(
          archivedIssues.map(async (issue) => {
            const [sessions, comments] = await Promise.all([
              this.issueTracker.getIssueSessions(issue.id),
              this.issueTracker.getComments(issue.id),
            ]);
            return {
              ...issue,
              sessions: sessions.map(s => ({
                id: s.id,
                issueId: s.issueId,
                sessionId: s.sessionId,
                workflowId: s.workflowId,
                workflowName: s.workflowName,
                workspacePath: s.workspacePath,
                worktreeRoot: s.worktreeRoot,
                isActive: s.isActive,
                createdAt: s.createdAt.toISOString(),
              })),
              comments: comments.map(c => ({
                id: c.id,
                author: c.author,
                content: c.content,
                createdAt: c.createdAt.toISOString(),
              })),
            };
          })
        );
        res.json(issuesWithSessionsAndComments);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.post('/api/issues/:id/unarchive', async (req, res) => {
      try {
        const issueId = await this.issueTracker.resolveIssueId(req.params.id);
        if (!issueId) {
          res.status(404).json({ error: 'Issue not found' });
          return;
        }
        
        const newState = req.body.state || 'Backlog';
        const issue = await this.issueTracker.updateIssue(issueId, { state: newState });
        
        this.broadcastIssuesUpdated();
        res.json({ success: true, issue });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.get('/api/issues/:id/logs', async (req, res) => {
      try {
        const issueId = await this.issueTracker.resolveIssueId(req.params.id);
        if (!issueId) {
          res.status(404).json({ error: 'Issue not found' });
          return;
        }
        const logs = await this.issueTracker.getLogs(issueId);
        res.json(logs);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.post('/api/issues/:id/logs', async (req, res) => {
      try {
        const issueId = await this.issueTracker.resolveIssueId(req.params.id);
        if (!issueId) {
          res.status(404).json({ error: 'Issue not found' });
          return;
        }
        const { content, sessionId, workflowId } = req.body;
        
        if (!content || typeof content !== 'string') {
          res.status(400).json({ error: 'content is required and must be a string' });
          return;
        }
        
        if (content.length > 10000) {
          res.status(400).json({ error: 'content exceeds maximum length of 10000 characters' });
          return;
        }
        
        const log = await this.issueTracker.addLog(issueId, content, sessionId, workflowId);
        res.json(log);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.get('/api/issues/:id/sessions/export', async (req, res) => {
      try {
        const issueId = await this.issueTracker.resolveIssueId(req.params.id);
        if (!issueId) {
          res.status(404).json({ error: 'Issue not found' });
          return;
        }
        
        const issuesMap = await this.issueTracker.fetchIssuesByIds([issueId]);
        const issue = issuesMap.get(issueId);
        if (!issue) {
          res.status(404).json({ error: 'Issue not found' });
          return;
        }
        
        const sessions = await this.issueTracker.getIssueSessions(issueId);
        const comments = await this.issueTracker.getComments(issueId);
        const logs = await this.issueTracker.getLogs(issueId);

        const serverPort = this.config.serverPort ?? 4096;
        const sessionHistories = new Map<string, Array<{ role: string; text: string; timestamp: number }>>();
        for (const session of sessions) {
          try {
            const client = createOpencodeClient({
              baseUrl: `http://127.0.0.1:${serverPort}`,
              directory: session.workspacePath ?? undefined,
            });
            const result = await client.session.messages({
              sessionID: session.sessionId,
            });
            const messages = result.data ?? [];
            const history: Array<{ role: string; text: string; timestamp: number }> = [];
            for (const msg of messages) {
              const role = msg.info.role;
              const timestamp = msg.info.time.created;

              const textParts = msg.parts
                .filter((p): p is typeof p & { type: 'text'; text: string } => p.type === 'text' && 'text' in p && typeof (p as Record<string, unknown>).text === 'string')
                .map(p => (p as { text: string }).text)
                .join('');
              if (textParts.trim()) {
                history.push({ role, text: textParts, timestamp });
              }
            }
            sessionHistories.set(session.sessionId, history);
          } catch (_err) {
            log.debug('Could not fetch messages for session', { sessionId: session.sessionId, error: (_err as Error).message });
          }
        }
        
        const markdown = this.generateSessionExportMarkdown(issue, sessions, comments, logs, sessionHistories);
        
        const exported = await this.issueTracker.saveSessionExport(issueId, markdown, sessions.length);
        
        res.json({
          id: exported.id,
          issueId: exported.issueId,
          markdownContent: exported.markdownContent,
          sessionCount: exported.sessionCount,
          createdAt: exported.createdAt.toISOString(),
          updatedAt: exported.updatedAt.toISOString(),
        });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.post('/api/issues/:id/handover', async (req, res) => {
      try {
        const resolvedIssueId = await this.issueTracker.resolveIssueId(req.params.id);
        if (!resolvedIssueId) {
          res.status(404).json({ error: 'Issue not found', code: 'ISSUE_NOT_FOUND' });
          return;
        }
        const issueId = resolvedIssueId;
        const requestedState = req.body.new_state ?? req.body.state;
        const newWorkflowId = req.body.new_workflow_id ?? req.body.workflow_id;
        const notes = req.body.handover_notes ?? req.body.notes;

        if (!notes || notes.trim() === '') {
          res.status(400).json({ 
            error: 'Handover notes are required. Please provide context about the current state and what needs to be done next.',
            code: 'HANDOVER_NOTES_REQUIRED'
          });
          return;
        }

        if (newWorkflowId && newWorkflowId.trim()) {
          const { workflow, availableWorkflows, closestMatch } = await this.workflowStore.findWorkflowByNameOrId(newWorkflowId);
          if (!workflow) {
            const errorParts = [`Workflow '${newWorkflowId}' not found.`];
            if (closestMatch) {
              errorParts.push(`Did you mean '${closestMatch.id}'? (similarity: ${Math.round(closestMatch.similarity * 100)}%)`);
            }
            if (availableWorkflows && availableWorkflows.length > 0) {
              errorParts.push(`Available workflows: ${availableWorkflows.map(w => w.id).join(', ')}`);
            }
            res.status(400).json({
              error: errorParts.join(' '),
              code: 'WORKFLOW_NOT_FOUND',
              closestMatch: closestMatch ? { id: closestMatch.id, name: closestMatch.name, similarity: closestMatch.similarity } : null,
              availableWorkflows,
            });
            return;
          }
        }

        const issuesMap = await this.issueTracker.fetchIssuesByIds([issueId]);
        const currentIssue = issuesMap.get(issueId);
        if (!currentIssue) {
          res.status(404).json({ error: 'Issue not found', code: 'ISSUE_NOT_FOUND' });
          return;
        }

        const isWorkflowChange = newWorkflowId && newWorkflowId !== currentIssue.workflowId;
        const effectiveState = isWorkflowChange ? 'Todo' : requestedState;

        let issue: typeof currentIssue | null = currentIssue;

        if (effectiveState || newWorkflowId) {
          issue = await this.issueTracker.updateIssue(issueId, {
            state: effectiveState,
            workflowId: newWorkflowId,
          });
        }

        await this.issueTracker.addComment(issueId, 'agent', `**Handover Notes:**\n${notes}`);

        const sessionTerminated = await this.orchestrator.terminateSession(issueId);

        this.broadcastIssuesUpdated();
        this.broadcast({ type: 'comments_updated', data: { issueId } });

        res.json({ 
          success: true, 
          issue,
          workflowChanged: isWorkflowChange,
          stateOverridden: isWorkflowChange && requestedState && requestedState !== 'Todo',
          sessionTerminated,
        });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.get('/api/logs', (_req, res) => {
      res.json(getLogs());
    });

    this.app.get('/api/workflows', async (_req, res) => {
      try {
        const workflows = await this.workflowStore.listWorkflows();
        res.json(workflows.map(w => this.serializeWorkflow(w)));
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.get('/api/workflows/resolve/:nameOrId', async (req, res) => {
      try {
        const { workflow, availableWorkflows, closestMatch } = await this.workflowStore.findWorkflowByNameOrId(req.params.nameOrId);
        if (!workflow) {
          const errorParts = [`Workflow not found: "${req.params.nameOrId}".`];
          if (closestMatch) {
            errorParts.push(`Did you mean '${closestMatch.id}'? (similarity: ${Math.round(closestMatch.similarity * 100)}%)`);
          }
          if (availableWorkflows && availableWorkflows.length > 0) {
            errorParts.push(`Available workflows: ${availableWorkflows.map(w => w.id).join(', ')}`);
          }
          res.status(404).json({ 
            error: errorParts.join(' '),
            code: 'WORKFLOW_NOT_FOUND',
            closestMatch: closestMatch ? { id: closestMatch.id, name: closestMatch.name, similarity: closestMatch.similarity } : null,
            availableWorkflows,
          });
          return;
        }
        res.json(this.serializeWorkflow(workflow));
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.get('/api/workflows/:id', async (req, res) => {
      try {
        const workflow = await this.workflowStore.getWorkflowFresh(req.params.id);
        if (!workflow) {
          res.status(404).json({ error: 'Workflow not found' });
          return;
        }
        res.json(this.serializeWorkflow(workflow));
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.post('/api/workflows', async (req, res) => {
      try {
        const { name, description, promptTemplate, config, isDefault, maxConcurrentAgents } = req.body;
        
        if (!name || !promptTemplate) {
          res.status(400).json({ error: 'Name and promptTemplate are required' });
          return;
        }

        const workflow = await this.workflowStore.createWorkflow({
          name,
          description: description ?? null,
          promptTemplate,
          config: config ?? {},
          isDefault: isDefault ?? false,
          maxConcurrentAgents: typeof maxConcurrentAgents === 'number' ? maxConcurrentAgents : 1,
        });

        this.broadcast({ type: 'workflows_updated' });
        res.json(this.serializeWorkflow(workflow));
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.put('/api/workflows/:id', async (req, res) => {
      try {
        const { name, description, promptTemplate, config, isDefault, maxConcurrentAgents } = req.body;
        
        const workflow = await this.workflowStore.updateWorkflow(req.params.id, {
          name,
          description,
          promptTemplate,
          config,
          isDefault,
          maxConcurrentAgents,
        });

        if (!workflow) {
          res.status(404).json({ error: 'Workflow not found' });
          return;
        }

        this.broadcast({ type: 'workflows_updated' });
        res.json(this.serializeWorkflow(workflow));
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.delete('/api/workflows/:id', async (req, res) => {
      try {
        const deleted = await this.workflowStore.deleteWorkflow(req.params.id);
        if (!deleted) {
          res.status(404).json({ error: 'Workflow not found' });
          return;
        }

        this.broadcast({ type: 'workflows_updated' });
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.get('/api/settings', async (_req, res) => {
      try {
        const config = await this.localConfigStore.getConfig();
        res.json(config);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.put('/api/settings', async (req, res) => {
      try {
        const { privateWorkflowsDir, privateWorkflowsEnabled, workflowBadgeMode, theme, safeExecute } = req.body;
        
        const updates: { privateWorkflowsDir?: string | null; privateWorkflowsEnabled?: boolean; workflowBadgeMode?: 'dot' | 'border'; theme?: 'system' | 'light' | 'dark'; safeExecute?: boolean } = {};
        
        if (privateWorkflowsDir !== undefined) {
          updates.privateWorkflowsDir = privateWorkflowsDir;
        }
        if (privateWorkflowsEnabled !== undefined) {
          updates.privateWorkflowsEnabled = privateWorkflowsEnabled;
        }
        if (workflowBadgeMode !== undefined) {
          updates.workflowBadgeMode = workflowBadgeMode;
        }
        if (theme !== undefined) {
          updates.theme = theme;
        }
        if (safeExecute !== undefined) {
          updates.safeExecute = safeExecute;
        }
        
        const config = await this.localConfigStore.updateConfig(updates);
        
        const privateDir = await this.localConfigStore.getPrivateWorkflowsDir();
        this.workflowStore.setPrivateWorkflowsDir(privateDir);
        
        this.broadcast({ type: 'settings_updated' });
        this.broadcast({ type: 'workflows_updated' });
        
        res.json(config);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.get('/api/agents/:id/logs', (req, res) => {
      const logs = this.agentLogs.get(req.params.id) ?? [];
      res.json(logs);
    });

    this.app.post('/api/agents/:id/input', (req, res) => {
      const issueId = req.params.id;
      const { input } = req.body;

      if (!input || typeof input !== 'string') {
        res.status(400).json({ error: 'Input is required and must be a string' });
        return;
      }

      if (!this.orchestrator.hasPendingInput(issueId)) {
        res.status(404).json({ error: 'No pending input request for this agent' });
        return;
      }

      const success = this.orchestrator.submitInput(issueId, input);
      if (success) {
        log.info('User input submitted', { issueId, inputLength: input.length });
        this.broadcast({ type: 'input_submitted', data: { issueId } });
        res.json({ success: true });
      } else {
        res.status(500).json({ error: 'Failed to submit input' });
      }
    });

    this.app.get('/api/agents', (_req, res) => {
      const status = this.orchestrator.getStatus();
      const agents = status.runningIssues.map(r => ({
        ...r,
        logCount: this.agentLogs.get(r.id)?.length ?? 0,
      }));
      res.json(agents);
    });

    this.app.get('/api/events', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      this.sseClients.add(res);

      req.on('close', () => {
        this.sseClients.delete(res);
      });
    });

    // Chat endpoints
    this.app.get('/api/chat/session', (_req, res) => {
      const sessionId = this.chatManager.getSessionId();
      const workspacePath = this.chatManager.getWorkspacePath();
      res.json({ 
        sessionId,
        workspacePath,
        serverPort: this.config.serverPort ?? 4096,
      });
    });

    this.app.get('/api/chat/history', (_req, res) => {
      const history = this.chatManager.getHistory();
      res.json(history);
    });

    this.app.post('/api/chat/reset', async (_req, res) => {
      try {
        await this.chatManager.resetSession();
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.get('/api/chat/stream', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      this.chatSseClients.add(res);

      req.on('close', () => {
        this.chatSseClients.delete(res);
      });
    });

    this.app.post('/api/chat', async (req, res) => {
      try {
        const { message } = req.body;
        
        if (!message || typeof message !== 'string') {
          res.status(400).json({ error: 'Message is required' });
          return;
        }

        log.info('Chat message received', { messageLength: message.length });

        const onEvent = (event: ChatEvent) => {
          const sseMessage = `data: ${JSON.stringify(event)}\n\n`;
          for (const client of this.chatSseClients) {
            client.write(sseMessage);
          }
        };

        const response = await this.chatManager.sendMessage(message, onEvent);
        res.json(response);
      } catch (err) {
        log.error('Chat message failed', { error: (err as Error).message });
        res.status(500).json({ error: (err as Error).message });
      }
    });
  }

  private setupLogCapture(): void {
    setLogStreamCallback((formatted) => {
      this.broadcast({ type: 'log', data: formatted });
    });
  }

  broadcast(event: { type: string; data?: unknown }): void {
    const message = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.sseClients) {
      client.write(message);
    }
  }

  broadcastIssuesUpdated(): void {
    this.broadcast({ type: 'issues_updated' });
    this.broadcastStatusUpdated();
  }

  broadcastStatusUpdated(): void {
    this.broadcast({ type: 'status_updated' });
  }

  addAgentLog(issueId: string, entry: AgentLogEntry): void {
    if (!this.agentLogs.has(issueId)) {
      this.agentLogs.set(issueId, []);
    }
    
    const logs = this.agentLogs.get(issueId)!;
    logs.push(entry);
    
    if (logs.length > this.maxAgentLogEntries) {
      logs.shift();
    }
    
    this.broadcast({ 
      type: 'agent_log', 
      data: { issueId, entry } 
    });
  }

  broadcastInputRequest(request: InputRequest): void {
    log.info('Broadcasting input request', { 
      issueId: request.issueId, 
      hasPrompt: !!request.prompt,
    });
    this.broadcast({
      type: 'input_required',
      data: request,
    });
  }

  clearAgentLogs(issueId: string): void {
    this.agentLogs.delete(issueId);
  }

  private generateSessionExportMarkdown(
    issue: Issue,
    sessions: IssueSession[],
    comments: IssueComment[],
    logs: IssueLog[],
    sessionHistories: Map<string, Array<{ role: string; text: string; timestamp: number }>> = new Map()
  ): string {
    const lines: string[] = [];
    const exportDate = new Date().toISOString();
    
    lines.push(`# Sessions Export: ${issue.identifier}`);
    lines.push('');
    lines.push(`**Title:** ${issue.title}`);
    lines.push(`**State:** ${issue.state}`);
    lines.push(`**Export Date:** ${exportDate}`);
    lines.push(`**Total Sessions:** ${sessions.length}`);
    lines.push('');
    
    if (issue.description) {
      lines.push('## Description');
      lines.push('');
      lines.push(issue.description);
      lines.push('');
    }
    
    lines.push('---');
    lines.push('');
    
    if (sessions.length > 0) {
      lines.push('## Sessions');
      lines.push('');
      
      for (const session of sessions) {
        const status = session.isActive ? '🟢 Active' : '⚪ Completed';
        const workflowLabel = session.workflowName || 'Default';
        const createdAt = session.createdAt.toISOString();
        
        lines.push(`### Session: ${session.sessionId.slice(0, 12)}...`);
        lines.push('');
        lines.push(`- **Status:** ${status}`);
        lines.push(`- **Workflow:** ${workflowLabel}`);
        lines.push(`- **Created:** ${createdAt}`);
        if (session.workspacePath) {
          lines.push(`- **Workspace:** \`${session.workspacePath}\``);
        }
        lines.push('');
        
        const history = sessionHistories.get(session.sessionId);
        if (history && history.length > 0) {
          lines.push('#### Conversation');
          lines.push('');
          for (const msg of history) {
            const roleLabel = msg.role === 'user' ? '👤 User' : '🤖 Assistant';
            const ts = new Date(msg.timestamp).toISOString();
            lines.push(`**${roleLabel}** _(${ts})_`);
            lines.push('');
            lines.push(msg.text);
            lines.push('');
          }
        }

        const sessionLogs = logs.filter(l => l.sessionId === session.sessionId);
        if (sessionLogs.length > 0) {
          lines.push('#### Session Logs');
          lines.push('');
          for (const logEntry of sessionLogs) {
            lines.push(`**[${logEntry.createdAt.toISOString()}]**`);
            lines.push('');
            lines.push(logEntry.content);
            lines.push('');
          }
        }
        
        lines.push('---');
        lines.push('');
      }
    }
    
    if (comments.length > 0) {
      lines.push('## Activity / Comments');
      lines.push('');
      
      for (const comment of comments) {
        const authorLabel = comment.author === 'agent' ? '🤖 Agent' : '👤 Human';
        const createdAt = comment.createdAt.toISOString();
        
        lines.push(`### ${authorLabel} - ${createdAt}`);
        lines.push('');
        lines.push(comment.content);
        lines.push('');
      }
    }
    
    return lines.join('\n');
  }

  private serializeWorkflow(workflow: StoredWorkflow): Record<string, unknown> {
    return {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      promptTemplate: workflow.promptTemplate,
      config: workflow.config,
      isDefault: workflow.isDefault,
      isPrivate: workflow.isPrivate,
      maxConcurrentAgents: workflow.maxConcurrentAgents,
      createdAt: workflow.createdAt.toISOString(),
      updatedAt: workflow.updatedAt.toISOString(),
    };
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.app.listen(this.port, () => {
        log.info('Web UI started', { url: `http://localhost:${this.port}` });
        resolve();
      });
    });
  }

  private getDashboardHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Symphony Dashboard</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎵</text></svg>">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            'symphony-bg': '#f8f7f6',
            'symphony-text': '#37352f',
            'symphony-border': '#e8e5e0',
            'symphony-muted': '#9b9a97',
          }
        }
      }
    }
  </script>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"></script>
  <link rel="stylesheet" href="/ui/styles.css">
</head>
<body>
  <div id="app"></div>
  <script>window.opencodePort = ${this.config.serverPort ?? 4096};</script>
  <script type="module" src="/ui/bundle.js"></script>
</body>
</html>`;
  }
}
