import { useEffect, useRef, useState } from 'react';
import { ArrowUp } from './icons';
import { Banner, Button, Card, cx } from './ui';

const SUGGESTIONS = [
  'Add a dark mode toggle',
  'Make the landing page work on small screens',
  'Add a share button to the header',
  'Write a short README for this project',
];

const MAX_LENGTH = 4000;

export function PromptComposer({
  onSubmit,
  disabled,
  disabledReason,
  placeholder,
}: {
  onSubmit: (prompt: string) => Promise<void>;
  disabled: boolean;
  disabledReason?: string;
  placeholder: string;
}) {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, [value]);

  async function send(nextPrompt: string) {
    const prompt = nextPrompt.trim();
    if (prompt.length < 4 || sending || disabled) return;

    setSending(true);
    setError(null);
    try {
      await onSubmit(prompt);
      setValue('');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not start the task');
    } finally {
      setSending(false);
    }
  }

  const canSend = value.trim().length >= 4 && !sending && !disabled;

  return (
    <div className="space-y-2.5">
      <Card className="p-3">
        <label htmlFor="prompt" className="sr-only">
          What should the agent change?
        </label>
        <textarea
          id="prompt"
          ref={textareaRef}
          rows={2}
          value={value}
          maxLength={MAX_LENGTH}
          disabled={disabled || sending}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send(value);
            }
          }}
          placeholder={placeholder}
          className={cx(
            'w-full resize-none bg-transparent px-1.5 py-1.5 text-[16px] leading-relaxed text-zinc-100',
            'placeholder:text-zinc-500 focus:outline-none disabled:opacity-60',
          )}
        />
        <div className="mt-1 flex items-end justify-between gap-2">
          <span
            className={cx(
              'pl-1.5 text-[11px]',
              value.length > MAX_LENGTH - 200 ? 'text-amber-300' : 'text-zinc-600',
            )}
          >
            {value.length > 0 ? `${value.length}/${MAX_LENGTH}` : disabledReason ?? ''}
          </span>
          <Button
            onClick={() => void send(value)}
            disabled={!canSend}
            loading={sending}
            aria-label="Send prompt"
            className="size-11 min-h-11 shrink-0 rounded-full px-0"
          >
            {!sending ? <ArrowUp className="size-5" /> : null}
          </Button>
        </div>
      </Card>

      {error ? <Banner>{error}</Banner> : null}

      {!value && !disabled ? (
        <div className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => {
                setValue(suggestion);
                textareaRef.current?.focus();
              }}
              className="shrink-0 rounded-full border border-white/10 bg-white/5 px-3.5 py-2 text-[12px] whitespace-nowrap text-zinc-300 active:bg-white/10"
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
