import { useCallback, useEffect, useMemo, useState } from 'react';
import { adminApi } from './api';
import { PhotoList } from './PhotoList';
import { PhotoUpload } from './PhotoUpload';
import { RepublishPanel } from './RepublishPanel';
import { SiteConfigPanel } from './SiteConfigPanel';
import type { PhotosJson, SiteConfig, WatermarkResponse } from './types';
import { WatermarkConfigPanel } from './WatermarkConfig';
import './admin.css';

type AdminTab = 'photos' | 'watermark' | 'site' | 'republish';

const emptyPhotos: PhotosJson = {
  version: 0,
  updatedAt: new Date(0).toISOString(),
  photos: []
};

const emptySite: SiteConfig = {
  name: 'Victor Yeung',
  tagline: 'Art & Photography',
  bio: '',
  social: [],
  footer: 'Copyright 2026 Victor Yeung'
};

const tabs: Array<{ id: AdminTab; label: string }> = [
  { id: 'photos', label: 'Photos' },
  { id: 'watermark', label: 'Watermark' },
  { id: 'site', label: 'Site Info' },
  { id: 'republish', label: 'Republish' }
];

export default function AdminApp() {
  const [activeTab, setActiveTab] = useState<AdminTab>('photos');
  const [photos, setPhotos] = useState<PhotosJson>(emptyPhotos);
  const [watermark, setWatermark] = useState<WatermarkResponse>({ config: null });
  const [site, setSite] = useState<SiteConfig>(emptySite);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const visibleCount = useMemo(() => photos.photos.filter((photo) => !photo.deleted).length, [photos.photos]);
  const deletedCount = photos.photos.length - visibleCount;

  const refresh = useCallback(async () => {
    setError('');
    const [nextPhotos, nextWatermark, nextSite] = await Promise.all([
      adminApi.getPhotos(),
      adminApi.getWatermark(),
      adminApi.getSite()
    ]);
    setPhotos(nextPhotos);
    setWatermark(nextWatermark);
    setSite(nextSite);
  }, []);

  useEffect(() => {
    refresh()
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Unable to load admin data.'))
      .finally(() => setLoading(false));
  }, [refresh]);

  const refreshAfterUpload = async (ids: string[]) => {
    setNotice(ids.length === 1 ? 'Upload received. Processing image.' : `${ids.length} uploads received. Processing images.`);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await delay(attempt === 0 ? 1400 : 2500);
      const nextPhotos = await adminApi.getPhotos();
      setPhotos(nextPhotos);

      if (ids.every((id) => nextPhotos.photos.some((photo) => photo.id === id))) {
        setNotice(ids.length === 1 ? 'Photo is ready.' : 'Photos are ready.');
        return;
      }
    }

    setNotice('Upload finished. Processing is still running.');
  };

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div>
          <p className="admin-eyebrow">Victor Yeung</p>
          <h1>Portfolio Admin</h1>
        </div>

        <dl className="admin-stats" aria-label="Gallery status">
          <div>
            <dt>Live</dt>
            <dd>{visibleCount}</dd>
          </div>
          <div>
            <dt>Deleted</dt>
            <dd>{deletedCount}</dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>{photos.version}</dd>
          </div>
        </dl>
      </header>

      <nav className="admin-tabs" aria-label="Admin sections">
        {tabs.map((tab) => (
          <button
            className={activeTab === tab.id ? 'is-active' : ''}
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {(loading || notice || error) && (
        <div className={`admin-status ${error ? 'is-error' : ''}`} role="status">
          {error || notice || 'Loading admin data'}
        </div>
      )}

      {activeTab === 'photos' && (
        <section className="admin-section" aria-labelledby="photos-heading">
          <div className="section-heading">
            <h2 id="photos-heading">Photos</h2>
            <button type="button" onClick={() => void refresh()}>
              Refresh
            </button>
          </div>
          <PhotoUpload onUploaded={(ids) => void refreshAfterUpload(ids)} onError={setError} />
          <PhotoList
            photos={photos.photos}
            onChanged={(photo) =>
              setPhotos((current) => ({
                ...current,
                photos: current.photos.map((entry) => (entry.id === photo.id ? photo : entry))
              }))
            }
            onRefresh={() => void refresh()}
          />
        </section>
      )}

      {activeTab === 'watermark' && (
        <section className="admin-section" aria-labelledby="watermark-heading">
          <div className="section-heading">
            <h2 id="watermark-heading">Watermark</h2>
          </div>
          <WatermarkConfigPanel
            response={watermark}
            onChanged={(next) => {
              setWatermark(next);
              setNotice('Watermark saved. Republish existing photos to apply it.');
            }}
            onError={setError}
          />
        </section>
      )}

      {activeTab === 'site' && (
        <section className="admin-section" aria-labelledby="site-heading">
          <div className="section-heading">
            <h2 id="site-heading">Site Info</h2>
          </div>
          <SiteConfigPanel
            site={site}
            onChanged={(next) => {
              setSite(next);
              setNotice('Site info saved. Public pages will refresh shortly.');
            }}
            onError={setError}
          />
        </section>
      )}

      {activeTab === 'republish' && (
        <section className="admin-section" aria-labelledby="republish-heading">
          <div className="section-heading">
            <h2 id="republish-heading">Republish</h2>
          </div>
          <RepublishPanel
            onError={setError}
            onDone={() =>
              setNotice('Republish finished. CloudFront cache refresh has started and may take a minute to show everywhere.')
            }
          />
        </section>
      )}
    </main>
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
