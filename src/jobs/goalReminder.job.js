const Goal = require("../models/Goal");
const notificationService = require("../services/notification.service");

exports.sendGoalReminders = async () => {

  const goals = await Goal.find({
    status: "active",
    reminderFrequency: { $ne: "none" }
  });

  for (const goal of goals) {

    await notificationService.createNotification(
      goal.userId,
      `Reminder: Save money for goal "${goal.title}"`,
      "goal_reminder"
    );

  }

};