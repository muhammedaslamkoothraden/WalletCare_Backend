'use strict';

const Goal = require("../models/Goal");
const { createNotification } = require("../services/notification.service");

exports.updateOverdueGoals = async () => {
  try {
    const today = new Date();

    const overdueGoals = await Goal.find({
      status: "active",
      targetDate: { $lt: today },
    }).lean();

    if (overdueGoals.length === 0) {
      console.log("[OverdueJob] No overdue goals found.");
      return;
    }

    const overdueIds = overdueGoals.map((g) => g._id);

    // Single bulk write instead of N individual .save() calls
    await Goal.updateMany(
      { _id: { $in: overdueIds }, status: "active" },
      { $set: { status: "overdue" } }
    );

    // Fire notifications concurrently — isolated failures don't block others
    const notifications = overdueGoals.map((goal) => {
      // Race guard: user may have extended the date between find() and updateMany
      if (new Date(goal.targetDate) >= today) return Promise.resolve();

      return createNotification(
        goal.userId,
        `Your goal "${goal.title}" has missed its target date. Update your timeline to get back on track!`,
        "goal_overdue"
      ).catch((e) => {
        console.error(
          `[OverdueJob] Notification failed for goal ${goal._id}:`,
          e.message
        );
      });
    });

    await Promise.allSettled(notifications);

    console.log(
      `[OverdueJob] Marked ${overdueGoals.length} goal(s) as overdue.`,
      { goalIds: overdueIds }
    );
  } catch (err) {
    console.error("[OverdueJob] Fatal error:", err.message);
    throw err; // re-throw so scheduler can handle retry
  }
};