import assert from "node:assert/strict";
import test from "node:test";

import healthHandler from "../api/health.js";
import mapFieldsHandler from "../api/map-fields.js";
import { HttpError, mapFieldsWithClaude } from "../server/index.js";

function responseRecorder() {
  const headers = new Map();
  return {
    body: "",
    statusCode: 200,
    setHeader(name, value) {
      headers.set(name.toLocaleLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(name.toLocaleLowerCase());
    },
    end(value = "") {
      this.body = value;
    },
  };
}

test("Vercel health function reports configuration state as JSON", () => {
  const response = responseRecorder();
  healthHandler({ method: "GET" }, response);

  assert.equal(response.statusCode, 200);
  assert.match(response.getHeader("content-type"), /application\/json/);
  assert.equal(JSON.parse(response.body).ok, true);
});

test("Vercel map-fields function rejects unsupported methods as JSON", async () => {
  const response = responseRecorder();
  await mapFieldsHandler({ method: "GET" }, response);

  assert.equal(response.statusCode, 405);
  assert.equal(JSON.parse(response.body).error, "Method not allowed.");
});

test("Vercel map-fields function validates request bodies before Claude", async () => {
  const response = responseRecorder();
  await mapFieldsHandler({ method: "POST", body: {} }, response);

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error, "Clinical notes must be between 2 and 50,000 characters.");
});

test("Claude requests trim surrounding whitespace from the configured API key", async () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalFetch = global.fetch;
  process.env.ANTHROPIC_API_KEY = "  sk-ant-test-key\n";
  global.fetch = async (url, options) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal(options.headers["x-api-key"], "sk-ant-test-key");
    const requestBody = JSON.parse(options.body);
    const confidenceSchema = requestBody.output_config.format.schema
      .properties.assignments.items.properties.confidence;
    assert.deepEqual(confidenceSchema, { type: "number" });
    return {
      ok: true,
      headers: { get: () => "request-test" },
      json: async () => ({
        model: "claude-sonnet-5",
        stop_reason: "end_turn",
        content: [{
          type: "text",
          text: JSON.stringify({
            assignments: [{ name: "allergies", value: "None", confidence: 1 }],
          }),
        }],
      }),
    };
  };

  try {
    const result = await mapFieldsWithClaude({
      fields: [{ name: "allergies", type: "TextField", options: [] }],
      freeText: "No allergies.",
      pdfBase64: "JVBERi0xLjQK",
    });
    assert.equal(result.assignments[0].value, "None");
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  }
});

test("Claude connection failures return a useful safe error", async () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalFetch = global.fetch;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
  global.fetch = async () => {
    throw new TypeError("fetch failed");
  };

  try {
    await assert.rejects(
      () => mapFieldsWithClaude({
        fields: [{ name: "allergies", type: "TextField", options: [] }],
        freeText: "No allergies.",
        pdfBase64: "JVBERi0xLjQK",
      }),
      (error) => error instanceof HttpError
        && error.status === 502
        && /could not connect to Claude/.test(error.message),
    );
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  }
});
