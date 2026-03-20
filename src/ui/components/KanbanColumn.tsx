import type { JSX } from 'preact';
import { Fragment } from 'preact';
import { useState, useCallback } from 'preact/hooks';
import type { Issue, RunningAgent, InputRequest, KanbanColumnState } from '../types.js';
import { KanbanCard } from './KanbanCard.js';
import { QuickAddCard } from './QuickAddCard.js';
import type { QuickAddPosition } from './KanbanBoard.js';

type DragEventHandler = JSX.DragEventHandler<HTMLDivElement>;

interface KanbanColumnProps {
  columnState: KanbanColumnState;
  issues: Issue[];
  runningAgents: RunningAgent[];
  pendingInputRequests: Record<string, InputRequest>;
  workflowBadgeMode?: 'border';
  workflowColorMap?: Record<string, string | null | undefined>;
  selectedCardId: string | null;
  quickAddPosition: QuickAddPosition | null;
  onCardClick: (issueId: string) => void;
  onCardDrop: (issueId: string, newState: KanbanColumnState) => void;
  onAddCard: (state: KanbanColumnState) => void;
  onArchiveCard: (issueId: string) => void;
  onQuickAddSave: () => void;
  onQuickAddCancel: () => void;
  onHoverEnter: (col: KanbanColumnState) => void;
  onHoverLeave: () => void;
}

const COLUMN_ICONS: Record<KanbanColumnState, { border: string; bg: string }> = {
  'Backlog': { border: '#9b9a97', bg: 'transparent' },
  'Todo': { border: '#9b9a97', bg: 'transparent' },
  'In Progress': { border: '#f7b955', bg: '#f7b955' },
  'Review': { border: '#9065e0', bg: '#9065e0' },
  'Done': { border: '#6bc950', bg: '#6bc950' },
};

export function KanbanColumn({
  columnState,
  issues,
  runningAgents,
  pendingInputRequests,
  workflowBadgeMode,
  workflowColorMap,
  selectedCardId,
  quickAddPosition,
  onCardClick,
  onCardDrop,
  onAddCard,
  onArchiveCard,
  onQuickAddSave,
  onQuickAddCancel,
  onHoverEnter,
  onHoverLeave,
}: KanbanColumnProps): JSX.Element {
  const [isDragOver, setIsDragOver] = useState(false);

  const icon = COLUMN_ICONS[columnState];

  const handleDragOver: DragEventHandler = useCallback((e) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
    setIsDragOver(true);
  }, []);

  const handleDragLeave: DragEventHandler = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop: DragEventHandler = useCallback((e) => {
    e.preventDefault();
    setIsDragOver(false);
    const issueId = e.dataTransfer?.getData('text/plain');
    if (issueId) {
      onCardDrop(issueId, columnState);
    }
  }, [onCardDrop, columnState]);

  return (
    <div
      className="kanban-column flex flex-col group"
      onMouseEnter={() => onHoverEnter(columnState)}
      onMouseLeave={onHoverLeave}
    >
      <div className="flex items-center justify-between px-1 py-2 mb-2">
        <div className="flex items-center gap-2">
          <span
            className="w-4 h-4 rounded-full flex-shrink-0"
            style={{
              border: `2px solid ${icon.border}`,
              background: icon.bg,
            }}
          />
          <span className="text-sm font-medium text-gray-800 dark:text-[#e0e0e0]">{columnState}</span>
          <span className="text-sm text-gray-400 dark:text-[#808080] ml-1">{issues.length}</span>
        </div>
        <button
          onClick={() => onAddCard(columnState)}
          className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-200 dark:hover:text-[#e0e0e0] dark:hover:bg-[#3d3d3d] rounded opacity-0 group-hover:opacity-100 transition-opacity"
          title={`Add card to ${columnState}`}
        >
          +
        </button>
      </div>

      <div
        className={`flex-1 flex flex-col gap-2 min-h-[100px] rounded-md transition-colors ${
          isDragOver ? 'bg-blue-50 dark:bg-blue-900/30 outline-2 outline-dashed outline-blue-400 -outline-offset-2' : ''
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {quickAddPosition && quickAddPosition.afterCardId === null && (
          <QuickAddCard
            columnState={columnState}
            onSave={onQuickAddSave}
            onCancel={onQuickAddCancel}
          />
        )}

        {issues.map((issue) => (
          <Fragment key={issue.id}>
            <KanbanCard
              issue={issue}
              runningAgent={runningAgents.find((a) => a.issueId === issue.id)}
              pendingInput={pendingInputRequests[issue.id]}
              workflowBadgeMode={workflowBadgeMode}
              workflowColorOverride={issue.workflowId ? workflowColorMap?.[issue.workflowId] : undefined}
              isSelected={selectedCardId === issue.id}
              onClick={() => onCardClick(issue.id)}
              onArchive={() => onArchiveCard(issue.id)}
            />
            {quickAddPosition && quickAddPosition.afterCardId === issue.id && (
              <QuickAddCard
                columnState={columnState}
                onSave={onQuickAddSave}
                onCancel={onQuickAddCancel}
              />
            )}
          </Fragment>
        ))}

        {issues.length === 0 && !isDragOver && !quickAddPosition && (
          <div className="text-center py-8 text-gray-400 dark:text-[#6b6b6b] text-xs">
            No issues
          </div>
        )}
      </div>
    </div>
  );
}
