import { useEffect, useState, type FormEvent } from 'react';

interface ContactFormProps {
  turnstileSiteKey?: string;
}

interface ContactDraft {
  name: string;
  email: string;
  message: string;
  website: string;
}

declare global {
  interface Window {
    onVictorTurnstile?: (token: string) => void;
  }
}

const initialDraft: ContactDraft = {
  name: '',
  email: '',
  message: '',
  website: ''
};

export function ContactForm({ turnstileSiteKey }: ContactFormProps) {
  const [draft, setDraft] = useState<ContactDraft>(initialDraft);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!turnstileSiteKey) {
      return;
    }

    window.onVictorTurnstile = setTurnstileToken;

    if (!document.querySelector('script[data-turnstile-script="true"]')) {
      const script = document.createElement('script');
      script.async = true;
      script.defer = true;
      script.dataset.turnstileScript = 'true';
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
      document.head.append(script);
    }
  }, [turnstileSiteKey]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setStatus('');
    setError('');

    try {
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ...draft,
          turnstileToken
        })
      });
      const body = (await safeJson(response)) as { error?: string } | null;

      if (!response.ok) {
        throw new Error(body?.error ?? 'Unable to send message right now.');
      }

      setDraft(initialDraft);
      setTurnstileToken('');
      setStatus("Thanks, I'll get back to you.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to send message right now.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="contact-form" onSubmit={(event) => void submit(event)}>
      <label>
        <span>Name</span>
        <input
          autoComplete="name"
          maxLength={100}
          onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
          required
          value={draft.name}
        />
      </label>

      <label>
        <span>Email</span>
        <input
          autoComplete="email"
          maxLength={320}
          onChange={(event) => setDraft({ ...draft, email: event.currentTarget.value })}
          required
          type="email"
          value={draft.email}
        />
      </label>

      <label>
        <span>Message</span>
        <textarea
          maxLength={2000}
          minLength={10}
          onChange={(event) => setDraft({ ...draft, message: event.currentTarget.value })}
          required
          rows={8}
          value={draft.message}
        />
      </label>

      <label className="honey-field" aria-hidden="true">
        <span>Website</span>
        <input
          autoComplete="off"
          onChange={(event) => setDraft({ ...draft, website: event.currentTarget.value })}
          tabIndex={-1}
          value={draft.website}
        />
      </label>

      {turnstileSiteKey && <div className="cf-turnstile" data-sitekey={turnstileSiteKey} data-callback="onVictorTurnstile" />}

      {(status || error) && (
        <p className={`form-status ${error ? 'is-error' : ''}`} role="status">
          {error || status}
        </p>
      )}

      <button disabled={busy} type="submit">
        {busy ? 'Sending' : 'Send Message'}
      </button>
    </form>
  );
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
