/**
 * Seed CLI. Idempotent: skips seeding if picklists already exist.
 * Run `npm run seed -- --reset` to wipe and reseed.
 */
import { isSeeded, resetData, seed } from "./seedData.js";

if (process.argv.includes("--reset")) resetData();

if (isSeeded()) {
  console.log("Database already seeded — run with --reset to wipe and reseed.");
  process.exit(0);
}

seed();
console.log("Seed complete.");
