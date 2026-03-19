# Symphony

Issue orchestration service that runs OpenCode AI agents per issue from Linear or local JSON trackers.

## Features

- **Multi-Tracker Support**: Linear API or local JSON file
- **Kanban Web UI**: 5-column board (Backlog, Todo, In Progress, Review, Done)
- **Multi-Workflow**: Custom prompt templates per issue
- **Chat Assistant**: AI-powered assistant for managing cards via natural language
- **Session Resumption**: Agents resume on restart via stored `session_id`
- **Comment Forwarding**: Human comments forwarded to running agent sessions
- **MCP Server**: LLM tools for adding comments and updating issue state

## Table of Contents

- [Screenshots](#screenshots)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Running Symphony](#running-symphony)
- [Usage](#usage)
  - [Using the Chat Assistant](#using-the-chat-assistant)
  - [Creating Cards via UI](#creating-cards-via-ui)
  - [Moving Cards Between States](#moving-cards-between-states)
  - [Assigning Workflows to Cards](#assigning-workflows-to-cards)
- [Workflows](#workflows)
  - [Creating Workflows via UI](#creating-workflows-via-ui)
  - [Creating Workflows via Chat](#creating-workflows-via-chat)
  - [Workflow Template Syntax](#workflow-template-syntax)
  - [Available Workflow Variables](#available-workflow-variables)
- [Configuration](#configuration)
- [CLI Options](#cli-options)
- [API Endpoints](#api-endpoints)
- [MCP Integration](#mcp-integration)
- [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)
- [Development](#development)

## Screenshots

### Kanban Board
![Kanban Board](screenshots/kanban-board.png)

### Issue Detail
![Issue Detail](screenshots/issue-detail.png)

### Workflows
![Workflows](screenshots/workflows.png)

### Workflow Editor
![Workflow Editor](screenshots/workflow-edit.png)

## Prerequisites

Before installing Symphony, ensure you have:

### Required Software

| Software | Version | Purpose |
|----------|---------|---------|
| **Node.js** | >= 20.0.0 | Runtime environment |
| **npm** | >= 10.0.0 | Package manager (comes with Node.js) |
| **OpenCode** | Latest | AI agent execution engine |

### Installing Node.js

**macOS (using Homebrew):**
```bash
brew install node@20
```

**Ubuntu/Debian:**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Windows:**
Download and install from [nodejs.org](https://nodejs.org/)

Verify installation:
```bash
node --version  # Should be >= 20.0.0
npm --version   # Should be >= 10.0.0
```

### Installing OpenCode

Symphony requires OpenCode (or OhMyOpenCode) to run AI agents. Install it using one of these methods:

**Using npm (recommended):**
```bash
npm install -g @opencode-ai/cli
```

**Using Homebrew (macOS):**
```bash
brew install opencode
```

**From source:**
```bash
git clone https://github.com/opencode-ai/opencode.git
cd opencode
npm install && npm run build
npm link
```

Verify OpenCode installation:
```bash
opencode --version
```

**Configure OpenCode** with your preferred AI provider:
```bash
# Set up API keys (example for Anthropic)
export ANTHROPIC_API_KEY="your-api-key"

# Or configure via opencode config
opencode config set anthropic.apiKey "your-api-key"
```

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/your-org/symphony.git
cd symphony
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Set Up Data Directory

The `data/` directory contains user-specific data and is not tracked in git (except for sample files):

```bash
# Copy sample workflow registry
cp data/workflow/sample-workflows.json data/workflow/workflows.json

# Copy sample workflow template
cp data/workflow/sample-workflow.md data/workflow/default-workflow.md
```

### 4. Build the Project (for production)

```bash
npm run build
```

### Directory Structure After Setup

```
data/
├── issues.db              # SQLite database (created automatically)
├── issues.db-shm          # SQLite shared memory (created automatically)
├── issues.db-wal          # SQLite write-ahead log (created automatically)
└── workflow/
    ├── workflows.json     # Your workflow registry
    ├── default-workflow.md # Your default workflow template
    ├── sample-workflow.md # Sample template (reference)
    └── sample-workflows.json # Sample registry (reference)
```

## Running Symphony

### Development Mode (with hot reload)

```bash
npm run dev
```

This starts Symphony with TypeScript compilation on-the-fly. Changes to source files will be reflected immediately.

### Production Mode

```bash
# First build the project
npm run build

# Then start
npm start
```

### With Custom Options

```bash
# Custom port
npm run dev -- -p 8080

# Debug logging
npm run dev -- -l debug

# Watch mode (auto-restart on file changes)
npm run dev -- -W

# Without web UI (headless)
npm run dev -- --no-web
```

### Access the Web UI

Once running, open your browser to:
```
http://localhost:3000
```

The default port is 3000. Use `-p <port>` to change it.

## Usage

### Using the Chat Assistant

Symphony includes a built-in AI chat assistant that can help manage your Kanban board through natural language commands.

**Accessing the Chat:**
1. Click the chat button (💬) in the bottom-right corner of the UI
2. Or press `c` on your keyboard to toggle the chat panel

**Example Commands:**

| Command | Action |
|---------|--------|
| "Create a card for fixing the login bug" | Creates a new card in Backlog |
| "Move optimistic-louse to In Progress" | Changes card state |
| "Add a comment to brave-fox: Started working on this" | Adds a comment |
| "Show me all cards in Review" | Lists cards by state |
| "Create a workflow for code review" | Creates a new workflow |
| "Assign the code-review workflow to happy-turtle" | Assigns workflow to card |

**Chat Workflow:**
The chat assistant uses a special "chat" workflow if defined. You can customize its behavior by creating a workflow with ID `chat` in the Workflows panel.

### Creating Cards via UI

**Method 1: Using the Add Button**
1. Click the **"+"** button in the header area
2. Fill in the card details:
   - **Title** (required): Brief description of the task
   - **Description**: Detailed information, requirements, or context
   - **State**: Initial column (default: Backlog)
   - **Workflow**: Optional workflow assignment
   - **Labels**: Comma-separated tags
3. Click **"Create"**

**Method 2: Using Keyboard Shortcut**
- Press `n` to open the new card dialog

**Card Identifiers:**
- Each card automatically gets a unique identifier (e.g., `optimistic-louse`, `brave-fox`)
- These identifiers are used when referencing cards in chat, API calls, or MCP tools

### Moving Cards Between States

**Drag and Drop:**
1. Click and hold on a card
2. Drag it to the desired column
3. Release to drop

**Via Card Modal:**
1. Click on a card to open its detail modal
2. Use the state dropdown to select a new state
3. Changes are saved automatically

**Via Chat:**
```
"Move optimistic-louse to Done"
"Change the state of brave-fox to Review"
```

**Available States:**
| State | Description |
|-------|-------------|
| **Backlog** | Not yet prioritized |
| **Todo** | Ready to be worked on (triggers agent) |
| **In Progress** | Currently being worked on |
| **Review** | Awaiting review |
| **Done** | Completed |

**Automatic State Transitions:**
Workflows can configure automatic transitions:
- **on_start**: When agent begins work (e.g., Todo → In Progress)
- **on_complete**: When agent finishes (e.g., In Progress → Review)
- **on_failure**: When agent fails (configurable)

### Assigning Workflows to Cards

**Via Card Modal:**
1. Click on a card to open its detail modal
2. Find the "Workflow" dropdown
3. Select the desired workflow
4. The card will use this workflow's prompt template and configuration

**Via Chat:**
```
"Assign the code-review workflow to optimistic-louse"
"Set workflow for brave-fox to bug-fix"
```

**Via API:**
```bash
curl -X PUT http://localhost:3000/api/issues/optimistic-louse \
  -H "Content-Type: application/json" \
  -d '{"workflow_id": "code-review"}'
```

## Workflows

Workflows define how Symphony's AI agents behave. Each workflow consists of:
- **Prompt Template**: LiquidJS template that generates the agent's instructions
- **Configuration**: Settings for agent behavior, state transitions, hooks, etc.

### Creating Workflows via UI

1. Click **"Workflows"** in the header
2. Click **"+ New Workflow"**
3. Fill in the workflow details:
   - **Name**: Human-readable name
   - **Description**: What this workflow does
   - **Prompt Template**: LiquidJS template (see syntax below)
   - **Max Concurrent Agents**: Limit for this workflow
   - **Set as Default**: Use for new cards without explicit workflow
4. Click **"Save"**

**Editing Workflows:**
1. Click "Workflows" in the header
2. Click on an existing workflow
3. Make changes in the editor
4. Click "Save"

### Creating Workflows via Chat

The chat assistant can create workflows for you:

```
"Create a workflow called code-review with the following template:
You are a code reviewer. Review the changes in {{ issue.title }} and provide feedback."
```

Or more detailed:
```
"Create a new workflow:
- Name: Bug Fix Workflow
- Description: For fixing reported bugs
- Template: You are fixing bug {{ issue.identifier }}: {{ issue.title }}. 
  Description: {{ issue.description }}
  Fix the issue and write tests."
```

### Workflow Template Syntax

Symphony uses [LiquidJS](https://liquidjs.com/) for templating. Here's the syntax:

**Variable Output:**
```liquid
{{ issue.title }}
{{ issue.description | default: "No description" }}
```

**Conditionals:**
```liquid
{% if issue.priority == 1 %}
This is an URGENT issue!
{% elsif issue.priority == 2 %}
This is a high priority issue.
{% else %}
Normal priority.
{% endif %}
```

**Loops:**
```liquid
{% if issue.comments.size > 0 %}
## Previous Comments:
{% for comment in issue.comments %}
- [{{ comment.author }}]: {{ comment.content }}
{% endfor %}
{% endif %}
```

**Filters:**
```liquid
{{ issue.description | default: "No description provided" }}
{{ issue.title | upcase }}
{{ issue.created_at | date: "%Y-%m-%d" }}
```

**Full Example Template:**
```liquid
# {{ issue.title }}

You are an AI agent working on issue **{{ issue.identifier }}**.

## Details
- **Priority**: {{ issue.priority | default: "None" }}
- **State**: {{ issue.state }}
- **Labels**: {{ issue.labels | join: ", " | default: "None" }}

## Description
{{ issue.description | default: "No description provided." }}

{% if issue.comments.size > 0 %}
## Comments
{% for comment in issue.comments %}
### {{ comment.author }} ({{ comment.created_at }}):
{{ comment.content }}
{% endfor %}
{% endif %}

{% if issue.handover_notes %}
## Handover Notes
{{ issue.handover_notes }}
{% endif %}

{% if attempt and attempt > 1 %}
## Retry Information
This is retry attempt #{{ attempt }}.
{% endif %}

## Instructions
1. Analyze the requirements
2. Implement the solution
3. Test your changes
4. Use `symphony_update_state` to move to Review when done
```

### Available Workflow Variables

**Issue Variables** (`issue.*`):

| Variable | Type | Description |
|----------|------|-------------|
| `issue.id` | string | Internal unique ID |
| `issue.identifier` | string | Human-readable ID (e.g., "optimistic-louse") |
| `issue.title` | string | Issue title |
| `issue.description` | string/null | Detailed description |
| `issue.priority` | number/null | 1=urgent, 2=high, 3=medium, 4=low |
| `issue.state` | string | Current state |
| `issue.labels` | array | List of labels |
| `issue.branch_name` | string/null | Associated git branch |
| `issue.url` | string/null | External URL |
| `issue.created_at` | string | ISO date of creation |
| `issue.updated_at` | string | ISO date of last update |
| `issue.handover_notes` | string/null | Latest agent handover notes |

**Issue Comments** (`issue.comments`):

Each comment has:
| Variable | Type | Description |
|----------|------|-------------|
| `comment.id` | string | Comment ID |
| `comment.author` | string | "human" or "agent" |
| `comment.content` | string | Comment text |
| `comment.created_at` | string | ISO date |

**Issue Blockers** (`issue.blocked_by`):

Each blocker has:
| Variable | Type | Description |
|----------|------|-------------|
| `blocker.id` | string/null | Blocker issue ID |
| `blocker.identifier` | string/null | Blocker identifier |
| `blocker.state` | string/null | Blocker state |

**Retry Context**:

| Variable | Type | Description |
|----------|------|-------------|
| `attempt` | number/null | Current retry attempt (null on first run, 2+ on retries) |

## Configuration

### Platform Selection

Symphony supports multiple AI platforms for running agents. Configure the platform in your workflow configuration:

| Platform | Description | Requirements |
|----------|-------------|--------------|
| `opencode` | OpenCode AI agent (default) | OpenCode CLI installed |
| `codex` | OpenAI Codex CLI | Codex CLI installed |
| `copilot` | GitHub Copilot CLI | Copilot CLI installed, GitHub authentication |

**Example: Using GitHub Copilot CLI**

```json
{
  "config": {
    "platform": {
      "type": "copilot",
      "copilot": {
        "model": "claude-sonnet-4.6",
        "allow_all_tools": true,
        "silent": true
      }
    }
  }
}
```

**Copilot Platform Options:**

| Option | Type | Description |
|--------|------|-------------|
| `token` | string | GitHub token (or use `COPILOT_GITHUB_TOKEN` env var) |
| `model` | string | Model to use (e.g., `gpt-5.3-codex`, `claude-sonnet-4.6`) |
| `allow_all_tools` | boolean | Allow all tool permissions (equivalent to `--allow-all`) |
| `allow_all_paths` | boolean | Allow access to all paths |
| `allowed_tools` | string[] | Specific tools to allow (e.g., `["shell", "write", "read"]`) |
| `additional_dirs` | string[] | Additional directories to include |
| `silent` | boolean | Enable silent mode (suppress decorations) |

**Authentication:**

GitHub Copilot CLI uses these environment variables (in order of precedence):
1. `COPILOT_GITHUB_TOKEN`
2. `GH_TOKEN`
3. `GITHUB_TOKEN`

**Installing GitHub Copilot CLI:**

```bash
# Using npm
npm install -g @github/copilot-cli

# Using Homebrew (macOS)
brew install gh
gh extension install github/gh-copilot
```

### Workflow Configuration Options

Workflows can include configuration in `workflows.json`:

```json
{
  "workflows": [
    {
      "id": "my-workflow",
      "name": "My Workflow",
      "description": "Description here",
      "template_file": "my-workflow.md",
      "config": {
        "tracker": { ... },
        "workspace": { ... },
        "polling": { ... },
        "agent": { ... },
        "opencode": { ... },
        "hooks": { ... }
      },
      "is_default": false
    }
  ]
}
```

### Configuration Reference

| Section | Option | Type | Description |
|---------|--------|------|-------------|
| **tracker** | | | |
| | `kind` | `"local"` \| `"linear"` | Issue tracker type |
| | `issues_path` | string | Path to SQLite database (local) |
| | `api_key` | string | Linear API key (use `$ENV_VAR`) |
| | `project_slug` | string | Linear project slug |
| | `active_states` | string[] | States that trigger agent work |
| | `terminal_states` | string[] | States that stop agent work |
| | `auto_transition.on_start` | string | State when agent starts |
| | `auto_transition.on_complete` | string | State when agent completes |
| | `auto_transition.on_failure` | string | State when agent fails |
| **workspace** | | | |
| | `root` | string | Directory for agent workspaces |
| **polling** | | | |
| | `interval_ms` | number | How often to check for new issues |
| **agent** | | | |
| | `max_concurrent_agents` | number | Max parallel agents globally |
| | `max_turns` | number | Max turns per agent session |
| | `max_retries` | number | Max retry attempts on failure |
| | `max_retry_backoff_ms` | number | Max backoff between retries |
| **opencode** | | | |
| | `model` | string | AI model (e.g., "claude-sonnet-4-20250514") |
| | `agent` | string | OpenCode agent type |
| | `turn_timeout_ms` | number | Timeout per turn |
| | `stall_timeout_ms` | number | Stall detection timeout |
| | `idle_timeout_ms` | number | Idle session timeout |
| | `idle_prompt` | string | Prompt sent when idle detected |
| **hooks** | | | |
| | `after_create` | string | Shell command after workspace creation |
| | `before_run` | string | Shell command before agent run |
| | `after_run` | string | Shell command after agent run |
| | `before_remove` | string | Shell command before workspace removal |
| | `timeout_ms` | number | Hook execution timeout |

### Example Configuration

```json
{
  "config": {
    "tracker": {
      "kind": "local",
      "active_states": ["Todo", "In Progress"],
      "terminal_states": ["Done", "Cancelled"],
      "auto_transition": {
        "on_start": "In Progress",
        "on_complete": "Review"
      }
    },
    "workspace": {
      "root": "./workspaces"
    },
    "polling": {
      "interval_ms": 30000
    },
    "agent": {
      "max_concurrent_agents": 3,
      "max_turns": 20,
      "max_retries": 3
    },
    "opencode": {
      "model": "claude-sonnet-4-20250514",
      "stall_timeout_ms": 300000
    },
    "hooks": {
      "after_create": "git init && git remote add origin $REPO_URL",
      "before_run": "git pull origin main || true"
    }
  }
}
```

## CLI Options

```bash
symphony [options] [workflow-path]

Options:
  -w, --workflow <path>    Path to workflow directory or WORKFLOW.md file
  -l, --log-level <level>  Log level: debug, info, warn, error (default: info)
  -p, --port <port>        Web UI port (default: 3000)
  --no-web                 Disable web UI (headless mode)
  -W, --watch              Enable hot reload on .ts and .md file changes
  -h, --help               Show this help message

Workflow Loading (in order of precedence):
  1. Explicit path via -w or positional argument
  2. ./data/workflow/workflows.json (default)
```

**Examples:**
```bash
# Start with defaults
symphony

# Custom workflow directory
symphony ./my-workflows

# Debug mode on custom port
symphony -l debug -p 8080

# Headless mode (no web UI)
symphony --no-web

# Development with auto-restart
symphony -W
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| **Issues** | | |
| GET | `/api/issues` | List all issues |
| POST | `/api/issues` | Create new issue |
| GET | `/api/issues/:id` | Get issue details |
| PUT | `/api/issues/:id` | Update issue |
| DELETE | `/api/issues/:id` | Delete issue |
| POST | `/api/issues/:id/comments` | Add comment |
| POST | `/api/issues/:id/handover` | Handover to new workflow |
| POST | `/api/issues/:id/archive` | Archive issue |
| **Workflows** | | |
| GET | `/api/workflows` | List all workflows |
| POST | `/api/workflows` | Create workflow |
| GET | `/api/workflows/:id` | Get workflow details |
| PUT | `/api/workflows/:id` | Update workflow |
| DELETE | `/api/workflows/:id` | Delete workflow |
| **System** | | |
| GET | `/api/status` | Orchestrator status |
| GET | `/api/logs` | Recent log entries |
| GET | `/api/generate-identifier` | Generate random ID |

## MCP Integration

To allow agents to interact with Symphony, add the MCP server to your OpenCode config:

**~/.config/opencode/opencode.json**:
```json
{
  "mcp": {
    "symphony": {
      "enabled": true,
      "type": "local",
      "command": ["node", "/path/to/symphony/dist/mcp-server.js"],
      "env": {
        "SYMPHONY_API_URL": "http://localhost:3000"
      }
    }
  }
}
```

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `symphony_add_comment` | Add a comment to an issue |
| `symphony_update_state` | Update issue state |
| `symphony_handover` | Hand over to another workflow |
| `symphony_create_issue` | Create a new issue |
| `symphony_update_issue` | Update issue details |
| `symphony_list_issues` | List issues (optionally filtered by state) |
| `symphony_archive_issue` | Archive an issue |
| `symphony_create_workflow` | Create a new workflow |
| `symphony_list_workflows` | List all workflows |
| `symphony_get_workflow` | Get workflow details |

## Troubleshooting

### Common Issues

#### "Failed to connect to OpenCode server"

**Cause:** OpenCode is not running or not accessible.

**Solution:**
1. Verify OpenCode is installed: `opencode --version`
2. Start OpenCode server manually: `opencode server`
3. Check if port 4096 is available: `lsof -i :4096`
4. Check Symphony logs for connection details

#### "No workflow configuration found"

**Cause:** Missing `data/workflow/workflows.json` file.

**Solution:**
```bash
cp data/workflow/sample-workflows.json data/workflow/workflows.json
cp data/workflow/sample-workflow.md data/workflow/default-workflow.md
```

#### "Agent session not starting"

**Cause:** Issue is not in an active state.

**Solution:**
1. Check your workflow's `active_states` configuration
2. Verify the card is in "Todo" or another active state
3. Check if `max_concurrent_agents` limit is reached

#### "Template rendering error"

**Cause:** Invalid LiquidJS syntax in workflow template.

**Solution:**
1. Check for unclosed tags: `{% if %}` needs `{% endif %}`
2. Check variable names match available variables
3. Use `| default: "value"` for optional fields
4. Check the logs for specific template errors

#### Cards Not Moving Automatically

**Cause:** `auto_transition` not configured.

**Solution:**
Add to your workflow config:
```json
"auto_transition": {
  "on_start": "In Progress",
  "on_complete": "Review"
}
```

#### Web UI Not Loading

**Cause:** Port conflict or build issues.

**Solution:**
1. Try a different port: `symphony -p 8080`
2. Rebuild the UI: `npm run build`
3. Check browser console for errors
4. Clear browser cache

### Debugging Tips

**Enable Debug Logging:**
```bash
symphony -l debug
```

**Log Levels:**
| Level | Description |
|-------|-------------|
| `debug` | Verbose output, all operations |
| `info` | Normal operation (default) |
| `warn` | Warnings only |
| `error` | Errors only |

**View Logs in UI:**
- Click "Logs" in the header to see recent log entries
- Logs show component, timestamp, level, and message

**Log Format:**
```
[2024-01-15T10:30:00.000Z] INFO  [orchestrator] Starting agent run {"issueId": "abc123"}
```

**Check Agent Sessions:**
- Click on a card to see its session history
- View logs for specific agent runs
- Check the "Sessions" tab for past sessions

**Database Location:**
```
data/issues.db       # Main database
data/issues.db-wal   # Write-ahead log
data/issues.db-shm   # Shared memory
```

**Reset Database (⚠️ destroys all data):**
```bash
rm data/issues.db*
# Restart Symphony - database will be recreated
```

### Getting Help

1. Check logs with `-l debug` for detailed information
2. Review workflow templates for syntax errors
3. Verify OpenCode is running and accessible
4. Check network connectivity for Linear integration

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Symphony Service                        │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ Web Server  │  │ Orchestrator │  │ Workspace Manager  │  │
│  │  (Express)  │  │              │  │                    │  │
│  └──────┬──────┘  └──────┬──────┘  └─────────┬──────────┘  │
│         │                │                    │             │
│         │         ┌──────┴──────┐            │             │
│         │         │ Agent Runner │◄──────────┘             │
│         │         │  (OpenCode)  │                         │
│         │         └──────┬──────┘                          │
│         │                │                                  │
│  ┌──────┴────────────────┴──────────────────────────────┐  │
│  │              Issue Tracker Client                     │  │
│  │         (Linear API / Local SQLite DB)               │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| CLI | `cli.ts` | Entry point, argument parsing |
| Web Server | `web-server.ts` | Express app, REST API, SSE |
| Orchestrator | `orchestrator.ts` | Issue polling, agent dispatch |
| Agent Runner | `agent-runner.ts` | OpenCode session management |
| Workflow Store | `workflow-store.ts` | Workflow CRUD operations |
| Issue Tracker | `local-sqlite-client.ts` | SQLite issue storage |
| Chat Manager | `chat-manager.ts` | AI chat assistant |
| MCP Server | `mcp-server.ts` | LLM tool integration |

### Key Behaviors

**Session Resumption:**
When Symphony restarts, it checks for issues in active states with a `session_id` and resumes those sessions.

**Comment Forwarding:**
Human comments on running issues are forwarded to the agent session in real-time.

**State Transitions:**
- `on_start`: Issue transitions when agent starts (e.g., Todo → In Progress)
- `on_complete`: Issue transitions when agent completes (e.g., In Progress → Review)

## Development

```bash
# Development with hot reload
npm run dev

# Type check only
npm run typecheck

# Build for production
npm run build

# Run production build
npm start

# Run tests
npm test

# Run tests in watch mode
npm run test:watch
```

### Project Structure

```
src/
├── cli.ts               # CLI entry point
├── mcp-server.ts        # MCP server entry point
├── orchestrator.ts      # Main orchestration logic
├── agent-runner.ts      # OpenCode agent execution
├── web-server.ts        # Express web UI server
├── chat-manager.ts      # Chat assistant
├── workflow-store.ts    # Workflow persistence
├── local-sqlite-client.ts # SQLite issue tracker
├── types.ts             # TypeScript types
├── config.ts            # Configuration management
├── prompt-renderer.ts   # LiquidJS template rendering
└── logger.ts            # Logging infrastructure
```

## License

MIT
