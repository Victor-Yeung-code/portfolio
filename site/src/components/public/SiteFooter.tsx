import { useEffect, useState } from 'react';
import { defaultSiteConfig, fetchSiteConfig, type SiteConfig } from '../../lib/public-data';

export function SiteFooter() {
  const [site, setSite] = useState<SiteConfig>(defaultSiteConfig);

  useEffect(() => {
    void fetchSiteConfig().then(setSite);
  }, []);

  return (
    <div className="footer-inner">
      <p>{site.footer}</p>
      {site.social.length > 0 && (
        <nav aria-label="Social links">
          {site.social.map((link) => (
            <a href={link.url} key={`${link.platform}-${link.url}`} rel="noreferrer" target="_blank">
              {link.platform}
            </a>
          ))}
        </nav>
      )}
    </div>
  );
}
