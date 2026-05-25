import { useEffect, useRef, useState } from 'react';
import { TransformComponent, TransformWrapper } from 'react-zoom-pan-pinch';
import type { GalleryPhoto } from '../../lib/public-data';

interface LightboxProps {
  photo: GalleryPhoto;
  onClose: () => void;
  onNext: () => void;
  onPrev: () => void;
}

export function Lightbox({ photo, onClose, onNext, onPrev }: LightboxProps) {
  const [highResSrc, setHighResSrc] = useState<string | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isZoomed, setIsZoomed] = useState(false);
  const idleTimer = useRef<number | null>(null);

  useEffect(() => {
    setHighResSrc(null);
    setIsZoomed(false);
    const preload = new Image();
    preload.onload = () => setHighResSrc(photo.variants.full);
    preload.src = photo.variants.full;

    return () => {
      preload.onload = null;
    };
  }, [photo.id, photo.variants.full]);

  useEffect(() => {
    const isTouchOnly = window.matchMedia('(hover: none)').matches;
    if (isTouchOnly) {
      setControlsVisible(true);
      return;
    }

    const showAndScheduleHide = () => {
      setControlsVisible(true);
      if (idleTimer.current !== null) {
        window.clearTimeout(idleTimer.current);
      }
      idleTimer.current = window.setTimeout(() => setControlsVisible(false), 1500);
    };

    window.addEventListener('mousemove', showAndScheduleHide);
    window.addEventListener('focusin', showAndScheduleHide);
    window.addEventListener('keydown', showAndScheduleHide);
    showAndScheduleHide();

    return () => {
      window.removeEventListener('mousemove', showAndScheduleHide);
      window.removeEventListener('focusin', showAndScheduleHide);
      window.removeEventListener('keydown', showAndScheduleHide);
      if (idleTimer.current !== null) {
        window.clearTimeout(idleTimer.current);
      }
    };
  }, [photo.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      } else if (event.key === 'ArrowRight') {
        onNext();
      } else if (event.key === 'ArrowLeft') {
        onPrev();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, onNext, onPrev]);

  const visibleSrc = highResSrc ?? photo.variants.medium;

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={photo.title}>
      <TransformWrapper
        centerOnInit
        alignmentAnimation={{ disabled: true }}
        centerZoomedOut={false}
        doubleClick={{ mode: 'reset', step: 0.5 }}
        initialScale={1}
        key={photo.id}
        maxScale={8}
        minScale={1}
        onTransform={(_, state) => setIsZoomed(state.scale > 1.001)}
        pinch={{ step: 5 }}
        velocityAnimation={{ disabled: false }}
        wheel={{ step: 0.1, smoothStep: 0.001 }}
      >
        <TransformComponent
          wrapperClass={isZoomed ? 'lightbox-canvas is-zoomed' : 'lightbox-canvas'}
          contentClass="lightbox-canvas-content"
        >
          <img
            alt={photo.title}
            draggable={false}
            height={photo.height}
            src={visibleSrc}
            width={photo.width}
          />
        </TransformComponent>
      </TransformWrapper>

      <button className="lightbox-close" onClick={onClose} type="button" aria-label="Close">
        <CloseIcon />
      </button>

      <div className={controlsVisible ? 'lightbox-controls' : 'lightbox-controls is-hidden'} aria-hidden={!controlsVisible}>
        <button className="lightbox-nav is-prev" onClick={onPrev} type="button" aria-label="Previous photo">
          <ChevronLeftIcon />
        </button>
        <button className="lightbox-nav is-next" onClick={onNext} type="button" aria-label="Next photo">
          <ChevronRightIcon />
        </button>
        <a className="lightbox-download" href={photo.variants.full} download aria-label="Download full-size image">
          <DownloadIcon />
        </a>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M15 5 8 12l7 7" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg aria-hidden="true" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}
