const cron = require("node-cron");

const { updateGoalStatus } = require("./goalStatus.job");
const { updateOverdueGoals } = require("./goalOverdue.job");
const { sendGoalReminders } = require("./goalReminder.job");

console.log("Cron jobs initialized...");

/*
-----------------------------------------
Goal Status Update Job
Runs every day at midnight
-----------------------------------------
*/
cron.schedule("0 0 * * *", async () => {
  console.log("Running goal status update job...");
  await updateGoalStatus();
});

/*
-----------------------------------------
Goal Overdue Check Job
Runs every day at 1 AM
-----------------------------------------
*/
cron.schedule("0 1 * * *", async () => {
  console.log("Running goal overdue job...");
  await updateOverdueGoals();
});

/*
-----------------------------------------
Goal Reminder Job
Runs every day at 9 AM
-----------------------------------------
*/
cron.schedule("0 9 * * *", async () => {
  console.log("Running goal reminder job...");
  await sendGoalReminders();
});