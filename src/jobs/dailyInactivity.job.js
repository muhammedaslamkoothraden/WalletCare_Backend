const { User } = require("../models/user");
const Account = require("../models/Account");
const { Notification } = require("../models/Notification");
const { admin, isFirebaseInitialized } = require("../config/firebase");

// Notify users who have had no transaction today (since midnight)
const INACTIVITY_DAYS = 1;

exports.checkDailyInactivity = async () => {
    console.log("Running Daily Inactivity Check...");
    try {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        // CHANGED: threshold = N days ago; accounts with lastTransactionAt before this
        // (or null = never transacted) are considered inactive
        const inactivityThreshold = new Date(Date.now() - INACTIVITY_DAYS * 24 * 60 * 60 * 1000);

        const users = await User.find({}, { _id: 1, fcmToken: 1, createdAt: 1 });

        for (const user of users) {
            // GUARDBAND: newly created users cannot be "inactive for 3 days" if they haven't existed for 3 days.
            if (user.createdAt && user.createdAt > inactivityThreshold) {
                console.log(`[dailyInactivity] Skipping user ${user._id} — Account is less than 1 day old.`);
                continue;
            }

            // CHANGED: check Account.lastTransactionAt instead of Ledger.createdAt today
            const hasActiveAccount = await Account.exists({
                userId: user._id,
                $or: [
                    { lastTransactionAt: { $gte: inactivityThreshold } },
                ],
            });

            if (hasActiveAccount) {
                console.log(`[dailyInactivity] Skipping user ${user._id} — Transacted within the active window.`);
                continue; // user transacted recently — skip
            }

            // CHANGED: dedup guard — skip if we already sent an inactivity FCM today
            const alreadySent = await Notification.findOne({
                userId: user._id,
                type: "INACTIVITY_REMINDER",
                createdAt: { $gte: todayStart },
            }).lean();

            if (alreadySent) {
                console.log(`[dailyInactivity] Already notified user ${user._id} today, skipping.`);
                continue;
            }

            // Save a lightweight DB record only to support the same-day dedup
            // guard on next run. No Socket.IO emit — this notification is
            // specifically for users who are NOT in the app right now.
            try {
                await Notification.create({
                    userId: user._id,
                    title: "Daily Reminder 💡",
                    message: `You haven't recorded any transactions today. Stay on top of your finances with WalletCare!`,
                    category: "SYSTEM",
                    type: "INACTIVITY_REMINDER",
                });
            } catch (dbErr) {
                console.warn(`[dailyInactivity] Failed to save dedup record for ${user._id}:`, dbErr.message);
            }

            // FCM push — reaches the user even when app is backgrounded or closed
            if (isFirebaseInitialized && user.fcmToken) {
                try {
                    await admin.messaging().send({
                        token: user.fcmToken,
                        notification: {
                            title: "Daily Reminder 💡",
                            body: `You haven't recorded any transactions today. Stay on top of your finances!`,
                        },
                        data: {
                            route: "/main",
                            click_action: "FLUTTER_NOTIFICATION_CLICK",
                        },
                        android: {
                            priority: "high",
                            notification: {
                                channelId: "high_importance_channel",
                                priority: "high",
                            },
                        },
                        apns: {
                            headers: { "apns-priority": "10" },
                            payload: {
                                aps: { sound: "default", contentAvailable: true },
                            },
                        },
                    });
                    console.log(`[dailyInactivity] FCM sent to user ${user._id}`);
                } catch (fcmErr) {
                    // Clear stale token so future sends don't waste FCM quota
                    if (
                        fcmErr.code === 'messaging/registration-token-not-registered' ||
                        fcmErr.code === 'messaging/invalid-registration-token'
                    ) {
                        await User.findByIdAndUpdate(user._id, { fcmToken: null });
                        console.warn(`[dailyInactivity] Dead FCM token cleared for user ${user._id}`);
                    } else {
                        console.error(`[dailyInactivity] FCM failed for user ${user._id}:`, fcmErr.code || fcmErr.message);
                    }
                }
            }
        }

        console.log("Daily inactivity check completed");
    } catch (err) {
        console.error("Inactivity job error:", err);
    }
};