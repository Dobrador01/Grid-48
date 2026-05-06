import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Sweep expired sitrep_queue rows every hour. Each row has a 5 min TTL
// (see createSitrepRequest), so anything older than that is dead weight.
crons.interval(
  "gc sitrep_queue",
  { hours: 1 },
  internal.mutations.gcSitrepQueue,
);

export default crons;
