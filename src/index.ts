import { isLive, loadState, runCycle } from "./bridge";
import { MOCK_PATH } from "./meronrg";
import { mockReceiver } from "./mock";
import { statusPage } from "./page";
import type { Env } from "./types";

export default {
  // Once an hour: post any charging session the operator has not seen yet.
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runCycle(env));
  },

  async fetch(request, env) {
    const { pathname, origin } = new URL(request.url);
    const authorised =
      !!env.STATUS_TOKEN && request.headers.get("authorization") === `Bearer ${env.STATUS_TOKEN}`;

    if (pathname === "/api/status") {
      // Real charging times say when someone is home, so live status needs a token.
      if (isLive(env) && !authorised) return new Response("unauthorised\n", { status: 401 });
      return Response.json(await loadState(env));
    }

    // Run the hourly job now (after fixing a problem, or to check a new deployment).
    if (pathname === "/run" && request.method === "POST" && authorised) {
      const state = await runCycle(env);
      return Response.json({ delivered_total: state.seq, last_error: state.last_error });
    }

    if (isLive(env)) {
      return pathname === "/"
        ? new Response("wallconnector-meter-bridge: running\n")
        : new Response("not found\n", { status: 404 });
    }

    if (pathname === "/") {
      return new Response(statusPage(await loadState(env), env, origin), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (pathname === MOCK_PATH) return mockReceiver(request, env, false);
    return new Response("not found\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
