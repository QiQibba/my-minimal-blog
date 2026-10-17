const ALLOWED_ORIGINS = new Set([
  "https://qiqibba.github.io",
  "https://9ik.cc",
  "https://cautious-fortnight-jr9q7p9j9grrcqp9q-4322.app.github.dev",
]);
const PRODUCTS_ENDPOINT = "/api/content/products";
const PRODUCTS_DIRECTORY = "src/content/products";
const ADMIN_API_PREFIX = "/api/admin/";
const ACCESS_ISSUER = "https://patient-art-8945.cloudflareaccess.com";
const ACCESS_CERTS_URL = `${ACCESS_ISSUER}/cdn-cgi/access/certs`;
const ADMIN_EMAIL = "136860199@qq.com";

function corsHeaders(origin) {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function decodeBase64Url(segment) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new ApiError(401, "invalid_access_token", "Access JWT 格式无效。");
  }

  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJwtJson(segment) {
  try {
    const bytes = decodeBase64Url(segment);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, "invalid_access_token", "Access JWT 格式无效。");
  }
}

async function verifyAdminAccess(request, env) {
  const audience = env.ACCESS_AUD?.trim();
  if (!audience) {
    throw new ApiError(
      503,
      "access_configuration_missing",
      "Worker 缺少 Cloudflare Access AUD 配置。"
    );
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    throw new ApiError(401, "access_token_missing", "缺少 Cloudflare Access JWT。");
  }

  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment === "")) {
    throw new ApiError(401, "invalid_access_token", "Access JWT 格式无效。");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  const header = decodeJwtJson(encodedHeader);
  const payload = decodeJwtJson(encodedPayload);

  if (
    !header ||
    typeof header !== "object" ||
    Array.isArray(header) ||
    header.alg !== "RS256" ||
    typeof header.kid !== "string" ||
    header.kid === "" ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new ApiError(401, "invalid_access_token", "Access JWT 头部或载荷无效。");
  }

  let certsResponse;
  try {
    certsResponse = await fetch(ACCESS_CERTS_URL);
  } catch {
    throw new ApiError(
      503,
      "access_verification_unavailable",
      "无法获取 Cloudflare Access 验证密钥。"
    );
  }

  if (!certsResponse.ok) {
    throw new ApiError(
      503,
      "access_verification_unavailable",
      "无法获取 Cloudflare Access 验证密钥。"
    );
  }

  let certs;
  try {
    certs = await certsResponse.json();
  } catch {
    throw new ApiError(
      503,
      "access_verification_unavailable",
      "Cloudflare Access 验证密钥响应无效。"
    );
  }

  const jwk = Array.isArray(certs?.keys)
    ? certs.keys.find((key) => key?.kid === header.kid)
    : undefined;

  if (
    !jwk ||
    jwk.kty !== "RSA" ||
    (jwk.alg !== undefined && jwk.alg !== "RS256") ||
    (jwk.use !== undefined && jwk.use !== "sig") ||
    (Array.isArray(jwk.key_ops) && !jwk.key_ops.includes("verify"))
  ) {
    throw new ApiError(401, "invalid_access_token", "Access JWT 签名密钥无效。");
  }

  let publicKey;
  let signatureValid;
  try {
    publicKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    signatureValid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      decodeBase64Url(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
    );
  } catch {
    throw new ApiError(401, "invalid_access_token", "Access JWT 签名验证失败。");
  }

  if (!signatureValid) {
    throw new ApiError(401, "invalid_access_token", "Access JWT 签名验证失败。");
  }

  const now = Math.floor(Date.now() / 1000);
  const tokenAudiences = typeof payload.aud === "string" ? [payload.aud] : payload.aud;

  if (
    payload.iss !== ACCESS_ISSUER ||
    !Array.isArray(tokenAudiences) ||
    !tokenAudiences.includes(audience) ||
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.exp) ||
    payload.exp <= now ||
    typeof payload.nbf !== "number" ||
    !Number.isFinite(payload.nbf) ||
    payload.nbf > now ||
    payload.email !== ADMIN_EMAIL
  ) {
    throw new ApiError(
      401,
      "access_token_not_authorized",
      "Cloudflare Access JWT 无效或未获授权。"
    );
  }
}

function jsonResponse(data, status = 200, origin = null) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
    ...corsHeaders(origin),
  };

  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(status, code, message, origin = null) {
  return jsonResponse({ error: { code, message } }, status, origin);
}

const DRAFTS_ENDPOINT = "/api/admin/drafts";
const MAX_DRAFT_REQUEST_BYTES = 64 * 1024;
const MAX_DRAFT_JSON_BYTES = 48 * 1024;

function adminCorsHeaders(origin) {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function adminJsonResponse(data, status = 200, origin = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Vary": "Origin",
      ...adminCorsHeaders(origin),
    },
  });
}

function adminErrorResponse(status, code, message, origin = null) {
  return adminJsonResponse({ error: { code, message } }, status, origin);
}

function requireDraftDatabase(env) {
  if (!env.DRAFTS_DB || typeof env.DRAFTS_DB.prepare !== "function") {
    throw new ApiError(
      503,
      "draft_storage_unavailable",
      "草稿数据库当前不可用。"
    );
  }
  return env.DRAFTS_DB;
}

async function readDraftJson(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new ApiError(415, "unsupported_media_type", "请求必须使用 application/json。");
  }

  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new ApiError(400, "invalid_content_length", "请求长度无效。");
    }
    if (Number(contentLength) > MAX_DRAFT_REQUEST_BYTES) {
      throw new ApiError(413, "request_too_large", "草稿请求超过允许的大小。");
    }
  }

  if (!request.body) {
    throw new ApiError(400, "invalid_json", "请求必须包含 JSON 内容。");
  }

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_DRAFT_REQUEST_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The request is already rejected; cancellation failure does not change its result.
        }
        throw new ApiError(413, "request_too_large", "草稿请求超过允许的大小。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let input;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError(400, "invalid_json", "请求 JSON 格式无效。");
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(400, "invalid_draft", "请求 JSON 顶层必须是对象。");
  }

  const allowedKeys = new Set(["content_type", "title", "slug", "content_json"]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new ApiError(400, "invalid_draft", "请求包含不支持的草稿字段。");
  }
  if (input.content_type !== "product") {
    throw new ApiError(400, "invalid_content_type", "content_type 目前只支持 product。");
  }
  if (typeof input.title !== "string" || input.title.trim().length === 0 || input.title.trim().length > 200) {
    throw new ApiError(400, "invalid_title", "title 必须是 1 到 200 个字符的非空字符串。");
  }
  if (typeof input.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug) || input.slug.length > 100) {
    throw new ApiError(400, "invalid_slug", "slug 必须是最多 100 个字符的小写字母、数字和连字符。");
  }
  if (
    !Object.hasOwn(input, "content_json") ||
    !input.content_json ||
    typeof input.content_json !== "object" ||
    Array.isArray(input.content_json)
  ) {
    throw new ApiError(400, "invalid_content_json", "content_json 必须是 JSON 对象。");
  }

  const serializedContent = JSON.stringify(input.content_json);
  if (new TextEncoder().encode(serializedContent).byteLength > MAX_DRAFT_JSON_BYTES) {
    throw new ApiError(413, "draft_content_too_large", "草稿内容超过允许的大小。");
  }

  return {
    content_type: input.content_type,
    title: input.title.trim(),
    slug: input.slug,
    content_json: serializedContent,
  };
}

function mapDraftRow(row) {
  let contentJson;
  try {
    contentJson = JSON.parse(row.content_json);
  } catch {
    throw new ApiError(500, "invalid_stored_draft", "草稿数据库中的内容格式无效。");
  }

  return { ...row, content_json: contentJson };
}

async function getDraftRow(db, id) {
  return db
    .prepare(
      "SELECT id, content_type, title, slug, content_json, status, created_by, created_at, updated_at, published_at, published_commit FROM content_drafts WHERE id = ? LIMIT 1"
    )
    .bind(id)
    .first();
}

async function requireEditableProductDraft(db, id) {
  const row = await getDraftRow(db, id);
  if (!row || row.content_type !== "product") {
    throw new ApiError(404, "draft_not_found", "草稿不存在。");
  }
  if (row.status !== "draft") {
    throw new ApiError(409, "draft_not_editable", "已发布或非草稿记录不能修改或删除。");
  }
  return row;
}

async function handleDraftRequest(request, env, origin, route) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Vary": "Origin",
        ...adminCorsHeaders(origin),
      },
    });
  }

  const db = requireDraftDatabase(env);

  if (route.kind === "collection") {
    if (request.method === "GET") {
      const result = await db
        .prepare(
          "SELECT id, content_type, title, slug, content_json, status, created_by, created_at, updated_at, published_at, published_commit FROM content_drafts WHERE content_type = ? AND status = ? ORDER BY updated_at DESC"
        )
        .bind("product", "draft")
        .all();
      if (result.success === false) {
        throw new Error("D1 草稿列表查询失败。");
      }
      return adminJsonResponse({ drafts: (result.results || []).map(mapDraftRow) }, 200, origin);
    }

    if (request.method === "POST") {
      const draft = await readDraftJson(request);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const result = await db
        .prepare(
          "INSERT INTO content_drafts (id, content_type, title, slug, content_json, status, created_by, created_at, updated_at, published_at, published_commit) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, NULL, NULL)"
        )
        .bind(id, draft.content_type, draft.title, draft.slug, draft.content_json, ADMIN_EMAIL, now, now)
        .run();
      if (result.success === false || result.meta?.changes !== 1) {
        throw new Error("D1 草稿创建失败。");
      }
      const created = await getDraftRow(db, id);
      if (!created) throw new Error("D1 创建草稿后未能读取记录。");
      return adminJsonResponse({ draft: mapDraftRow(created) }, 201, origin);
    }

    return adminErrorResponse(405, "method_not_allowed", "草稿列表仅支持 GET 和 POST 请求。", origin);
  }

  if (route.kind === "preview" || request.method === "GET") {
    if (request.method !== "GET") {
      return adminErrorResponse(405, "method_not_allowed", "草稿预览仅支持 GET 请求。", origin);
    }
    const row = await requireEditableProductDraft(db, route.id);
    return adminJsonResponse({ draft: mapDraftRow(row) }, 200, origin);
  }

  if (request.method === "PUT") {
    await requireEditableProductDraft(db, route.id);
    const draft = await readDraftJson(request);
    const result = await db
      .prepare(
        "UPDATE content_drafts SET title = ?, slug = ?, content_json = ?, updated_at = ? WHERE id = ? AND content_type = ? AND status = ?"
      )
      .bind(draft.title, draft.slug, draft.content_json, new Date().toISOString(), route.id, "product", "draft")
      .run();
    if (result.success === false) throw new Error("D1 草稿修改失败。");
    if (result.meta?.changes !== 1) {
      throw new ApiError(409, "draft_not_editable", "草稿已发布或已被修改，无法保存。");
    }
    const updated = await getDraftRow(db, route.id);
    if (!updated) throw new Error("D1 修改草稿后未能读取记录。");
    return adminJsonResponse({ draft: mapDraftRow(updated) }, 200, origin);
  }

  if (request.method === "DELETE") {
    await requireEditableProductDraft(db, route.id);
    const result = await db
      .prepare(
        "DELETE FROM content_drafts WHERE id = ? AND content_type = ? AND status = ?"
      )
      .bind(route.id, "product", "draft")
      .run();
    if (result.success === false) throw new Error("D1 草稿删除失败。");
    if (result.meta?.changes !== 1) {
      throw new ApiError(409, "draft_not_editable", "草稿已发布或已被修改，无法删除。");
    }
    return adminJsonResponse({ deleted: true, id: route.id }, 200, origin);
  }

  return adminErrorResponse(405, "method_not_allowed", "草稿仅支持 GET、PUT 和 DELETE 请求。", origin);
}

function stripYamlComment(line) {
  let quote = null;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (quote === '"' && char === "\\") {
      i += 1;
      continue;
    }

    if (quote === "'" && char === "'" && line[i + 1] === "'") {
      i += 1;
      continue;
    }

    if (quote === char) {
      quote = null;
      continue;
    }

    if (!quote && (char === '"' || char === "'")) {
      quote = char;
      continue;
    }

    if (!quote && char === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }

  return line;
}

function parseYamlScalar(raw, context) {
  const value = raw.trim();

  if (value === "[]") return [];
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;

  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== "string") throw new Error();
      return parsed;
    } catch {
      throw new Error(`${context} 的双引号字符串格式无效。`);
    }
  }

  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw new Error(`${context} 的单引号字符串格式无效。`);
    }

    return value.slice(1, -1).replace(/''/g, "'");
  }

  if (
    value.startsWith("[") ||
    value.endsWith("]") ||
    value.startsWith("{") ||
    value.endsWith("}")
  ) {
    throw new Error(`${context} 使用了当前解析器不支持的 YAML 内联结构。`);
  }

  if (/^(?:\||>)(?:[-+])?$/.test(value)) {
    throw new Error(`${context} 使用了当前解析器不支持的 YAML 块字符串。`);
  }

  return value;
}

function tokenizeYaml(source, filename) {
  const tokens = [];

  for (const originalLine of source.split(/\r?\n/)) {
    const line = stripYamlComment(originalLine);

    if (line.trim() === "") continue;
    if (line.includes("\t")) {
      throw new Error(`${filename} 的 frontmatter 不能使用 Tab 缩进。`);
    }

    const indent = line.length - line.trimStart().length;
    tokens.push({ indent, text: line.trim() });
  }

  return tokens;
}

function parseYamlMapping(tokens, start, indent, filename, context) {
  const result = {};
  let index = start;

  while (index < tokens.length && tokens[index].indent === indent) {
    const token = tokens[index];
    const match = token.text.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/);

    if (!match) {
      throw new Error(`${filename} 的 ${context} 字段格式无效。`);
    }

    const key = match[1];

    if (Object.hasOwn(result, key)) {
      throw new Error(`${filename} 的 ${context}.${key} 重复定义。`);
    }

    const rawValue = match[2] ?? "";
    index += 1;

    if (rawValue.trim() !== "") {
      result[key] = parseYamlScalar(rawValue, `${context}.${key}`);
      continue;
    }

    if (index < tokens.length && tokens[index].indent > indent) {
      const [nestedValue, nextIndex] = parseYamlBlock(
        tokens,
        index,
        tokens[index].indent,
        filename,
        `${context}.${key}`
      );
      result[key] = nestedValue;
      index = nextIndex;
    } else {
      result[key] = null;
    }
  }

  return [result, index];
}

function parseYamlSequence(tokens, start, indent, filename, context) {
  const result = [];
  let index = start;

  while (index < tokens.length && tokens[index].indent === indent) {
    const token = tokens[index];
    const match = token.text.match(/^-\s*(.*)$/);

    if (!match) {
      throw new Error(`${filename} 的 ${context} 列表格式无效。`);
    }

    const itemText = match[1];
    index += 1;

    if (itemText === "") {
      if (index >= tokens.length || tokens[index].indent <= indent) {
        result.push(null);
        continue;
      }

      const [item, nextIndex] = parseYamlBlock(
        tokens,
        index,
        tokens[index].indent,
        filename,
        context
      );
      result.push(item);
      index = nextIndex;
      continue;
    }

    const propertyMatch = itemText.match(
      /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/
    );

    if (!propertyMatch) {
      result.push(parseYamlScalar(itemText, context));

      if (index < tokens.length && tokens[index].indent > indent) {
        throw new Error(`${filename} 的 ${context} 标量列表项不能有子字段。`);
      }

      continue;
    }

    const item = {};
    const firstKey = propertyMatch[1];
    const firstValue = propertyMatch[2] ?? "";

    item[firstKey] = firstValue.trim()
      ? parseYamlScalar(firstValue, `${context}.${firstKey}`)
      : null;

    if (index < tokens.length && tokens[index].indent > indent) {
      const continuationIndent = tokens[index].indent;
      const [continuation, nextIndex] = parseYamlMapping(
        tokens,
        index,
        continuationIndent,
        filename,
        context
      );

      for (const [key, value] of Object.entries(continuation)) {
        if (Object.hasOwn(item, key)) {
          throw new Error(`${filename} 的 ${context}.${key} 重复定义。`);
        }
        item[key] = value;
      }

      index = nextIndex;
    }

    result.push(item);
  }

  return [result, index];
}

function parseYamlBlock(tokens, start, indent, filename, context) {
  if (tokens[start].text.startsWith("-")) {
    return parseYamlSequence(tokens, start, indent, filename, context);
  }

  return parseYamlMapping(tokens, start, indent, filename, context);
}

function parseFrontmatter(source, filename) {
  const match = source.match(
    /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/
  );

  if (!match) {
    throw new Error(`${filename} 缺少有效的 frontmatter 分隔符。`);
  }

  const tokens = tokenizeYaml(match[1], filename);
  const [data, nextIndex] = parseYamlMapping(tokens, 0, 0, filename, "frontmatter");

  if (nextIndex !== tokens.length) {
    throw new Error(`${filename} 的 frontmatter 缩进或结构无效。`);
  }

  return { data, body: match[2].trim() };
}

function requireString(value, field, filename) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${filename} 的 ${field} 必须是非空字符串。`);
  }

  return value.trim();
}

function validateAndMapProduct(data, filename) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${filename} 的 frontmatter 必须是对象。`);
  }

  const name = requireString(data.name, "name", filename);
  const category = requireString(data.category, "category", filename);
  const summary = requireString(data.summary, "summary", filename);

  let imageSrc = "";
  let imageAlt = "";

  if (data.image !== undefined) {
    if (!data.image || typeof data.image !== "object" || Array.isArray(data.image)) {
      throw new Error(`${filename} 的 image 必须是包含 src 和 alt 的对象。`);
    }

    imageSrc = requireString(data.image.src, "image.src", filename);
    imageAlt = requireString(data.image.alt, "image.alt", filename);

    const validImageSrc =
      /^\/(?:my-minimal-blog\/)?images\/products\/[^?#\s]+$/.test(imageSrc) ||
      /^https:\/\/\S+$/i.test(imageSrc);

    if (!validImageSrc) {
      throw new Error(`${filename} 的 image.src 不符合商品图片路径规则。`);
    }
  }

  const specs = data.specs === undefined ? [] : data.specs;
  if (!Array.isArray(specs)) {
    throw new Error(`${filename} 的 specs 必须是数组。`);
  }

  const normalizedSpecs = specs.map((spec, index) => {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      throw new Error(`${filename} 的 specs 第 ${index + 1} 项必须是对象。`);
    }

    return {
      label: requireString(spec.label, `specs[${index}].label`, filename),
      value: requireString(spec.value, `specs[${index}].value`, filename),
    };
  });

  const features = data.features === undefined ? [] : data.features;
  if (!Array.isArray(features)) {
    throw new Error(`${filename} 的 features 必须是数组。`);
  }

  const normalizedFeatures = features.map((feature, index) =>
    requireString(feature, `features[${index}]`, filename)
  );

  const recommended = data.recommended === undefined ? false : data.recommended;
  if (typeof recommended !== "boolean") {
    throw new Error(`${filename} 的 recommended 必须是布尔值。`);
  }

  const sample = data.sample === undefined ? false : data.sample;
  if (typeof sample !== "boolean") {
    throw new Error(`${filename} 的 sample 必须是布尔值。`);
  }

  const contact = data.contact === undefined ? {} : data.contact;
  if (!contact || typeof contact !== "object" || Array.isArray(contact)) {
    throw new Error(`${filename} 的 contact 必须是对象。`);
  }

  const contactLabel =
    contact.label === undefined
      ? "咨询客服"
      : requireString(contact.label, "contact.label", filename);

  const contactPage = contact.page === undefined ? "contact" : contact.page;
  if (contactPage !== "contact") {
    throw new Error(`${filename} 的 contact.page 必须是 "contact"。`);
  }

  return {
    name,
    category,
    summary,
    imageSrc,
    imageAlt,
    specs: normalizedSpecs.map(({ label, value }) => `${label}: ${value}`).join("\n"),
    features: normalizedFeatures.join("\n"),
    recommended,
    contactLabel,
    sample,
  };
}

function decodeGithubFile(content, filename) {
  try {
    const binary = atob(content.replace(/\s/g, ""));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ApiError(
      502,
      "invalid_github_file",
      `${filename} 的 GitHub 文件内容不是有效的 UTF-8 Base64。`
    );
  }
}

async function fetchGithubJson(url, token) {
  let response;

  try {
    response = await fetch(url, {
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "qiqibba-content-api",
      },
    });
  } catch {
    throw new ApiError(502, "github_unavailable", "无法连接 GitHub API。");
  }

  if (!response.ok) {
    throw new ApiError(
      502,
      "github_request_failed",
      `GitHub API 请求失败（HTTP ${response.status}）。请检查仓库、分支、目录和 Token 权限。`
    );
  }

  try {
    return await response.json();
  } catch {
    throw new ApiError(502, "invalid_github_response", "GitHub API 返回了无效的 JSON。");
  }
}

async function fetchProducts(env) {
  const owner = env.GITHUB_OWNER?.trim();
  const repo = env.GITHUB_REPO?.trim();
  const branch = env.GITHUB_BRANCH?.trim();
  const token = env.GITHUB_TOKEN;

  if (!owner || !repo || !branch || !token) {
    throw new ApiError(
      500,
      "missing_configuration",
      "Worker 缺少 GitHub 仓库、分支或 Token 配置。"
    );
  }

  const encodedDirectory = PRODUCTS_DIRECTORY
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  const directoryUrl = new URL(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedDirectory}`
  );
  directoryUrl.searchParams.set("ref", branch);

  const entries = await fetchGithubJson(directoryUrl, token);

  if (!Array.isArray(entries)) {
    throw new ApiError(
      502,
      "invalid_github_directory",
      "GitHub 商品目录响应格式无效。"
    );
  }

  const markdownFiles = entries.filter(
    (entry) =>
      entry &&
      entry.type === "file" &&
      typeof entry.name === "string" &&
      /\.md$/i.test(entry.name)
  );

  return Promise.all(
    markdownFiles.map(async (file) => {
      const fileUrl = new URL(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedDirectory}/${encodeURIComponent(file.name)}`
      );
      fileUrl.searchParams.set("ref", branch);

      const fileData = await fetchGithubJson(fileUrl, token);

      if (
        !fileData ||
        fileData.encoding !== "base64" ||
        typeof fileData.content !== "string"
      ) {
        throw new ApiError(
          502,
          "invalid_github_file",
          `${file.name} 缺少可读取的 Base64 文件内容。`
        );
      }

      const source = decodeGithubFile(fileData.content, file.name);

      try {
        const { data, body } = parseFrontmatter(source, file.name);
        const product = validateAndMapProduct(data, file.name);

        return {
          slug: file.name.replace(/\.md$/i, ""),
          ...product,
          detail: body,
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "未知 Markdown 格式错误";
        throw new ApiError(
          422,
          "invalid_product_markdown",
          `商品文件 ${file.name} 无法解析：${reason}`
        );
      }
    })
  );
}

function getAdminDraftRoute(pathname) {
  if (pathname === DRAFTS_ENDPOINT) return { kind: "collection" };

  const match = pathname.match(/^\/api\/admin\/drafts\/([^/]+)(\/preview)?$/);
  if (!match) return null;

  let id;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;

  return {
    kind: match[2] ? "preview" : "item",
    id,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Response.json({
        name: "Qiqibba Content API",
        status: "ok",
        message: "网站后台 API 已启动",
      });
    }

    const isAdminApiRequest = url.pathname.startsWith(ADMIN_API_PREFIX);
    if (url.pathname !== PRODUCTS_ENDPOINT && !isAdminApiRequest) {
      return errorResponse(404, "not_found", "Not Found");
    }

    const origin = request.headers.get("Origin");

    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return errorResponse(403, "origin_not_allowed", "此来源不允许访问该 API。");
    }

    if (isAdminApiRequest) {
      const draftRoute = getAdminDraftRoute(url.pathname);

      if (request.method === "OPTIONS" && draftRoute) {
        return handleDraftRequest(request, env, origin, draftRoute);
      }

      try {
        await verifyAdminAccess(request, env);
      } catch (error) {
        if (error instanceof ApiError) {
          return adminErrorResponse(error.status, error.code, error.message, origin);
        }

        return adminErrorResponse(
          503,
          "access_verification_unavailable",
          "Cloudflare Access 身份验证失败。",
          origin
        );
      }

      if (!draftRoute) {
        return adminErrorResponse(404, "not_found", "Not Found", origin);
      }

      try {
        return await handleDraftRequest(request, env, origin, draftRoute);
      } catch (error) {
        if (error instanceof ApiError) {
          return adminErrorResponse(error.status, error.code, error.message, origin);
        }

        return adminErrorResponse(
          500,
          "draft_storage_error",
          "Worker 处理草稿请求时发生未预期错误。",
          origin
        );
      }
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Vary": "Origin",
          ...corsHeaders(origin),
        },
      });
    }

    if (request.method !== "GET") {
      return errorResponse(
        405,
        "method_not_allowed",
        "仅支持 GET 和 OPTIONS 请求。",
        origin
      );
    }

    try {
      const products = await fetchProducts(env);
      return jsonResponse({ products }, 200, origin);
    } catch (error) {
      if (error instanceof ApiError) {
        return errorResponse(error.status, error.code, error.message, origin);
      }

      return errorResponse(
        500,
        "internal_error",
        "Worker 处理商品请求时发生未预期错误。",
        origin
      );
    }
  },
};
