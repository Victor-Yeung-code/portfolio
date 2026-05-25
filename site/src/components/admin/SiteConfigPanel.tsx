import { useEffect, useState } from 'react';
import { adminApi } from './api';
import type { SiteConfig, SocialLink } from './types';

interface SiteConfigPanelProps {
  site: SiteConfig;
  onChanged: (site: SiteConfig) => void;
  onError: (message: string) => void;
}

export function SiteConfigPanel({ site, onChanged, onError }: SiteConfigPanelProps) {
  const [draft, setDraft] = useState<SiteConfig>(site);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(site);
  }, [site]);

  const updateSocial = (index: number, patch: Partial<SocialLink>) => {
    setDraft((current) => ({
      ...current,
      social: current.social.map((link, currentIndex) => (currentIndex === index ? { ...link, ...patch } : link))
    }));
  };

  const removeSocial = (index: number) => {
    setDraft((current) => ({
      ...current,
      social: current.social.filter((_, currentIndex) => currentIndex !== index)
    }));
  };

  const addSocial = () => {
    setDraft((current) => ({
      ...current,
      social: [...current.social, { platform: '', url: '' }].slice(0, 8)
    }));
  };

  const save = async () => {
    setBusy(true);
    onError('');

    try {
      const response = await adminApi.saveSite({
        ...draft,
        social: draft.social.filter((link) => link.platform.trim() || link.url.trim())
      });
      onChanged(response.config);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Unable to save site info.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="site-config-panel">
      <div className="control-panel">
        <div className="field-grid two-up">
          <label>
            <span>Name</span>
            <input
              maxLength={80}
              onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
              value={draft.name}
            />
          </label>
          <label>
            <span>Tagline</span>
            <input
              maxLength={120}
              onChange={(event) => setDraft({ ...draft, tagline: event.currentTarget.value })}
              value={draft.tagline}
            />
          </label>
        </div>

        <label>
          <span>Bio</span>
          <textarea
            maxLength={5000}
            onChange={(event) => setDraft({ ...draft, bio: event.currentTarget.value })}
            rows={9}
            value={draft.bio}
          />
        </label>

        <div className="field-grid two-up">
          <label>
            <span>Email</span>
            <input
              maxLength={320}
              onChange={(event) => setDraft({ ...draft, email: event.currentTarget.value })}
              type="email"
              value={draft.email}
            />
          </label>
          <label>
            <span>Footer</span>
            <input
              maxLength={200}
              onChange={(event) => setDraft({ ...draft, footer: event.currentTarget.value })}
              value={draft.footer}
            />
          </label>
        </div>

        <div className="social-editor">
          <div className="mini-heading">
            <h3>Social Links</h3>
            <button disabled={draft.social.length >= 8} onClick={addSocial} type="button">
              Add Link
            </button>
          </div>

          {draft.social.map((link, index) => (
            <div className="social-row" key={`${index}-${link.platform}`}>
              <label>
                <span>Platform</span>
                <input
                  maxLength={20}
                  onChange={(event) => updateSocial(index, { platform: event.currentTarget.value })}
                  value={link.platform}
                />
              </label>
              <label>
                <span>URL</span>
                <input
                  onChange={(event) => updateSocial(index, { url: event.currentTarget.value })}
                  type="url"
                  value={link.url}
                />
              </label>
              <button className="secondary" onClick={() => removeSocial(index)} type="button">
                Remove
              </button>
            </div>
          ))}
        </div>

        <button disabled={busy} onClick={() => void save()} type="button">
          {busy ? 'Saving' : 'Save Site Info'}
        </button>
      </div>
    </div>
  );
}
