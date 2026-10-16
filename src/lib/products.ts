import { getCollection } from 'astro:content';

type LocalProductEntry = Awaited<ReturnType<typeof getCollection<'products'>>>[number];

export interface ProductRecord {
  source: 'local';
  slug: string;
  data: LocalProductEntry['data'];
  entry: LocalProductEntry;
}

export async function getProducts(): Promise<ProductRecord[]> {
  const entries = await getCollection('products');
  const slugs = new Set<string>();

  for (const product of entries) {
    if (slugs.has(product.slug)) {
      throw new Error(`商品 slug 重复：${product.slug}`);
    }
    slugs.add(product.slug);
  }

  return entries
    .map((entry) => ({
      source: 'local' as const,
      slug: entry.slug,
      data: entry.data,
      entry,
    }))
    .sort(
      (left, right) => Number(right.data.recommended) - Number(left.data.recommended)
    );
}

export function getProductImageUrl(src: string, baseUrl: string) {
  if (/^https:\/\//i.test(src)) return src;

  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const path = src.replace(/^\/+/, '');
  const basePath = base.replace(/^\/+/, '');

  return path.startsWith(basePath) ? `/${path}` : `${base}${path}`;
}
