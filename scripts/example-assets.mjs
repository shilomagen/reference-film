#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "examples", "assets");
fs.mkdirSync(output, { recursive: true });

const assets = [
  ["traveler-primary.png", "#176b87", 190],
  ["traveler-profile.png", "#22577a", 235],
  ["maker-primary.png", "#9c4a2f", 280],
  ["group-reference.png", "#514663", 220],
];

function ffmpeg(args) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") throw new Error("FFmpeg is required to generate example assets. Install ffmpeg and retry.");
  if (result.status !== 0) throw new Error(`FFmpeg failed: ${result.stderr.trim()}`);
}

for (const [filename, color, offset] of assets) {
  ffmpeg([
    "-f", "lavfi", "-i", `color=c=${color}:s=640x360:d=1`,
    "-vf", `drawbox=x=${offset}:y=60:w=160:h=210:color=white@0.85:t=fill,drawbox=x=${offset + 30}:y=90:w=100:h=100:color=${color}@0.8:t=fill,drawbox=x=40:y=300:w=560:h=8:color=white@0.7:t=fill`,
    "-frames:v", "1", path.join(output, filename),
  ]);
}
ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=20", "-c:a", "pcm_s16le", path.join(output, "example-tone.wav")]);
process.stdout.write(`Generated ${assets.length} synthetic PNG files and one WAV tone in ${output}\n`);
