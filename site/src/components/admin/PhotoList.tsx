import { useEffect, useMemo, useState } from 'react';
import { adminApi } from './api';
import type { PhotoEntry } from './types';

interface PhotoListProps {
  photos: PhotoEntry[];
  onChanged: (photo: PhotoEntry) => void;
  onRefresh: () => void;
}

export function PhotoList({ photos, onChanged, onRefresh }: PhotoListProps) {
  const [showDeleted, setShowDeleted] = useState(false);
  const [filter, setFilter] = useState('');

  const visiblePhotos = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return photos.filter((photo) => {
      const matchesDeleted = showDeleted || !photo.deleted;
      const matchesQuery =
        !query ||
        photo.title.toLowerCase().includes(query) ||
        photo.id.toLowerCase().includes(query) ||
        photo.tags.some((tag) => tag.toLowerCase().includes(query));

      return matchesDeleted && matchesQuery;
    });
  }, [filter, photos, showDeleted]);

  return (
    <div className="photo-workbench">
      <div className="list-tools">
        <label className="search-box">
          <span>Search</span>
          <input onChange={(event) => setFilter(event.currentTarget.value)} value={filter} />
        </label>
        <label className="checkline">
          <input checked={showDeleted} onChange={(event) => setShowDeleted(event.currentTarget.checked)} type="checkbox" />
          <span>Show deleted</span>
        </label>
      </div>

      <div className="photo-list">
        {visiblePhotos.map((photo) => (
          <PhotoRow key={photo.id} onChanged={onChanged} onRefresh={onRefresh} photo={photo} />
        ))}
        {visiblePhotos.length === 0 && <p className="empty-state">No photos found.</p>}
      </div>
    </div>
  );
}

interface PhotoRowProps {
  photo: PhotoEntry;
  onChanged: (photo: PhotoEntry) => void;
  onRefresh: () => void;
}

function PhotoRow({ photo, onChanged, onRefresh }: PhotoRowProps) {
  const [draft, setDraft] = useState(() => draftFromPhoto(photo));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setDraft(draftFromPhoto(photo));
  }, [photo]);

  const save = async () => {
    setBusy('save');
    setError('');

    try {
      const response = await adminApi.updatePhoto(photo.id, {
        title: draft.title,
        description: draft.description,
        album: draft.album,
        order: Number(draft.order) || 0,
        tags: draft.tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean)
      });
      onChanged(response.photo);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save photo.');
    } finally {
      setBusy('');
    }
  };

  const softDelete = async () => {
    setBusy('delete');
    setError('');

    try {
      const response = await adminApi.softDeletePhoto(photo.id);
      onChanged(response.photo);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to delete photo.');
    } finally {
      setBusy('');
    }
  };

  const restore = async () => {
    setBusy('restore');
    setError('');

    try {
      const response = await adminApi.restorePhoto(photo.id);
      onChanged(response.photo);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to restore photo.');
    } finally {
      setBusy('');
    }
  };

  const purge = async () => {
    if (!window.confirm(`Permanently purge ${photo.title || photo.id}?`)) {
      return;
    }

    setBusy('purge');
    setError('');

    try {
      await adminApi.purgePhoto(photo.id);
      onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to purge photo.');
    } finally {
      setBusy('');
    }
  };

  return (
    <article className={`photo-row ${photo.deleted ? 'is-deleted' : ''}`}>
      <img alt="" className="photo-thumb" loading="lazy" src={photo.variants.thumb} />

      <div className="photo-fields">
        <div className="field-grid">
          <label>
            <span>Title</span>
            <input
              onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })}
              value={draft.title}
            />
          </label>
          <label>
            <span>Order</span>
            <input
              inputMode="numeric"
              onChange={(event) => setDraft({ ...draft, order: event.currentTarget.value })}
              type="number"
              value={draft.order}
            />
          </label>
          <label>
            <span>Album</span>
            <input
              onChange={(event) => setDraft({ ...draft, album: event.currentTarget.value })}
              value={draft.album}
            />
          </label>
          <label>
            <span>Tags</span>
            <input onChange={(event) => setDraft({ ...draft, tags: event.currentTarget.value })} value={draft.tags} />
          </label>
        </div>

        <label>
          <span>Description</span>
          <textarea
            onChange={(event) => setDraft({ ...draft, description: event.currentTarget.value })}
            rows={3}
            value={draft.description}
          />
        </label>

        <div className="photo-meta">
          <span>{photo.width} x {photo.height}</span>
          <span>{photo.id}</span>
          {photo.deleted && <strong>Deleted</strong>}
        </div>

        {error && <p className="row-error">{error}</p>}

        <div className="row-actions">
          <button disabled={Boolean(busy)} onClick={() => void save()} type="button">
            {busy === 'save' ? 'Saving' : 'Save'}
          </button>
          {photo.deleted ? (
            <>
              <button disabled={Boolean(busy)} onClick={() => void restore()} type="button">
                {busy === 'restore' ? 'Restoring' : 'Restore'}
              </button>
              <button className="danger" disabled={Boolean(busy)} onClick={() => void purge()} type="button">
                {busy === 'purge' ? 'Purging' : 'Purge'}
              </button>
            </>
          ) : (
            <button disabled={Boolean(busy)} onClick={() => void softDelete()} type="button">
              {busy === 'delete' ? 'Deleting' : 'Soft Delete'}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function draftFromPhoto(photo: PhotoEntry) {
  return {
    title: photo.title,
    description: photo.description,
    album: photo.album,
    order: String(photo.order),
    tags: photo.tags.join(', ')
  };
}
