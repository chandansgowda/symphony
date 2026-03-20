import { useEffect } from 'preact/hooks';
import { safeMarkdown, formatDateTime } from '../utils/helpers.js';

export interface SessionExport {
  id: string;
  issueId: string;
  markdownContent: string;
  sessionCount: number;
  createdAt: string;
  updatedAt: string;
}

interface SessionsExportViewerProps {
  issueIdentifier: string;
  exportData: SessionExport;
  onClose: () => void;
}

export function SessionsExportViewer({ issueIdentifier, exportData, onClose }: SessionsExportViewerProps) {
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  const handleDownload = () => {
    const blob = new Blob([exportData.markdownContent], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${issueIdentifier}-sessions-export.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white dark:bg-[#252525] rounded-xl shadow-2xl w-full max-w-5xl max-h-[95vh] flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-[#3d3d3d] bg-gray-50 dark:bg-[#2d2d2d] flex justify-between items-center">
          <div>
            <h2 className="text-lg font-semibold text-gray-800 dark:text-[#e0e0e0]">
              Sessions Export — {issueIdentifier}
            </h2>
            <div className="flex items-center gap-4 mt-1 text-sm text-gray-500 dark:text-[#a0a0a0]">
              <span>{exportData.sessionCount} session{exportData.sessionCount !== 1 ? 's' : ''}</span>
              <span>•</span>
              <span>Generated {formatDateTime(exportData.updatedAt)}</span>
            </div>
          </div>
          <button 
            onClick={onClose} 
            className="text-gray-400 dark:text-[#808080] hover:text-gray-600 dark:hover:text-[#a0a0a0] text-2xl leading-none p-1"
          >
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 bg-white dark:bg-[#252525]">
          <div 
            className="prose prose-sm max-w-none text-gray-700 dark:text-[#c0c0c0]
              [&>h1]:text-2xl [&>h1]:font-bold [&>h1]:text-gray-900 dark:[&>h1]:text-[#e0e0e0] [&>h1]:mb-4 [&>h1]:border-b [&>h1]:pb-2
              [&>h2]:text-xl [&>h2]:font-semibold [&>h2]:text-gray-800 dark:[&>h2]:text-[#d0d0d0] [&>h2]:mt-8 [&>h2]:mb-3
              [&>h3]:text-lg [&>h3]:font-medium [&>h3]:text-gray-700 dark:[&>h3]:text-[#c0c0c0] [&>h3]:mt-6 [&>h3]:mb-2
              [&>h4]:text-base [&>h4]:font-medium [&>h4]:text-gray-600 dark:[&>h4]:text-[#a0a0a0] [&>h4]:mt-4 [&>h4]:mb-2
              [&>hr]:my-6 [&>hr]:border-gray-200 dark:[&>hr]:border-[#3d3d3d]
              [&>ul]:list-disc [&>ul]:pl-6 [&>ul]:my-2
              [&>p]:my-2
              [&_code]:bg-gray-100 dark:[&_code]:bg-[#3d3d3d] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-sm [&_code]:font-mono
              [&_pre]:bg-gray-800 [&_pre]:text-gray-100 [&_pre]:rounded-lg [&_pre]:p-4 [&_pre]:overflow-x-auto [&_pre]:my-4
              [&_pre_code]:bg-transparent [&_pre_code]:p-0
              [&_a]:text-blue-600 dark:[&_a]:text-blue-400 [&_a]:underline [&_a]:hover:text-blue-800 dark:[&_a]:hover:text-blue-300
              [&_blockquote]:border-l-4 [&_blockquote]:border-gray-300 dark:[&_blockquote]:border-[#4d4d4d] [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-gray-600 dark:[&_blockquote]:text-[#a0a0a0]"
            dangerouslySetInnerHTML={{ __html: safeMarkdown(exportData.markdownContent) }}
          />
        </div>

        <div className="px-6 py-4 border-t border-gray-200 dark:border-[#3d3d3d] bg-gray-50 dark:bg-[#2d2d2d] flex justify-between items-center">
          <button
            onClick={handleDownload}
            className="px-4 py-2 text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded-md transition-colors flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Download Markdown
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm bg-white dark:bg-[#2d2d2d] text-gray-700 dark:text-[#c0c0c0] border border-gray-300 dark:border-[#3d3d3d] rounded-md hover:bg-gray-50 dark:hover:bg-[#3d3d3d] transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
