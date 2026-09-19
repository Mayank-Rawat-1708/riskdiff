import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { config, buildModelChain, describeEnvironment } from "./config.js";
import { initRepo, repoMode, getLastPushError, primaryDir } from "./repoManager.js";
import { reconcileFromGit } from "./proposalStore.js";
import { rulesRouter } from "./routes/rules.js";
import { proposalsRouter } from "./routes/proposals.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const { mode } = await initRepo();
  await reconcileFromGit(primaryDir());

  const app = express();
  app.use(cors(config.corsOrigin ? { origin: config.corsOrigin } : {}));
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/status", (_req, res) => {
    const chain = buildModelChain();
    res.json({
      repoMode: repoMode(),
      runtimeMode: mode,
      modelChain: chain.map((c) => c.label),
      hasGitRepoUrl: Boolean(config.gitRepoUrl),
      // Non-fatal: the merge landed locally, the push didn't. The
      // status bar says so rather than the analyst discovering it on
      // GitHub later.
      pushError: getLastPushError(),
    });
  });

  app.use("/api/rules", rulesRouter);
  app.use("/api/proposals", proposalsRouter);

  app.use("/api", (_req, res) => res.status(404).json({ error: "No such endpoint." }));

  // Serve the built web app if present (single-service Render deploy).
  // In local dev without a web build yet, the API still runs fine on
  // its own -- run `npm run dev` in web/ separately and point it at
  // this server's port.
  const webDist = path.resolve(__dirname, "..", "..", "web", "dist");
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));
  } else {
    app.get("/", (_req, res) =>
      res
        .type("text/plain")
        .send("RiskDiff API is running. web/dist not found -- build the frontend to serve it from here."),
    );
  }

  app.listen(config.port, () => {
    console.log(`RiskDiff listening on :${config.port}`);
    console.log(describeEnvironment());
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
