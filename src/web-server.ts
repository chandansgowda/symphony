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
import { getLogs, setLogStreamCallback, clearLogStreamCallback } from './log-buffer.js';
import { Logger } from './logger.js';
import { AgentLogEntry, InputRequest, StoredWorkflow, Issue, IssueSession, IssueComment, IssueLog, OPENCODE_SERVER_PORT } from './types.js';
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

function serializeAgentLogEntry(entry: AgentLogEntry): {
  type: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
} {
  return {
    type: entry.type,
    content: entry.message,
    timestamp: entry.timestamp instanceof Date
      ? entry.timestamp.toISOString()
      : typeof entry.timestamp === 'number'
        ? new Date(entry.timestamp < 1e10 ? entry.timestamp * 1000 : entry.timestamp).toISOString()
        : String(entry.timestamp),
    metadata: entry.details as Record<string, unknown> | undefined,
  };
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
  private readonly startupNonce: string = Date.now().toString(36);

  constructor(options: WebServerOptions) {
    this.port = options.port;
    this.orchestrator = options.orchestrator;
    this.config = options.config;
    this.workflowStore = options.workflowStore;
    this.localConfigStore = options.localConfigStore;
    this.issueTracker = options.issueTracker;
    this.app = express();
    this.chatManager = new ChatManager({
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
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.send(this.getDashboardHTML());
    });

    // ========================================================================
    // PWA Assets
    // ========================================================================

    this.app.get('/manifest.json', (_req, res) => {
      res.setHeader('Content-Type', 'application/manifest+json');
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      res.json(this.getPwaManifest());
    });

    this.app.get('/sw.js', (_req, res) => {
      // Cache-Control: no-store is required — the browser byte-diffs sw.js to
      // detect updates. If cached, users never receive SW version upgrades.
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Service-Worker-Allowed', '/');
      res.send(this.getServiceWorkerScript());
    });

    this.app.get('/offline.html', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(this.getOfflinePageHTML());
    });

    this.app.get('/ui/bundle.js', (req, res) => {
      const bundlePath = join(uiDir, 'bundle.js');
      if (existsSync(bundlePath)) {
        try {
          res.type('application/javascript');
          if (req.query['v'] === this.startupNonce) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          }
          res.send(readFileSync(bundlePath, 'utf-8'));
        } catch (err) {
          log.error('Failed to read bundle.js', { error: (err as Error).message });
          res.status(500).send('Failed to read bundle');
        }
      } else {
        res.status(404).send('Bundle not found');
      }
    });

    this.app.get('/ui/styles.css', (req, res) => {
      const stylesPath = join(uiDir, 'styles.css');
      if (existsSync(stylesPath)) {
        try {
          res.type('text/css');
          if (req.query['v'] === this.startupNonce) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          }
          res.send(readFileSync(stylesPath, 'utf-8'));
        } catch (err) {
          log.error('Failed to read styles.css', { error: (err as Error).message });
          res.status(500).send('Failed to read styles');
        }
      } else {
        res.status(404).send('Styles not found');
      }
    });

    this.app.get('/api/health', (_req, res) => {
      res.json({ status: 'ok', uptime: process.uptime() });
    });

    this.app.post('/api/restart', (_req, res) => {
      res.json({ status: 'restarting' });
      setImmediate(() => {
        log.info('Restart requested via API');
        process.exit(100);
      });
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
          .sort((a, b) => (b.lastModified ?? b.created ?? 0) - (a.lastModified ?? a.created ?? 0));
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

        const sessionHistories = new Map<string, Array<{ role: string; text: string; timestamp: number }>>();
        for (const session of sessions) {
          try {
            const client = createOpencodeClient({
              baseUrl: `http://127.0.0.1:${OPENCODE_SERVER_PORT}`,
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
            history.sort((a, b) => a.timestamp - b.timestamp);
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

        const sessionTerminated = await this.orchestrator.terminateSession(issueId, 30000, true);

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

    this.app.get('/api/workflows/:id/models', async (req, res) => {
      try {
        const { workflow, availableWorkflows } = await this.workflowStore.findWorkflowByNameOrId(req.params.id);
        if (!workflow) {
          res.status(404).json({
            error: `Workflow not found: "${req.params.id}"`,
            availableWorkflows,
          });
          return;
        }

        const opencode = workflow.config.opencode;
        const modelConfig = opencode?.model;
        const secondaryModel = opencode?.secondary_model ?? null;

        let primaryModel: string | null = null;
        const allModels: string[] = [];

        if (Array.isArray(modelConfig)) {
          primaryModel = modelConfig[0] ?? null;
          for (const m of modelConfig) {
            if (!allModels.includes(m)) allModels.push(m);
          }
        } else if (typeof modelConfig === 'string') {
          primaryModel = modelConfig;
          allModels.push(modelConfig);
        }

        if (secondaryModel && !allModels.includes(secondaryModel)) {
          allModels.push(secondaryModel);
        }

        res.json({
          workflowId: workflow.id,
          workflowName: workflow.name,
          primaryModel,
          secondaryModel,
          availableModels: allModels,
        });
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
        const { name, description, promptTemplate, config, isDefault, maxConcurrentAgents, color, nextWorkflowId, hiddenFromPicker } = req.body;
        
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
          color: typeof color === 'string' ? color : undefined,
          nextWorkflowId: typeof nextWorkflowId === 'string' ? nextWorkflowId : (nextWorkflowId === null ? null : undefined),
          hiddenFromPicker: typeof hiddenFromPicker === 'boolean' ? hiddenFromPicker : undefined,
        });

        this.broadcast({ type: 'workflows_updated' });
        res.json(this.serializeWorkflow(workflow));
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.put('/api/workflows/:id', async (req, res) => {
      try {
        const { name, description, promptTemplate, config, isDefault, maxConcurrentAgents, color, nextWorkflowId, hiddenFromPicker } = req.body;
        
        const workflow = await this.workflowStore.updateWorkflow(req.params.id, {
          name,
          description,
          promptTemplate,
          config,
          isDefault,
          maxConcurrentAgents,
          color: color !== undefined ? (typeof color === 'string' ? color : null) : undefined,
          nextWorkflowId: nextWorkflowId !== undefined ? (typeof nextWorkflowId === 'string' ? nextWorkflowId : null) : undefined,
          hiddenFromPicker: typeof hiddenFromPicker === 'boolean' ? hiddenFromPicker : undefined,
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
        
        const updates: { privateWorkflowsDir?: string | null; privateWorkflowsEnabled?: boolean; workflowBadgeMode?: 'border'; theme?: 'system' | 'light' | 'dark'; safeExecute?: boolean } = {};
        
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
      res.json(logs.map(serializeAgentLogEntry));
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
        serverPort: OPENCODE_SERVER_PORT,
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
      data: { issueId, entry: serializeAgentLogEntry(entry) } 
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
      
      const sortedSessions = [...sessions].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      for (const session of sortedSessions) {
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
          let workflowPromptCollapsed = false;
          for (const msg of history) {
            const roleLabel = msg.role === 'user' ? '👤 User' : '🤖 Assistant';
            const ts = new Date(msg.timestamp).toISOString();
            lines.push(`**${roleLabel}** _(${ts})_`);
            lines.push('');
            if (msg.role === 'user' && !workflowPromptCollapsed) {
              lines.push(`_[Workflow: **${workflowLabel}**]_`);
              workflowPromptCollapsed = true;
            } else {
              lines.push(msg.text);
            }
            lines.push('');
          }
        }

        const sessionLogs = logs
          .filter(l => l.sessionId === session.sessionId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
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
      
      const sortedComments = [...comments].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      for (const comment of sortedComments) {
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
      color: workflow.color ?? null,
      nextWorkflowId: workflow.nextWorkflowId,
      hiddenFromPicker: workflow.hiddenFromPicker,
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

  stop(): void {
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();

    for (const client of this.chatSseClients) {
      client.end();
    }
    this.chatSseClients.clear();

    clearLogStreamCallback();
    this.agentLogs.clear();
  }

  private getPwaManifest(): Record<string, unknown> {
    return {
      name: 'Symphony',
      short_name: 'Symphony',
      description: 'AI-powered issue orchestration and Kanban board',
      id: '/?source=pwa',
      start_url: '/?source=pwa',
      scope: '/',
      display: 'standalone',
      orientation: 'any',
      background_color: '#0f0f0f',
      theme_color: '#0f0f0f',
      lang: 'en-US',
      icons: [
        {
          src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎵</text></svg>",
          sizes: 'any',
          type: 'image/svg+xml',
          purpose: 'any',
        },
      ],
      categories: ['productivity', 'utilities'],
    };
  }

  private getServiceWorkerScript(): string {
    const cacheVersion = this.startupNonce;
    return `'use strict';

const CACHE_VERSION = ${JSON.stringify(cacheVersion)};
const STATIC_CACHE  = 'symphony-static-'  + CACHE_VERSION;
const RUNTIME_CACHE = 'symphony-runtime-' + CACHE_VERSION;
const API_CACHE     = 'symphony-api-'     + CACHE_VERSION;

const PRECACHE_ASSETS = ['/', '/offline.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  const currentCaches = [STATIC_CACHE, RUNTIME_CACHE, API_CACHE];
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((n) => n.startsWith('symphony-') && !currentCaches.includes(n))
          .map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request, API_CACHE, 3000));
    return;
  }

  if (/\\.(?:js|css|png|jpg|jpeg|svg|ico|woff2?|ttf)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstWithOfflineFallback(request));
    return;
  }
});

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (_err) {
    return new Response('Resource unavailable offline', {
      status: 408,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

async function networkFirst(request, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);
  try {
    const networkPromise = fetch(request);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Network timeout')), timeoutMs)
    );
    const response = await Promise.race([networkPromise, timeoutPromise]);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (_err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'Offline', cached: false }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function networkFirstWithOfflineFallback(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (_err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    const offlinePage = await caches.match('/offline.html');
    return offlinePage ?? new Response('<h1>Offline</h1>', {
      status: 503,
      headers: { 'Content-Type': 'text/html' },
    });
  }
}
`;
  }

  private getOfflinePageHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#0f0f0f">
  <title>Symphony — Offline</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0f0f0f;
      color: #e0e0e0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100dvh;
      margin: 0;
      gap: 1rem;
      padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
      box-sizing: border-box;
    }
    h1 { font-size: 1.5rem; margin: 0; }
    p { color: #9e9e9e; text-align: center; max-width: 300px; margin: 0; }
    button {
      margin-top: 0.5rem;
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      border: none;
      background: #4f46e5;
      color: white;
      font-size: 1rem;
      cursor: pointer;
      touch-action: manipulation;
      min-height: 44px;
    }
  </style>
</head>
<body>
  <span style="font-size:3rem">🎵</span>
  <h1>Symphony</h1>
  <p>You're offline. Check your connection and try again.</p>
  <button onclick="window.location.reload()">Retry</button>
</body>
</html>`;
  }

  private getDashboardHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#0f0f0f">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Symphony">
  <title>Symphony Dashboard</title>
  <link rel="manifest" href="/manifest.json">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎵</text></svg>">
  <link rel="apple-touch-icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎵</text></svg>">
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"></script>
  <link rel="stylesheet" href="/ui/styles.css?v=${this.startupNonce}">
</head>
<body>
  <div id="app"></div>
  <script>window.opencodePort = ${OPENCODE_SERVER_PORT};</script>
  <script type="module" src="/ui/bundle.js?v=${this.startupNonce}"></script>
  <script>
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function() {
        navigator.serviceWorker.register('/sw.js', { scope: '/' })
          .then(function(reg) {
            reg.addEventListener('updatefound', function() {
              var newWorker = reg.installing;
              if (!newWorker) return;
              newWorker.addEventListener('statechange', function() {
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                  console.log('[PWA] New version available — reload to update');
                }
              });
            });
          })
          .catch(function(err) { console.warn('[PWA] SW registration failed:', err); });
      });
    }
  </script>
</body>
</html>`;
  }
}
