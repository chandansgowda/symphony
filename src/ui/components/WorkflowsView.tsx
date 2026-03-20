import type { Workflow } from '../types.js';

interface WorkflowsViewProps {
  workflows: Workflow[];
  onEdit: (w: Workflow) => void;
  onCreate: () => void;
}

export function WorkflowsView({ workflows, onEdit, onCreate }: WorkflowsViewProps) {
  return (
    <div className="p-6 max-w-6xl mx-auto h-full overflow-y-auto">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold m-0" style={{ color: 'var(--text-primary)' }}>Workflows</h2>
        <button 
          onClick={onCreate}
          className="px-4 py-2 text-white rounded-md font-medium transition-colors"
          style={{ background: 'var(--accent-blue)' }}
          onMouseOver={(e) => (e.currentTarget.style.background = 'var(--accent-blue-hover)')}
          onMouseOut={(e) => (e.currentTarget.style.background = 'var(--accent-blue)')}
        >
          New Workflow
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {workflows.length === 0 ? (
          <div 
            className="col-span-full text-center py-10 rounded-lg border border-dashed"
            style={{ 
              color: 'var(--text-muted)', 
              background: 'var(--bg-secondary)',
              borderColor: 'var(--border-primary)'
            }}
          >
            No workflows configured. Create one to get started.
          </div>
        ) : (
          workflows.map(workflow => (
            <button 
              key={workflow.id}
              type="button"
              onClick={() => onEdit(workflow)}
              className="rounded-lg shadow-sm border p-5 flex flex-col text-left cursor-pointer transition-all hover:shadow-md"
              style={{
                background: 'var(--bg-secondary)',
                borderColor: 'var(--border-primary)',
                borderLeft: workflow.color
                  ? `4px solid ${workflow.color}`
                  : workflow.isDefault ? '4px solid var(--accent-green)' : undefined,
              }}
              onMouseOver={(e) => (e.currentTarget.style.borderColor = workflow.color ?? (workflow.isDefault ? 'var(--accent-green)' : 'var(--text-muted)'))}
              onMouseOut={(e) => (e.currentTarget.style.borderColor = 'var(--border-primary)')}
            >
              <div className="flex justify-between items-start mb-2">
                <h3 className="font-bold text-lg truncate pr-2 flex items-center gap-1.5" title={workflow.name} style={{ color: 'var(--text-primary)' }}>
                  {workflow.isPrivate && (
                    <span title="Private workflow" style={{ color: 'var(--text-muted)' }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                    </span>
                  )}
                  {workflow.name}
                </h3>
                {workflow.isDefault && (
                  <span 
                    className="px-2 py-1 text-xs font-semibold rounded-full whitespace-nowrap"
                    style={{ 
                      background: 'var(--accent-green-bg)', 
                      color: 'var(--accent-green)' 
                    }}
                  >
                    Default
                  </span>
                )}
              </div>
              
              <p className="text-sm mb-4 flex-1 line-clamp-3" style={{ color: 'var(--text-secondary)' }}>
                {workflow.description || 'No description provided.'}
              </p>

              <div className="flex flex-col gap-1">
                {workflow.config?.workspace?.root && (
                  <div className="flex items-center gap-1 text-xs font-mono overflow-hidden" title={`Workspace: ${workflow.config.workspace.root}`} style={{ color: 'var(--text-muted)' }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    <span className="truncate">{workflow.config.workspace.root}</span>
                  </div>
                )}
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Created: {new Date(workflow.createdAt).toLocaleDateString()}
                </div>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
