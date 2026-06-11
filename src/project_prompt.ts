/**
 * project_prompt.ts
 *
 * Optional MCP prompt support for project-local agent instructions.
 */

import * as fs from "fs";
import * as path from "path";

export const PROJECT_PROMPT_FILE = "indexer-prompt.md";
export const PROJECT_PROMPT_NAME = "project-indexer-prompt";

export function projectPromptPath(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_PROMPT_FILE);
}

export function hasProjectPrompt(projectRoot: string): boolean {
  return fs.existsSync(projectPromptPath(projectRoot));
}

export function listProjectPrompts(projectRoot: string): Record<string, unknown> {
  if (!hasProjectPrompt(projectRoot)) return { prompts: [] };
  return {
    prompts: [
      {
        name: PROJECT_PROMPT_NAME,
        title: "Project Indexer Prompt",
        description: `Project-local agent guidance loaded from ${PROJECT_PROMPT_FILE}. Use as routing and behavior guidance; it is not source evidence.`,
        arguments: [],
      },
    ],
  };
}

export function getProjectPrompt(projectRoot: string, name: string): Record<string, unknown> {
  if (name !== PROJECT_PROMPT_NAME) {
    throw new Error(`Unknown prompt: ${name}`);
  }
  const promptPath = projectPromptPath(projectRoot);
  if (!fs.existsSync(promptPath)) {
    throw new Error(`${PROJECT_PROMPT_FILE} not found in project root`);
  }
  const text = fs.readFileSync(promptPath, "utf-8");
  return {
    description: `Project-local indexer prompt from ${PROJECT_PROMPT_FILE}.`,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text,
        },
      },
    ],
    _meta: {
      file: PROJECT_PROMPT_FILE,
      path: promptPath,
      evidenceKind: "project_prompt",
      note: "Prompt guidance only; not source behavior evidence.",
    },
  };
}
