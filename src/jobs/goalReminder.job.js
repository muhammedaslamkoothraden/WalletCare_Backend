const Goal = require("../models/Goal");
const { createNotification } = require("../services/notification.service");

exports.sendGoalReminders = async () => {
  const goals = await Goal.find({
    status: "active",
    reminderFrequency: { $ne: "none" }
  });

  const today = new Date();
  const dayOfWeek = today.getDay(); // 0 is Sunday, 1 is Monday...
  const dateOfMonth = today.getDate(); // 1-31

  for (const goal of goals) {
    let shouldSend = false;

    if (goal.reminderFrequency === "daily") {
      shouldSend = true;
    } else if (goal.reminderFrequency === "weekly" && dayOfWeek === 1) { // Monday
      shouldSend = true;
    } else if (goal.reminderFrequency === "monthly" && dateOfMonth === 1) { // 1st of month
      shouldSend = true;
    }

    if (shouldSend) {
      try {
        await createNotification(
          goal.userId,
          `Reminder: Save money for goal "${goal.title}".`,
          "goal_reminder",
          { title: "Goal Reminder" },
          null
        );
      } catch (e) {
        console.error("Goal reminder error:", e.message);
      }
    }
  }
};