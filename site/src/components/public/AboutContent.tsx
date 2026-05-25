import { useEffect, useState } from 'react';
import { defaultSiteConfig, fetchSiteConfig, type SiteConfig } from '../../lib/public-data';

export function AboutContent() {
  const [site, setSite] = useState<SiteConfig>(defaultSiteConfig);

  useEffect(() => {
    void fetchSiteConfig().then(setSite);
  }, []);

  return (
    <section className="content-panel" aria-labelledby="about-title">
      <p className="eyebrow">{site.tagline}</p>
      <h1 id="about-title">About {site.name}</h1>
      <div className="prose" dangerouslySetInnerHTML={{ __html: site.bio }} />
      {site.social.length > 0 && (
        <div className="text-links" aria-label="Social links">
          {site.social.map((link) => (
            <a href={link.url} key={`${link.platform}-${link.url}`} rel="noreferrer" target="_blank">
              {link.platform}
            </a>
          ))}
        </div>
      )}
    </section>
  );
}
