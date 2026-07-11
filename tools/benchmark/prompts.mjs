/**
 * Prompt text for both benchmark arms, in its own pure module so
 * prompts.test.mjs can assert on their content without spawning `claude` at
 * all. Both arms are given the same underlying task (add an "Order" entity
 * vertical slice); only the instructions around *how* to do it differ.
 */

export const ORDER_TASK_DESCRIPTION =
  'Add a new "Order" entity to this backend: fields id (Guid), customerId (Guid), total (decimal), and ' +
  'status (string), plus a full CRUD vertical slice (create, get-by-id) exposed through the API layer, ' +
  'wired into dependency injection and the EF Core DbContext exactly the way the existing entities in ' +
  'this solution are wired.';

/**
 * Freehand arm: explicitly forbidden from using the scaffold CLI. The
 * prompt instruction alone isn't trusted as the only guardrail — the
 * scaffold binary is also kept off PATH for this arm's spawned process
 * (see arms/freehand.mjs) — but the instruction is still here so Claude
 * doesn't waste a turn discovering and then abandoning the CLI, which
 * would pollute the token/time comparison even if it never actually ran.
 */
export function buildFreehandPrompt(taskDescription = ORDER_TASK_DESCRIPTION) {
  return (
    `${taskDescription}\n\n` +
    'Do this by hand-writing every file directly with your own file-editing tools. ' +
    'Do NOT use, invoke, or reference the "scaffold" CLI or @mohantn/scaffold-core in any way — it is not ' +
    'available in this environment and any attempt to run it will fail. Follow the existing code\'s own ' +
    'conventions (naming, folder layout, DI registration style) by reading the existing entities in this ' +
    'solution first.'
  );
}

/**
 * Scaffolded arm: follows the real SKILL.md workflow — build an intent
 * manifest, run `scaffold generate`, then fill only the AI_IMPLEMENTATION
 * blocks the generate report marks as empty. `scaffold` is on PATH for
 * this arm's spawned process (see arms/scaffolded.mjs).
 */
export function buildScaffoldedPrompt(taskDescription = ORDER_TASK_DESCRIPTION) {
  return (
    `${taskDescription}\n\n` +
    'This repo has the "scaffold" CLI (@mohantn/scaffold-core) available on PATH, along with its Skill ' +
    'documentation. Follow that Skill\'s documented workflow exactly: build an intent manifest for the ' +
    '"Order" entity, run "scaffold generate" against it, then fill only the AI_IMPLEMENTATION blocks the ' +
    'generate report marks as empty. Do not hand-write any file the scaffold CLI would have rendered or ' +
    'injected for you.'
  );
}
