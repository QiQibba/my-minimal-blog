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

export type ProductDraftContent = {
  name: string;
  category: string;
  summary: string;
  image?: {
    src: string;
    alt: string;
  };
  specs: Array<{
    label: string;
    value: string;
  }>;
  features: string[];
  recommended: boolean;
  contact: {
    label: string;
    page: 'contact';
  };
  sample: boolean;
  detail: string;
};

export type ContentDraft = {
  id: string;
  content_type: 'product';
  title: string;
  slug: string;
  content_json: Record<string, unknown>;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  published_commit: string | null;
};

export type ProductDraftInput = {
  content_type: 'product';
  title: string;
  slug: string;
  content_json: ProductDraftContent;
};

const CONTENT_API_BASE_URL = 'https://qiqibba-content-api.yxyx5267.workers.dev';
const DRAFTS_API_PATH = '/api/admin/drafts';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

export class DraftApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'DraftApiError';
  }
}

async function requestDraftApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      signal: AbortSignal.timeout(8000),
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new DraftApiError('草稿 API 网络请求失败，请检查连接后重试。', 0);
  }

  const contentType = response.headers.get('Content-Type') ?? '';
  if (response.redirected && /\/cdn-cgi\/access\/login(?:\/|$|\?)/.test(response.url)) {
    throw new DraftApiError('Cloudflare Access 登录已失效，请重新登录后再试。', 401);
  }
  if (!contentType.toLowerCase().includes('application/json')) {
    if (response.status === 401 || response.status === 403) {
      throw new DraftApiError(
        response.status === 401
          ? '尚未通过 Cloudflare Access 登录，请登录后重试。'
          : '当前账号没有管理草稿的权限。',
        response.status,
      );
    }
    throw new DraftApiError('草稿 API 返回了非 JSON 响应，请确认登录状态和 API 路由配置。', response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new DraftApiError('草稿 API 返回了无效 JSON。', response.status);
  }

  if (!response.ok) {
    const error =
      typeof payload === 'object' && payload !== null && 'error' in payload
        ? payload.error
        : undefined;
    const code =
      typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined;
    const message =
      typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
        ? error.message
        : `草稿 API 请求失败（HTTP ${response.status}）。`;

    throw new DraftApiError(message, response.status, code);
  }

  return payload as T;
}

function isContentDraft(value: unknown): value is ContentDraft {
  if (!isRecord(value)) return false;
  const draft = value;
  return (
    typeof draft.id === 'string' &&
    draft.content_type === 'product' &&
    typeof draft.title === 'string' &&
    typeof draft.slug === 'string' &&
    isRecord(draft.content_json) &&
    typeof draft.status === 'string' &&
    typeof draft.created_by === 'string' &&
    typeof draft.created_at === 'string' &&
    typeof draft.updated_at === 'string' &&
    (typeof draft.published_at === 'string' || draft.published_at === null) &&
    (typeof draft.published_commit === 'string' || draft.published_commit === null)
  );
}

function requireDraft(value: unknown): ContentDraft {
  if (!isContentDraft(value)) {
    throw new DraftApiError('草稿 API 返回的数据格式无效。', 502);
  }
  return value;
}

export async function getProductDrafts(): Promise<ContentDraft[]> {
  const payload = await requestDraftApi<{ drafts?: unknown }>(DRAFTS_API_PATH);
  if (!isRecord(payload) || !Array.isArray(payload.drafts)) {
    throw new DraftApiError('草稿 API 列表响应格式无效。', 502);
  }
  return payload.drafts.map(requireDraft);
}

export async function getProductDraft(id: string): Promise<ContentDraft> {
  const payload = await requestDraftApi<unknown>(
    `${DRAFTS_API_PATH}/${encodeURIComponent(id)}`,
  );
  return requireDraft(isRecord(payload) ? payload.draft : undefined);
}

export async function getProductDraftPreview(id: string): Promise<ContentDraft> {
  const payload = await requestDraftApi<unknown>(
    `${DRAFTS_API_PATH}/${encodeURIComponent(id)}/preview`,
  );
  return requireDraft(isRecord(payload) ? payload.draft : undefined);
}

export async function createProductDraft(input: ProductDraftInput): Promise<ContentDraft> {
  const payload = await requestDraftApi<unknown>(DRAFTS_API_PATH, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return requireDraft(isRecord(payload) ? payload.draft : undefined);
}

export async function updateProductDraft(
  id: string,
  input: ProductDraftInput,
): Promise<ContentDraft> {
  const payload = await requestDraftApi<unknown>(
    `${DRAFTS_API_PATH}/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      body: JSON.stringify(input),
    },
  );
  return requireDraft(isRecord(payload) ? payload.draft : undefined);
}

export async function deleteProductDraft(id: string): Promise<void> {
  const payload = await requestDraftApi<unknown>(
    `${DRAFTS_API_PATH}/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
  if (!isRecord(payload) || payload.deleted !== true || payload.id !== id) {
    throw new DraftApiError('草稿 API 删除响应格式无效。', 502);
  }
}
