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
          "goal_overdue",
          { title: "Goal Overdue" },
          null
        );
      } catch (e) {
        console.error("Overdue notification error:", e.message);
      }
    }

    console.log("Overdue goals checked and updated");
  } catch (err) {
    console.error("Cron job error:", err.message);
  }
};