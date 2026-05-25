import { useEffect, useMemo, useState } from 'react';
import { fetchGallery, type GalleryPhoto } from '../../lib/public-data';

export function PublicGallery() {
  const [photos, setPhotos] = useState<GalleryPhoto[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const activePhoto = activeIndex === null ? null : photos[activeIndex] ?? null;

  useEffect(() => {
    let mounted = true;

    fetchGallery()
      .then((gallery) => {
        if (!mounted) {
          return;
        }

        setPhotos(gallery.photos);
        const photoId = photoIdFromLocation();
        if (photoId) {
          const index = gallery.photos.findIndex((photo) => photo.id === photoId);
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
      const photoId = photoIdFromLocation();
      if (!photoId) {
        setActiveIndex(null);
        return;
      }

      const index = photos.findIndex((photo) => photo.id === photoId);
      setActiveIndex(index >= 0 ? index : null);
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [photos]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (activeIndex === null) {
        return;
      }

      if (event.key === 'Escape') {
        closeLightbox();
      } else if (event.key === 'ArrowRight') {
        step(1);
      } else if (event.key === 'ArrowLeft') {
        step(-1);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeIndex, photos.length]);

  useEffect(() => {
    document.body.classList.toggle('has-lightbox', activeIndex !== null);
    return () => document.body.classList.remove('has-lightbox');
  }, [activeIndex]);

  const groupedTags = useMemo(() => {
    const tags = new Set<string>();
    photos.forEach((photo) => photo.tags.forEach((tag) => tags.add(tag)));
    return Array.from(tags).slice(0, 8);
  }, [photos]);

  const openLightbox = (index: number) => {
    setActiveIndex(index);
    const photo = photos[index];
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
      const next = nextIndex(current, photos.length, direction);
      const photo = next === null ? null : photos[next];
      if (photo) {
        window.history.replaceState({ galleryLightbox: true }, '', photoUrl(photo.id));
      }
      return next;
    });
  };

  return (
    <>
      <section className="gallery-tools" aria-label="Gallery summary">
        <p>{loading ? 'Loading gallery' : `${photos.length} selected ${photos.length === 1 ? 'work' : 'works'}`}</p>
        {groupedTags.length > 0 && (
          <div aria-label="Tags">
            {groupedTags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
        )}
      </section>

      <section className="gallery-grid" aria-label="Photo gallery">
        {photos.map((photo, index) => (
          <button className="gallery-card" key={photo.id} onClick={() => openLightbox(index)} type="button">
            <img
              alt={photo.title}
              loading="lazy"
              src={photo.variants.thumb}
              srcSet={`${photo.variants.thumb} 1x, ${photo.variants.medium} 2x`}
            />
            <span>
              <strong>{photo.title}</strong>
              {photo.description && <em>{photo.description}</em>}
            </span>
          </button>
        ))}
        {!loading && photos.length === 0 && (
          <p className="gallery-empty">The first public gallery edit is coming soon.</p>
        )}
      </section>

      {activePhoto && (
        <div className="lightbox" onMouseDown={closeLightbox} role="dialog" aria-modal="true" aria-label={activePhoto.title}>
          <button
            className="lightbox-close"
            onClick={closeLightbox}
            onMouseDown={(event) => event.stopPropagation()}
            type="button"
            aria-label="Close"
          >
            X
          </button>
          <button
            className="lightbox-nav is-prev"
            onClick={(event) => { event.stopPropagation(); step(-1); }}
            onMouseDown={(event) => event.stopPropagation()}
            type="button"
            aria-label="Previous photo"
          >
            &lt;
          </button>
          <figure onMouseDown={(event) => event.stopPropagation()}>
            <img alt={activePhoto.title} src={activePhoto.variants.medium} />
            <figcaption>
              <span>
                <strong>{activePhoto.title}</strong>
                {activePhoto.description && <em>{activePhoto.description}</em>}
              </span>
              <a href={activePhoto.variants.full} download>
                Download
              </a>
            </figcaption>
          </figure>
          <button
            className="lightbox-nav is-next"
            onClick={(event) => { event.stopPropagation(); step(1); }}
            onMouseDown={(event) => event.stopPropagation()}
            type="button"
            aria-label="Next photo"
          >
            &gt;
          </button>
        </div>
      )}
    </>
  );
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
