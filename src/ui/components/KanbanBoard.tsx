import type { JSX } from 'preact';
import { useCallback, useState, useEffect, useRef } from 'preact/hooks';
import type { Issue, RunningAgent, InputRequest, KanbanColumnState } from '../types.js';
import { KANBAN_COLUMNS } from '../types.js';
import { api } from '../api.js';
import { KanbanColumn } from './KanbanColumn.js';

export interface QuickAddPosition {
  columnState: KanbanColumnState;
  afterCardId: string | null;
}

interface KanbanBoardProps {
  issues: Issue[];
  runningAgents: RunningAgent[];
  pendingInputRequests: Record<string, InputRequest>;
  workflowBadgeMode?: 'border';
  workflowColorMap?: Record<string, string | null | undefined>;
  onCardClick: (issueId: string) => void;
  onAddCard: (state: KanbanColumnState) => void;
  onIssuesChanged: () => void;
}

export function KanbanBoard({
  issues,
  runningAgents,
  pendingInputRequests,
  workflowBadgeMode,
  workflowColorMap,
  onCardClick,
  onAddCard,
  onIssuesChanged,
}: KanbanBoardProps): JSX.Element {
  const [activeColumnIndex, setActiveColumnIndex] = useState(0);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [quickAddPosition, setQuickAddPosition] = useState<QuickAddPosition | null>(null);
  const [hoveredColumnState, setHoveredColumnState] = useState<KanbanColumnState | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  const issuesByColumn = useCallback(
    (col: KanbanColumnState): Issue[] =>
      issues
        .filter((issue) => issue.state === col)
        .sort((a, b) => (b.lastModified ?? b.created ?? 0) - (a.lastModified ?? a.created ?? 0)),
    [issues]
  );

  const handleCardDrop = useCallback(
    async (issueId: string, newState: KanbanColumnState): Promise<void> => {
      const issue = issues.find((i) => i.id === issueId);
      if (!issue || issue.state === newState) return;

      try {
        await api.updateIssue(issueId, { state: newState });
        onIssuesChanged();
      } catch (err) {
        console.error('Failed to move issue', err);
      }
    },
    [issues, onIssuesChanged]
  );

  const handleArchiveCard = useCallback(
    async (issueId: string): Promise<void> => {
      try {
        await api.archiveIssue(issueId);
        onIssuesChanged();
      } catch (err) {
        console.error('Failed to archive issue', err);
      }
    },
    [onIssuesChanged]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (quickAddPosition) return;
      
      const target = e.target as HTMLElement;
      const isInputFocused = target.tagName === 'INPUT' || 
                             target.tagName === 'TEXTAREA' || 
                             target.isContentEditable;
      if (isInputFocused) return;

      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        
        const targetColumn = hoveredColumnState ?? KANBAN_COLUMNS[activeColumnIndex];
        setQuickAddPosition({
          columnState: targetColumn,
          afterCardId: null,
        });
      }
      
      if (e.key === 'Escape') {
        setSelectedCardId(null);
        setQuickAddPosition(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [quickAddPosition, activeColumnIndex, hoveredColumnState]);

  const handleQuickAddSave = useCallback(() => {
    setQuickAddPosition(null);
    setSelectedCardId(null);
    onIssuesChanged();
  }, [onIssuesChanged]);

  const handleQuickAddCancel = useCallback(() => {
    setQuickAddPosition(null);
  }, []);

  const handleCardSelect = useCallback((issueId: string) => {
    setSelectedCardId(issueId);
    onCardClick(issueId);
  }, [onCardClick]);

  // Track scroll position to update column indicator dots
  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;

    const handleScroll = () => {
      const scrollLeft = board.scrollLeft;
      const columnWidth = board.scrollWidth / KANBAN_COLUMNS.length;
      const newIndex = Math.round(scrollLeft / columnWidth);
      setActiveColumnIndex(Math.min(newIndex, KANBAN_COLUMNS.length - 1));
    };

    board.addEventListener('scroll', handleScroll, { passive: true });
    return () => board.removeEventListener('scroll', handleScroll);
  }, []);

  const handleDotClick = useCallback((index: number) => {
    const board = boardRef.current;
    if (!board) return;
    
    const columnWidth = board.scrollWidth / KANBAN_COLUMNS.length;
    board.scrollTo({ left: columnWidth * index, behavior: 'smooth' });
  }, []);

  const handleColumnHoverEnter = useCallback((col: KanbanColumnState) => {
    setHoveredColumnState(col);
  }, []);

  const handleColumnHoverLeave = useCallback(() => {
    setHoveredColumnState(null);
  }, []);

  return (
    <div className="kanban-container flex-1 flex flex-col bg-[#f8f7f6] dark:bg-[#191919]">
      <div 
        ref={boardRef}
        className="kanban-board flex-1 overflow-x-auto p-5"
      >
        <div className="flex gap-3 min-h-[calc(100vh-200px)]">
          {KANBAN_COLUMNS.map((col) => (
            <KanbanColumn
              key={col}
              columnState={col}
              issues={issuesByColumn(col)}
              runningAgents={runningAgents}
              pendingInputRequests={pendingInputRequests}
              workflowBadgeMode={workflowBadgeMode}
              workflowColorMap={workflowColorMap}
              selectedCardId={selectedCardId}
              quickAddPosition={quickAddPosition?.columnState === col ? quickAddPosition : null}
              onCardClick={handleCardSelect}
              onCardDrop={handleCardDrop}
              onAddCard={onAddCard}
              onArchiveCard={handleArchiveCard}
              onQuickAddSave={handleQuickAddSave}
              onQuickAddCancel={handleQuickAddCancel}
              onHoverEnter={handleColumnHoverEnter}
              onHoverLeave={handleColumnHoverLeave}
            />
          ))}
        </div>
      </div>
      
      <div className="column-indicator">
        {KANBAN_COLUMNS.map((col, index) => (
          <button
            key={col}
            className={`column-dot ${index === activeColumnIndex ? 'active' : ''}`}
            onClick={() => handleDotClick(index)}
            aria-label={`Go to ${col} column`}
          />
        ))}
      </div>
    </div>
  );
}
