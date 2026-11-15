import { closeDb } from "@finn/db";
import { parseArgv, UsageError } from "./args";
import { buildRegistry, loadResearchCommands, usage } from "./commands";
import { createLogger, createWorkerContext } from "./container";

async function main(argv: string[]): Promise<number> {
  const { command, args } = parseArgv(argv);
  const research = await loadResearchCommands();
  const registry = buildRegistry(research.commands);
  if (!command || command === "help" || args.help === true) {
    console.log(usage(registry));
    if (research.error) console.log(`\n(research commands unavailable: ${research.error.message})`);
    return command ? 0 : 1;
  }
  const cmd = registry.get(command);
  if (!cmd) {
    if (research.error && command.startsWith("research")) {
      console.error(`Research commands failed to load: ${research.error.stack ?? research.error.message}`);
      return 1;
    }
    console.error(`Unknown command "${command}"\n\n${usage(registry)}`);
    return 2;
  }

  const ctx = createWorkerContext(process.env);
  const started = Date.now();
  try {
    await cmd.run(ctx, args);
    ctx.log.info({ command, ms: Date.now() - started }, "Command completed");
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${command}: ${err.message}`);
      return 2;
    }
    ctx.log.error({ command, ms: Date.now() - started, error: err instanceof Error ? (err.stack ?? err.message) : String(err) }, "Command failed");
    return 1;
  }
}

main(process.argv.slice(2))
  .catch((err) => {
    createLogger(process.env).error({ error: err instanceof Error ? (err.stack ?? err.message) : String(err) }, "Worker crashed");
    return 1;
  })
  .then(async (code) => {
    await closeDb().catch(() => {});
    process.exit(code);
  });
