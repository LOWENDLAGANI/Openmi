import type { Issue } from '../../shared/types';

export interface ErrorState {
  message: string;
  code?: string;
  issues: Issue[];
}

// Normalise anything thrown (Error, ApiError, string, unknown) into a message
// plus the full list of issues the API reported.
export function toErrorState(error: unknown, fallback = 'Something went wrong'): ErrorState {
  const err = error as any;
  const issues: Issue[] = Array.isArray(err?.issues) ? err.issues : [];
  const message =
    typeof err?.message === 'string' && err.message
      ? err.message
      : typeof error === 'string' && error
        ? error
        : fallback;
  const code = typeof err?.code === 'string' ? err.code : undefined;
  return { message, code, issues };
}

export default function ErrorList({
  state,
  className = '',
}: {
  state: ErrorState;
  className?: string;
}) {
  return (
    <div
      className={`bg-red-500/10 border border-red-500/30 text-red-300 text-sm rounded-xl p-3 ${className}`}
    >
      <div className="font-medium break-words">
        {state.code ? `${state.code}: ` : ''}
        {state.message}
      </div>
      {state.issues.length > 0 && (
        <>
          <ul className="mt-2 space-y-1 list-disc pl-4 text-xs opacity-90">
            {state.issues.map((issue, idx) => (
              <li key={`${issue.code}-${idx}`} className="break-words">
                {issue.path ?? issue.field ?? issue.source ? (
                  <span className="font-mono opacity-80">
                    {issue.path ?? issue.field ?? issue.source}
                    {issue.path ?? issue.field ?? issue.source ? ': ' : ''}
                  </span>
                ) : null}
                {issue.message}
              </li>
            ))}
          </ul>
          {state.issues.length > 1 && (
            <div className="mt-2 text-xs opacity-70">{state.issues.length} problems</div>
          )}
        </>
      )}
    </div>
  );
}
