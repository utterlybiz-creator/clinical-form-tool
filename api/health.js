function sendJson(response, status, value) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(value));
}

export default function handler(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return sendJson(response, 405, { error: "Method not allowed." });
  }

  if (request.method === "HEAD") {
    response.statusCode = 200;
    response.setHeader("Cache-Control", "no-store");
    return response.end();
  }

  return sendJson(response, 200, {
    ok: true,
    configured: Boolean(process.env.ANTHROPIC_API_KEY),
  });
}
