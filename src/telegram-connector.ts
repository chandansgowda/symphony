import TelegramBot from 'node-telegram-bot-api';
import { Connector, ConnectorContext, ConnectorEvent, IssueStateChangedEvent, AgentCompletedEvent, AgentFailedEvent, InputRequestedEvent, CommentAddedEvent, IssueCreatedEvent } from './connector.js';
import { LocalConfigStore, TelegramConfig, TelegramNotificationLevel } from './local-config-store.js';
import { Logger } from './logger.js';

const log = new Logger('telegram-connector');

export interface TelegramConnectorOptions {
  localConfigStore: LocalConfigStore;
}

export class TelegramConnector implements Connector {
  readonly id = 'telegram';
  readonly name = 'Telegram';

  private bot: TelegramBot | null = null;
  private context: ConnectorContext | null = null;
  private config: TelegramConfig | null = null;
  private localConfigStore: LocalConfigStore;
  private allowedSenders: Set<string> = new Set();
  private telegramInitiatedIssues: Set<string> = new Set();

  constructor(options: TelegramConnectorOptions) {
    this.localConfigStore = options.localConfigStore;
  }

  async start(context: ConnectorContext): Promise<void> {
    this.context = context;

    const localConfig = await this.localConfigStore.getConfig();
    const tgConfig = localConfig.telegram;

    if (!tgConfig?.enabled || !tgConfig.botToken) {
      log.info('Telegram connector disabled or bot token not set — skipping');
      return;
    }

    this.config = tgConfig;
    this.allowedSenders = this.parseAllowlist(tgConfig.allowlist ?? '');

    try {
      this.bot = new TelegramBot(tgConfig.botToken, { polling: true });
      this.setupHandlers();
      log.info('Telegram connector started (polling mode)');
    } catch (err) {
      log.error('Failed to start Telegram bot', { error: (err as Error).message });
    }
  }

  onEvent(event: ConnectorEvent): void {
    if (!this.bot || !this.config?.enabled) return;

    switch (event.type) {
      case 'issue_created':
        this.handleIssueCreated(event as IssueCreatedEvent);
        break;
      case 'issue_state_changed':
        this.handleStateChanged(event as IssueStateChangedEvent);
        break;
      case 'agent_completed':
        this.handleAgentCompleted(event as AgentCompletedEvent);
        break;
      case 'agent_failed':
        this.handleAgentFailed(event as AgentFailedEvent);
        break;
      case 'input_requested':
        this.handleInputRequested(event as InputRequestedEvent);
        break;
      case 'comment_added':
        this.handleCommentAdded(event as CommentAddedEvent);
        break;
    }
  }

  stop(): void {
    if (this.bot) {
      this.bot.stopPolling().catch((err) => {
        log.warn('Error stopping Telegram polling', { error: (err as Error).message });
      });
      this.bot = null;
    }
    log.info('Telegram connector stopped');
  }

  async reload(): Promise<void> {
    this.stop();
    if (this.context) {
      await this.start(this.context);
    }
  }

  private setupHandlers(): void {
    if (!this.bot) return;

    this.bot.on('message', async (msg) => {
      if (!this.isAllowed(msg)) {
        log.debug('Rejected message from unauthorized sender', {
          from: msg.from?.username ?? msg.from?.id,
        });
        return;
      }

      const text = msg.text?.trim() ?? '';
      const chatId = msg.chat.id;

      if (!text) return;

      try {
        await this.handleIncomingMessage(chatId, text, msg.message_id);
      } catch (err) {
        log.warn('Error handling Telegram message', { error: (err as Error).message });
        await this.safeSend(chatId, `Error: ${(err as Error).message}`);
      }
    });

    this.bot.on('polling_error', (err) => {
      log.warn('Telegram polling error', { error: (err as Error).message });
    });
  }

  private async handleIncomingMessage(chatId: number, text: string, _messageId: number): Promise<void> {
    if (!this.context) return;

    if (text.startsWith('/start') || text.startsWith('/help')) {
      await this.safeSend(chatId, this.getHelpText());
      return;
    }

    if (text.startsWith('/list')) {
      const issues = await this.context.getIssues();
      if (issues.length === 0) {
        await this.safeSend(chatId, 'No active cards found.');
        return;
      }
      const lines = issues.map(i => `• [${i.identifier}] ${i.state}: ${i.title}`);
      await this.safeSend(chatId, `Active cards:\n${lines.join('\n')}`);
      return;
    }

    if (text.startsWith('/comment ')) {
      const rest = text.slice('/comment '.length).trim();
      const spaceIdx = rest.indexOf(' ');
      if (spaceIdx === -1) {
        await this.safeSend(chatId, 'Usage: /comment <identifier> <message>');
        return;
      }
      const identifier = rest.slice(0, spaceIdx).trim();
      const comment = rest.slice(spaceIdx + 1).trim();
      const issue = await this.context.getIssue(identifier);
      if (!issue) {
        await this.safeSend(chatId, `Card not found: ${identifier}`);
        return;
      }
      await this.context.addComment(issue.id, 'human', comment);
      await this.safeSend(chatId, `Comment added to ${issue.identifier}: ${issue.title}`);
      return;
    }

    if (text.startsWith('/input ')) {
      const rest = text.slice('/input '.length).trim();
      const spaceIdx = rest.indexOf(' ');
      if (spaceIdx === -1) {
        await this.safeSend(chatId, 'Usage: /input <identifier> <answer>');
        return;
      }
      const identifier = rest.slice(0, spaceIdx).trim();
      const input = rest.slice(spaceIdx + 1).trim();
      const issue = await this.context.getIssue(identifier);
      if (!issue) {
        await this.safeSend(chatId, `Card not found: ${identifier}`);
        return;
      }
      const submitted = this.context.submitInput(issue.id, input);
      if (submitted) {
        await this.safeSend(chatId, `Input submitted to ${issue.identifier}.`);
      } else {
        await this.safeSend(chatId, `No pending input request for ${issue.identifier}.`);
      }
      return;
    }

    const issue = await this.context.createIssue({
      title: text.slice(0, 200),
      description: text.length > 200 ? text : undefined,
      state: 'Todo',
    });

    this.telegramInitiatedIssues.add(issue.id);
    await this.safeSend(chatId, `Card created: [${issue.identifier}] ${issue.title}`);
  }

  private handleIssueCreated(event: IssueCreatedEvent): void {
    if (!this.shouldNotifyCard(event.issue.id, this.config?.cardNotificationLevel ?? 'all')) return;
    this.broadcastToAllChats(`New card: [${event.issue.identifier}] ${event.issue.title}`);
  }

  private handleStateChanged(event: IssueStateChangedEvent): void {
    if (!this.shouldNotifyCard(event.issueId, this.config?.cardNotificationLevel ?? 'all')) return;
    this.broadcastToAllChats(
      `[${event.issueIdentifier}] state: ${event.fromState} → ${event.toState}`
    );
  }

  private handleAgentCompleted(event: AgentCompletedEvent): void {
    if (!this.shouldNotifyCard(event.issueId, this.config?.cardNotificationLevel ?? 'all')) return;
    const tokens = event.tokenUsage ? ` (${event.tokenUsage.total} tokens)` : '';
    this.broadcastToAllChats(`Agent completed [${event.issueIdentifier}]${tokens}`);
  }

  private handleAgentFailed(event: AgentFailedEvent): void {
    if (!this.shouldNotifyCard(event.issueId, this.config?.cardNotificationLevel ?? 'all')) return;
    const retry = event.willRetry ? ' (will retry)' : '';
    this.broadcastToAllChats(`Agent failed [${event.issueIdentifier}]: ${event.error}${retry}`);
  }

  private handleInputRequested(event: InputRequestedEvent): void {
    if (!this.shouldNotifyCard(event.issueId, this.config?.cardNotificationLevel ?? 'all')) return;
    const prompt = event.request.prompt ? `\n\nPrompt: ${event.request.prompt}` : '';
    this.broadcastToAllChats(
      `[${event.issueIdentifier}] agent needs input.${prompt}\n\nReply with: /input ${event.issueIdentifier} <answer>`
    );
  }

  private handleCommentAdded(event: CommentAddedEvent): void {
    if (event.author !== 'agent') return;
    if (!this.shouldNotifyComment(event.issueId, this.config?.commentNotificationLevel ?? 'all')) return;
    this.broadcastToAllChats(`[${event.issueIdentifier}] comment:\n${event.content.slice(0, 500)}`);
  }

  private shouldNotifyCard(issueId: string, level: TelegramNotificationLevel): boolean {
    if (level === 'all') return true;
    return this.telegramInitiatedIssues.has(issueId);
  }

  private shouldNotifyComment(issueId: string, level: TelegramNotificationLevel): boolean {
    if (level === 'all') return true;
    return this.telegramInitiatedIssues.has(issueId);
  }

  private broadcastToAllChats(text: string): void {
    const chatIds = this.getAllowedChatIds();
    for (const chatId of chatIds) {
      this.safeSend(chatId, text).catch((err) => {
        log.warn('Failed to send Telegram message', { chatId, error: (err as Error).message });
      });
    }
  }

  private getAllowedChatIds(): number[] {
    if (!this.config?.allowlist) return [];
    return this.config.allowlist
      .split(',')
      .map(s => s.trim())
      .filter(s => /^-?\d+$/.test(s))
      .map(s => parseInt(s, 10));
  }

  private isAllowed(msg: TelegramBot.Message): boolean {
    if (this.allowedSenders.size === 0) return true;

    const from = msg.from;
    if (!from) return false;

    const userId = String(from.id);
    const username = from.username ? `@${from.username}` : null;
    const chatId = String(msg.chat.id);

    return (
      this.allowedSenders.has(userId) ||
      (username !== null && this.allowedSenders.has(username)) ||
      this.allowedSenders.has(chatId)
    );
  }

  private parseAllowlist(raw: string): Set<string> {
    return new Set(
      raw
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0)
    );
  }

  private async safeSend(chatId: number, text: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.sendMessage(chatId, text);
    } catch (err) {
      log.warn('Failed to send Telegram message', { chatId, error: (err as Error).message });
    }
  }

  private getHelpText(): string {
    return [
      'Symphony Telegram Bot',
      '',
      'Commands:',
      '/list - List active cards',
      '/comment <id> <message> - Add a comment to a card',
      '/input <id> <answer> - Submit input for a waiting agent',
      '/help - Show this help',
      '',
      'Or just send any text to create a new card.',
    ].join('\n');
  }
}
