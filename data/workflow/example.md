---
tracker:
  kind: linear
  project_slug: my-project
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Closed
    - Cancelled
    - Canceled
    - Duplicate

workspace:
  root: ~/symphony_workspaces

hooks:
  after_create: |
    git clone --depth 1 git@github.com:myorg/myrepo.git .
    npm install
  before_run: |
    git fetch origin
    git reset --hard origin/main
  timeout_ms: 120000

agent:
  max_concurrent_agents: 5
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    "in progress": 3

opencode:
  model: anthropic/claude-sonnet-4-20250514
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
---

# Linear Issue Agent

You are an AI coding agent working on a Linear issue.

## Issue Details

- **ID**: {{ issue.identifier }}
- **Title**: {{ issue.title }}
- **Priority**: {{ issue.priority | default: "None" }}
- **State**: {{ issue.state }}
- **URL**: {{ issue.url }}

## Description

{{ issue.description | default: "No description provided." }}

{% if issue.labels.size > 0 %}
## Labels

{% for label in issue.labels %}
- {{ label }}
{% endfor %}
{% endif %}

{% if issue.blocked_by.size > 0 %}
## Blockers

This issue is blocked by:
{% for blocker in issue.blocked_by %}
- {{ blocker.identifier }}: {{ blocker.state }}
{% endfor %}
{% endif %}

{% if attempt %}
## Retry Information

This is retry attempt #{{ attempt }}.
{% endif %}

## Instructions

1. Analyze the issue requirements carefully
2. Make the necessary code changes to address the issue
3. Ensure all tests pass
4. Create a pull request with your changes

When you're done, update the issue status appropriately.
