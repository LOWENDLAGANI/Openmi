type LogFields = Record<string, unknown>;

const REDACTED_KEYS = /token|secret|key|authorization|cookie|password/i;

function scrub(fields: LogFields): LogFields {
  const clean: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACTED_KEYS.test(key)) {
      clean[key] = '[redacted]';
    } else if (value instanceof Error) {
      clean[key] = { name: value.name, message: value.message };
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

function emit(level: 'info' | 'warn' | 'error', event: string, fields: LogFields): void {
  const line = JSON.stringify({
    level,
    event,
    ts: new Date().toISOString(),
    ...scrub(fields),
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields: LogFields = {}) => emit('info', event, fields),
  warn: (event: string, fields: LogFields = {}) => emit('warn', event, fields),
  error: (event: string, fields: LogFields = {}) => emit('error', event, fields),
};
