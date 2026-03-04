const cron = require("node-cron");
const Goal = require("../models/Goal");

cron.schedule("0 0 * * *", async () => {
  try {
    const today = new Date();

    await Goal.updateMany(
      {
        targetDate: { $lt: today },
        status: "active"
      },
      { $set: { isOverdue: true } }
    );

    console.log("Overdue goals updated");
  } catch (err) {
    console.error("Cron job error:", err.message);
  }
});