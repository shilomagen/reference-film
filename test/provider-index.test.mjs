import assert from "node:assert/strict";
import test from "node:test";
import {
  createProviderRegistry, finalArtifactDirectory, finalArtifactPath,
  requestedVideoDuration, validateProviderSelection, videoArtifactDirectory,
} from "../src/providers/index.mjs";

test("registry selects each capability and rejects unsupported combinations", () => {
  const config = {
    providers: { text: "xai", image: "xai", judge: "xai", video: "gemini" },
    models: { text: "t", image: "i", judge: "j", video: "xv", geminiVideo: "gv" },
    credentials: { xai: { apiKey: "fake-x" }, gemini: { apiKey: "fake-g" } },
  };
  const registry = createProviderRegistry(config, { fetch: async () => { throw new Error("offline"); } });
  assert.equal(registry.models.video, "gv");
  assert.equal(registry.text, registry.image);
  assert.notEqual(registry.video, registry.text);
  assert.throws(() => validateProviderSelection({ providers: { text: "gemini" } }), /does not support/);
});

test("provider artifact and duration helpers are generic", () => {
  const video = { supportedDurations: () => [4, 6, 8] };
  assert.equal(requestedVideoDuration(video, "720p", 5.2), 6);
  assert.equal(videoArtifactDirectory("gemini"), "video-gemini");
  assert.equal(finalArtifactDirectory("xai"), "final-xai");
  assert.equal(finalArtifactPath("out", "xai", "My Film!"), "out/final-xai/my-film.mp4");
});
