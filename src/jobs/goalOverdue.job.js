const Goal = require("../models/Goal");
const { createNotification } = require("../services/notification.service");

exports.updateOverdueGoals = async () => {
  try {
    const today = new Date();

    const overdueGoals = await Goal.find({
      targetDate: { $lt: today },
      status: "active"
    });

    for (const goal of overdueGoals) {
      goal.status = "overdue";
      await goal.save();

      try {
        await createNotification(
          goal.userId,
          `Your goal "${goal.title}" has missed its target date. Let's adjust your timeline!`,
          "goal_overdue"
        );
      } catch (e) {
        console.error("Overdue notification error:", e.message);
      }
    }

    console.log(`[OverdueJob] Marked ${overdueGoals.length} goals as overdue.`);
  } catch (err) {
    console.error("[OverdueJob] Error:", err.message);
  }
};