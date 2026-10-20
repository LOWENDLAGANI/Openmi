import { app } from './app';
import type { Env } from './env';

// Workflow classes must be exported from the Worker entrypoint so the
// `workflows[].class_name` binding can find them.
export { TaskWorkflow } from './workflows/task-workflow';

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
