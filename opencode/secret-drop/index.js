import { Plugin } from "@opencode/plugin";
import { containsSecret, SAFE_REPLACEMENT } from "./detect.js";

export default Plugin.define({
  id: "secret-drop-opencode",
  async setup(ctx) {
    await ctx.session.hook("prompt", (event) => {
      if (!containsSecret(event.prompt?.text)) return;
      // OpenCode v2 has a mutable prompt-admission hook; cancellation is not documented.
      // Replace the ENTIRE prompt rather than sending any part of an accidental secret.
      event.prompt.text = SAFE_REPLACEMENT;
      event.metadata = { ...event.metadata, secret_drop: "prompt-replaced" };
    });
  },
});
