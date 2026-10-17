export type ContentApiRecord = Record<string, string | boolean> & {
  slug: string;
};

export type ContentApiProduct = ContentApiRecord & {
  name: string;
  category: string;
  summary: string;
  imageSrc: string;
  imageAlt: string;
  specs: string;
  features: string;
  recommended: boolean;
  contactLabel: string;
  detail: string;
};

const CONTENT_API_BASE_URL = 'https://qiqibba-content-api.yxyx5267.workers.dev';

const productStringFields = [
  'slug',
  'name',
  'category',
  'summary',
  'imageSrc',
  'imageAlt',
  'specs',
  'features',
  'contactLabel',
  'detail',
] as const;

function isContentApiProduct(value: unknown): value is ContentApiProduct {
  if (typeof value !== 'object' || value === null) return false;

  const item = value as Record<string, unknown>;
  return (
    productStringFields.every((field) => typeof item[field] === 'string') &&
    typeof item.recommended === 'boolean'
  );
}

function getContentApiUrl(path: string): URL {
  const normalizedBaseUrl = `${CONTENT_API_BASE_URL.replace(/\/+$/, '')}/`;
  return new URL(path.replace(/^\/+/, ''), normalizedBaseUrl);
}

export async function getContentApiText(path = ''): Promise<string> {
  const url = getContentApiUrl(path);
  let response: Response;

  try {
    response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : '未知网络错误';
    throw new Error(`Content API ${url.pathname} 网络请求失败：${reason}`);
  }

  if (!response.ok) {
    throw new Error(`Content API ${url.pathname} 请求失败：HTTP ${response.status}`);
  }

  return response.text();
}

export async function getContentApiProducts(): Promise<ContentApiProduct[]> {
  const responseText = await getContentApiText('/api/content/products');
  let payload: unknown;

  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error('Content API 商品列表响应不是有效 JSON。');
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('products' in payload) ||
    !Array.isArray(payload.products)
  ) {
    throw new Error('Content API 商品列表响应格式无效。');
  }

  return payload.products.map((product, index) => {
    if (!isContentApiProduct(product)) {
      throw new Error(`Content API 商品列表第 ${index + 1} 项字段格式无效。`);
    }

    return product;
  });
}
