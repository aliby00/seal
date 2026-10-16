import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/site';

/** The legal pages join once they are out of draft. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: new URL('/', siteUrl()).toString(), changeFrequency: 'weekly', priority: 1 }];
}
