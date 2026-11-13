import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The Workers runtime module does not exist under Node; tests use a minimal stand-in.
    alias: { "cloudflare:workers": fileURLToPath(new URL("./test/cloudflare-workers-stub.ts", import.meta.url)) },
  },
});
