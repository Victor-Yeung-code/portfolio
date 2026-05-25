import { useEffect, useMemo, useState } from 'react';
import { fetchGallery, type GalleryPhoto } from '../../lib/public-data';
import { slugify } from '../../lib/slug';
import { Lightbox } from './Lightbox';

type AlbumOption = [slug: string, label: string];

export function PublicGallery() {
  const [photos, setPhotos] = useState<GalleryPhoto[]>([]);
  const [activeAlbum, setActiveAlbum] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const albums = useMemo(() => extractAlbums(photos), [photos]);
  const activeAlbumName = activeAlbum ? albums.find(([slug]) => slug === activeAlbum)?.[1] ?? activeAlbum : null;
  const filteredPhotos = useMemo(() => {
    if (!activeAlbum) {
      return photos;
    }

    return photos.filter((photo) => slugify(photo.album) === activeAlbum);
  }, [activeAlbum, photos]);
  const activePhoto = activeIndex === null ? null : filteredPhotos[activeIndex] ?? null;

  useEffect(() => {
    let mounted = true;

    fetchGallery()
      .then((gallery) => {
        if (!mounted) {
          return;
        }

        const nextAlbum = albumSlugFromLocation();
        const nextPhotos = nextAlbum
          ? gallery.photos.filter((photo) => slugify(photo.album) === nextAlbum)
          : gallery.photos;

        setPhotos(gallery.photos);
        setActiveAlbum(nextAlbum);

        const photoId = photoIdFromLocation();
        if (photoId) {
          const index = nextPhotos.findIndex((photo) => photo.id === photoId);
          if (index >= 0) {
            setActiveIndex(index);
            if (photoIdFromHash()) {
              window.history.replaceState(window.history.state, '', photoUrl(photoId));
            }
          }
        }
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const nextAlbum = albumSlugFromLocation();
      const nextPhotos = nextAlbum ? photos.filter((photo) => slugify(photo.album) === nextAlbum) : photos;
      const photoId = photoIdFromLocation();

      setActiveAlbum(nextAlbum);
      if (!photoId) {
        setActiveIndex(null);
        return;
      }

      const index = nextPhotos.findIndex((photo) => photo.id === photoId);
      setActiveIndex(index >= 0 ? index : null);
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [photos]);

  useEffect(() => {
    document.body.classList.toggle('has-lightbox', activeIndex !== null);
    return () => document.body.classList.remove('has-lightbox');
  }, [activeIndex]);

  useEffect(() => {
    document.title = activeAlbumName ? `${activeAlbumName} | Victor Yeung` : 'Victor Yeung | Photography Portfolio';
  }, [activeAlbumName]);

  const openLightbox = (index: number) => {
    setActiveIndex(index);
    const photo = filteredPhotos[index];
    if (photo) {
      window.history.pushState({ galleryLightbox: true }, '', photoUrl(photo.id));
    }
  };

  const closeLightbox = () => {
    if (window.history.state?.galleryLightbox) {
      window.history.back();
      return;
    }

    setActiveIndex(null);
    if (photoIdFromLocation()) {
      window.history.replaceState(window.history.state, '', galleryUrl());
    }
  };

  const step = (direction: 1 | -1) => {
    setActiveIndex((current) => {
      const next = nextIndex(current, filteredPhotos.length, direction);
      const photo = next === null ? null : filteredPhotos[next];
      if (photo) {
        window.history.replaceState({ galleryLightbox: true }, '', photoUrl(photo.id));
      }
      return next;
    });
  };

  return (
    <>
      <section className="gallery-tools" aria-label="Gallery summary">
        <p>
          {loading
            ? 'Loading gallery'
            : `${filteredPhotos.length} selected ${filteredPhotos.length === 1 ? 'work' : 'works'}`}
        </p>
        {activeAlbumName && <strong>{activeAlbumName}</strong>}
      </section>

      <section className="gallery-grid" aria-label="Photo gallery">
        {filteredPhotos.map((photo, index) => (
          <button
            aria-label={photo.title || photo.id}
            className="gallery-card"
            key={photo.id}
            onClick={() => openLightbox(index)}
            type="button"
          >
            <img
              alt={photo.title}
              height={photo.height}
              loading="lazy"
              src={photo.variants.thumb}
              srcSet={`${photo.variants.thumb} 1x, ${photo.variants.medium} 2x`}
              width={photo.width}
            />
          </button>
        ))}
        {!loading && filteredPhotos.length === 0 && (
          <p className="gallery-empty">
            {activeAlbum ? 'No photos in this album yet.' : 'The first public gallery edit is coming soon.'}
          </p>
        )}
      </section>

      {activePhoto && (
        <Lightbox photo={activePhoto} onClose={closeLightbox} onNext={() => step(1)} onPrev={() => step(-1)} />
      )}
    </>
  );
}

function extractAlbums(photos: GalleryPhoto[]): AlbumOption[] {
  const labels = new Map<string, string>();

  for (const photo of photos) {
    const label = photo.album.trim();
    const slug = slugify(label);
    if (slug && !labels.has(slug)) {
      labels.set(slug, label);
    }
  }

  return Array.from(labels.entries()).sort(([, left], [, right]) => left.localeCompare(right));
}

function albumSlugFromLocation(): string | null {
  const slug = new URLSearchParams(window.location.search).get('album');
  return slug ? slug.toLowerCase() : null;
}

function photoIdFromLocation(): string | null {
  const queryId = new URLSearchParams(window.location.search).get('photo');
  if (queryId) {
    return queryId;
  }

  return photoIdFromHash();
}

function photoIdFromHash(): string | null {
  const hash = window.location.hash;
  return hash.startsWith('#photo-') ? decodeURIComponent(hash.slice('#photo-'.length)) : null;
}

function photoUrl(photoId: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set('photo', photoId);
  url.hash = '';
  return `${url.pathname}${url.search}`;
}

function galleryUrl(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete('photo');
  url.hash = '';
  return `${url.pathname}${url.search}`;
}

function nextIndex(current: number | null, total: number, direction: 1 | -1): number | null {
  if (current === null || total === 0) {
    return current;
  }

  return (current + direction + total) % total;
}
