import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { fetchGallery } from '../../lib/public-data';
import { slugify } from '../../lib/slug';

type AlbumOption = [slug: string, label: string];

interface GalleryNavProps {
  currentPath: string;
}

export function GalleryNav({ currentPath }: GalleryNavProps) {
  const [albums, setAlbums] = useState<AlbumOption[]>([]);
  const [open, setOpen] = useState(false);
  const [activeAlbum, setActiveAlbum] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLAnchorElement | null>>([]);

  useEffect(() => {
    let mounted = true;
    fetchGallery().then((gallery) => {
      if (!mounted) {
        return;
      }

      setAlbums(extractAlbums(gallery.photos));
    });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const updateActiveAlbum = () => setActiveAlbum(albumFromLocation());
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    updateActiveAlbum();
    window.addEventListener('popstate', updateActiveAlbum);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('popstate', updateActiveAlbum);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, []);

  const items = useMemo<AlbumOption[]>(() => [['', 'All'], ...albums], [albums]);
  const activeItem = activeAlbum ?? '';

  const focusItem = (index: number) => {
    itemRefs.current[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const currentIndex = itemRefs.current.findIndex((item) => item === document.activeElement);

    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      focusItem(currentIndex >= 0 ? (currentIndex + 1) % items.length : 0);
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      focusItem(currentIndex >= 0 ? (currentIndex - 1 + items.length) % items.length : items.length - 1);
    }
  };

  return (
    <div className={open ? 'gallery-nav is-open' : 'gallery-nav'} onKeyDown={onKeyDown} ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className={activeItem || currentPath === '/' ? 'gallery-nav-button is-active' : 'gallery-nav-button'}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        Gallery
      </button>
      <div className="gallery-nav-menu" role="menu">
        {items.map(([slug, label], index) => (
          <a
            className={activeItem === slug ? 'is-active' : ''}
            href={slug ? `/?album=${encodeURIComponent(slug)}` : '/'}
            key={slug || 'all'}
            onClick={() => setOpen(false)}
            ref={(node) => {
              itemRefs.current[index] = node;
            }}
            role="menuitem"
          >
            {label}
          </a>
        ))}
      </div>
    </div>
  );
}

function extractAlbums(photos: Array<{ album: string }>): AlbumOption[] {
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

function albumFromLocation(): string | null {
  const slug = new URLSearchParams(window.location.search).get('album');
  return slug ? slug.toLowerCase() : null;
}
