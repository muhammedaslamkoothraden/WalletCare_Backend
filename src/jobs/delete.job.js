const cron = require("node-cron");
const { User, PendingUser } = require("../models/user");
const Account = require("../models/Account");
const Goal = require("../models/Goal");
const Ledger = require("../models/Ledger");
const Otp = require("../models/otp");

// runs every day at midnight
// finds users whose scheduledDeletionAt has passed and deletes all their data
const startDeletionJob = () => {
  cron.schedule("0 0 * * *", async () => {
    console.log("[DeletionJob] Running scheduled account deletion...");

    try {
      // find all users past their deletion date
      const usersToDelete = await User.find({
        scheduledDeletionAt: { $lte: new Date() }
      });

      if (usersToDelete.length === 0) {
        console.log("[DeletionJob] No accounts to delete.");
        return;
      }

      console.log(`[DeletionJob] Deleting ${usersToDelete.length} account(s)...`);

      for (const user of usersToDelete) {
        const userId = user._id;
        const email = user.email;

        // delete all related documents
        await Promise.all([
          Account.deleteMany({ userId }),
          Goal.deleteMany({ userId }),
          Ledger.deleteMany({ userId }),
          Otp.deleteMany({ identifier: email }),
          PendingUser.deleteMany({ email }),
          User.findByIdAndDelete(userId)
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