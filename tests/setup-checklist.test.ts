import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SetupChecklist from '../src/components/SetupChecklist';
import { configChecks } from '../server/config-catalogue';
import type { ConfigCheck } from '../shared/types';

function render(checks: ConfigCheck[]): string {
  return renderToStaticMarkup(
    createElement(SetupChecklist, {
      checks,
      onRetry: () => {},
      onSkip: () => {},
    }),
  );
}

describe('setup checklist screen', () => {
  const checks = configChecks();

  it('lists every environment variable by name', () => {
    const html = render(checks);
    for (const check of checks) {
      expect(html).toContain(check.name);
    }
  });

  it('shows how to set each variable', () => {
    const html = render(checks);
    expect(html).toContain('How');
    expect(html).toContain('Re-check');
    expect(html).toContain('Continue to the app');
    // The instructions of the first entry are rendered on the row.
    expect(html).toContain('Firebase console');
  });

  it('separates required, recommended and optional variables', () => {
    const html = render(checks);
    expect(html).toContain('Required');
    expect(html).toContain('Recommended');
    expect(html).toContain('Optional');
  });

  it('marks a variable that is not set as missing', () => {
    const html = render([
      {
        name: 'TEST_MISSING_VAR',
        group: 'required',
        required: true,
        present: false,
        secret: true,
        purpose: 'A variable that is not set yet.',
        howToSet: 'Set it somewhere obvious.',
        example: 'example-value',
      },
    ]);
    expect(html).toContain('TEST_MISSING_VAR');
    expect(html).toContain('missing');
    expect(html).toContain('A variable that is not set yet.');
  });

  it('marks a variable that is set, and shows the default of an unset one', () => {
    const html = render([
      {
        name: 'SET_VAR',
        group: 'optional',
        required: false,
        present: true,
        secret: false,
        purpose: 'Already configured.',
        howToSet: 'Nothing to do.',
      },
      {
        name: 'DEFAULTED_VAR',
        group: 'optional',
        required: false,
        present: false,
        secret: false,
        purpose: 'Has a default.',
        howToSet: 'Nothing to do.',
        defaultValue: 'the-default',
      },
    ]);
    expect(html).toContain('SET_VAR');
    expect(html).toContain('set');
    expect(html).toContain('default: the-default');
  });

  it('never renders a secret value', () => {
    const html = render(checks);
    expect(html).not.toContain('internal-token-123456789012345678901234567890');
    expect(html).not.toContain('cron-secret-1234');
  });
});
