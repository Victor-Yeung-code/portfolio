import { useEffect, useMemo, useState } from 'react';
import { adminApi, putSignedObject } from './api';
import type { PhotoEntry, WatermarkConfig, WatermarkProfile, WatermarkResponse } from './types';
import { watermarkPositions } from './types';
import { WatermarkPreview } from './WatermarkPreview';

interface WatermarkConfigPanelProps {
  response: WatermarkResponse;
  photos: PhotoEntry[];
  onChanged: (response: WatermarkResponse) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

type ProfileDraft = Omit<WatermarkProfile, 'id'> & { id?: string };

const defaultProfile: ProfileDraft = {
  name: 'Standard',
  position: 'bottom-right',
  marginPct: 3,
  widthPct: 15,
  opacity: 0.7,
  minWidthPx: 40,
  maxWidthPx: 600
};

export function WatermarkConfigPanel({ response, photos, onChanged, onNotice, onError }: WatermarkConfigPanelProps) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState(response.previewUrl ?? '');
  const [defaultProfileForUploads, setDefaultProfileForUploads] = useState(
    response.settings.defaultProfileForUploads ?? ''
  );
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    setPreviewUrl(response.previewUrl ?? '');
    setDefaultProfileForUploads(response.settings.defaultProfileForUploads ?? '');
  }, [response]);

  const selectedFileUrl = useMemo(() => (file ? URL.createObjectURL(file) : ''), [file]);
  const effectivePreviewUrl = selectedFileUrl || previewUrl;
  const profileCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const photo of photos) {
      if (photo.watermarkProfile) {
        counts.set(photo.watermarkProfile, (counts.get(photo.watermarkProfile) ?? 0) + 1);
      }
    }
    return counts;
  }, [photos]);

  useEffect(
    () => () => {
      if (selectedFileUrl) {
        URL.revokeObjectURL(selectedFileUrl);
      }
    },
    [selectedFileUrl]
  );

  const uploadWatermark = async () => {
    if (!file) {
      return;
    }

    setBusy('upload');
    onError('');

    try {
      const uploadUrl = await adminApi.createUploadUrl({
        filename: file.name,
        contentType: file.type || 'image/png',
        kind: 'watermark'
      });
      await putSignedObject(uploadUrl.url, file, uploadUrl.headers);
      const next = await adminApi.saveWatermarkSettings({
        file: uploadUrl.key,
        defaultProfileForUploads: response.settings.defaultProfileForUploads
      });
      setPreviewUrl(next.previewUrl ?? selectedFileUrl);
      setFile(null);
      onChanged(next);
      onNotice('Watermark image changed. Use Republish All to apply this image to watermarked photos.');
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Unable to upload watermark.');
    } finally {
      setBusy('');
    }
  };

  const saveDefault = async () => {
    setBusy('default');
    onError('');

    try {
      const next = await adminApi.saveWatermarkSettings({
        file: response.settings.file,
        defaultProfileForUploads: defaultProfileForUploads || null
      });
      onChanged(next);
      onNotice('Default profile for new uploads saved.');
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Unable to save default profile.');
    } finally {
      setBusy('');
    }
  };

  const saveProfile = async () => {
    if (!draft) {
      return;
    }

    setBusy('profile');
    onError('');

    try {
      if (draft.id) {
        const next = await adminApi.updateWatermarkProfile(draft.id, profilePayload(draft));
        onChanged(next);
        onNotice(
          next.queued === 0
            ? `${next.profile.name} saved. No photos use this profile yet.`
            : `Republishing ${next.queued} photo${next.queued === 1 ? '' : 's'} using ${next.profile.name}.`
        );
      } else {
        const next = await adminApi.createWatermarkProfile(profilePayload(draft));
        onChanged(next);
        onNotice(`${next.profile.name} profile created.`);
      }
      setDraft(null);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Unable to save profile.');
    } finally {
      setBusy('');
    }
  };

  const deleteProfile = async (profile: WatermarkProfile) => {
    if (!window.confirm(`Delete ${profile.name}?`)) {
      return;
    }

    setBusy(`delete-${profile.id}`);
    onError('');

    try {
      const next = await adminApi.deleteWatermarkProfile(profile.id);
      onChanged(next);
      onNotice(`${profile.name} profile deleted.`);
      if (draft?.id === profile.id) {
        setDraft(null);
      }
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Unable to delete profile.');
    } finally {
      setBusy('');
    }
  };

  const previewConfig: WatermarkConfig | null =
    draft && response.settings.file
      ? {
          file: response.settings.file,
          position: draft.position,
          marginPct: draft.marginPct,
          widthPct: draft.widthPct,
          opacity: draft.opacity,
          minWidthPx: draft.minWidthPx,
          maxWidthPx: draft.maxWidthPx
        }
      : null;

  return (
    <div className="watermark-manager">
      <div className="watermark-settings">
        <div className="control-panel">
          <div className="mini-heading">
            <h3>Watermark Image</h3>
          </div>
          <div className="upload-band is-compact">
            <label className="file-picker">
              <span>{file?.name || response.settings.file || 'Select PNG'}</span>
              <input accept="image/png" onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)} type="file" />
            </label>
            <button disabled={!file || busy === 'upload'} onClick={() => void uploadWatermark()} type="button">
              {busy === 'upload' ? 'Uploading' : 'Upload PNG'}
            </button>
          </div>
          {response.settings.file && (
            <p className="field-note">Current: {response.settings.file}</p>
          )}
          <p className="field-note">
            After uploading a new image, use Republish All to apply it to existing watermarked photos.
          </p>
        </div>

        <div className="control-panel">
          <div className="mini-heading">
            <h3>Default For New Uploads</h3>
          </div>
          <label>
            <span>Profile</span>
            <select
              onChange={(event) => setDefaultProfileForUploads(event.currentTarget.value)}
              value={defaultProfileForUploads}
            >
              <option value="">None</option>
              {response.settings.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
          <button disabled={busy === 'default'} onClick={() => void saveDefault()} type="button">
            {busy === 'default' ? 'Saving' : 'Save Default'}
          </button>
        </div>
      </div>

      <div className="profiles-panel control-panel">
        <div className="mini-heading">
          <h3>Profiles</h3>
          <button className="secondary" onClick={() => setDraft({ ...defaultProfile })} type="button">
            Add Profile
          </button>
        </div>

        <div className="profile-list">
          {response.settings.profiles.map((profile) => (
            <article className="profile-row" key={profile.id}>
              <div>
                <strong>{profile.name}</strong>
                <span>{profile.position}</span>
              </div>
              <span>{profile.opacity.toFixed(2)} opacity</span>
              <span>{profileCounts.get(profile.id) ?? 0} photos using</span>
              <div className="row-actions">
                <button className="secondary" onClick={() => setDraft({ ...profile })} type="button">
                  Edit
                </button>
                <button
                  className="danger"
                  disabled={busy === `delete-${profile.id}`}
                  onClick={() => void deleteProfile(profile)}
                  type="button"
                >
                  {busy === `delete-${profile.id}` ? 'Deleting' : 'Delete'}
                </button>
              </div>
            </article>
          ))}
          {response.settings.profiles.length === 0 && <p className="empty-state">No watermark profiles yet.</p>}
        </div>
      </div>

      {draft && (
        <div className="watermark-grid">
          <ProfileEditor draft={draft} saving={busy === 'profile'} setDraft={setDraft} onCancel={() => setDraft(null)} onSave={saveProfile} />
          <WatermarkPreview config={previewConfig} watermarkUrl={effectivePreviewUrl} />
        </div>
      )}
    </div>
  );
}

interface ProfileEditorProps {
  draft: ProfileDraft;
  saving: boolean;
  setDraft: (draft: ProfileDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}

function ProfileEditor({ draft, saving, setDraft, onCancel, onSave }: ProfileEditorProps) {
  return (
    <div className="control-panel">
      <div className="mini-heading">
        <h3>{draft.id ? 'Edit Profile' : 'Add Profile'}</h3>
      </div>
      <label>
        <span>Name</span>
        <input onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })} value={draft.name} />
      </label>

      <div className="anchor-picker" aria-label="Watermark position">
        <span>Position</span>
        <div className="anchor-grid">
          {watermarkPositions.map((position) => (
            <button
              aria-label={position}
              aria-pressed={draft.position === position}
              className={draft.position === position ? 'is-active' : ''}
              key={position}
              onClick={() => setDraft({ ...draft, position })}
              type="button"
            >
              <span className={`anchor-dot is-${position}`} />
            </button>
          ))}
        </div>
      </div>

      <div className="slider-grid">
        <label>
          <span>Width %</span>
          <input
            max={50}
            min={1}
            onChange={(event) => setDraft({ ...draft, widthPct: Number(event.currentTarget.value) })}
            type="range"
            value={draft.widthPct}
          />
          <output>{draft.widthPct}</output>
        </label>
        <label>
          <span>Margin %</span>
          <input
            max={20}
            min={0}
            onChange={(event) => setDraft({ ...draft, marginPct: Number(event.currentTarget.value) })}
            type="range"
            value={draft.marginPct}
          />
          <output>{draft.marginPct}</output>
        </label>
        <label>
          <span>Opacity</span>
          <input
            max={1}
            min={0}
            onChange={(event) => setDraft({ ...draft, opacity: Number(event.currentTarget.value) })}
            step={0.05}
            type="range"
            value={draft.opacity}
          />
          <output>{draft.opacity.toFixed(2)}</output>
        </label>
      </div>

      <div className="field-grid two-up">
        <label>
          <span>Min px</span>
          <input
            min={1}
            onChange={(event) => setDraft({ ...draft, minWidthPx: Number(event.currentTarget.value) })}
            type="number"
            value={draft.minWidthPx}
          />
        </label>
        <label>
          <span>Max px</span>
          <input
            min={1}
            onChange={(event) => setDraft({ ...draft, maxWidthPx: Number(event.currentTarget.value) })}
            type="number"
            value={draft.maxWidthPx}
          />
        </label>
      </div>

      <div className="row-actions">
        <button disabled={saving || !draft.name.trim()} onClick={() => void onSave()} type="button">
          {saving ? 'Saving' : 'Save Profile'}
        </button>
        <button className="secondary" disabled={saving} onClick={onCancel} type="button">
          Cancel
        </button>
      </div>
    </div>
  );
}

function profilePayload(draft: ProfileDraft): Omit<WatermarkProfile, 'id'> {
  return {
    name: draft.name,
    position: draft.position,
    marginPct: draft.marginPct,
    widthPct: draft.widthPct,
    opacity: draft.opacity,
    minWidthPx: draft.minWidthPx,
    maxWidthPx: draft.maxWidthPx
  };
}
