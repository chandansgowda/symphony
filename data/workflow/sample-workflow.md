---
# Sample workflow configuration (YAML frontmatter)
# Copy this file and customize for your use case

tracker:
  kind: local                    # 'local' or 'linear'
  issues_path: ./data/issues.db  # Path to issues database (local tracker)
  # api_key: $LINEAR_API_KEY     # Linear API key (use env var)
  # project_slug: my-project     # Linear project slug
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Closed
    - Cancelled

workspace:
  root: ./workspaces             # Where agent workspaces are created

hooks:
  after_create: |                # Run after workspace creation
    echo "Workspace created at $(pwd)"
  before_run: |                  # Run before each agent run
    echo "Starting agent run"
  timeout_ms: 120000

agent:
  max_concurrent_agents: 3       # Max parallel agents

opencode:
  model: claude-sonnet-4-20250514
  turn_timeout_ms: 3600000       # 1 hour per turn
  stall_timeout_ms: 300000       # 5 min stall detection
---

# Sample Issue Agent

You are an AI coding agent working on an issue.

## Issue Details

- **ID**: {{ issue.identifier }}
- **Title**: {{ issue.title }}
- **Priority**: {{ issue.priority | default: "None" }}
- **State**: {{ issue.state }}

## Description

{{ issue.description | default: "No description provided." }}

{% if issue.labels.size > 0 %}
## Labels

{% for label in issue.labels %}
- {{ label }}
{% endfor %}
{% endif %}

{% if issue.comments.size > 0 %}
## Comments

{% for comment in issue.comments %}
- [{{ comment.author }}]: {{ comment.content }}
{% endfor %}
{% endif %}

{% if attempt %}
## Retry Information

This is retry attempt #{{ attempt }}.
{% endif %}

## Instructions

1. Analyze the issue requirements carefully
2. Make the necessary code changes
3. Test your changes
4. Update the issue status when complete

Use `symphony_add_comment` to add progress updates.
Use `symphony_update_state` to change the issue state when done.
