import { useState, useEffect, useRef } from 'preact/hooks';
import { Issue, Workflow, Comment, KANBAN_COLUMNS, SessionExport } from '../types.js';
import { api } from '../api.js';
import { safeMarkdown, formatRelativeTime, formatDateTime, formatDate, buildSessionUrl } from '../utils/helpers.js';
import { SessionsExportViewer } from './SessionsExportViewer.js';

const LABEL_COLORS: Record<string, { name: string; bg: string; text: string }> = {
  '1': { name: 'green', bg: '#2f9e44', text: '#ffffff' },
  '2': { name: 'yellow', bg: '#f59f00', text: '#ffffff' },
  '3': { name: 'orange', bg: '#e8590c', text: '#ffffff' },
  '4': { name: 'red', bg: '#c92a2a', text: '#ffffff' },
  '5': { name: 'purple', bg: '#7048e8', text: '#ffffff' },
  '6': { name: 'blue', bg: '#1971c2', text: '#ffffff' },
  '7': { name: 'sky', bg: '#0c8599', text: '#ffffff' },
  '8': { name: 'lime', bg: '#5c940d', text: '#ffffff' },
  '9': { name: 'pink', bg: '#c2255c', text: '#ffffff' },
  '0': { name: 'black', bg: '#495057', text: '#ffffff' },
};

const LABEL_KEY_ORDER = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

function getLabelColor(labelName: string): { bg: string; text: string } | null {
  for (const color of Object.values(LABEL_COLORS)) {
    if (color.name === labelName) {
      return { bg: color.bg, text: color.text };
    }
  }
  return null;
}

function sortLabels(labels: string[]): string[] {
  const orderedNames = LABEL_KEY_ORDER.map((k) => LABEL_COLORS[k].name);
  return [...labels].sort((a, b) => {
    const ai = orderedNames.indexOf(a);
    const bi = orderedNames.indexOf(b);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

declare global {
  interface Window {
    opencodePort?: string;
  }
}

function getSessionLink(sessionId: string, workspacePath?: string | null, worktreeRoot?: string | null): string | null {
  const port = window.opencodePort;
  const urlPath = worktreeRoot ?? workspacePath;
  if (!port || !urlPath) return null;
  return buildSessionUrl(port, urlPath, sessionId);
}

interface IssueModalProps {
  issue?: Issue;
  onClose: () => void;
  onSave: () => void;
}

export function IssueModal({ issue, onClose, onSave }: IssueModalProps) {
  const isExistingIssue = !!issue?.id;
  
  const [identifier, setIdentifier] = useState(issue?.identifier || '');
  const [title, setTitle] = useState(issue?.title || '');
  const [description, setDescription] = useState(issue?.description || '');
  const [state, setState] = useState(issue?.state || 'Backlog');
  const [workflowId, setWorkflowId] = useState(issue?.workflowId || '');
  const [model, setModel] = useState<string | null>(issue?.model ?? null);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGeneratingId, setIsGeneratingId] = useState(!isExistingIssue);
  const [activeTab, setActiveTab] = useState<'details' | 'activity'>('activity');
  const [showExportViewer, setShowExportViewer] = useState(false);
  const [exportData, setExportData] = useState<SessionExport | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  
  
  const commentsEndRef = useRef<HTMLDivElement>(null);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const workflowIdRef = useRef(workflowId);

  useEffect(() => {
    workflowIdRef.current = workflowId;
  }, [workflowId]);

  useEffect(() => {
    loadWorkflows();
    if (isExistingIssue) {
      loadComments();
    } else {
      generateId();
    }
  }, [isExistingIssue]);

  useEffect(() => {
    if (commentsEndRef.current) {
      commentsEndRef.current.scrollIntoView({ behavior: 'instant' });
    }
  }, [comments]);

  // Handle escape key
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);



  const loadWorkflows = async () => {
    try {
      const data = await api.getWorkflows();
      const currentId = workflowIdRef.current;
      if (currentId && !data.some(w => w.id === currentId)) {
        try {
          const currentWorkflow = await api.getWorkflow(currentId);
          data.push(currentWorkflow);
        } catch (_fetchErr) {
        }
      }
      setWorkflows(data);
      if (!isExistingIssue && !workflowIdRef.current) {
        const defaultWorkflow = data.find(w => w.isDefault);
        if (defaultWorkflow) setWorkflowId(defaultWorkflow.id);
      }
    } catch (err) {
      console.error('Failed to load workflows', err);
    }
  };

  const loadComments = async () => {
    if (!issue) return;
    try {
      const data = await api.getIssueComments(issue.id);
      setComments(data);
    } catch (err) {
      console.error('Failed to load comments', err);
    }
  };

  const generateId = async () => {
    if (isExistingIssue) return;
    setIsGeneratingId(true);
    try {
      const { identifier } = await api.generateIdentifier();
      setIdentifier(identifier);
    } catch (err) {
      console.error('Failed to generate identifier', err);
    } finally {
      setIsGeneratingId(false);
    }
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const issueData = {
        identifier,
        title,
        description,
        state,
        workflowId: workflowId || undefined,
        model: model || undefined,
      };

      if (isExistingIssue && issue) {
        await api.updateIssue(issue.id, issueData);
      } else {
        await api.createIssue(issueData);
      }
      onSave();
    } catch (err) {
      console.error('Failed to save issue', err);
      alert('Failed to save issue');
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    const handleSaveShortcut = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        if (activeTab === 'details' || !isExistingIssue) {
          const target = e.target as HTMLElement;
          if (target.closest('.comment-input')) return;
          e.preventDefault();
          handleSubmit(e as unknown as Event);
        }
      }
    };
    window.addEventListener('keydown', handleSaveShortcut);
    return () => window.removeEventListener('keydown', handleSaveShortcut);
  }, [activeTab, isExistingIssue, handleSubmit]);

  const handleArchive = async () => {
    if (!issue) return;
    try {
      await api.archiveIssue(issue.id);
      onSave();
    } catch (err) {
      console.error('Failed to archive issue', err);
      alert('Failed to archive issue');
    }
  };

  const handleAddComment = async (e: Event) => {
    e.preventDefault();
    if (!issue || !newComment.trim()) return;

    try {
      await api.addIssueComment(issue.id, 'human', newComment);
      setNewComment('');
      loadComments();
    } catch (err) {
      console.error('Failed to add comment', err);
      alert('Failed to add comment');
    }
  };

  const handleExportSessions = async () => {
    if (!issue) return;
    setIsExporting(true);
    try {
      const data = await api.exportIssueSessions(issue.id);
      setExportData(data);
      setShowExportViewer(true);
    } catch (err) {
      console.error('Failed to export sessions', err);
      alert('Failed to export sessions');
    } finally {
      setIsExporting(false);
    }
  };

  // Render compact session badges for the sidebar
  const renderSessionBadges = () => {
    if (!issue?.sessions || issue.sessions.length === 0) return null;
    
    return (
      <div className="mb-4">
        <div className="text-xs font-medium text-gray-500 dark:text-[#808080] uppercase tracking-wide mb-2">Sessions</div>
        <div className="flex flex-wrap gap-1.5">
          {issue.sessions.map((session, idx) => {
            const link = getSessionLink(session.sessionId, session.workspacePath, session.worktreeRoot);
            const isActive = session.isActive;
            return (
              <a
                key={session.id || idx}
                href={link || '#'}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => { if (!link) e.preventDefault(); }}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                  isActive 
                    ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400 hover:bg-blue-200 dark:hover:bg-blue-900/60' 
                    : 'bg-gray-100 dark:bg-[#3d3d3d] text-gray-600 dark:text-[#a0a0a0] hover:bg-gray-200 dark:hover:bg-[#4d4d4d]'
                }`}
                title={`${session.workflowName || 'Session'} - ${formatDateTime(session.createdAt)}`}
              >
                {isActive && (
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                )}
                <span className="truncate max-w-[80px]">{session.workflowName || 'Session'}</span>
                <span className="text-[10px] opacity-60">↗</span>
              </a>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-0 md:p-4 modal-backdrop" onClick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="issue-modal bg-white dark:bg-[#252525] rounded-none md:rounded-xl shadow-2xl w-full max-w-5xl h-full md:h-auto md:max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 dark:border-[#3d3d3d] flex justify-between items-center bg-gray-50 dark:bg-[#2d2d2d]">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-gray-800 dark:text-[#e0e0e0]">
              {isExistingIssue ? issue.identifier : 'New Issue'}
            </h2>
            {isExistingIssue && (
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                state === 'Done' ? 'bg-green-100 text-green-700' :
                state === 'In Progress' ? 'bg-yellow-100 text-yellow-700' :
                state === 'Review' ? 'bg-purple-100 text-purple-700' :
                'bg-gray-100 text-gray-600'
              }`}>
                {state}
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:text-[#808080] dark:hover:text-[#a0a0a0] text-2xl leading-none p-1">&times;</button>
        </div>

        {/* Main Content - Two Column Layout */}
        <div className={`issue-modal-body flex-1 min-h-0 flex overflow-hidden ${activeTab === 'activity' && isExistingIssue ? 'activity-tab-active' : ''}`}>
          {/* Left Column: Main Content Area */}
          <div className="issue-modal-main flex-1 min-w-0 flex flex-col overflow-hidden">
            {/* Tabs for existing issues */}
            {isExistingIssue && (
              <div className="flex border-b border-gray-200 dark:border-[#3d3d3d] px-6 bg-white dark:bg-[#252525]">
                <button
                  onClick={() => setActiveTab('activity')}
                  className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                    activeTab === 'activity'
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 dark:text-[#a0a0a0] hover:text-gray-700 dark:hover:text-[#e0e0e0]'
                  }`}
                >
                  Activity
                  {comments.length > 0 && (
                    <span className="ml-2 px-1.5 py-0.5 bg-gray-100 dark:bg-[#3d3d3d] text-gray-600 dark:text-[#a0a0a0] text-xs rounded-full">
                      {comments.length}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => setActiveTab('details')}
                  className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                    activeTab === 'details'
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 dark:text-[#a0a0a0] hover:text-gray-700 dark:hover:text-[#e0e0e0]'
                  }`}
                >
                  Details
                </button>

              </div>
            )}

            {/* Tab Content */}
            <div className="flex-1 min-h-0 overflow-hidden">
              {/* Activity Tab - Comments Section */}
              {(activeTab === 'activity' && isExistingIssue) && (
                <div className="h-full flex flex-col">
                  {/* Comments List */}
                  <div className="flex-1 overflow-y-auto px-6 py-4">
                    {comments.length === 0 ? (
                      <div className="flex flex-col items-center justify-center h-full text-gray-400">
                        <svg className="w-12 h-12 mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                        </svg>
                        <p className="text-sm">No comments yet</p>
                        <p className="text-xs mt-1">Be the first to add a comment</p>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {comments.map(comment => (
                          <div key={comment.id} className="group">
                            <div className="flex items-start gap-3">
                              {/* Avatar */}
                              <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-medium ${
                                comment.author === 'agent' 
                                  ? 'bg-blue-100 text-blue-600' 
                                  : 'bg-green-100 text-green-600'
                              }`}>
                                {comment.author === 'agent' ? 'AI' : 'H'}
                              </div>
                              
                              {/* Comment Content */}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-baseline gap-2 mb-1">
                                  <span className="text-sm font-medium text-gray-900 dark:text-[#e0e0e0] capitalize">
                                    {comment.author === 'agent' ? 'Agent' : 'Human'}
                                  </span>
                                  <span className="text-xs text-gray-400 dark:text-[#808080]">
                                    {formatRelativeTime(comment.createdAt)}
                                  </span>
                                </div>
                                <div 
                                  className={`rounded-lg px-4 py-3 ${
                                    comment.author === 'agent' 
                                      ? 'bg-blue-50 dark:bg-blue-900/30 border border-blue-100 dark:border-blue-800' 
                                      : 'bg-gray-50 dark:bg-[#2d2d2d] border border-gray-100 dark:border-[#3d3d3d]'
                                  }`}
                                >
                                  <div 
                                    className="prose prose-sm max-w-none text-gray-700 dark:text-[#e0e0e0] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [overflow-wrap:anywhere] [word-break:break-word] [&_pre]:bg-gray-800 [&_pre]:text-gray-100 [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:overflow-x-auto [&_code]:bg-gray-200 dark:[&_code]:bg-[#3d3d3d] [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-sm [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_a]:text-blue-600 [&_a]:underline"
                                    dangerouslySetInnerHTML={{ __html: safeMarkdown(comment.content) }}
                                  />
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                        <div ref={commentsEndRef} />
                      </div>
                    )}
                  </div>

                  {/* Comment Input - Trello-style */}
                  <div className="comment-input-area border-t border-gray-200 dark:border-[#3d3d3d] bg-gray-50 dark:bg-[#2d2d2d] px-6 py-4">
                    <div className="flex items-start gap-3">
                      <div className="w-8 h-8 rounded-full bg-green-100 text-green-600 flex items-center justify-center flex-shrink-0 text-xs font-medium">
                        H
                      </div>
                      <div className="flex-1">
                        <textarea
                          ref={commentInputRef}
                          value={newComment}
                          onInput={(e) => setNewComment(e.currentTarget.value)}
                          placeholder="Write a comment..."
                          rows={3}
                          className="comment-textarea w-full px-3 py-2 border border-gray-300 dark:border-[#3d3d3d] rounded-lg resize-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm bg-white dark:bg-[#2d2d2d] dark:text-[#e0e0e0]"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                              e.preventDefault();
                              handleAddComment(e);
                            }
                          }}
                        />
                        <div className="flex items-center justify-between mt-2">
                          <p className="text-xs text-gray-400 dark:text-[#808080]">
                            {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to send
                          </p>
                          <button
                            onClick={handleAddComment}
                            disabled={!newComment.trim()}
                            className="px-4 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Details Tab - Issue Form */}
              {(activeTab === 'details' || !isExistingIssue) && (
                <div className="h-full overflow-y-auto p-6">
                  <form id="issue-form" onSubmit={handleSubmit} className="space-y-5 max-w-2xl">
                    {isExistingIssue && (
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <div className="text-xs font-medium text-gray-500 dark:text-[#808080] uppercase tracking-wide mb-1">Identifier</div>
                          <div className="text-sm text-gray-700 dark:text-[#a0a0a0] font-mono px-3 py-2">
                            {identifier}
                          </div>
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-[#a0a0a0] mb-1.5">State</label>
                          <select
                            value={state}
                            onChange={(e) => setState(e.currentTarget.value)}
                            className="w-full px-3 py-2 border border-gray-300 dark:border-[#3d3d3d] rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm bg-white dark:bg-[#2d2d2d] dark:text-[#e0e0e0]"
                          >
                            {KANBAN_COLUMNS.map(col => (
                              <option key={col} value={col}>{col}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    )}

                    {!isExistingIssue && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-[#a0a0a0] mb-1.5">State</label>
                        <select
                          value={state}
                          onChange={(e) => setState(e.currentTarget.value)}
                          className="w-full px-3 py-2 border border-gray-300 dark:border-[#3d3d3d] rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm bg-white dark:bg-[#2d2d2d] dark:text-[#e0e0e0]"
                        >
                          {KANBAN_COLUMNS.map(col => (
                            <option key={col} value={col}>{col}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-[#a0a0a0] mb-1.5">Workflow</label>
                      <select
                        value={workflowId}
                        onChange={(e) => { setWorkflowId(e.currentTarget.value); setModel(null); }}
                        className="w-full px-3 py-2 border border-gray-300 dark:border-[#3d3d3d] rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm bg-white dark:bg-[#2d2d2d] dark:text-[#e0e0e0]"
                      >
                        <option value="">(No Workflow)</option>
                        {workflows.filter(wf => !wf.hiddenFromPicker || wf.id === workflowId).map(wf => (
                          <option key={wf.id} value={wf.id}>
                            {wf.name} {wf.isDefault ? '(Default)' : ''}
                          </option>
                        ))}
                      </select>
                      <p className="text-xs text-gray-500 dark:text-[#808080] mt-1.5">
                        Assigning a workflow enables AI agent assistance for this issue.
                      </p>
                    </div>

                    {(() => {
                      const selectedWorkflow = workflows.find(wf => wf.id === workflowId);
                      const primaryModel = selectedWorkflow?.config?.opencode?.model;
                      const secondaryModel = selectedWorkflow?.config?.opencode?.secondary_model;
                      if (!selectedWorkflow || !secondaryModel) return null;
                      return (
                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-[#a0a0a0] mb-1.5">Model</label>
                          <select
                            value={model ?? ''}
                            onChange={(e) => setModel(e.currentTarget.value || null)}
                            className="w-full px-3 py-2 border border-gray-300 dark:border-[#3d3d3d] rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm bg-white dark:bg-[#2d2d2d] dark:text-[#e0e0e0]"
                          >
                            <option value="">{primaryModel ? `Primary (${primaryModel})` : 'Workflow default'}</option>
                            <option value={secondaryModel}>Secondary ({secondaryModel})</option>
                          </select>
                          <p className="text-xs text-gray-500 dark:text-[#808080] mt-1.5">
                            Select which model to use for this issue.
                          </p>
                        </div>
                      );
                    })()}

                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-[#a0a0a0] mb-1.5">Title</label>
                      <input
                        type="text"
                        value={title}
                        onInput={(e) => setTitle(e.currentTarget.value)}
                        className="w-full px-3 py-2 border border-gray-300 dark:border-[#3d3d3d] rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm bg-white dark:bg-[#2d2d2d] dark:text-[#e0e0e0]"
                        required
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-[#a0a0a0] mb-1.5">Description</label>
                      <textarea
                        value={description}
                        onInput={(e) => setDescription(e.currentTarget.value)}
                        className="w-full px-3 py-2 border border-gray-300 dark:border-[#3d3d3d] rounded-md h-48 font-mono text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-y bg-white dark:bg-[#2d2d2d] dark:text-[#e0e0e0]"
                      />
                    </div>
                  </form>
                </div>
              )}
            </div>
          </div>

          {/* Right Sidebar - Metadata (Only for existing issues) */}
          {isExistingIssue && (
            <div className="issue-modal-sidebar w-64 border-l border-gray-200 dark:border-[#3d3d3d] bg-gray-50 dark:bg-[#2d2d2d] p-4 overflow-y-auto flex-shrink-0">
              {/* Sessions - Compact badges */}
              {renderSessionBadges()}
              
              {/* Export Sessions Button */}
              {issue?.sessions && issue.sessions.length > 0 && (
                <div className="mb-4">
                  <button
                    onClick={handleExportSessions}
                    disabled={isExporting}
                    className="w-full px-3 py-2 text-sm text-gray-700 dark:text-[#a0a0a0] bg-white dark:bg-[#252525] border border-gray-300 dark:border-[#3d3d3d] rounded-md hover:bg-gray-50 dark:hover:bg-[#3d3d3d] disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
                  >
                    {isExporting ? (
                      <>
                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        <span>Exporting...</span>
                      </>
                    ) : (
                      <>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <span>Export Sessions</span>
                      </>
                    )}
                  </button>
                </div>
              )}
              
              {/* Quick Info */}
              <div className="space-y-3">
                <div>
                  <div className="text-xs font-medium text-gray-500 dark:text-[#808080] uppercase tracking-wide mb-1">State</div>
                  <div className={`inline-block px-2 py-1 rounded text-xs font-medium ${
                    state === 'Done' ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400' :
                    state === 'In Progress' ? 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400' :
                    state === 'Review' ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-400' :
                    'bg-gray-200 dark:bg-[#3d3d3d] text-gray-600 dark:text-[#a0a0a0]'
                  }`}>
                    {state}
                  </div>
                </div>
                
                <div>
                  <div className="text-xs font-medium text-gray-500 dark:text-[#808080] uppercase tracking-wide mb-1">Workflow</div>
                  <div className="text-sm text-gray-700 dark:text-[#a0a0a0]">
                    {workflows.find(w => w.id === workflowId)?.name || 'None'}
                  </div>
                </div>
                
                {issue.created && (
                  <div>
                    <div className="text-xs font-medium text-gray-500 dark:text-[#808080] uppercase tracking-wide mb-1">Created</div>
                    <div className="text-sm text-gray-700 dark:text-[#a0a0a0]">
                      {formatDate(issue.created)}
                    </div>
                  </div>
                )}
                
                {issue.labels && issue.labels.length > 0 && (
                  <div>
                    <div className="text-xs font-medium text-gray-500 dark:text-[#808080] uppercase tracking-wide mb-1">Labels</div>
                    <div className="flex flex-wrap gap-1">
                      {sortLabels(issue.labels).map((label) => {
                        const color = getLabelColor(label);
                        return color ? (
                          <span key={label} className="label-bar" style={{ backgroundColor: color.bg }} title={label} />
                        ) : null;
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-[#3d3d3d] bg-gray-50 dark:bg-[#2d2d2d] flex justify-between items-center">
          <div>
            {isExistingIssue && (
              <button
                type="button"
                onClick={handleArchive}
                className="px-3 py-1.5 text-sm text-red-600 hover:text-red-700 hover:bg-red-50 rounded-md transition-colors"
              >
                Archive
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            {(activeTab === 'details' || !isExistingIssue) && (
              <p className="text-xs text-gray-400 dark:text-[#808080]">
                {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to save
              </p>
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm bg-white dark:bg-[#252525] text-gray-700 dark:text-[#a0a0a0] border border-gray-300 dark:border-[#3d3d3d] rounded-md hover:bg-gray-50 dark:hover:bg-[#3d3d3d] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="issue-form"
              disabled={isSubmitting || isGeneratingId}
              className="px-5 py-2 text-sm bg-blue-600 text-white font-medium rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {isSubmitting ? 'Saving...' : isGeneratingId ? 'Loading...' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      {showExportViewer && exportData && issue && (
        <SessionsExportViewer
          issueIdentifier={issue.identifier}
          exportData={exportData}
          onClose={() => setShowExportViewer(false)}
        />
      )}
    </div>
  );
}
