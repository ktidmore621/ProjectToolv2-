import express from "express";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";

const app = buildApp((app) => {
  // Serve the built client in production
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const clientDist = join(__dirname, "..", "..", "client", "dist");
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(clientDist, "index.html")));
  }
});

const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => console.log(`Accio API on http://localhost:${PORT}`));
