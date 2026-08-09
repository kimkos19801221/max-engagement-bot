import { spawn, type ChildProcess } from "node:child_process";

type Service = {
  name: string;
  command: string;
  args: string[];
  process: ChildProcess | null;
  restartCount: number;
  restartTimer: NodeJS.Timeout | null;
};

const services: Service[] = [];
let stopping = false;

register("web", "npm", ["run", "web"]);
register("worker", "npm", ["run", "max:watch"]);

process.on("SIGINT", () => stopAll("SIGINT"));
process.on("SIGTERM", () => stopAll("SIGTERM"));
process.on("uncaughtException", (error) => {
  console.error(`[runtime] uncaught exception: ${formatError(error)}`);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[runtime] unhandled rejection: ${formatError(reason)}`);
});

function register(name: string, command: string, args: string[]): void {
  const service: Service = {
    name,
    command,
    args,
    process: null,
    restartCount: 0,
    restartTimer: null
  };
  services.push(service);
  start(service);
}

function start(service: Service): void {
  const child = spawn(service.command, service.args, {
    env: {
      ...process.env,
      ENGAGEMENT_STORAGE: process.env.ENGAGEMENT_STORAGE || "supabase",
      MAX_API_MODE: process.env.MAX_API_MODE || "http"
    },
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });

  service.process = child;
  const stableTimer = setTimeout(() => {
    service.restartCount = 0;
  }, 30_000);
  stableTimer.unref();

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[${service.name}] ${chunk.toString()}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[${service.name}] ${chunk.toString()}`);
  });
  child.on("error", (error) => {
    console.error(`[${service.name}] failed to start: ${formatError(error)}`);
  });
  child.on("exit", (code, signal) => {
    clearTimeout(stableTimer);
    service.process = null;
    if (stopping) {
      return;
    }
    console.error(`[${service.name}] exited with code=${code ?? "null"} signal=${signal ?? "null"}`);
    scheduleRestart(service);
  });
}

function stopAll(reason: string): void {
  if (stopping) {
    return;
  }
  stopping = true;
  console.log(`Stopping Timeweb runtime: ${reason}`);

  for (const service of services) {
    if (service.restartTimer) {
      clearTimeout(service.restartTimer);
      service.restartTimer = null;
    }

    if (service.process && !service.process.killed) {
      service.process.kill("SIGTERM");
    }
  }

  setTimeout(() => {
    for (const service of services) {
      if (service.process && !service.process.killed) {
        service.process.kill("SIGKILL");
      }
    }
    process.exit(reason === "SIGINT" || reason === "SIGTERM" ? 0 : 1);
  }, 10_000).unref();
}

function scheduleRestart(service: Service): void {
  service.restartCount += 1;
  const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(service.restartCount - 1, 6));

  console.error(`[${service.name}] restarting in ${delayMs}ms (attempt ${service.restartCount})`);
  service.restartTimer = setTimeout(() => {
    service.restartTimer = null;
    if (!stopping) {
      start(service);
    }
  }, delayMs);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack ?? ""}`;
  }

  return String(error);
}
