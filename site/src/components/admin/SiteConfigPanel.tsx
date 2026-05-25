import { useEffect, useState } from 'react';
import Link from '@tiptap/extension-link';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { adminApi } from './api';
import type { SiteConfig, SocialLink } from './types';

const bioTextLimit = 15000;

interface SiteConfigPanelProps {
  site: SiteConfig;
  onChanged: (site: SiteConfig) => void;
  onError: (message: string) => void;
}

export function SiteConfigPanel({ site, onChanged, onError }: SiteConfigPanelProps) {
  const [draft, setDraft] = useState<SiteConfig>(site);
  const [busy, setBusy] = useState(false);
  const editor = useEditor({
    content: toEditorContent(site.bio),
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        horizontalRule: false
      }),
      Link.configure({
        autolink: true,
        defaultProtocol: 'https',
        openOnClick: false
      })
    ],
    immediatelyRender: false,
    onUpdate: ({ editor: activeEditor }) => {
      setDraft((current) => ({ ...current, bio: activeEditor.getHTML() }));
    }
  });

  const bioTextLength = editor?.getText().trim().length ?? plainTextLength(draft.bio);
  const canSave = Boolean(draft.name.trim()) && bioTextLength <= bioTextLimit && !busy;

  useEffect(() => {
    setDraft(site);
    editor?.commands.setContent(toEditorContent(site.bio), false);
  }, [editor, site]);

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
    if (!canSave) {
      return;
    }

    setBusy(true);
    onError('');

    try {
      const response = await adminApi.saveSite({
        ...draft,
        bio: editor?.getHTML() ?? draft.bio,
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
          <div className="rich-editor-shell">
            <div className="rich-editor-toolbar" aria-label="Bio formatting">
              <button
                className={editor?.isActive('bold') ? 'is-active' : 'secondary'}
                disabled={!editor}
                onClick={() => editor?.chain().focus().toggleBold().run()}
                type="button"
              >
                B
              </button>
              <button
                className={editor?.isActive('italic') ? 'is-active' : 'secondary'}
                disabled={!editor}
                onClick={() => editor?.chain().focus().toggleItalic().run()}
                type="button"
              >
                I
              </button>
              <button
                className={editor?.isActive('heading', { level: 2 }) ? 'is-active' : 'secondary'}
                disabled={!editor}
                onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
                type="button"
              >
                H2
              </button>
              <button
                className={editor?.isActive('heading', { level: 3 }) ? 'is-active' : 'secondary'}
                disabled={!editor}
                onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
                type="button"
              >
                H3
              </button>
              <button
                className={editor?.isActive('bulletList') ? 'is-active' : 'secondary'}
                disabled={!editor}
                onClick={() => editor?.chain().focus().toggleBulletList().run()}
                type="button"
              >
                Bullet
              </button>
              <button
                className={editor?.isActive('orderedList') ? 'is-active' : 'secondary'}
                disabled={!editor}
                onClick={() => editor?.chain().focus().toggleOrderedList().run()}
                type="button"
              >
                Numbered
              </button>
              <button
                className={editor?.isActive('link') ? 'is-active' : 'secondary'}
                disabled={!editor}
                onClick={() => setEditorLink(editor)}
                type="button"
              >
                Link
              </button>
              <button
                className="secondary"
                disabled={!editor}
                onClick={() => editor?.chain().focus().undo().run()}
                type="button"
              >
                Undo
              </button>
              <button
                className="secondary"
                disabled={!editor}
                onClick={() => editor?.chain().focus().redo().run()}
                type="button"
              >
                Redo
              </button>
            </div>
            <EditorContent className="rich-editor" editor={editor} />
          </div>
          <small className={bioTextLength > bioTextLimit ? 'field-note is-error' : 'field-note'}>
            {bioTextLength}/{bioTextLimit}
          </small>
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

        <button disabled={!canSave} onClick={() => void save()} type="button">
          {busy ? 'Saving' : 'Save Site Info'}
        </button>
      </div>
    </div>
  );
}

function setEditorLink(editor: ReturnType<typeof useEditor>): void {
  if (!editor) {
    return;
  }

  const existing = editor.getAttributes('link').href as string | undefined;
  const href = window.prompt('URL', existing ?? '');

  if (href === null) {
    return;
  }

  if (!href.trim()) {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    return;
  }

  editor.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run();
}

function toEditorContent(value: string): string {
  if (/<[a-z][\s\S]*>/i.test(value)) {
    return value;
  }

  return value
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function plainTextLength(value: string): number {
  return value.replace(/<[^>]*>/g, '').trim().length;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
