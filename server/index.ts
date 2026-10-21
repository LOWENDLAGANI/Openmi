import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { AppError } from './errors.js';
import healthRoutes from './routes/health.js';
import meRoutes from './routes/me.js';
import githubRoutes from './routes/github.js';
import projectRoutes from './routes/projects.js';
import taskRoutes from './routes/tasks.js';
import internalRoutes from './routes/internal.js';

const app = new Hono();

app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'] }));

app.route('/', healthRoutes);
app.route('/', meRoutes);
app.route('/', githubRoutes);
app.route('/', projectRoutes);
app.route('/', taskRoutes);
app.route('/', internalRoutes);

// 404 for unknown /api/* routes.
app.all('*', (c) =>
  c.json({ error: { code: 'NOT_FOUND', message: `no route for ${c.req.method} ${c.req.path}` } }, 404),
);

// Central error handler. AppError -> structured JSON; anything else -> 500.
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json(err.toJSON(), err.status);
  }
  console.error('unhandled error:', err);
  return c.json(
    { error: { code: 'INTERNAL', message: err?.message ?? 'internal error' } },
    500,
  );
});

export default app;
