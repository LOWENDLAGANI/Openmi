/**
 * Runtime stub for `cloudflare:workers` so the Workflow class can be executed
 * under Vitest. Type-checking still uses the real Workers types.
 */
export abstract class WorkflowEntrypoint<Env, Params> {
  protected ctx: unknown;
  protected env: Env;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  abstract run(event: unknown, step: unknown): Promise<unknown>;
}
