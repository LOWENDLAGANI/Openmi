import { app } from './app.js';
import type { Env } from './env.js';

// Workflow classes must be exported from the Worker entrypoint so the
// `workflows[].class_name` binding can find them.
export { TaskWorkflow } from './workflows/task-workflow.js';

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
