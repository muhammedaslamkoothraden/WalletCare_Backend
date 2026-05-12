const cron = require("node-cron");

const { updateOverdueGoals } = require("./goalOverdue.job");
const { sendGoalReminders } = require("./goalReminder.job");
const { runReconciliationJob } = require("./ReconciliationJob");
const { checkDailyInactivity } = require("./dailyInactivity.job");

console.log("Cron jobs initialized...");

/*
Goal Overdue Check Job
Runs every day at midnight
*/
cron.schedule("0 0 * * *", async () => {
  console.log("[Cron] Running goal overdue job...");
  await updateOverdueGoals();
});

/*
Goal Reminder Job
Runs every day at 9 AM
*/
cron.schedule("0 9 * * *", async () => {
  console.log("[Cron] Running goal reminder job...");
  await sendGoalReminders();
});

/*
Reconciliation Job
Runs every day at 2 AM
*/
cron.schedule("0 2 * * *", async () => {
  console.log("[Cron] Running reconciliation job...");
  await runReconciliationJob();
});

/*
Daily Inactivity Reminder Job
Runs every day at 8 PM
*/
cron.schedule("0 20 * * *", async () => {
  console.log("[Cron] Running daily inactivity job...");
  await checkDailyInactivity();
});

/*
Monthly AI Summary Notification Job
Runs on the 1st of every month at 10:00 AM IST (UTC+5:30 = 04:30 UTC)
Summarises last month's spending for all active users using Claude AI.
*/
cron.schedule("30 4 1 * *", async () => {
  console.log("[Cron] Running monthly AI summary job...");
  await runMonthlySummaryJob();
});