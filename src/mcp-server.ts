#!/usr/bin/env node
/**
 * Symphony MCP Server
 * 
 * Exposes Symphony functionality as MCP tools that can be used by LLMs.
 * Runs as a stdio-based MCP server.
 * 
 * Tools:
 *   - symphony_add_comment: Add a comment to an issue
 *   - symphony_update_state: Update an issue's state
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Configuration from environment
const SYMPHONY_API_URL = process.env.SYMPHONY_API_URL || 'http://localhost:3000';

interface AddCommentInput {
  issue_id: string;
  content: string;
}

interface UpdateStateInput {
  issue_id: string;
  state: string;
}

interface HandoverInput {
  issue_id: string;
  new_state?: string;
  new_workflow_id?: string;
  handover_notes?: string;
}

interface CreateIssueInput {
  title: string;
  description?: string;
  state?: string;
  priority?: number;
  workflow_id?: string;
  labels?: string[];
  model?: string;
}

interface UpdateIssueInput {
  issue_id: string;
  title?: string;
  description?: string;
  state?: string;
  priority?: number;
  workflow_id?: string;
  labels?: string[];
  model?: string;
}

interface ListIssuesInput {
  state?: string;
}

interface CreateWorkflowInput {
  name: string;
  description?: string;
  prompt_template: string;
  is_default?: boolean;
  config?: {
    opencode?: {
      model?: string;
      agent?: string;
    };
  };
}

interface ArchiveIssueInput {
  issue_id: string;
}

interface GetWorkflowInput {
  workflow_id: string;
}

// Tool definitions
const addCommentTool = {
  name: 'symphony_add_comment',
  description: 'Add a comment to a Symphony issue. Use this to record important information like merge request links, status updates, or notes about the work done.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      issue_id: {
        type: 'string',
        description: 'The ID of the issue to add a comment to (accepts both internal ID and human-readable identifier like "optimistic-louse")',
      },
      content: {
        type: 'string',
        description: 'The content of the comment (supports markdown)',
      },
    },
    required: ['issue_id', 'content'],
  },
};

const updateStateTool = {
  name: 'symphony_update_state',
  description: 'Update the state of a Symphony issue. Common states: "Todo", "In Progress", "Review", "Done".',
  inputSchema: {
    type: 'object' as const,
    properties: {
      issue_id: {
        type: 'string',
        description: 'The ID of the issue to update (accepts both internal ID and human-readable identifier like "optimistic-louse")',
      },
      state: {
        type: 'string',
        description: 'The new state for the issue',
      },
    },
    required: ['issue_id', 'state'],
  },
};

const handoverTool = {
  name: 'symphony_handover',
  description: 'Gracefully hand over a running agent session by atomically updating state/workflow and optionally attaching handover notes.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      issue_id: { type: 'string', description: 'The ID of the issue to transition (accepts both internal ID and human-readable identifier like "optimistic-louse")' },
      new_state: { type: 'string', description: 'Optional new state for the issue' },
      new_workflow_id: { type: 'string', description: 'Optional new workflow ID for the issue' },
      handover_notes: { type: 'string', description: 'Optional handover notes to persist as an agent comment' },
    },
    required: ['issue_id'],
  },
};

const createIssueTool = {
  name: 'symphony_create_issue',
  description: 'Create a new Symphony issue/card. States: "Backlog", "Todo", "In Progress", "Review", "Done". Priority: 1=urgent, 2=high, 3=medium, 4=low.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      title: {
        type: 'string',
        description: 'The title of the issue',
      },
      description: {
        type: 'string',
        description: 'The description of the issue',
      },
      state: {
        type: 'string',
        description: 'The initial state (default: "Backlog")',
      },
      priority: {
        type: 'number',
        description: 'Priority level 1-4 (1=urgent, default: 3)',
      },
      workflow_id: {
        type: 'string',
        description: 'The workflow ID to use for this issue',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Labels to apply to the issue',
      },
      model: {
        type: 'string',
        description: 'OpenCode model to use for this issue. Accepts "primary" (workflow\'s default model), "secondary" (workflow\'s secondary model), or an explicit model name (e.g., "anthropic/claude-sonnet-4"). Must be from the workflow\'s available models. If not specified, uses workflow default.',
      },
    },
    required: ['title'],
  },
};

const updateIssueTool = {
  name: 'symphony_update_issue',
  description: 'Update an existing Symphony issue/card. Can update title, description, state, priority, workflow, or labels.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      issue_id: {
        type: 'string',
        description: 'The ID of the issue to update (accepts both internal ID and human-readable identifier like "optimistic-louse")',
      },
      title: {
        type: 'string',
        description: 'New title for the issue',
      },
      description: {
        type: 'string',
        description: 'New description for the issue',
      },
      state: {
        type: 'string',
        description: 'New state for the issue',
      },
      priority: {
        type: 'number',
        description: 'New priority level 1-4',
      },
      workflow_id: {
        type: 'string',
        description: 'New workflow ID for the issue',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'New labels for the issue',
      },
      model: {
        type: 'string',
        description: 'OpenCode model to use for this issue. Accepts "primary" (workflow\'s default model), "secondary" (workflow\'s secondary model), or an explicit model name (e.g., "anthropic/claude-sonnet-4"). Must be from the workflow\'s available models.',
      },
    },
    required: ['issue_id'],
  },
};

const listIssuesTool = {
  name: 'symphony_list_issues',
  description: 'List all Symphony issues/cards, optionally filtered by state.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      state: {
        type: 'string',
        description: 'Filter by state (e.g., "Todo", "In Progress")',
      },
    },
    required: [],
  },
};

const listWorkflowsTool = {
  name: 'symphony_list_workflows',
  description: 'List all available workflows that can be assigned to issues.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    required: [],
  },
};

const createWorkflowTool = {
  name: 'symphony_create_workflow',
  description: 'Create a new workflow with a custom prompt template. The prompt template uses LiquidJS syntax with variables like {{ issue.title }}, {{ issue.description }}, {{ issue.identifier }}.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: {
        type: 'string',
        description: 'Name of the workflow',
      },
      description: {
        type: 'string',
        description: 'Description of what the workflow does',
      },
      prompt_template: {
        type: 'string',
        description: 'The prompt template in markdown with LiquidJS variables',
      },
      is_default: {
        type: 'boolean',
        description: 'Whether this should be the default workflow',
      },
      config: {
        type: 'object',
        description: 'Workflow configuration including model settings',
        properties: {
          opencode: {
            type: 'object',
            description: 'OpenCode-specific configuration',
            properties: {
              model: {
                type: 'string',
                description: 'Model to use in "provider/model" format (e.g., "anthropic/claude-sonnet-4-20250514")',
              },
              agent: {
                type: 'string',
                description: 'Agent type to use (e.g., "build", "oracle")',
              },
            },
          },
        },
      },
    },
    required: ['name', 'prompt_template'],
  },
};

const archiveIssueTool = {
  name: 'symphony_archive_issue',
  description: 'Archive a Symphony issue, removing it from all board columns. Archived issues are hidden from the UI but preserved in the database. This is a terminal state.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      issue_id: {
        type: 'string',
        description: 'The ID of the issue to archive (accepts both internal ID and human-readable identifier like "optimistic-louse")',
      },
    },
    required: ['issue_id'],
  },
};

const getWorkflowTool = {
  name: 'symphony_get_workflow',
  description: 'Get details of a specific workflow by ID or name. Supports fuzzy matching - you can use the workflow name, ID, or partial matches. Returns the workflow configuration and prompt template.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      workflow_id: {
        type: 'string',
        description: 'The workflow ID or name to look up (supports fuzzy matching)',
      },
    },
    required: ['workflow_id'],
  },
};

interface ModelResolutionResult {
  resolvedModel: string | null;
  error?: string;
}

interface WorkflowModelsResponse {
  workflowId: string;
  workflowName: string;
  primaryModel: string | null;
  secondaryModel: string | null;
  availableModels: string[];
}

async function resolveModel(
  model: string | undefined,
  workflowId: string | undefined,
): Promise<ModelResolutionResult> {
  if (!model) {
    return { resolvedModel: null };
  }

  const isToken = model === 'primary' || model === 'secondary';

  if (workflowId || isToken) {
    const id = workflowId || 'default';
    try {
      const response = await fetch(`${SYMPHONY_API_URL}/api/workflows/${encodeURIComponent(id)}/models`);

      if (!response.ok) {
        if (isToken) {
          const errData = await response.json().catch(() => ({ error: response.statusText }));
          return {
            resolvedModel: null,
            error: `Cannot resolve model token "${model}": ${errData.error ?? response.statusText}`,
          };
        }
        return { resolvedModel: model };
      }

      const wfModels: WorkflowModelsResponse = await response.json();

      if (model === 'primary') {
        if (!wfModels.primaryModel) {
          return {
            resolvedModel: null,
            error: `Workflow "${wfModels.workflowName}" has no primary model configured. Available models: ${wfModels.availableModels.join(', ') || 'none'}`,
          };
        }
        return { resolvedModel: wfModels.primaryModel };
      }

      if (model === 'secondary') {
        if (!wfModels.secondaryModel) {
          return {
            resolvedModel: null,
            error: `Workflow "${wfModels.workflowName}" has no secondary model configured. Available models: ${wfModels.availableModels.join(', ') || 'none'}`,
          };
        }
        return { resolvedModel: wfModels.secondaryModel };
      }

      if (wfModels.availableModels.length > 0 && !wfModels.availableModels.includes(model)) {
        return {
          resolvedModel: null,
          error: `Model "${model}" is not available for workflow "${wfModels.workflowName}". Available models: ${wfModels.availableModels.join(', ')}`,
        };
      }

      return { resolvedModel: model };
    } catch (_err) {
      return { resolvedModel: model };
    }
  }

  return { resolvedModel: model };
}

// Tool handlers
async function handleAddComment(input: AddCommentInput): Promise<{ success: boolean; comment_id?: string; error?: string }> {
  try {
    const response = await fetch(`${SYMPHONY_API_URL}/api/issues/${input.issue_id}/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        author: 'agent',
        content: input.content,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error: `Failed to add comment: ${error}` };
    }

    const result = await response.json();
    return { success: true, comment_id: result.id };
  } catch (error) {
    return { success: false, error: `Failed to add comment: ${(error as Error).message}` };
  }
}

async function handleUpdateState(input: UpdateStateInput): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${SYMPHONY_API_URL}/api/issues/${input.issue_id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        state: input.state,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error: `Failed to update state: ${error}` };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: `Failed to update state: ${(error as Error).message}` };
  }
}

async function handleCreateIssue(input: CreateIssueInput): Promise<{ success: boolean; issue?: { id: string; identifier: string; title: string; state: string }; error?: string }> {
  try {
    const modelResult = await resolveModel(input.model, input.workflow_id);
    if (modelResult.error) {
      return { success: false, error: modelResult.error };
    }

    const response = await fetch(`${SYMPHONY_API_URL}/api/issues`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: input.title,
        description: input.description,
        state: input.state || 'Backlog',
        priority: input.priority || 3,
        workflow_id: input.workflow_id,
        labels: input.labels,
        model: modelResult.resolvedModel,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error: `Failed to create issue: ${error}` };
    }

    const issue = await response.json();
    return { 
      success: true, 
      issue: { 
        id: issue.id, 
        identifier: issue.identifier, 
        title: issue.title, 
        state: issue.state 
      } 
    };
  } catch (error) {
    return { success: false, error: `Failed to create issue: ${(error as Error).message}` };
  }
}

async function handleUpdateIssue(input: UpdateIssueInput): Promise<{ success: boolean; issue?: { id: string; title: string; state: string }; error?: string }> {
  try {
    const modelResult = await resolveModel(input.model, input.workflow_id);
    if (modelResult.error) {
      return { success: false, error: modelResult.error };
    }

    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body.title = input.title;
    if (input.description !== undefined) body.description = input.description;
    if (input.state !== undefined) body.state = input.state;
    if (input.priority !== undefined) body.priority = input.priority;
    if (input.workflow_id !== undefined) body.workflow_id = input.workflow_id;
    if (input.labels !== undefined) body.labels = input.labels;
    if (input.model !== undefined) body.model = modelResult.resolvedModel;

    const response = await fetch(`${SYMPHONY_API_URL}/api/issues/${input.issue_id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error: `Failed to update issue: ${error}` };
    }

    const issue = await response.json();
    return { 
      success: true, 
      issue: { id: issue.id, title: issue.title, state: issue.state } 
    };
  } catch (error) {
    return { success: false, error: `Failed to update issue: ${(error as Error).message}` };
  }
}

async function handleListIssues(input: ListIssuesInput): Promise<{ success: boolean; issues?: Array<{ id: string; identifier: string; title: string; state: string; priority?: number }>; error?: string }> {
  try {
    const response = await fetch(`${SYMPHONY_API_URL}/api/issues`);

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error: `Failed to list issues: ${error}` };
    }

    let issues = await response.json();
    
    if (input.state) {
      issues = issues.filter((i: { state: string }) => i.state === input.state);
    }

    return { 
      success: true, 
      issues: issues.map((i: { id: string; identifier: string; title: string; state: string; priority?: number }) => ({
        id: i.id,
        identifier: i.identifier,
        title: i.title,
        state: i.state,
        priority: i.priority,
      }))
    };
  } catch (error) {
    return { success: false, error: `Failed to list issues: ${(error as Error).message}` };
  }
}

async function handleListWorkflows(): Promise<{ success: boolean; workflows?: Array<{ id: string; name: string; description?: string; isDefault: boolean }>; error?: string }> {
  try {
    const response = await fetch(`${SYMPHONY_API_URL}/api/workflows`);

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error: `Failed to list workflows: ${error}` };
    }

    const workflows = await response.json();

    return { 
      success: true, 
      workflows: workflows.map((w: { id: string; name: string; description?: string; isDefault: boolean }) => ({
        id: w.id,
        name: w.name,
        description: w.description,
        isDefault: w.isDefault,
      }))
    };
  } catch (error) {
    return { success: false, error: `Failed to list workflows: ${(error as Error).message}` };
  }
}

async function handleCreateWorkflow(input: CreateWorkflowInput): Promise<{ success: boolean; workflow_id?: string; error?: string }> {
  try {
    const response = await fetch(`${SYMPHONY_API_URL}/api/workflows`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: input.name,
        description: input.description,
        promptTemplate: input.prompt_template,
        isDefault: input.is_default ?? false,
        config: input.config,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error: `Failed to create workflow: ${error}` };
    }

    const result = await response.json();
    return { success: true, workflow_id: result.id };
  } catch (error) {
    return { success: false, error: `Failed to create workflow: ${(error as Error).message}` };
  }
}

async function handleArchiveIssue(input: ArchiveIssueInput): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${SYMPHONY_API_URL}/api/issues/${input.issue_id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        state: 'Archived',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error: `Failed to archive issue: ${error}` };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: `Failed to archive issue: ${(error as Error).message}` };
  }
}

async function handleGetWorkflow(input: GetWorkflowInput): Promise<{ 
  success: boolean; 
  workflow?: { id: string; name: string; description?: string; isDefault: boolean; promptTemplate: string }; 
  availableWorkflows?: Array<{ id: string; name: string }>;
  error?: string 
}> {
  try {
    const response = await fetch(`${SYMPHONY_API_URL}/api/workflows/resolve/${encodeURIComponent(input.workflow_id)}`);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Failed to get workflow' }));
      return { 
        success: false, 
        error: errorData.error || `Failed to get workflow: ${response.statusText}`,
        availableWorkflows: errorData.availableWorkflows,
      };
    }

    const workflow = await response.json();
    return { 
      success: true, 
      workflow: {
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        isDefault: workflow.isDefault,
        promptTemplate: workflow.promptTemplate,
      }
    };
  } catch (error) {
    return { success: false, error: `Failed to get workflow: ${(error as Error).message}` };
  }
}

// Create MCP server
const server = new Server(
  {
    name: 'symphony-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tool listing handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      addCommentTool, 
      updateStateTool, 
      handoverTool,
      createIssueTool, 
      updateIssueTool, 
      listIssuesTool, 
      listWorkflowsTool,
      createWorkflowTool,
      archiveIssueTool,
      getWorkflowTool
    ],
  };
});

// Register tool call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'symphony_add_comment': {
        const result = await handleAddComment(args as unknown as AddCommentInput);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: !result.success,
        };
      }

      case 'symphony_update_state': {
        const result = await handleUpdateState(args as unknown as UpdateStateInput);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: !result.success,
        };
      }

      case 'symphony_handover': {
        const input = args as unknown as HandoverInput;

        const response = await fetch(`${SYMPHONY_API_URL}/api/issues/${input.issue_id}/handover`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            new_state: input.new_state,
            new_workflow_id: input.new_workflow_id,
            handover_notes: input.handover_notes,
          }),
        });

        if (!response.ok) {
          const text = await response.text();
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: text }) }],
            isError: true,
          };
        }

        const data = await response.json();
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, data }, null, 2) }],
          isError: false,
        };
      }

      case 'symphony_create_issue': {
        const result = await handleCreateIssue(args as unknown as CreateIssueInput);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: !result.success,
        };
      }

      case 'symphony_update_issue': {
        const result = await handleUpdateIssue(args as unknown as UpdateIssueInput);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: !result.success,
        };
      }

      case 'symphony_list_issues': {
        const result = await handleListIssues(args as unknown as ListIssuesInput);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: !result.success,
        };
      }

      case 'symphony_list_workflows': {
        const result = await handleListWorkflows();
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: !result.success,
        };
      }

      case 'symphony_create_workflow': {
        const result = await handleCreateWorkflow(args as unknown as CreateWorkflowInput);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: !result.success,
        };
      }

      case 'symphony_archive_issue': {
        const result = await handleArchiveIssue(args as unknown as ArchiveIssueInput);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: !result.success,
        };
      }

      case 'symphony_get_workflow': {
        const result = await handleGetWorkflow(args as unknown as GetWorkflowInput);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: !result.success,
        };
      }

      default:
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown tool: ${name}` }) }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        }),
      }],
      isError: true,
    };
  }
});

// Start the server
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout is used for MCP protocol)
  console.error(`Symphony MCP server started (API: ${SYMPHONY_API_URL})`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
