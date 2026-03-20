import { Connector, ConnectorContext, ConnectorEvent, AgentLogEvent, InputRequestedEvent, AgentCompletedEvent, AgentFailedEvent } from './connector.js';
import { WebServer } from './web-server.js';
import { Orchestrator } from './orchestrator.js';
import { ServiceConfig } from './config.js';
import { IssueTrackerClient } from './issue-tracker.js';
import { WorkflowStore } from './workflow-store.js';
import { LocalConfigStore } from './local-config-store.js';
import { Logger } from './logger.js';

const log = new Logger('kanban-connector');

export interface KanbanConnectorOptions {
  port: number;
  orchestrator: Orchestrator;
  config: ServiceConfig;
  workflowStore: WorkflowStore;
  localConfigStore: LocalConfigStore;
  issueTracker: IssueTrackerClient;
}

export class KanbanConnector implements Connector {
  readonly id = 'kanban';
  readonly name = 'Kanban Board';

  private webServer: WebServer;
  private issueTracker: IssueTrackerClient;
  private orchestrator: Orchestrator;

  constructor(private options: KanbanConnectorOptions) {
    this.issueTracker = options.issueTracker;
    this.orchestrator = options.orchestrator;

    this.webServer = new WebServer({
      port: options.port,
      orchestrator: options.orchestrator,
      config: options.config,
      workflowStore: options.workflowStore,
      localConfigStore: options.localConfigStore,
      issueTracker: options.issueTracker,
    });
  }

  async start(_context: ConnectorContext): Promise<void> {
    this.orchestrator.setAgentLogCallback((issueId, entry) => {
      this.webServer.addAgentLog(issueId, entry);
    });

    this.orchestrator.setInputRequestCallback((request) => {
      this.webServer.broadcastInputRequest(request);
    });

    this.orchestrator.setIssueUpdatedCallback(() => {
      this.webServer.broadcastIssuesUpdated();
    });

    await this.issueTracker.startWatching(() => {
      this.webServer.broadcastIssuesUpdated();
    });

    await this.webServer.start();
    log.info('Kanban connector started', { port: this.options.port });
  }

  onEvent(event: ConnectorEvent): void {
    switch (event.type) {
      case 'issues_changed':
      case 'issue_created':
      case 'issue_updated':
      case 'issue_state_changed':
      case 'issue_deleted':
        this.webServer.broadcastIssuesUpdated();
        break;

      case 'agent_log': {
        const logEvent = event as AgentLogEvent;
        if (logEvent.issueId) {
          this.webServer.addAgentLog(logEvent.issueId, logEvent.entry);
        }
        break;
      }

      case 'input_requested': {
        const inputEvent = event as InputRequestedEvent;
        this.webServer.broadcastInputRequest(inputEvent.request);
        break;
      }

      case 'agent_started':
        this.webServer.broadcastStatusUpdated();
        break;

      case 'agent_completed':
      case 'agent_failed': {
        const agentEvent = event as AgentCompletedEvent | AgentFailedEvent;
        if (agentEvent.issueId) {
          this.webServer.clearAgentLogs(agentEvent.issueId);
        }
        this.webServer.broadcastStatusUpdated();
        break;
      }
    }
  }

  stop(): void {
    log.info('Kanban connector stopped');
  }

  getWebServer(): WebServer {
    return this.webServer;
  }
}
