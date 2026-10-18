import { useEffect, useRef } from 'react';
import { DitherGradient } from '../components/grim-dither-kit/gradient';
import { heroDitherPresets, type HeroDitherVariant } from './hero-dither';

/** Two prepainted Grim gradients drift and crossfade over the original image. */
export function HeroDither({ variant, className }: {
  variant: HeroDitherVariant;
  className?: string;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const overlay = overlayRef.current;
    const hero = overlay?.closest('.hero');
    if (!overlay || !hero) return;
    let visible = false;
    let covered = false;
    const sync = () => overlay.toggleAttribute('data-paused', document.hidden || !visible || covered);
    const viewportObserver = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? false;
      sync();
    });
    viewportObserver.observe(hero);

    // The sticky hero still intersects the viewport behind the opaque sheet.
    // Observe a one-pixel strip at the top to detect when that sheet covers it.
    const foreground = hero.parentElement?.querySelector('.page-sections');
    let coverObserver: IntersectionObserver | undefined;
    const watchCover = () => {
      coverObserver?.disconnect();
      if (!foreground) return;
      coverObserver = new IntersectionObserver((entries) => {
        covered = entries[0]?.isIntersecting ?? false;
        sync();
      }, { rootMargin: '0px 0px -' + Math.max(0, window.innerHeight - 1) + 'px 0px' });
      coverObserver.observe(foreground);
    };
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('resize', watchCover);
    watchCover();
    sync();

    return () => {
      viewportObserver.disconnect();
      coverObserver?.disconnect();
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('resize', watchCover);
    };
  }, []);

  return (
    <div ref={overlayRef} className={className} data-animated={variant === 'bottom' || undefined} aria-hidden="true">
      <div className="hero-dither-pattern hero-dither-pattern-primary">
        {heroDitherPresets[variant].layers.map((layer, index) => (
          <DitherGradient key={index} {...layer} />
        ))}
      </div>
      {variant === 'bottom' && heroDitherPresets.bottom.layers.map((layer, index) => (
        <div key={index} className="hero-dither-pattern hero-dither-pattern-secondary">
          <DitherGradient {...layer} />
        </div>
      ))}
    </div>
  );
}
