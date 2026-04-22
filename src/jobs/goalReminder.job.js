exports.sendGoalReminders = async () => {
  const goals = await Goal.find({
    status: "active",
    reminderFrequency: { $ne: "none" }
  });

  const today = new Date();
  const dayOfWeek = today.getDay();
  const dateOfMonth = today.getDate();

  for (const goal of goals) {
    let shouldSend = false;

    if (goal.reminderFrequency === "daily") {
      shouldSend = true;
    } else if (goal.reminderFrequency === "weekly" && dayOfWeek === 1) {
      shouldSend = true;
    } else if (goal.reminderFrequency === "monthly" && dateOfMonth === 1) {
      shouldSend = true;
    }

    if (shouldSend) {
      try {
        await createNotification(
          goal.userId,
          `Reminder: Save money for your goal "${goal.title}".`,
          "goal_reminder"
          // no overrides needed — TYPE_MAP already sets the correct title
        );
      } catch (e) {
        console.error("[GoalReminder] Notification failed:", e.message);
      }
    }
  }
};