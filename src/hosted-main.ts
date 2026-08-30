import { loadHostedEnvironment } from "./hosted/config";
import { GitHubAppInstallationClients } from "./hosted/github-auth";
import { createJsonLogger } from "./hosted/logger";
import { HostedAnalysisService } from "./hosted/processor";
import { createHostedServer } from "./hosted/server";

async function main(): Promise<void> {
  const logger = createJsonLogger();
  const environment = loadHostedEnvironment();
  const clients = new GitHubAppInstallationClients({
    appId: environment.githubAppId,
    privateKey: environment.githubPrivateKey,
    apiBaseUrl: environment.githubApiBaseUrl,
    apiVersion: environment.githubApiVersion,
  });
  const processor = new HostedAnalysisService({ environment, clients, logger });
  const hosted = createHostedServer({ environment, processor, logger });
  const address = await hosted.start();
  logger.info("Knowledge Diff hosted service started", address);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Hosted service is shutting down", { signal });
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("Graceful shutdown timed out.")),
        environment.shutdownTimeoutMs
      );
    });
    try {
      await Promise.race([hosted.close(), timeout]);
      logger.info("Hosted service stopped");
    } catch (error) {
      logger.error("Hosted service shutdown failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "fatal",
      message: error instanceof Error ? error.message : String(error),
    })}\n`
  );
  process.exitCode = 1;
});
