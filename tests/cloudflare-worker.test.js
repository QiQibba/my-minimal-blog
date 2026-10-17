import test from "node:test";
import assert from "node:assert/strict";
import worker from "../cloudflare-worker.js";

const ACCESS_ISSUER = "https://patient-art-8945.cloudflareaccess.com";
const ADMIN_EMAIL = "136860199@qq.com";
const ACCESS_AUD = "local-test-audience";
const DRAFTS_PATH = "/api/admin/drafts";
const ALLOWED_ORIGIN = "https://qiqibba.github.io";

const { publicKey, privateKey } = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"]
);
const testJwk = await crypto.subtle.exportKey("jwk", publicKey);
Object.assign(testJwk, { kid: "local-test-key", alg: "RS256", use: "sig" });

function encodeBase64Url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function createJwt(overrides = {}) {
  const header = encodeBase64Url({ alg: "RS256", kid: "local-test-key" });
  const payload = encodeBase64Url({
    iss: ACCESS_ISSUER,
    aud: [ACCESS_AUD],
    exp: Math.floor(Date.now() / 1000) + 300,
    nbf: Math.floor(Date.now() / 1000) - 1,
    email: ADMIN_EMAIL,
    ...overrides,
  });
  const data = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(data)
  );
  return `${data}.${Buffer.from(signature).toString("base64url")}`;
}

const validJwt = await createJwt();
const testEnv = { ACCESS_AUD, GITHUB_OWNER: "local-owner", GITHUB_REPO: "local-repo", GITHUB_BRANCH: "main", GITHUB_TOKEN: "test-only-token" };

class MemoryD1 {
  constructor() {
    this.rows = new Map();
    this.calls = [];
    this.fail = false;
    this.failOperations = new Set();
    this.enforceUniqueSlugs = false;
  }

  prepare(sql) {
    const db = this;
    return {
      sql,
      values: [],
      bind(...values) {
        this.values = values;
        return this;
      },
      async first() {
        db.calls.push({ operation: "first", sql, values: this.values });
        if (db.fail || db.failOperations.has("first")) {
          throw new Error("TEST_ONLY_DATABASE_SECRET");
        }
        return db.rows.get(this.values[0]) ?? null;
      },
      async all() {
        db.calls.push({ operation: "all", sql, values: this.values });
        if (db.fail || db.failOperations.has("all")) {
          throw new Error("TEST_ONLY_DATABASE_SECRET");
        }
        return {
          success: true,
          results: [...db.rows.values()].filter(
            (row) => row.content_type === this.values[0] && row.status === this.values[1]
          ),
        };
      },
      async run() {
        const values = this.values;
        const operation = sql.startsWith("INSERT")
          ? "insert"
          : sql.startsWith("UPDATE")
            ? "update"
            : sql.startsWith("DELETE")
              ? "delete"
              : "run";
        db.calls.push({ operation, sql, values });
        if (db.fail || db.failOperations.has(operation)) {
          throw new Error("TEST_ONLY_DATABASE_SECRET");
        }

        if (sql.startsWith("INSERT")) {
          if (db.rows.has(values[0])) {
            throw new Error("TEST_ONLY_DATABASE_SECRET: UNIQUE constraint failed: content_drafts.id");
          }
          if (
            db.enforceUniqueSlugs &&
            [...db.rows.values()].some(
              (row) => row.content_type === values[1] && row.slug === values[3]
            )
          ) {
            throw new Error("TEST_ONLY_DATABASE_SECRET: UNIQUE constraint failed: content_drafts.slug");
          }
          db.rows.set(values[0], {
            id: values[0],
            content_type: values[1],
            title: values[2],
            slug: values[3],
            content_json: values[4],
            status: "draft",
            created_by: values[5],
            created_at: values[6],
            updated_at: values[7],
            published_at: null,
            published_commit: null,
          });
          return { success: true, meta: { changes: 1 } };
        }

        if (sql.startsWith("UPDATE")) {
          const row = db.rows.get(values[4]);
          if (!row || row.content_type !== values[5] || row.status !== values[6]) {
            return { success: true, meta: { changes: 0 } };
          }
          Object.assign(row, {
            title: values[0],
            slug: values[1],
            content_json: values[2],
            updated_at: values[3],
          });
          return { success: true, meta: { changes: 1 } };
        }

        if (sql.startsWith("DELETE")) {
          const row = db.rows.get(values[0]);
          if (!row || row.content_type !== values[1] || row.status !== values[2]) {
            return { success: true, meta: { changes: 0 } };
          }
          db.rows.delete(values[0]);
          return { success: true, meta: { changes: 1 } };
        }

        throw new Error("Unexpected test SQL statement");
      },
    };
  }
}

function createDbEnv(db = new MemoryD1()) {
  return { ...testEnv, DRAFTS_DB: db };
}

function requestFor(method, path, { jwt, origin, body, rawBody, headers = {} } = {}) {
  const requestHeaders = new Headers(headers);
  if (jwt) requestHeaders.set("Cf-Access-Jwt-Assertion", jwt);
  if (origin) requestHeaders.set("Origin", origin);
  let requestBody;
  if (rawBody !== undefined) {
    requestBody = rawBody;
  } else if (body !== undefined) {
    if (!requestHeaders.has("Content-Type")) {
      requestHeaders.set("Content-Type", "application/json");
    }
    requestBody = JSON.stringify(body);
  }
  return new Request(`https://worker.test${path}`, {
    method,
    headers: requestHeaders,
    body: requestBody,
  });
}

async function callWorker(request, env, networkFetch = async () => {
  throw new Error("Unexpected network request in isolated test");
}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = networkFetch;
  try {
    const response = await worker.fetch(request, env, {});
    const body = response.status === 204 ? null : await response.json();
    return { response, body };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function accessOnlyFetch(calls = []) {
  return async (url) => {
    const parsedUrl = new URL(url);
    calls.push(parsedUrl.href);
    assert.equal(parsedUrl.href, `${ACCESS_ISSUER}/cdn-cgi/access/certs`);
    return Response.json({ keys: [testJwk] });
  };
}

async function createJwtWithInvalidSignature() {
  const [header, payload, encodedSignature] = validJwt.split(".");
  const signature = Buffer.from(encodedSignature, "base64url");
  signature[0] ^= 0xff;
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

const validDraft = {
  content_type: "product",
  title: "Local test product",
  slug: "local-test-product",
  content_json: { price: 25, description: "Test data only" },
};

test("rejects all draft reads and writes without JWT or with invalid JWT before D1", async (t) => {
  const cases = [
    ["GET", DRAFTS_PATH],
    ["POST", DRAFTS_PATH, validDraft],
    ["GET", `${DRAFTS_PATH}/draft-id`],
    ["PUT", `${DRAFTS_PATH}/draft-id`, validDraft],
    ["DELETE", `${DRAFTS_PATH}/draft-id`],
    ["GET", `${DRAFTS_PATH}/draft-id/preview`],
  ];

  for (const jwtState of ["missing", "invalid"]) {
    await t.test(jwtState, async () => {
      const db = new MemoryD1();
      for (const [method, path, body] of cases) {
        const request = requestFor(method, path, {
          jwt: jwtState === "invalid" ? "not.a.valid-jwt" : undefined,
          body,
        });
        const { response } = await callWorker(request, createDbEnv(db));
        assert.equal(response.status, 401, `${method} ${path}`);
      }
      assert.equal(db.calls.length, 0);
    });
  }
});

test("rejects signed-invalid and invalid-claim JWTs before any D1 operation", async (t) => {
  const invalidTokens = [
    ["bad signature", await createJwtWithInvalidSignature()],
    ["expired", await createJwt({ exp: Math.floor(Date.now() / 1000) - 1 })],
    ["wrong email", await createJwt({ email: "not-the-admin@example.test" })],
    ["wrong issuer", await createJwt({ iss: "https://wrong-issuer.example.test" })],
    ["wrong audience", await createJwt({ aud: ["wrong-audience"] })],
    ["not yet valid", await createJwt({ nbf: Math.floor(Date.now() / 1000) + 60 })],
  ];

  for (const [label, jwt] of invalidTokens) {
    await t.test(label, async () => {
      const db = new MemoryD1();
      const { response } = await callWorker(
        requestFor("POST", DRAFTS_PATH, { jwt, body: validDraft }),
        createDbEnv(db),
        accessOnlyFetch()
      );
      assert.equal(response.status, 401);
      assert.equal(db.calls.length, 0);
    });
  }
});

test("valid administrator JWT can create, list, read, preview, update, and delete drafts", async () => {
  const db = new MemoryD1();
  const env = createDbEnv(db);
  const networkCalls = [];
  const fetch = accessOnlyFetch(networkCalls);

  const created = await callWorker(
    requestFor("POST", DRAFTS_PATH, { jwt: validJwt, body: validDraft }),
    env,
    fetch
  );
  assert.equal(created.response.status, 201);
  assert.match(created.body.draft.id, /^[A-Za-z0-9_-]+$/);
  assert.equal(created.body.draft.created_by, ADMIN_EMAIL);
  assert.equal(created.body.draft.status, "draft");
  assert.deepEqual(created.body.draft.content_json, validDraft.content_json);

  const id = created.body.draft.id;
  const listed = await callWorker(requestFor("GET", DRAFTS_PATH, { jwt: validJwt }), env, fetch);
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.drafts.length, 1);
  assert.equal(listed.body.drafts[0].id, id);

  const read = await callWorker(
    requestFor("GET", `${DRAFTS_PATH}/${id}`, { jwt: validJwt }),
    env,
    fetch
  );
  assert.equal(read.response.status, 200);
  assert.equal(read.body.draft.id, id);

  const preview = await callWorker(
    requestFor("GET", `${DRAFTS_PATH}/${id}/preview`, { jwt: validJwt }),
    env,
    fetch
  );
  assert.equal(preview.response.status, 200);
  assert.deepEqual(preview.body.draft.content_json, validDraft.content_json);

  const updated = await callWorker(
    requestFor("PUT", `${DRAFTS_PATH}/${id}`, {
      jwt: validJwt,
      body: { ...validDraft, title: "Updated local test product" },
    }),
    env,
    fetch
  );
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.draft.title, "Updated local test product");

  const deleted = await callWorker(
    requestFor("DELETE", `${DRAFTS_PATH}/${id}`, { jwt: validJwt }),
    env,
    fetch
  );
  assert.equal(deleted.response.status, 200);
  assert.equal(db.rows.has(id), false);
  assert.equal(networkCalls.length, 6);
  assert.ok(
    db.calls.every(({ sql }) => /^(?:SELECT|INSERT|UPDATE|DELETE)\b/.test(sql) && !/github/i.test(sql))
  );
});

test("slug conflicts and generated ID collisions do not overwrite existing drafts", async (t) => {
  await t.test("duplicate slug", async () => {
    const db = new MemoryD1();
    db.enforceUniqueSlugs = true;
    const existing = {
      id: "existing-slug-draft",
      content_type: "product",
      title: "Existing slug owner",
      slug: validDraft.slug,
      content_json: JSON.stringify({ marker: "keep-existing" }),
      status: "draft",
      created_by: ADMIN_EMAIL,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      published_at: null,
      published_commit: null,
    };
    db.rows.set(existing.id, existing);

    const { response, body } = await callWorker(
      requestFor("POST", DRAFTS_PATH, { jwt: validJwt, body: validDraft }),
      createDbEnv(db),
      accessOnlyFetch()
    );
    assert.equal(response.status, 500);
    assert.equal(body.error.code, "draft_storage_error");
    assert.equal(db.rows.size, 1);
    assert.equal(db.rows.get(existing.id).title, "Existing slug owner");
    assert.equal(db.rows.get(existing.id).content_json, JSON.stringify({ marker: "keep-existing" }));
  });

  await t.test("generated ID collision", async () => {
    const db = new MemoryD1();
    const collisionId = "already-existing-id";
    db.rows.set(collisionId, {
      id: collisionId,
      content_type: "product",
      title: "Existing ID owner",
      slug: "existing-id-owner",
      content_json: JSON.stringify({ marker: "keep-existing" }),
      status: "draft",
      created_by: ADMIN_EMAIL,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      published_at: null,
      published_commit: null,
    });
    const originalDescriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      writable: true,
      value: () => collisionId,
    });

    try {
      const { response, body } = await callWorker(
        requestFor("POST", DRAFTS_PATH, { jwt: validJwt, body: validDraft }),
        createDbEnv(db),
        accessOnlyFetch()
      );
      assert.equal(response.status, 500);
      assert.equal(body.error.code, "draft_storage_error");
      assert.equal(db.rows.size, 1);
      assert.equal(db.rows.get(collisionId).title, "Existing ID owner");
      assert.equal(db.rows.get(collisionId).content_json, JSON.stringify({ marker: "keep-existing" }));
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(crypto, "randomUUID", originalDescriptor);
      } else {
        delete crypto.randomUUID;
      }
    }
  });
});

test("published records cannot be updated or deleted", async () => {
  const db = new MemoryD1();
  db.rows.set("published-id", {
    id: "published-id",
    content_type: "product",
    title: "Published",
    slug: "published",
    content_json: "{}",
    status: "published",
    created_by: ADMIN_EMAIL,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    published_at: "2026-01-01T00:00:00.000Z",
    published_commit: "test-commit-id",
  });

  for (const method of ["PUT", "DELETE"]) {
    const { response } = await callWorker(
      requestFor(method, `${DRAFTS_PATH}/published-id`, {
        jwt: validJwt,
        body: method === "PUT" ? validDraft : undefined,
      }),
      createDbEnv(db),
      accessOnlyFetch()
    );
    assert.equal(response.status, 409);
    assert.equal(db.rows.get("published-id").title, "Published");
    assert.equal(db.rows.get("published-id").status, "published");
  }
});

test("rejects malformed JSON, invalid content type, title, content type, and slug", async (t) => {
  const invalidCases = [
    ["malformed JSON", undefined, "{invalid-json", { "Content-Type": "application/json" }, 400],
    ["wrong content type", validDraft, undefined, { "Content-Type": "text/plain" }, 415],
    ["invalid content type", { ...validDraft, content_type: "article" }, undefined, {}, 400],
    ["empty title", { ...validDraft, title: "  " }, undefined, {}, 400],
    ["invalid slug", { ...validDraft, slug: "Bad Slug/../../x" }, undefined, {}, 400],
  ];

  for (const [label, body, rawBody, headers, status] of invalidCases) {
    await t.test(label, async () => {
      const db = new MemoryD1();
      const { response } = await callWorker(
        requestFor("POST", DRAFTS_PATH, { jwt: validJwt, body, rawBody, headers }),
        createDbEnv(db),
        accessOnlyFetch()
      );
      assert.equal(response.status, status);
      assert.equal(db.calls.filter(({ operation }) => operation === "run").length, 0);
    });
  }
});

test("rejects request bodies larger than the configured request limit", async () => {
  const db = new MemoryD1();
  const oversizedBody = JSON.stringify({
    ...validDraft,
    content_json: { text: "x".repeat(70 * 1024) },
  });
  const { response, body } = await callWorker(
    requestFor("POST", DRAFTS_PATH, {
      jwt: validJwt,
      rawBody: oversizedBody,
      headers: { "Content-Type": "application/json" },
    }),
    createDbEnv(db),
    accessOnlyFetch()
  );
  assert.equal(response.status, 413);
  assert.equal(body.error.code, "request_too_large");
  assert.equal(db.calls.filter(({ operation }) => operation === "run").length, 0);
});

test("accepts content_json at the byte limit and rejects content over the limit", async (t) => {
  const maxContentBytes = 48 * 1024;
  const emptyPayloadBytes = Buffer.byteLength(JSON.stringify({ data: "" }));
  const exactSizeContent = { data: "x".repeat(maxContentBytes - emptyPayloadBytes) };
  assert.equal(Buffer.byteLength(JSON.stringify(exactSizeContent)), maxContentBytes);

  await t.test("exactly at the content limit", async () => {
    const db = new MemoryD1();
    const { response, body } = await callWorker(
      requestFor("POST", DRAFTS_PATH, {
        jwt: validJwt,
        body: { ...validDraft, content_json: exactSizeContent },
      }),
      createDbEnv(db),
      accessOnlyFetch()
    );
    assert.equal(response.status, 201);
    assert.equal(Buffer.byteLength(JSON.stringify(body.draft.content_json)), maxContentBytes);
  });

  await t.test("one byte over the content limit", async () => {
    const db = new MemoryD1();
    const tooLargeContent = { data: "x".repeat(maxContentBytes - emptyPayloadBytes + 1) };
    assert.equal(Buffer.byteLength(JSON.stringify(tooLargeContent)), maxContentBytes + 1);
    const { response, body } = await callWorker(
      requestFor("POST", DRAFTS_PATH, {
        jwt: validJwt,
        body: { ...validDraft, content_json: tooLargeContent },
      }),
      createDbEnv(db),
      accessOnlyFetch()
    );
    assert.equal(response.status, 413);
    assert.equal(body.error.code, "draft_content_too_large");
    assert.equal(db.calls.filter(({ operation }) => operation === "insert").length, 0);
  });
});

test("rejects unknown routes and unsupported methods", async (t) => {
  const cases = [
    ["GET", "/api/admin/drafts-extra", 404],
    ["GET", "/api/admin/drafts/id/unknown", 404],
    ["POST", "/api/admin/drafts/id", 405],
    ["PUT", DRAFTS_PATH, 405],
    ["PATCH", `${DRAFTS_PATH}/id`, 405],
    ["PUT", `${DRAFTS_PATH}/id/preview`, 405],
  ];

  for (const [method, path, status] of cases) {
    await t.test(`${method} ${path}`, async () => {
      const db = new MemoryD1();
      const { response } = await callWorker(
        requestFor(method, path, { jwt: validJwt }),
        createDbEnv(db),
        accessOnlyFetch()
      );
      assert.equal(response.status, status);
      assert.equal(db.calls.length, 0);
    });
  }
});

test("rejects disallowed Origin and handles preflight without D1 access", async (t) => {
  await t.test("disallowed Origin", async () => {
    const db = new MemoryD1();
    const { response } = await callWorker(
      requestFor("GET", DRAFTS_PATH, { jwt: validJwt, origin: "https://untrusted.example" }),
      createDbEnv(db),
      accessOnlyFetch()
    );
    assert.equal(response.status, 403);
    assert.equal(db.calls.length, 0);
  });

  await t.test("draft preflight", async () => {
    const db = new MemoryD1();
    const { response } = await callWorker(
      requestFor("OPTIONS", DRAFTS_PATH, { origin: ALLOWED_ORIGIN }),
      createDbEnv(db)
    );
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), ALLOWED_ORIGIN);
    assert.match(response.headers.get("Access-Control-Allow-Methods"), /DELETE/);
    assert.equal(db.calls.length, 0);
  });
});

test("public products GET continues using only mocked GitHub read calls", async () => {
  const calls = [];
  const markdown = [
    "---",
    "name: Local test product",
    "category: test",
    "summary: A local fixture",
    "---",
    "Local test details.",
  ].join("\n");
  const encodedMarkdown = Buffer.from(markdown, "utf8").toString("base64");
  const networkFetch = async (url, options) => {
    const parsedUrl = new URL(url);
    calls.push({ url: parsedUrl.href, method: options?.method || "GET" });
    assert.equal(parsedUrl.origin, "https://api.github.com");
    assert.equal(options?.method || "GET", "GET");
    if (parsedUrl.pathname.endsWith("/src/content/products")) {
      return Response.json([{ type: "file", name: "local-product.md" }]);
    }
    assert.ok(parsedUrl.pathname.endsWith("/src/content/products/local-product.md"));
    return Response.json({ encoding: "base64", content: encodedMarkdown });
  };

  const { response, body } = await callWorker(
    requestFor("GET", "/api/content/products", { origin: ALLOWED_ORIGIN }),
    testEnv,
    networkFetch
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), ALLOWED_ORIGIN);
  assert.equal(body.products.length, 1);
  assert.equal(body.products[0].slug, "local-product");
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ method }) => method === "GET"));
});

test("D1 read, insert, update, and delete failures return generic errors without internal details", async (t) => {
  const failureCases = [
    ["read", "all", "GET", DRAFTS_PATH],
    ["single-record read", "first", "GET", `${DRAFTS_PATH}/missing-draft`],
    ["insert", "insert", "POST", DRAFTS_PATH, validDraft],
    ["update", "update", "PUT", `${DRAFTS_PATH}/existing-draft`, validDraft],
    ["delete", "delete", "DELETE", `${DRAFTS_PATH}/existing-draft`],
  ];

  for (const [label, operation, method, path, body] of failureCases) {
    await t.test(label, async () => {
      const db = new MemoryD1();
      db.failOperations.add(operation);
      if (method === "PUT" || method === "DELETE") {
        db.rows.set("existing-draft", {
          id: "existing-draft",
          content_type: "product",
          title: "Existing draft",
          slug: "existing-draft",
          content_json: JSON.stringify({ marker: true }),
          status: "draft",
          created_by: ADMIN_EMAIL,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          published_at: null,
          published_commit: null,
        });
      }

      const { response, body: responseBody } = await callWorker(
        requestFor(method, path, { jwt: validJwt, body }),
        createDbEnv(db),
        accessOnlyFetch()
      );
      const serialized = JSON.stringify(responseBody);
      assert.equal(response.status, 500);
      assert.equal(responseBody.error.code, "draft_storage_error");
      assert.doesNotMatch(serialized, /TEST_ONLY_DATABASE_SECRET/);
      assert.doesNotMatch(serialized, /database|secret|password/i);
      assert.ok(db.calls.some(({ operation: calledOperation }) => calledOperation === operation));
    });
  }
});

test("publishing routes remain unavailable and cause no writes or non-Access network calls", async () => {
  const db = new MemoryD1();
  const networkCalls = [];
  const { response } = await callWorker(
    requestFor("POST", "/api/admin/publish", { jwt: validJwt, body: validDraft }),
    createDbEnv(db),
    accessOnlyFetch(networkCalls)
  );
  assert.equal(response.status, 404);
  assert.equal(db.calls.length, 0);
  assert.equal(networkCalls.length, 1);
});
