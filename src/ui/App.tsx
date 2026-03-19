import type { JSX } from 'preact';
import { useState, useCallback } from 'preact/hooks';
import type { ViewType, KanbanColumnState, Workflow, Issue } from './types.js';
import { useAppState } from './hooks/useAppState.js';
import { Header } from './components/Header.js';
import { KanbanBoard } from './components/KanbanBoard.js';
import { WorkflowsView } from './components/WorkflowsView.js';
import { LogsView } from './components/LogsView.js';
import { SettingsView } from './components/SettingsView.js';
import { ArchivedView } from './components/ArchivedView.js';
import { IssueModal } from './components/IssueModal.js';
import { WorkflowModal } from './components/WorkflowModal.js';
import { ChatPanel } from './components/ChatPanel.js';

import { updateUrlState } from './utils/helpers.js';

export function App(): JSX.Element {
  const { state, updateState, fetchIssues, fetchWorkflows } = useAppState();
  const [newIssueDefaultState, setNewIssueDefaultState] = useState<KanbanColumnState | null>(null);
  const [editingWorkflow, setEditingWorkflow] = useState<Workflow | null>(null);
  const [showWorkflowModal, setShowWorkflowModal] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  const handleViewChange = useCallback(
    (view: ViewType): void => {
      updateState({ currentView: view, selectedIssueId: null, selectedWorkflowId: null });
      updateUrlState({ view });
    },
    [updateState]
  );

  const handleCardClick = useCallback(
    (issueId: string): void => {
      updateState({ selectedIssueId: issueId });
    },
    [updateState]
  );

  const handleAddCard = useCallback(
    (columnState: KanbanColumnState): void => {
      setNewIssueDefaultState(columnState);
      updateState({ selectedIssueId: '__new__' });
    },
    [updateState]
  );

  const handleCloseIssueModal = useCallback((): void => {
    updateState({ selectedIssueId: null });
    setNewIssueDefaultState(null);
  }, [updateState]);

  const handleIssueSaved = useCallback(async (): Promise<void> => {
    updateState({ selectedIssueId: null });
    setNewIssueDefaultState(null);
    await fetchIssues();
  }, [updateState, fetchIssues]);

  const handleEditWorkflow = useCallback((workflow: Workflow): void => {
    setEditingWorkflow(workflow);
    setShowWorkflowModal(true);
  }, []);

  const handleCreateWorkflow = useCallback((): void => {
    setEditingWorkflow(null);
    setShowWorkflowModal(true);
  }, []);

  const handleCloseWorkflowModal = useCallback((): void => {
    setShowWorkflowModal(false);
    setEditingWorkflow(null);
  }, []);

  const handleWorkflowSaved = useCallback(async (): Promise<void> => {
    setShowWorkflowModal(false);
    setEditingWorkflow(null);
    await fetchWorkflows();
  }, [fetchWorkflows]);

  const selectedIssue: Issue | undefined =
    state.selectedIssueId && state.selectedIssueId !== '__new__'
      ? state.issues.find((i) => i.id === state.selectedIssueId)
      : undefined;

  const isCreatingNewIssue = state.selectedIssueId === '__new__';

  return (
    <div className="flex flex-col h-screen" style={{ background: 'var(--bg-primary)' }}>
      <Header 
        currentView={state.currentView} 
        onViewChange={handleViewChange}
        onAddCard={handleAddCard}
        onOpenChat={() => setChatOpen(true)}
      />

      <main className="flex-1 flex flex-col overflow-hidden">
        {state.currentView === 'issues' && (
          <KanbanBoard
            issues={state.issues}
            runningAgents={state.runningAgents}
            pendingInputRequests={state.pendingInputRequests}
            workflowBadgeMode={state.workflowBadgeMode}
            onCardClick={handleCardClick}
            onAddCard={handleAddCard}
            onIssuesChanged={fetchIssues}
          />
        )}

        {state.currentView === 'workflows' && (
          <WorkflowsView
            workflows={state.workflows}
            onEdit={handleEditWorkflow}
            onCreate={handleCreateWorkflow}
          />
        )}

        {state.currentView === 'logs' && <LogsView logs={state.logs} />}

        {state.currentView === 'settings' && <SettingsView />}

        {state.currentView === 'archive' && <ArchivedView onIssueRestored={fetchIssues} />}

      </main>

      {(selectedIssue || isCreatingNewIssue) && (
        <IssueModal
          issue={
            isCreatingNewIssue
              ? newIssueDefaultState
                ? ({ state: newIssueDefaultState } as Issue)
                : undefined
              : selectedIssue
          }
          onClose={handleCloseIssueModal}
          onSave={handleIssueSaved}
        />
      )}

      {showWorkflowModal && (
        <WorkflowModal
          workflow={editingWorkflow ?? undefined}
          onClose={handleCloseWorkflowModal}
          onSave={handleWorkflowSaved}
        />
      )}

      <ChatPanel isOpen={chatOpen} onClose={() => setChatOpen(false)} onOpen={() => setChatOpen(true)} />
    </div>
  );
}
