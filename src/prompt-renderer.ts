import { Liquid } from 'liquidjs';
import { Issue } from './types.js';

const engine = new Liquid({
  strictVariables: true,
  strictFilters: true,
});

export interface PromptContext {
  issue: Issue;
  attempt: number | null;
}

export async function renderPrompt(template: string, context: PromptContext): Promise<string> {
  // Map comments to snake_case for template compatibility
  const commentsForTemplate = context.issue.comments.map(c => ({
    id: c.id,
    author: c.author,
    content: c.content,
    created_at: c.createdAt?.toISOString() ?? null,
  }));

  const latestAgentComment = [...context.issue.comments]
    .reverse()
    .find(c => c.author === 'agent');

  const handoverNotes = latestAgentComment ? latestAgentComment.content : null;

  const issueForTemplate = {
    ...context.issue,
    comments: commentsForTemplate,
    created_at: context.issue.created ?? null,
    updated_at: context.issue.lastModified ?? null,
    branch_name: context.issue.branchName,
    blocked_by: context.issue.blockedBy,
    handover_notes: handoverNotes,
  };

  return await engine.parseAndRender(template, {
    issue: issueForTemplate,
    attempt: context.attempt,
  });
}

export function getDefaultPrompt(): string {
  return 'You are working on an issue from Linear.';
}

export function getContinuationPrompt(turnCount: number): string {
  return `Continue working on the issue. This is turn ${turnCount + 1}.

Check the current state of the work and proceed with the next steps. If you believe the work is complete, indicate that you are done.`;
}
