import { internalQuery } from "./_generated/server";
import { v } from "convex/values";

export const getSitrepStatus = internalQuery({
  args: { request_id: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("sitrep_queue")
      .withIndex("by_request_id", (q) => q.eq("request_id", args.request_id))
      .first();
  },
});
