import { useState, useEffect, useCallback } from 'preact/hooks';
import type { AppState, ViewType } from '../types.js';
import { api } from '../api.js';
import { useEventSource } from './useEventSource.js';
import { parseUrlState, updateUrlState } from '../utils/helpers.js';

export function useAppState() {
  const [state, setState] = useState<AppState>({
    issues: [],
    workflows: [],
    runningAgents: [],
    pendingInputRequests: {},
    currentView: 'issues',
    selectedIssueId: null,
    selectedWorkflowId: null,
    agentLogCache: {},
    logs: [],
    chatMessages: [],
    chatSession: null,
    isChatOpen: false,
    isGenerating: false,
    workflowBadgeMode: 'border',
  });

  const updateState = useCallback((updates: Partial<AppState>) => {
    setState((prev) => ({ ...prev, ...updates }));
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const status = await api.getStatus();
      updateState({
        runningAgents: status.runningAgents,
        pendingInputRequests: status.pendingInputRequests,
      });
    } catch (err) {
      console.error('Failed to fetch status', err);
    }
  }, [updateState]);

  const fetchIssues = useCallback(async () => {
    try {
      const issues = await api.getIssues();
      const issueIdSet = new Set(issues.map((i) => i.id));
      setState((prev) => {
        const pruned: typeof prev.agentLogCache = {};
        for (const key of Object.keys(prev.agentLogCache)) {
          if (issueIdSet.has(key)) {
            pruned[key] = prev.agentLogCache[key];
          }
        }
        return { ...prev, issues, agentLogCache: pruned };
      });
    } catch (err) {
      console.error('Failed to fetch issues', err);
    }
  }, []);

  const fetchWorkflows = useCallback(async () => {
    try {
      const workflows = await api.getWorkflows();
      updateState({ workflows });
    } catch (err) {
      console.error('Failed to fetch workflows', err);
    }
  }, [updateState]);

  const fetchLogs = useCallback(async () => {
    try {
      const logs = await api.getLogs();
      updateState({ logs });
    } catch (err) {
      console.error('Failed to fetch logs', err);
    }
  }, [updateState]);

  const fetchSettings = useCallback(async () => {
    try {
      const settings = await api.getSettings();
      updateState({ workflowBadgeMode: settings.workflowBadgeMode ?? 'border' });
    } catch (err) {
      console.error('Failed to fetch settings', err);
    }
  }, [updateState]);

  useEffect(() => {
    const urlState = parseUrlState();
    if (urlState.view) updateState({ currentView: urlState.view as ViewType });
    if (urlState.card) updateState({ selectedIssueId: urlState.card });
    if (urlState.workflow) updateState({ selectedWorkflowId: urlState.workflow });

    Promise.all([
      fetchStatus(),
      fetchIssues(),
      fetchWorkflows(),
      fetchLogs(),
      fetchSettings(),
    ]).catch(console.error);
    
    const handlePopState = (e: PopStateEvent) => {
      if (e.state) {
        updateState({
          currentView: (e.state.view as ViewType) || 'issues',
          selectedIssueId: e.state.card || null,
          selectedWorkflowId: e.state.workflow || null,
        });
      } else {
        const parsed = parseUrlState();
        updateState({
          currentView: (parsed.view as ViewType) || 'issues',
          selectedIssueId: parsed.card || null,
          selectedWorkflowId: parsed.workflow || null,
        });
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [fetchStatus, fetchIssues, fetchWorkflows, fetchLogs, fetchSettings, updateState]);

  useEffect(() => {
    updateUrlState({
      view: state.currentView,
      card: state.selectedIssueId || undefined,
      workflow: state.selectedWorkflowId || undefined,
    });
  }, [state.currentView, state.selectedIssueId, state.selectedWorkflowId]);

  useEventSource({
    onLog: (data) => {
      setState((prev) => ({
        ...prev,
        logs: [...prev.logs, data].slice(-500),
      }));
    },
    onAgentLog: (issueId, entry) => {
      setState((prev) => {
        const cache = prev.agentLogCache[issueId] || [];
        const MAX_AGENT_LOG_CACHE = 200;
        const updated = cache.length >= MAX_AGENT_LOG_CACHE ? [...cache.slice(1), entry] : [...cache, entry];
        return {
          ...prev,
          agentLogCache: {
            ...prev.agentLogCache,
            [issueId]: updated,
          },
        };
      });
    },
    onIssuesUpdated: fetchIssues,
    onStatusUpdated: fetchStatus,
    onInputRequired: (request) => {
      setState((prev) => ({
        ...prev,
        pendingInputRequests: {
          ...prev.pendingInputRequests,
          [request.issueId]: request,
        },
      }));
    },
    onInputSubmitted: ({ issueId }) => {
      setState((prev) => {
        const pending = { ...prev.pendingInputRequests };
        delete pending[issueId];
        return { ...prev, pendingInputRequests: pending };
      });
    },
    onWorkflowsUpdated: fetchWorkflows,
    onSettingsUpdated: fetchSettings,
  });

  return {
    state,
    updateState,
    fetchIssues,
    fetchWorkflows,
    fetchStatus,
    fetchSettings,
  };
}
