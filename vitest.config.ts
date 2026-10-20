import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@shared\//, replacement: `${rootDir}shared/` },
      { find: /^@\//, replacement: `${rootDir}src/` },
      {
        find: /^cloudflare:workers$/,
        replacement: `${rootDir}tests/stubs/cloudflare-workers.ts`,
      },
      {
        find: /^cloudflare:workflows$/,
        replacement: `${rootDir}tests/stubs/cloudflare-workflows.ts`,
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
