import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Scheduled reports (convex/reports.ts): starts the ones that are due.
// Report times are on the quarter hour, so a run starts within 15 minutes.
crons.interval("reports due", { minutes: 15 }, internal.reports.runDue, {});

export default crons;
