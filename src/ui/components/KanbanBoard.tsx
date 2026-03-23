import type { JSX } from 'preact';
import { useCallback, useState, useEffect, useRef } from 'preact/hooks';
import type { Issue, RunningAgent, InputRequest } from '../types.js';
import { KANBAN_COLUMNS, KanbanColumnState } from '../types.js';
import { api } from '../api.js';
import { KanbanColumn } from './KanbanColumn.js';

// Copied from KanbanColumn.tsx since it's not exported
const COLUMN_ICONS: Record<KanbanColumnState, { border: string; bg: string }> = {
  'Backlog': { border: '#9b9a97', bg: 'transparent' },
  'Todo': { border: '#9b9a97', bg: 'transparent' },
  'In Progress': { border: '#f7b955', bg: '#f7b955' },
  'Review': { border: '#9065e0', bg: '#9065e0' },
  'Done': { border: '#6bc950', bg: '#6bc950' },
};

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
  const [isMobile, setIsMobile] = useState(false);
  const boardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.matchMedia('(max-width: 768px)').matches);
    };
    
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

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
    if (!board || isMobile) return;

    const handleScroll = () => {
      const scrollLeft = board.scrollLeft;
      const columnWidth = board.scrollWidth / KANBAN_COLUMNS.length;
      const newIndex = Math.round(scrollLeft / columnWidth);
      setActiveColumnIndex(Math.min(newIndex, KANBAN_COLUMNS.length - 1));
    };

    board.addEventListener('scroll', handleScroll, { passive: true });
    return () => board.removeEventListener('scroll', handleScroll);
  }, [isMobile]);

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

  const renderColumn = (col: KanbanColumnState) => (
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
  );

  return (
    <div className="kanban-container flex-1 flex flex-col bg-[#f8f7f6] dark:bg-[#191919]">
      <div className="mobile-tabs">
        {KANBAN_COLUMNS.map((col, index) => {
          const count = issuesByColumn(col).length;
          const isActive = index === activeColumnIndex;
          const icon = COLUMN_ICONS[col];
          
          return (
            <div
              key={col}
              className={`mobile-tab ${isActive ? 'active' : ''}`}
              onClick={() => setActiveColumnIndex(index)}
              style={isActive ? { borderBottomColor: icon.border === '#9b9a97' ? 'var(--text-primary)' : icon.border } : {}}
            >
              <span className="mobile-tab-label">{col}</span>
              <span className="mobile-tab-count">{count}</span>
            </div>
          );
        })}
      </div>

      <div 
        ref={boardRef}
        className="kanban-board flex-1 overflow-x-auto p-5"
      >
        <div className="flex gap-3 min-h-[calc(100vh-200px)]">
          {isMobile ? renderColumn(KANBAN_COLUMNS[activeColumnIndex]) : KANBAN_COLUMNS.map(renderColumn)}
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
