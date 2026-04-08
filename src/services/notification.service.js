const Notification = require("../models/Notification");
const { User } = require("../models/user");
const socketService = require("./socket.service");
const { admin, isFirebaseInitialized } = require("../config/firebase");

/**
 * Type → { schemaType, category, title } mapping.
 * Keeps callers using shorthand strings while satisfying the Mongoose enum.
 */
const TYPE_MAP = {
  // Goals
  goal_reminder: { type: "GOAL_REMINDER", category: "GOAL_PLANNING", title: "Goal Reminder" },
  goal_completed: { type: "GOAL_COMPLETED", category: "GOAL_PLANNING", title: "Goal Completed 🎉" },
  goal_overdue: { type: "GOAL_OVERDUE", category: "GOAL_PLANNING", title: "Goal Overdue" },
  // Transactions
  low_balance: { type: "LOW_BALANCE", category: "WALLET_TRANSACTION", title: "Low Balance Alert" },
  large_transaction: { type: "LARGE_TRANSACTION", category: "WALLET_TRANSACTION", title: "Large Transaction" },
  transfer_success: { type: "TRANSFER_SUCCESS", category: "WALLET_TRANSACTION", title: "Transfer Successful" },
  // Analytics
  weekly_summary: { type: "WEEKLY_SUMMARY", category: "GOAL_PLANNING", title: "Weekly Summary" },
  // Auth
  welcome: { type: "WELCOME", category: "AUTH_SECURITY", title: "Welcome to WalletCare!" },
  // Fallback
  system_info: { type: "SYSTEM_INFO", category: "SYSTEM", title: "System Notification" },
};

/**
 * createNotification(userId, message, typeKey, [overrides])
 *
 * typeKey can be a shorthand (e.g. "goal_reminder") or a schema enum value.
 * overrides = { title, category } — optional, takes precedence.
 *
 * Emits a live socket event immediately after saving so Flutter updates instantly.
 */
/**
 * Clean, Reusable Double-Emit Function
 */
async function sendHybridNotification(userId, message, title, category, typeInfo) {
  // 1. Save to DB for history
  const notification = await Notification.create({
    userId,
    message,
    title,
    category,
    type: typeInfo.type,
  });

  const user = await User.findById(userId).select("fcmToken");

  // 2. Foreground / Real-Time: Emit to WebSocket Room
  let isOnline = false;
  try {
    isOnline = socketService.isUserOnline(userId);
    socketService.sendNotification(userId, notification.toObject());
  } catch (socketErr) {
    console.warn("⚠️ WebSocket Push failed:", socketErr.message);
  }

  // 3. ALWAYS emit FCM Push (OS manages background display natively, Flutter handles dupes locally)
  if (isFirebaseInitialized && user && user.fcmToken) {
    const fcmPayload = {
      token: user.fcmToken,
      // The 'notification' object makes the OS natively show the system banner
      notification: {
        title: title,
        body: message,
      },
      // The 'data' object passes routing rules to Flutter's navigatorKey
      data: {
        route: '/main', // You can map specialized routes string based on `category` here
        notificationId: String(notification._id),
        click_action: "FLUTTER_NOTIFICATION_CLICK"
      },
      android: {
        priority: "high",
        notification: {
          channelId: "high_importance_channel",
          priority: "high"
        }
      },
      apns: {
        headers: {
          "apns-priority": "10"
        },
        payload: {
          aps: {
            sound: "default",
            contentAvailable: true
          }
        }
      }
    };

    try {
      await admin.messaging().send(fcmPayload);
      console.log(`✅ FCM Push successfully sent to User ${userId}`);
    } catch (fcmErr) {
      console.error(`❌ FCM Push failed:`, fcmErr.code);

      // ERROR HANDLING: Cleanup dead or invalid tokens automatically
      if (
        fcmErr.code === 'messaging/invalid-registration-token' ||
        fcmErr.code === 'messaging/registration-token-not-registered'
      ) {
        console.log(`🧹 Removing dead FCM token for User ${userId}`);
        await User.findByIdAndUpdate(userId, { fcmToken: null });
      }
    }
  }

  return notification;
}

exports.createNotification = async (userId, message, typeKey, overrides = {}) => {
  const key = (typeKey || "").toLowerCase().replace(/-/g, "_");
  const mapped = TYPE_MAP[key] || TYPE_MAP["system_info"];

  const title = overrides.title || mapped.title;
  const category = overrides.category || mapped.category;

  return await sendHybridNotification(userId, message, title, category, mapped);
};