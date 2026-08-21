import assert from "node:assert/strict";
import test from "node:test";

import healthHandler from "../api/health.js";
import mapFieldsHandler from "../api/map-fields.js";

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
