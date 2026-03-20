import { useEffect, useRef } from 'preact/hooks';
import type { AgentLogEntry, RunningAgent } from '../types.js';
import { generateListKey, buildSessionUrl } from '../utils/helpers.js';

interface AgentLogsModalProps {
  agent: RunningAgent;
  logs: AgentLogEntry[];
  onClose: () => void;
}

function formatTimestamp(ts: string): string {
  const numeric = Number(ts);
  const date = !isNaN(numeric) && ts.trim() !== ''
    ? (numeric < 1e10 ? new Date(numeric * 1000) : new Date(numeric))
    : new Date(ts);
  return isNaN(date.getTime()) ? ts : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const SENSITIVE_PATTERN = /(password|pwd|authToken|apiKey|accessToken|jwt|secret|secretKey|privateKey|encryptionKey|sessionToken)[\s:=]*[^\s]*/gi;

function sanitizeLogContent(content: string): string {
  return content.replace(SENSITIVE_PATTERN, '$1=[REDACTED]');
}

function getEntryTypeClass(type: AgentLogEntry['type']): string {
  switch (type) {
    case 'message': return 'log-type-message';
    case 'file': return 'log-type-file';
    case 'status': return 'log-type-status';
    case 'input': return 'log-type-input';
    case 'error': return 'log-type-error';
    case 'comment': return 'log-type-comment';
    case 'subagent': return 'log-type-subagent';
    default: return '';
  }
}

function getEntryLabel(type: AgentLogEntry['type']): string {
  switch (type) {
    case 'message': return 'Message';
    case 'file': return 'File';
    case 'status': return 'Status';
    case 'input': return 'Input';
    case 'error': return 'Error';
    case 'comment': return 'Comment';
    case 'subagent': return 'Subagent';
    default: return type;
  }
}

export function AgentLogsModal({ agent, logs, onClose }: AgentLogsModalProps) {
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  const opencodePort = 'opencodePort' in window ? String((window as unknown as Record<string, unknown>)['opencodePort']) : null;
  const sessionUrlPath = agent.worktreeRoot ?? agent.workspacePath;
  const sessionLink = agent.sessionId && sessionUrlPath && opencodePort
    ? buildSessionUrl(opencodePort, sessionUrlPath, agent.sessionId)
    : null;

  return (
    <div
      className="modal active"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal-content wide" style={{ maxHeight: '90vh' }}>
        <div style={{
          padding: '20px 24px 16px',
          borderBottom: '1px solid var(--border-primary)',
          background: 'var(--bg-tertiary)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          borderRadius: '8px 8px 0 0',
        }}>
          <div>
            <h3 style={{ marginBottom: '8px' }}>Agent Logs — {agent.identifier}</h3>
            <div className="agent-info-label" style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
              <span>Started: {new Date(agent.startedAt).toLocaleString()}</span>
              {sessionLink && (
                <a
                  href={sessionLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="session-link"
                >
                  Open Session
                </a>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="btn btn-secondary btn-sm btn-icon"
            style={{ fontSize: '18px', flexShrink: 0 }}
          >
            &times;
          </button>
        </div>

        <div className="agent-logs" style={{ borderRadius: 0, maxHeight: 'calc(90vh - 160px)' }}>
          {logs.length === 0 ? (
            <div className="agent-log-label" style={{ fontStyle: 'italic', padding: '32px', textAlign: 'center' }}>
              No log entries yet.
            </div>
          ) : (
            logs.map((entry, i) => (
              <div
                key={generateListKey(entry.content + entry.timestamp, i, 'agent-log')}
                className={`agent-log-entry ${getEntryTypeClass(entry.type)}`}
              >
                <div className="agent-log-header">
                  <span className="agent-log-label">{getEntryLabel(entry.type)}</span>
                  <span className="agent-log-time">{formatTimestamp(entry.timestamp)}</span>
                </div>
                <pre className="agent-message-content" style={{ margin: 0 }}>
                  {sanitizeLogContent(entry.content)}
                </pre>
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>

        <div style={{
          padding: '12px 16px',
          borderTop: '1px solid var(--border-primary)',
          background: 'var(--bg-tertiary)',
          display: 'flex',
          justifyContent: 'flex-end',
          borderRadius: '0 0 8px 8px',
        }}>
          <button onClick={onClose} className="btn btn-secondary btn-sm">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
