import express, { Express, NextFunction, Request, Response } from "express";
import { config } from "./routes/config.js";
import { dashboard } from "./routes/dashboard.js";
import { importexport } from "./routes/importexport.js";
import { projects, tasks } from "./routes/projects.js";
import { activities, timelogs } from "./routes/timelogs.js";
import { wins } from "./routes/wins.js";
import { db } from "./db.js";

/**
 * Builds the API app. `extraRoutes` lets tests mount routes that run *before*
 * the error middleware (Express only forwards errors to handlers registered
 * after the failing route).
 */
export function buildApp(extraRoutes?: (app: Express) => void): Express {
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

  extraRoutes?.(app);

  // B7: centralized JSON error handling. Without this, an unhandled exception
  // fell through to Express's HTML error page and the frontend could only show
  // "Request failed (500)". Full details and stack traces go to the server log
  // only — never to the client.
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    if (err?.type === "entity.parse.failed")
      return res.status(400).json({ error: "The request body wasn't valid JSON." });
    console.error(`[api] ${req.method} ${req.originalUrl} failed:`, err);
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    res.status(status).json({
      error: "Something went wrong on the server. The details were logged — try again, and report it if it keeps happening.",
    });
  });

  return app;
}
