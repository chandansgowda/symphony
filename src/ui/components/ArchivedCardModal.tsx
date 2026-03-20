import { useState } from 'preact/hooks';
import type { Issue, Comment } from '../types.js';
import { formatDate, formatRelativeTime, safeMarkdown } from '../utils/helpers.js';

const RESTORE_STATES = ['Backlog', 'Todo', 'In Progress', 'Review', 'Done'] as const;

interface ArchivedCardModalProps {
  issue: Issue;
  onClose: () => void;
  onRestore: (issueId: string, state: string) => Promise<void>;
}

export function ArchivedCardModal({ issue, onClose, onRestore }: ArchivedCardModalProps) {
  const [isRestoring, setIsRestoring] = useState(false);
  const [activeTab, setActiveTab] = useState<'details' | 'activity'>('details');

  const handleRestore = async (state: string) => {
    setIsRestoring(true);
    try {
      await onRestore(issue.id, state);
      onClose();
    } catch (err) {
      console.error('Failed to restore issue', err);
      alert('Failed to restore issue');
    } finally {
      setIsRestoring(false);
    }
  };

  const comments = issue.comments || [];

  return (
    <div 
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4 modal-backdrop" 
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white dark:bg-[#252525] rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 dark:border-[#3d3d3d] flex justify-between items-center bg-gray-50 dark:bg-[#2d2d2d]">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-gray-800 dark:text-[#e0e0e0]">{issue.identifier}</h2>
            <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-200 dark:bg-[#3d3d3d] text-gray-600 dark:text-[#a0a0a0]">
              Archived
            </span>
          </div>
          <button 
            onClick={onClose} 
            className="text-gray-400 dark:text-[#808080] hover:text-gray-600 dark:hover:text-[#a0a0a0] text-2xl leading-none p-1"
          >
            &times;
          </button>
        </div>

        {/* Main Content */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {/* Tabs */}
          <div className="flex border-b border-gray-200 dark:border-[#3d3d3d] px-6 bg-white dark:bg-[#252525]">
            <button
              onClick={() => setActiveTab('details')}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'details'
                  ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 dark:text-[#808080] hover:text-gray-700 dark:hover:text-[#a0a0a0]'
              }`}
            >
              Details
            </button>
            <button
              onClick={() => setActiveTab('activity')}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'activity'
                  ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 dark:text-[#808080] hover:text-gray-700 dark:hover:text-[#a0a0a0]'
              }`}
            >
              Activity
              {comments.length > 0 && (
                <span className="ml-2 px-1.5 py-0.5 bg-gray-100 dark:bg-[#3d3d3d] text-gray-600 dark:text-[#a0a0a0] text-xs rounded-full">
                  {comments.length}
                </span>
              )}
            </button>
          </div>

          {/* Tab Content */}
          <div className="flex-1 min-h-0 overflow-y-auto bg-white dark:bg-[#252525]">
            {activeTab === 'details' && (
              <div className="p-6 space-y-4">
                <div>
                  <h3 className="text-xl font-semibold text-gray-900 dark:text-[#e0e0e0] mb-2">{issue.title}</h3>
                  {issue.description ? (
                    <div 
                      className="prose prose-sm max-w-none text-gray-600 dark:text-[#a0a0a0] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                      dangerouslySetInnerHTML={{ __html: safeMarkdown(issue.description) }}
                    />
                  ) : (
                    <p className="text-gray-400 dark:text-[#606060] italic">No description</p>
                  )}
                </div>

                {issue.labels && issue.labels.length > 0 && (
                  <div>
                    <div className="text-xs font-medium text-gray-500 dark:text-[#808080] uppercase tracking-wide mb-2">Labels</div>
                    <div className="flex flex-wrap gap-2">
                      {issue.labels.map(label => (
                        <span key={label} className="px-2 py-1 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 text-xs rounded">
                          {label}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {issue.sessions && issue.sessions.length > 0 && (
                  <div>
                    <div className="text-xs font-medium text-gray-500 dark:text-[#808080] uppercase tracking-wide mb-2">Sessions</div>
                    <div className="text-sm text-gray-600 dark:text-[#a0a0a0]">
                      {issue.sessions.length} {issue.sessions.length === 1 ? 'session' : 'sessions'}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-4 pt-4 border-t border-gray-100 dark:border-[#3d3d3d]">
                  <div>
                    <div className="text-xs font-medium text-gray-500 dark:text-[#808080] uppercase tracking-wide mb-1">Created</div>
                    <div className="text-sm text-gray-700 dark:text-[#c0c0c0]">{formatDate(issue.created)}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-gray-500 dark:text-[#808080] uppercase tracking-wide mb-1">Updated</div>
                    <div className="text-sm text-gray-700 dark:text-[#c0c0c0]">{formatDate(issue.lastModified)}</div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'activity' && (
              <div className="p-6">
                {comments.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-gray-400 dark:text-[#606060]">
                    <svg className="w-12 h-12 mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                    </svg>
                    <p className="text-sm">No comments</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {comments.map((comment: Comment) => (
                      <div key={comment.id} className="group">
                        <div className="flex items-start gap-3">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-medium ${
                            comment.author === 'agent' 
                              ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400' 
                              : 'bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400'
                          }`}>
                            {comment.author === 'agent' ? 'AI' : 'H'}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline gap-2 mb-1">
                              <span className="text-sm font-medium text-gray-900 dark:text-[#e0e0e0] capitalize">
                                {comment.author === 'agent' ? 'Agent' : 'Human'}
                              </span>
                              <span className="text-xs text-gray-400 dark:text-[#606060]">
                                {formatRelativeTime(comment.createdAt)}
                              </span>
                            </div>
                            <div className={`rounded-lg px-4 py-3 ${
                              comment.author === 'agent' 
                                ? 'bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800/50' 
                                : 'bg-gray-50 dark:bg-[#2d2d2d] border border-gray-100 dark:border-[#3d3d3d]'
                            }`}>
                              <div 
                                className="prose prose-sm max-w-none text-gray-700 dark:text-[#c0c0c0] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [overflow-wrap:anywhere] [word-break:break-word] [&_pre]:bg-gray-800 [&_pre]:text-gray-100 [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:overflow-x-auto [&_code]:bg-gray-200 dark:[&_code]:bg-[#3d3d3d] [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-sm [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_a]:text-blue-600 dark:[&_a]:text-blue-400 [&_a]:underline"
                                dangerouslySetInnerHTML={{ __html: safeMarkdown(comment.content) }}
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer with Restore Options */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-[#3d3d3d] bg-gray-50 dark:bg-[#2d2d2d]">
          <div className="flex items-center justify-between">
            <div className="text-sm text-gray-600 dark:text-[#a0a0a0]">Restore to:</div>
            <div className="flex flex-wrap gap-2">
              {RESTORE_STATES.map(state => (
                <button
                  key={state}
                  onClick={() => handleRestore(state)}
                  disabled={isRestoring}
                  className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                    isRestoring
                      ? 'bg-gray-100 dark:bg-[#3d3d3d] text-gray-400 dark:text-[#606060] cursor-not-allowed'
                      : 'bg-blue-600 hover:bg-blue-700 text-white'
                  }`}
                >
                  {state}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
