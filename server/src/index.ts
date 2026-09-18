import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { config, buildModelChain } from "./config.js";
import { initRepo, repoMode } from "./repoManager.js";
import { reconcileFromGit } from "./proposalStore.js";
import { rulesRouter } from "./routes/rules.js";
import { proposalsRouter } from "./routes/proposals.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const { mode } = await initRepo();
  await reconcileFromGit(path.join(config.runtimeDir, "primary"));

  const app = express();
  app.use(cors(config.corsOrigin ? { origin: config.corsOrigin } : {}));
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/status", (_req, res) => {
    res.json({
      repoMode: repoMode(),
      runtimeMode: mode,
      modelChain: buildModelChain().map((c) => c.label),
      hasGitRepoUrl: Boolean(config.gitRepoUrl),
    });
  });

  app.use("/api/rules", rulesRouter);
  app.use("/api/proposals", proposalsRouter);

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
      res.type("text/plain").send("RiskDiff API is running. web/dist not found -- build the frontend to serve it from here."),
    );
  }

  app.listen(config.port, () => {
    console.log(`RiskDiff server listening on :${config.port} (git runtime mode: ${mode})`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
