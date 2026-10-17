import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  const page = (path: string) => new URL(path, siteUrl()).toString();
  return [
    { url: page('/'), changeFrequency: 'weekly', priority: 1 },
    ...['/terms', '/privacy', '/disclaimer'].map((path) => ({
      url: page(path),
      changeFrequency: 'yearly' as const,
      priority: 0.2,
    })),
  ];
}
