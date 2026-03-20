import { useState, useEffect } from 'preact/hooks';
import { Workflow, WorkflowConfig } from '../types.js';
import { api } from '../api.js';

interface WorkflowModalProps {
  workflow?: Workflow;
  onClose: () => void;
  onSave: () => void;
}

type Tab = 'general' | 'configuration';

export function WorkflowModal({ workflow, onClose, onSave }: WorkflowModalProps) {
  const isPrivate = workflow?.isPrivate === true;
  const [activeTab, setActiveTab] = useState<Tab>('general');
  const [name, setName] = useState(workflow?.name || '');
  const [description, setDescription] = useState(workflow?.description || '');
  const [promptTemplate, setPromptTemplate] = useState(workflow?.promptTemplate || '');
  const [isDefault, setIsDefault] = useState(workflow?.isDefault || false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [model, setModel] = useState(workflow?.config?.opencode?.model || '');
  const [secondaryModel, setSecondaryModel] = useState(workflow?.config?.opencode?.secondary_model || '');
  const [maxConcurrentAgents, setMaxConcurrentAgents] = useState<number>(workflow?.maxConcurrentAgents ?? 1);
  const [color, setColor] = useState<string>(workflow?.color || '');
  const [workspaceRoot, setWorkspaceRoot] = useState<string>(workflow?.config?.workspace?.root || '');

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const config: WorkflowConfig = {
        ...(workflow?.config || {}),
      };
      
      if (model || secondaryModel) {
        config.opencode = {
          ...(model ? { model } : {}),
          ...(secondaryModel ? { secondary_model: secondaryModel } : {}),
        };
      } else {
        delete config.opencode;
      }

      if (workspaceRoot) {
        config.workspace = { root: workspaceRoot };
      } else {
        delete config.workspace;
      }

      const data = {
        name,
        description,
        promptTemplate,
        isDefault,
        config,
        maxConcurrentAgents,
        color: color || null,
      };

      if (workflow) {
        await api.updateWorkflow(workflow.id, data);
      } else {
        await api.createWorkflow(data);
      }
      onSave();
    } catch (err) {
      console.error('Failed to save workflow:', (err as Error).message);
      alert('Failed to save workflow');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!workflow || !confirm('Are you sure you want to delete this workflow?')) return;
    try {
      await api.deleteWorkflow(workflow.id);
      onSave();
    } catch (err) {
      console.error('Failed to delete workflow:', (err as Error).message);
      alert('Failed to delete workflow');
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" onClick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="bg-white dark:bg-[#252525] rounded-lg shadow-xl w-full max-w-2xl flex flex-col max-h-[90vh] overflow-hidden">
        <div className="p-6 border-b border-gray-200 dark:border-[#3d3d3d] flex justify-between items-center bg-gray-50 dark:bg-[#2d2d2d]">
          <h2 className="text-xl font-bold text-gray-800 dark:text-[#e0e0e0] flex items-center gap-2">
            {workflow ? 'Edit Workflow' : 'New Workflow'}
            {isPrivate && (
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full border"
                style={{ color: 'var(--text-muted)', borderColor: 'var(--border-primary)', background: 'var(--bg-secondary)' }}
                title="This workflow is stored in the private workflows directory and changes will be saved there"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                Private
              </span>
            )}
          </h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700 dark:text-[#808080] dark:hover:text-[#a0a0a0] text-2xl leading-none">&times;</button>
        </div>

        <div className="flex border-b border-gray-200 dark:border-[#3d3d3d] bg-gray-50 dark:bg-[#2d2d2d]">
          <button
            type="button"
            onClick={() => setActiveTab('general')}
            className={`px-6 py-3 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === 'general'
                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 dark:text-[#808080] hover:text-gray-700 dark:hover:text-[#a0a0a0]'
            }`}
          >
            General
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('configuration')}
            className={`px-6 py-3 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === 'configuration'
                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 dark:text-[#808080] hover:text-gray-700 dark:hover:text-[#a0a0a0]'
            }`}
          >
            Configuration
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto bg-white dark:bg-[#252525]">
          <form id="workflow-form" onSubmit={handleSubmit}>
            {activeTab === 'general' && (
              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-[#a0a0a0] mb-1">Name</label>
                  <input
                    type="text"
                    value={name}
                    onInput={(e) => setName(e.currentTarget.value)}
                    className="w-full p-2 border border-gray-300 dark:border-[#3d3d3d] rounded focus:ring-2 focus:ring-blue-500 outline-none bg-white dark:bg-[#2d2d2d] text-gray-900 dark:text-[#e0e0e0]"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-[#a0a0a0] mb-1">Description</label>
                  <textarea
                    value={description}
                    onInput={(e) => setDescription(e.currentTarget.value)}
                    className="w-full p-2 border border-gray-300 dark:border-[#3d3d3d] rounded h-20 focus:ring-2 focus:ring-blue-500 outline-none resize-y bg-white dark:bg-[#2d2d2d] text-gray-900 dark:text-[#e0e0e0]"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-[#a0a0a0] mb-1">Card Color</label>
                  <div className="flex items-center gap-3">
                    <input
                      type="color"
                      value={color || '#6366f1'}
                      onInput={(e) => setColor(e.currentTarget.value)}
                      className="h-9 w-14 p-0.5 border border-gray-300 dark:border-[#3d3d3d] rounded cursor-pointer bg-white dark:bg-[#2d2d2d]"
                      title="Pick a color for the card's left bar"
                    />
                    <span className="text-sm text-gray-600 dark:text-[#a0a0a0] font-mono">{color || '(none)'}</span>
                    {color && (
                      <button
                        type="button"
                        onClick={() => setColor('')}
                        className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-[#a0a0a0] underline"
                      >
                        Reset to auto
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 dark:text-[#808080] mt-1">
                    Custom color for the card's left bar. Leave empty to use an auto-generated color.
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-[#a0a0a0] mb-1">Prompt Template</label>
                  <textarea
                    value={promptTemplate}
                    onInput={(e) => setPromptTemplate(e.currentTarget.value)}
                    className="w-full p-2 border border-gray-300 dark:border-[#3d3d3d] rounded h-64 font-mono text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-y bg-white dark:bg-[#2d2d2d] text-gray-900 dark:text-[#e0e0e0]"
                    required
                  />
                  <p className="text-xs text-gray-500 dark:text-[#808080] mt-1">
                    Available variables: {'{{issue.title}}'}, {'{{issue.description}}'}, {'{{issue.identifier}}'}
                  </p>
                </div>

                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="isDefault"
                    checked={isDefault}
                    onChange={(e) => setIsDefault(e.currentTarget.checked)}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-[#3d3d3d] rounded"
                  />
                  <label htmlFor="isDefault" className="ml-2 block text-sm text-gray-900 dark:text-[#e0e0e0]">
                    Set as default workflow
                  </label>
                </div>
              </div>
            )}

            {activeTab === 'configuration' && (
              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-[#a0a0a0] mb-1">Model</label>
                  <input
                    type="text"
                    value={model}
                    onInput={(e) => setModel(e.currentTarget.value)}
                    placeholder="e.g., anthropic/claude-sonnet-4-20250514"
                    className="w-full p-2 border border-gray-300 dark:border-[#3d3d3d] rounded focus:ring-2 focus:ring-blue-500 outline-none text-sm font-mono bg-white dark:bg-[#2d2d2d] text-gray-900 dark:text-[#e0e0e0] placeholder-gray-400 dark:placeholder-[#6b6b6b]"
                  />
                  <p className="text-xs text-gray-500 dark:text-[#808080] mt-1">
                    Format: provider/model-name (leave empty for default)
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-[#a0a0a0] mb-1">Secondary Model</label>
                  <input
                    type="text"
                    value={secondaryModel}
                    onInput={(e) => setSecondaryModel(e.currentTarget.value)}
                    placeholder="e.g., anthropic/claude-haiku-4-20250514"
                    className="w-full p-2 border border-gray-300 dark:border-[#3d3d3d] rounded focus:ring-2 focus:ring-blue-500 outline-none text-sm font-mono bg-white dark:bg-[#2d2d2d] text-gray-900 dark:text-[#e0e0e0] placeholder-gray-400 dark:placeholder-[#6b6b6b]"
                  />
                  <p className="text-xs text-gray-500 dark:text-[#808080] mt-1">
                    Optional alternative model selectable at card creation
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-[#a0a0a0] mb-1">Max Parallel Agents</label>
                  <input
                    type="number"
                    min={1}
                    value={maxConcurrentAgents}
                    onInput={(e) => setMaxConcurrentAgents(parseInt(e.currentTarget.value, 10) || 1)}
                    className="w-full p-2 border border-gray-300 dark:border-[#3d3d3d] rounded focus:ring-2 focus:ring-blue-500 outline-none text-sm bg-white dark:bg-[#2d2d2d] text-gray-900 dark:text-[#e0e0e0]"
                  />
                  <p className="text-xs text-gray-500 dark:text-[#808080] mt-1">
                    Maximum number of agents that can run in parallel for this workflow
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-[#a0a0a0] mb-1">Workspace Directory</label>
                  <input
                    type="text"
                    value={workspaceRoot}
                    onInput={(e) => setWorkspaceRoot(e.currentTarget.value)}
                    placeholder="e.g., ~/workspaces/my-project or /absolute/path"
                    className="w-full p-2 border border-gray-300 dark:border-[#3d3d3d] rounded focus:ring-2 focus:ring-blue-500 outline-none text-sm font-mono bg-white dark:bg-[#2d2d2d] text-gray-900 dark:text-[#e0e0e0] placeholder-gray-400 dark:placeholder-[#6b6b6b]"
                  />
                  <p className="text-xs text-gray-500 dark:text-[#808080] mt-1">
                    Override the workspace root directory for issues in this workflow. Supports <code className="font-mono">~</code> for home directory. Leave empty to use the global workspace root.
                  </p>
                </div>
              </div>
            )}
          </form>
        </div>

        <div className="p-6 border-t border-gray-200 dark:border-[#3d3d3d] bg-gray-50 dark:bg-[#2d2d2d] flex justify-between items-center">
          <div>
            {workflow && !workflow.isDefault && (
              <button
                type="button"
                onClick={handleDelete}
                className="px-4 py-2 text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 rounded border border-transparent hover:border-red-200 dark:hover:border-red-800 transition-colors"
              >
                Delete
              </button>
            )}
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-white dark:bg-[#252525] text-gray-700 dark:text-[#a0a0a0] border border-gray-300 dark:border-[#3d3d3d] rounded hover:bg-gray-50 dark:hover:bg-[#3d3d3d] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="workflow-form"
              disabled={isSubmitting}
              className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-sm"
            >
              {isSubmitting ? 'Saving...' : 'Save Workflow'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
