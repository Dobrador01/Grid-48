import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Poll Celesc power grid data every 5 minutes
crons.interval(
  "celesc-poll",
  { minutes: 5 },
  internal.celesc.pollCelesc,
);

export default crons;
