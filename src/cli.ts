#!/usr/bin/env node

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkflowLoader } from './workflow-loader.js';
import { ServiceConfig } from './config.js';
import { IssueTrackerClient } from './issue-tracker.js';
import { LinearIssueTrackerClient } from './linear-client.js';
import { LocalSqliteClient } from './local-sqlite-client.js';
import { GitLabIssueTrackerClient } from './gitlab-client.js';
import { WorkspaceManager } from './workspace-manager.js';
import { WorkflowStore } from './workflow-store.js';
import { LocalConfigStore } from './local-config-store.js';
import { Orchestrator } from './orchestrator.js';
import { ServerManager, checkDockerAvailable } from './server-manager.js';
import { Logger } from './logger.js';
import { FileWatcher } from './file-watcher.js';
import { WorkflowConfig, OPENCODE_SERVER_PORT } from './types.js';
import { initLogBuffer } from './log-buffer.js';
import { ConnectorManager } from './connector-manager.js';
import { KanbanConnector } from './kanban-connector.js';
import { TelegramConnector } from './telegram-connector.js';

const log = new Logger('cli');

interface WorkflowsFile {
  workflows: Array<{
    id: string;
    name: string;
    description?: string | null;
    template_file: string;
    config: WorkflowConfig;
    is_default?: boolean;
  }>;
}

async function loadFromWorkflowDir(workflowDir: string): Promise<{ promptTemplate: string; config: WorkflowConfig } | null> {
  const jsonPath = path.join(workflowDir, 'workflows.json');
  const sampleJsonPath = path.join(workflowDir, 'sample-workflows.json');
  
  try {
    let content: string;
    try {
      content = await fs.readFile(jsonPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // workflows.json doesn't exist - try to copy from sample
        try {
          const sampleContent = await fs.readFile(sampleJsonPath, 'utf-8');
          await fs.mkdir(workflowDir, { recursive: true });
          await fs.writeFile(jsonPath, sampleContent, 'utf-8');
          log.info('Created workflows.json from sample', { path: jsonPath });
          content = sampleContent;
        } catch {
          // No sample file either
          return null;
        }
      } else {
        throw err;
      }
    }
    
    const data: WorkflowsFile = JSON.parse(content);
    
    if (!data.workflows || data.workflows.length === 0) {
      return null;
    }
    
    const defaultWorkflow = data.workflows.find(w => w.is_default) ?? data.workflows[0];
    const templatePath = path.join(workflowDir, defaultWorkflow.template_file);
    const promptTemplate = await fs.readFile(templatePath, 'utf-8');
    
    return {
      promptTemplate,
      config: defaultWorkflow.config,
    };
  } catch {
    return null;
  }
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    workflowPath: undefined,
    logLevel: 'info',
    webPort: 3000,
    noWeb: false,
    watch: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-h' || arg === '--help') {
      result.help = true;
    } else if (arg === '-w' || arg === '--workflow') {
      result.workflowPath = args[++i];
    } else if (arg === '-l' || arg === '--log-level') {
      const level = args[++i];
      if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') {
        result.logLevel = level;
      }
    } else if (arg === '-p' || arg === '--port') {
      const port = parseInt(args[++i], 10);
      if (!isNaN(port)) {
        result.webPort = port;
      }
    } else if (arg === '--no-web') {
      result.noWeb = true;
    } else if (arg === '-W' || arg === '--watch') {
      result.watch = true;
    } else if (!arg.startsWith('-')) {
      result.workflowPath = arg;
    }
  }

  return result;
}

interface ParsedArgs {
  workflowPath?: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  webPort: number;
  noWeb: boolean;
  watch: boolean;
  help: boolean;
}

function printHelp(): void {
  console.log(`
Symphony - Issue orchestration service that runs opencode agents

Usage: symphony [options] [workflow-path]

Options:
  -w, --workflow <path>    Path to workflow directory or WORKFLOW.md file
  -l, --log-level <level>  Log level: debug, info, warn, error (default: info)
  -p, --port <port>        Web UI port (default: 3000)
  --no-web                 Disable web UI
  -W, --watch              Enable hot reload on .ts and .md file changes
  -h, --help               Show this help message

Workflow Loading (in order of precedence):
  1. Explicit path via -w or positional argument
  2. ./data/workflow/workflows.json

Tracker Types:
  local   - Read issues from a local SQLite file (default: ./data/issues.db)
  linear  - Fetch issues from Linear API (requires LINEAR_API_KEY)
  gitlab  - Fetch issues from GitLab (requires tracker.api_key and tracker.project_path)

Example:
  symphony                           # Auto-detect workflow
  symphony ./workflow                # Use workflow directory
  symphony ./my-workflow.md          # Use specific workflow file
  symphony -l debug                  # Run with debug logging
  symphony -p 8080                   # Run web UI on port 8080
  symphony --no-web                  # Run without web UI
  symphony -W                        # Enable hot reload in development
`);
}

function createIssueTracker(config: ServiceConfig): IssueTrackerClient {
  const kind = config.trackerKind;

  if (kind === 'local') {
    log.info('Using SQLite issue tracker', { path: config.trackerIssuesPath });
    return new LocalSqliteClient(config);
  }

  if (kind === 'linear') {
    log.info('Using Linear issue tracker');
    return new LinearIssueTrackerClient(config);
  }

  if (kind === 'gitlab') {
    log.info('Using GitLab issue tracker', { projectPath: config.trackerProjectPath, host: config.trackerGitLabHost });
    return new GitLabIssueTrackerClient(config);
  }

  throw new Error(`Unknown tracker kind: ${kind}`);
}

interface LoadedWorkflow {
  promptTemplate: string;
  config: WorkflowConfig;
  source: 'directory' | 'file';
  path: string;
}

async function loadWorkflow(explicitPath?: string): Promise<LoadedWorkflow> {
  const cwd = process.cwd();
  
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    const stat = await fs.stat(resolved);
    
    if (stat.isDirectory()) {
      const result = await loadFromWorkflowDir(resolved);
      if (result) {
        return { ...result, source: 'directory', path: resolved };
      }
      throw new Error(`No workflows.json found in directory: ${resolved}`);
    } else {
      const loader = new WorkflowLoader(resolved);
      const workflow = await loader.load();
      return { ...workflow, source: 'file', path: resolved };
    }
  }
  
  const dataWorkflowDir = path.join(cwd, 'data', 'workflow');
  const dataWorkflowDirResult = await loadFromWorkflowDir(dataWorkflowDir);
  if (dataWorkflowDirResult) {
    return { ...dataWorkflowDirResult, source: 'directory', path: dataWorkflowDir };
  }
  
  throw new Error(
    'No workflow configuration found. Create:\n' +
    '  - ./data/workflow/workflows.json'
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  Logger.setLevel(args.logLevel);
  initLogBuffer();

  let workflow: LoadedWorkflow;
  try {
    workflow = await loadWorkflow(args.workflowPath);
  } catch (err) {
    log.error('Failed to load workflow', { error: (err as Error).message });
    process.exit(1);
  }

  log.info('Symphony starting', { 
    workflowSource: workflow.source, 
    workflowPath: workflow.path, 
    logLevel: args.logLevel 
  });

  const config = new ServiceConfig(workflow.config);

  const validation = config.validate();
  if (!validation.valid) {
    log.error('Invalid configuration', { errors: validation.errors });
    process.exit(1);
  }

  const issueTracker = createIssueTracker(config);
  const workspaceManager = new WorkspaceManager(config);
  const workflowStore = new WorkflowStore(config);
  const localConfigStore = new LocalConfigStore(config.dataDir);

  const privateWorkflowsDir = await localConfigStore.getPrivateWorkflowsDir();
  if (privateWorkflowsDir) {
    workflowStore.setPrivateWorkflowsDir(privateWorkflowsDir);
    log.info('Private workflows enabled', { dir: privateWorkflowsDir });
  }

  issueTracker.setWorkflowStore(workflowStore);

  if (workflow.source === 'file') {
    await workflowStore.initializeFromWorkflowMd(workflow.promptTemplate, workflow.config);
  }

  const localConfig = await localConfigStore.getConfig();
  let safeExecute = localConfig.safeExecute ?? false;

  if (safeExecute) {
    const dockerError = checkDockerAvailable();
    if (dockerError) {
      log.warn(dockerError + ' Switching to non-Docker mode.');
      safeExecute = false;
    } else {
      log.info('Safe execute mode enabled: opencode will run inside a Docker container');
    }
  }

  const allWorkflows = await workflowStore.listWorkflows();
  const workspaceRoots = [
    config.workspaceRoot,
    ...allWorkflows
      .map(w => w.config?.workspace?.root)
      .filter((root): root is string => typeof root === 'string' && root.trim() !== '')
      .map(root => root.startsWith('~') ? path.join(os.homedir(), root.slice(1)) : root),
  ].filter((root, idx, arr) => arr.indexOf(root) === idx);

  const serverManager = new ServerManager({
    port: OPENCODE_SERVER_PORT,
    safeExecute,
    workspaceRoots,
  });

  try {
    await serverManager.start();
  } catch (err) {
    log.error('Failed to start opencode server', { error: (err as Error).message });
    process.exit(1);
  }

  const orchestrator = new Orchestrator({
    config,
    promptTemplate: workflow.promptTemplate,
    issueTracker,
    workspaceManager,
    workflowStore,
  });

  const connectorManager = new ConnectorManager({
    issueTracker,
    sendCommentToSession: (issueId, comment) => orchestrator.sendCommentToSession(issueId, comment),
    submitInput: (issueId, input) => orchestrator.submitInput(issueId, input),
  });

  orchestrator.setConnectorManager(connectorManager);

  process.on('SIGINT', () => {
    log.info('Received SIGINT, shutting down');
    connectorManager.stopAll();
    orchestrator.stop();
    serverManager.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    log.info('Received SIGTERM, shutting down');
    connectorManager.stopAll();
    orchestrator.stop();
    serverManager.stop();
    process.exit(0);
  });

  if (workflow.source === 'file') {
    const workflowLoader = new WorkflowLoader(workflow.path);
    workflowLoader.startWatching((newWorkflow) => {
      log.info('Workflow reloaded');
      const newConfig = new ServiceConfig(newWorkflow.config);
      const newValidation = newConfig.validate();

      if (!newValidation.valid) {
        log.error('New config invalid, keeping old config', { errors: newValidation.errors });
        return;
      }

      orchestrator.updateConfig(newConfig, newWorkflow.promptTemplate);
    });
  }

  await orchestrator.start();

  if (!args.noWeb) {
    const kanbanConnector = new KanbanConnector({
      port: args.webPort,
      orchestrator,
      config,
      workflowStore,
      localConfigStore,
      issueTracker,
    });
    connectorManager.register(kanbanConnector);
  }

  const telegramConnector = new TelegramConnector({ localConfigStore });
  connectorManager.register(telegramConnector);

  await connectorManager.startAll();

  let lastStatusKey = '';
  
  setInterval(() => {
    const status = orchestrator.getStatus();
    const statusData = {
      activeRuns: status.activeRuns,
      pendingRetries: status.pendingRetries,
      totalTokens: status.totals.totalTokens,
      runtimeSeconds: Math.round(status.totals.runtimeSeconds),
    };
    
    const statusKey = `${statusData.activeRuns}:${statusData.pendingRetries}:${statusData.totalTokens}`;
    
    if (statusKey === lastStatusKey) {
      log.debug('Heartbeat', { status: 'unchanged' });
    } else {
      log.info('Status', statusData);
      lastStatusKey = statusKey;
    }
  }, 60000);

  if (args.watch) {
    const fileWatcher = new FileWatcher({
      root: process.cwd(),
      extensions: ['.ts', '.md'],
      onReload: (changedFile) => {
        log.info('File changed, restarting', { file: changedFile });
        orchestrator.stop();
        serverManager.stop();
        process.exit(100);
      },
    });

    fileWatcher.start();
    log.info('Hot reload enabled - watching for .ts and .md file changes');
  }
}

main().catch((err) => {
  log.error('Fatal error', { error: err.message });
  process.exit(1);
});
