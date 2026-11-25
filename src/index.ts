import type { Env } from "./types.js";
import { analyze } from "./analyze.js";

// Static files are served from ./public by the [assets] binding in
// wrangler.toml; this Worker only handles the API.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID().slice(0, 8);
    if (url.pathname === "/api/analyze" && request.method === "POST") {
      return analyze(request, env, requestId);
    }
    return new Response(JSON.stringify({ error: "Not Found", requestId }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=UTF-8" },
    });
  },
};
