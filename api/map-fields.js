import {
  HttpError,
  mapFieldsWithClaude,
  validateRequest,
} from "../server/index.js";

const MAX_REQUEST_BYTES = 4_400_000;

function sendJson(response, status, value) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(value));
}

async function requestBody(request) {
  if (request.body !== undefined && request.body !== null) {
    if (typeof request.body === "object" && !Buffer.isBuffer(request.body)) {
      return request.body;
    }

    const raw = Buffer.isBuffer(request.body)
      ? request.body.toString("utf8")
      : String(request.body);
    try {
      return JSON.parse(raw);
    } catch {
      throw new HttpError(400, "The request body is not valid JSON.");
    }
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new HttpError(413, "The uploaded PDF is too large.");
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "The request body is not valid JSON.");
  }
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { error: "Method not allowed." });
  }

  try {
    const result = await mapFieldsWithClaude(validateRequest(await requestBody(request)));
    return sendJson(response, 200, result);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : "Unexpected server error.";
    return sendJson(response, status, {
      error: message,
      ...(error.requestId ? { requestId: error.requestId } : {}),
    });
  }
}
