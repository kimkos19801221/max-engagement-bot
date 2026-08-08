import { spawn, type ChildProcess } from "node:child_process";

type Service = {
  name: string;
  command: string;
  args: string[];
  process: ChildProcess;
};

const services: Service[] = [];
let stopping = false;

start("web", "npm", ["run", "web"]);
start("worker", "npm", ["run", "max:watch"]);

process.on("SIGINT", () => stopAll("SIGINT"));
process.on("SIGTERM", () => stopAll("SIGTERM"));

function start(name: string, command: string, args: string[]): void {
  const child = spawn(command, args, {
    env: {
      ...process.env,
      ENGAGEMENT_STORAGE: process.env.ENGAGEMENT_STORAGE || "supabase",
      MAX_API_MODE: process.env.MAX_API_MODE || "http"
    },
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });

  const service: Service = {
    name,
    command,
    args,
    process: child
  };
  services.push(service);

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[${name}] ${chunk.toString()}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[${name}] ${chunk.toString()}`);
  });
  child.on("exit", (code, signal) => {
    if (stopping) {
      return;
    }
    console.error(`[${name}] exited with code=${code ?? "null"} signal=${signal ?? "null"}`);
    stopAll(`service ${name} exited`);
  });
}

function stopAll(reason: string): void {
  if (stopping) {
    return;
  }
  stopping = true;
  console.log(`Stopping Timeweb runtime: ${reason}`);

  for (const service of services) {
    if (!service.process.killed) {
      service.process.kill("SIGTERM");
    }
  }

  setTimeout(() => {
    for (const service of services) {
      if (!service.process.killed) {
        service.process.kill("SIGKILL");
      }
    }
    process.exit(1);
  }, 10_000).unref();
}
