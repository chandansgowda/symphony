export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function parseDateValue(dateValue: string | number | null | undefined): Date | null {
  if (dateValue == null) return null;
  let date: Date;
  if (typeof dateValue === 'number') {
    // Epoch seconds: values under 1e10 are seconds, above are milliseconds
    date = dateValue < 1e10 ? new Date(dateValue * 1000) : new Date(dateValue);
  } else {
    // ISO string or numeric string (epoch seconds as string)
    const numeric = Number(dateValue);
    if (!isNaN(numeric) && dateValue.trim() !== '') {
      date = numeric < 1e10 ? new Date(numeric * 1000) : new Date(numeric);
    } else {
      date = new Date(dateValue);
    }
  }
  return isNaN(date.getTime()) ? null : date;
}

export function formatTimestamp(dateValue: string | number | null | undefined): string {
  const date = parseDateValue(dateValue);
  if (!date) return typeof dateValue === 'string' ? dateValue : '—';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDate(dateValue: string | number | null | undefined): string {
  const date = parseDateValue(dateValue);
  if (!date) return '—';

  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) {
    return 'Today';
  } else if (days === 1) {
    return 'Yesterday';
  } else if (days < 7) {
    return `${days}d ago`;
  } else {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
}

export function formatRelativeTime(dateValue: string | number | null | undefined): string {
  const date = parseDateValue(dateValue);
  if (!date) return '—';

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function formatElapsedTime(startedAtMs: number): string {
  const elapsed = Math.floor((Date.now() - startedAtMs) / 1000);
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function parseUrlState(): { view?: string; card?: string; workflow?: string } {
  const params = new URLSearchParams(window.location.search);
  return {
    view: params.get('view') || undefined,
    card: params.get('card') || undefined,
    workflow: params.get('workflow') || undefined,
  };
}

export function updateUrlState(state: { view?: string; card?: string; workflow?: string }, replace = false): void {
  const params = new URLSearchParams();
  if (state.view && state.view !== 'issues') params.set('view', state.view);
  if (state.card) params.set('card', state.card);
  if (state.workflow) params.set('workflow', state.workflow);

  const url = params.toString() ? `?${params.toString()}` : window.location.pathname;

  if (replace) {
    window.history.replaceState(state, '', url);
  } else {
    window.history.pushState(state, '', url);
  }
}

export function classNames(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ');
}

declare const marked: { 
  parse: (md: string) => string;
  use: (options: Record<string, unknown>) => void;
};
declare const DOMPurify: { 
  sanitize: (html: string, config?: Record<string, unknown>) => string;
};

// Link token type for marked v5+ renderer API
interface MarkedLinkToken {
  href: string;
  title: string | null;
  text: string;
  tokens?: unknown[];
}

// Configure marked once on module load
let markedConfigured = false;
function ensureMarkedConfigured(): void {
  if (markedConfigured) return;
  markedConfigured = true;
  
  // Custom renderer to make links open in new tab
  // marked v5+ passes a token object instead of individual parameters
  const renderer = {
    link(token: MarkedLinkToken): string {
      const { href, title, text } = token;
      const safeHref = typeof href === 'string' ? href : '';
      const safeText = typeof text === 'string' ? text : '';
      const titleAttr = title && typeof title === 'string' ? ` title="${title}"` : '';
      return `<a href="${safeHref}"${titleAttr} target="_blank" rel="noopener noreferrer">${safeText}</a>`;
    }
  };
  
  marked.use({ renderer });
}

export function safeMarkdown(markdown: string): string {
  ensureMarkedConfigured();
  const rawHtml = marked.parse(markdown);
  // Allow target and rel attributes for links
  return DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: ['target', 'rel']
  });
}

export function encodeWorkspacePath(workspacePath: string): string {
  const bytes = new TextEncoder().encode(workspacePath);
  const latin1 = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return btoa(latin1).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function buildSessionUrl(port: string | number, workspacePath: string, sessionId: string): string {
  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  return `http://${host}:${port}/${encodeWorkspacePath(workspacePath)}/session/${sessionId}`;
}

export function generateListKey(content: string, index: number, prefix = 'item'): string {
  let hash = 0;
  for (let i = 0; i < Math.min(content.length, 100); i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `${prefix}-${hash}-${index}`;
}
