import { DurableObject } from "cloudflare:workers";
import { isDemo, isHealthy, loadState, notify, runCycle } from "./bridge";
import { MOCK_PATH } from "./meronrg";
import { mockReceiver } from "./mock";
import { statusPage } from "./page";
import type { Config, State, Store } from "./types";

export interface Env extends Config {
  BRIDGE: DurableObjectNamespace<BridgeState>;
}

/**
 * Holds the bridge's state and runs the hourly job. One instance exists, its storage is
 * strongly consistent, and runs never overlap: a second trigger joins the run in progress.
 * That keeps the meter total exact and means a Tesla refresh token is never used twice.
 */
export class BridgeState extends DurableObject<Env> {
  private inFlight: Promise<State> | null = null;

  private store(): Store {
    const storage = this.ctx.storage;
    return {
      get: (key) => storage.get(key),
      put: (key, value) => storage.put(key, value),
    };
  }

  run(): Promise<State> {
    this.inFlight ??= runCycle(this.env, this.store()).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  state(): Promise<State> {
    return loadState(this.store());
  }
}

const bridge = (env: Env) => env.BRIDGE.get(env.BRIDGE.idFromName(env.STATE_NAME || "bridge"));

const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  // The page is static text and inline styles: no scripts, no outside resources, no framing.
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function reply(body: string, status = 200, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, "content-type": contentType } });
}
const replyJson = (body: unknown, status = 200) => reply(JSON.stringify(body), status, "application/json");

/** Compares secrets without leaking, through timing, how much of a guess was right. */
async function sameSecret(given: string | null, expected: string | undefined): Promise<boolean> {
  if (!given || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export default {
  // Once an hour: post any charging session the operator has not seen yet.
  async scheduled(_controller, env) {
    await bridge(env).run();
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const read = request.method === "GET" || request.method === "HEAD";

    // Keys and tokens must never travel unencrypted.
    if (url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      if (!read) return reply("use https\n", 400);
      url.protocol = "https:";
      return new Response(null, { status: 301, headers: { ...SECURITY_HEADERS, location: url.toString() } });
    }

    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
    const authorised = await sameSecret(bearer, env.STATUS_TOKEN);

    // Says only whether the bridge is working. Safe to point an uptime monitor at.
    if (pathname === "/health" && read) {
      const ok = isHealthy(await bridge(env).state());
      return reply(ok ? "ok\n" : "unhealthy\n", ok ? 200 : 503);
    }

    if (pathname === "/api/status" && read) {
      // Real charging times say when someone is home, so live status needs the token.
      if (!isDemo(env) && !authorised) return reply("unauthorised\n", 401);
      const state = await bridge(env).state();
      return replyJson({ healthy: isHealthy(state), ...state });
    }

    // Run the hourly job now (after fixing a problem, or to check a new deployment).
    if (pathname === "/run" && request.method === "POST" && authorised) {
      const state = await bridge(env).run();
      return replyJson({ delivered_count: state.delivered_count, last_error: state.last_error });
    }

    // Sends a test notice to the alert address, to prove alerts arrive.
    if (pathname === "/test-alert" && request.method === "POST" && authorised) {
      return replyJson({ sent: await notify(env, fetch, "test", null) });
    }

    // Anything that is not explicitly the demo is private.
    if (!isDemo(env)) {
      return pathname === "/" && read ? reply("wallconnector-meter-bridge: running\n") : reply("not found\n", 404);
    }

    // Demo only below this line.
    if (pathname === "/" && read) {
      return reply(statusPage(await bridge(env).state(), env, url.origin), 200, "text/html; charset=utf-8");
    }
    if (pathname === MOCK_PATH) return mockReceiver(request, null);
    return reply("not found\n", 404);
  },
} satisfies ExportedHandler<Env>;
