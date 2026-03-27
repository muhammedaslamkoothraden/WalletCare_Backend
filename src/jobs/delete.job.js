const cron = require("node-cron");
const { User, PendingUser } = require("../models/user");
const Account = require("../models/Account");
const Goal = require("../models/Goal");
const Ledger = require("../models/Ledger");
const Otp = require("../models/otp");

// Runs daily at midnight — deletes accounts past their scheduled deletion date
const startDeletionJob = () => {
  cron.schedule("0 0 * * *", async () => {
    console.log("[DeletionJob] Running scheduled account deletion...");

    try {
      const usersToDelete = await User.find({
        scheduledDeletionAt: { $lte: new Date() },
      });

      if (usersToDelete.length === 0) {
        console.log("[DeletionJob] No accounts to delete.");
        return;
      }

      console.log(`[DeletionJob] Deleting ${usersToDelete.length} account(s)...`);

      for (const user of usersToDelete) {
        const userId = user._id;
        const email = user.email;

        await Promise.all([
          Account.deleteMany({ userId }),
          Goal.deleteMany({ userId }),
          Ledger.deleteMany({ userId }),
          Otp.deleteMany({ identifier: email }),
          PendingUser.deleteMany({ email }),
          User.findByIdAndDelete(userId),
        ]);

        console.log(`[DeletionJob] Deleted account: ${email}`);
      }

      console.log("[DeletionJob] Completed.");
    } catch (error) {
      console.error("[DeletionJob] Error:", error.message);
    }
  });

  console.log("[DeletionJob] Scheduled — runs daily at midnight.");
};

module.exports = { startDeletionJob };