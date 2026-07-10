import express from "express";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./db.js";
import { config } from "./routes/config.js";
import { dashboard } from "./routes/dashboard.js";
import { importexport } from "./routes/importexport.js";
import { projects, tasks } from "./routes/projects.js";
import { activities, timelogs } from "./routes/timelogs.js";
import { wins } from "./routes/wins.js";

const app = express();
app.use(express.json({ limit: "5mb" }));

app.use("/api/projects", projects);
app.use("/api/tasks", tasks);
app.use("/api/timelogs", timelogs);
app.use("/api/activities", activities);
app.use("/api/wins", wins);
app.use("/api/dashboard", dashboard);
app.use("/api", importexport);
app.use("/api", config);

app.get("/api/health", (_req, res) => {
  const n = (db.prepare("SELECT COUNT(*) AS n FROM picklists").get() as any).n;
  res.json({ ok: true, seeded: n > 0 });
});

// Serve the built client in production
const __dirname = dirname(fileURLToPath(import.meta.url));
const clientDist = join(__dirname, "..", "..", "client", "dist");
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(clientDist, "index.html")));
}

const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => console.log(`Accio API on http://localhost:${PORT}`));
