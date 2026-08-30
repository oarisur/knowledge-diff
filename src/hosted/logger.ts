import type { HostedLogger } from "./types";

function write(
  stream: NodeJS.WriteStream,
  level: string,
  message: string,
  fields?: Record<string, unknown>
): void {
  stream.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(fields ?? {}),
    })}\n`
  );
}

export function createJsonLogger(): HostedLogger {
  return {
    info: (message, fields) => write(process.stdout, "info", message, fields),
    warning: (message, fields) => write(process.stderr, "warning", message, fields),
    error: (message, fields) => write(process.stderr, "error", message, fields),
  };
}
