import { useState, useEffect, useCallback } from 'preact/hooks';
import type { Issue } from '../types.js';
import { api } from '../api.js';
import { formatDate } from '../utils/helpers.js';
import { ArchivedCardModal } from './ArchivedCardModal.js';

interface ArchivedViewProps {
  onIssueRestored: () => void;
}

export function ArchivedView({ onIssueRestored }: ArchivedViewProps) {
  const [archivedIssues, setArchivedIssues] = useState<Issue[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null);

  const fetchArchivedIssues = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const issues = await api.getArchivedIssues();
      setArchivedIssues(issues);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchArchivedIssues();
  }, [fetchArchivedIssues]);

  const handleRestore = async (issueId: string, newState: string) => {
    try {
      await api.unarchiveIssue(issueId, newState);
      setArchivedIssues(prev => prev.filter(i => i.id !== issueId));
      setSelectedIssue(null);
      onIssueRestored();
    } catch (err) {
      setError((err as Error).message);
      throw err;
    }
  };

  const filteredIssues = archivedIssues.filter(issue => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    
    return (
      issue.title.toLowerCase().includes(query) ||
      issue.identifier.toLowerCase().includes(query) ||
      issue.description?.toLowerCase().includes(query) ||
      issue.labels?.some(label => label.toLowerCase().includes(query)) ||
      issue.comments?.some(comment => comment.content.toLowerCase().includes(query))
    );
  });

  return (
    <div className="p-6 max-w-6xl mx-auto h-full overflow-y-auto w-full">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-gray-800 dark:text-[#e0e0e0] m-0">Archived Cards</h2>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500 dark:text-[#a0a0a0]">
            {filteredIssues.length} {filteredIssues.length === 1 ? 'card' : 'cards'}
          </span>
        </div>
      </div>

      <div className="mb-6">
        <input
          type="text"
          placeholder="Search archived cards..."
          value={searchQuery}
          onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
          className="w-full px-4 py-2 border border-gray-300 dark:border-[#3d3d3d] rounded-lg bg-white dark:bg-[#2d2d2d] text-gray-900 dark:text-[#e0e0e0] placeholder-gray-400 dark:placeholder-[#808080] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </div>

      {loading && (
        <div className="text-center py-10 text-gray-500 dark:text-[#a0a0a0]">
          Loading archived cards...
        </div>
      )}

      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 p-4 rounded-lg mb-4">
          {error}
        </div>
      )}

      {!loading && !error && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 w-full">
          {filteredIssues.length === 0 ? (
            <div className="col-span-full text-center py-10 text-gray-500 dark:text-[#a0a0a0] bg-white dark:bg-[#252525] rounded-lg border border-dashed border-gray-300 dark:border-[#3d3d3d]">
              {searchQuery ? 'No archived cards match your search.' : 'No archived cards.'}
            </div>
          ) : (
            filteredIssues.map(issue => (
              <div 
                key={issue.id} 
                onClick={() => setSelectedIssue(issue)}
                className="bg-white dark:bg-[#252525] rounded-lg shadow-sm border border-gray-200 dark:border-[#3d3d3d] p-5 flex flex-col cursor-pointer hover:shadow-md hover:border-gray-300 dark:hover:border-[#4d4d4d] transition-all"
              >
                <div className="flex justify-between items-start mb-2">
                  <span className="text-xs font-medium text-gray-500 dark:text-[#a0a0a0]">{issue.identifier}</span>
                  <span className="text-xs text-gray-400 dark:text-[#808080]">{formatDate(issue.lastModified ?? issue.created)}</span>
                </div>
                
                <h3 className="font-semibold text-gray-900 dark:text-[#e0e0e0] mb-2 leading-snug" title={issue.title}>
                  {issue.title}
                </h3>
                
                {issue.description && (
                  <p className="text-gray-600 dark:text-[#a0a0a0] text-sm mb-3 line-clamp-2">
                    {issue.description}
                  </p>
                )}

                <div className="mt-auto flex items-center justify-between text-xs text-gray-400 dark:text-[#808080]">
                  {issue.sessions && issue.sessions.length > 0 && (
                    <span>{issue.sessions.length} {issue.sessions.length === 1 ? 'session' : 'sessions'}</span>
                  )}
                  {issue.comments && issue.comments.length > 0 && (
                    <span>{issue.comments.length} {issue.comments.length === 1 ? 'comment' : 'comments'}</span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {selectedIssue && (
        <ArchivedCardModal
          issue={selectedIssue}
          onClose={() => setSelectedIssue(null)}
          onRestore={handleRestore}
        />
      )}
    </div>
  );
}
