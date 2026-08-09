import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const heartbeatPath = resolve(
  process.env.MAX_POLL_HEARTBEAT_FILE || ".local-data/runtime/max-poll-heartbeat.json"
);
const maxAgeMs = Math.max(
  30_000,
  Number(process.env.MAX_WORKER_HEARTBEAT_MAX_AGE_MS || 180_000)
);

try {
  const heartbeat = JSON.parse(await readFile(heartbeatPath, "utf8"));
  const at = Date.parse(String(heartbeat.at || ""));
  const ageMs = Date.now() - at;

  if (!Number.isFinite(at)) {
    throw new Error(`Invalid heartbeat timestamp in ${heartbeatPath}`);
  }

  if (ageMs > maxAgeMs) {
    throw new Error(`Stale heartbeat: age=${ageMs}ms max=${maxAgeMs}ms`);
  }

  console.log(`worker heartbeat ok: status=${heartbeat.status} age=${ageMs}ms`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
