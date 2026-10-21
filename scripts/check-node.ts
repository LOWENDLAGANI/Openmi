// Verify the Vercel handler loads on plain Node with no Worker-only imports.
import 'dotenv/config';

async function main() {
  const mod = await import('../api/[[...route]].ts');
  if (typeof mod.default !== 'function') {
    throw new Error('handler default export is not a function');
  }
  console.log('ok: Vercel handler loads on plain Node');
}

main().catch((e) => {
  console.error('check:node failed:', e);
  process.exit(1);
});
