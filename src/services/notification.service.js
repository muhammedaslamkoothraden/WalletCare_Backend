const { Notification } = require("../models/Notification");
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
  // Admin-sent
  admin_broadcast: { type: "ADMIN_BROADCAST", category: "SYSTEM", title: "Message from GreenPouch" },
  admin_message:   { type: "ADMIN_MESSAGE",   category: "SYSTEM", title: "Message from GreenPouch" },
  // Fallback
  system_info: { type: "SYSTEM_INFO", category: "SYSTEM", title: "System Notification" },
};

// ─── sendHybridNotification ───────────────────────────────────────────────────
//
// Low-level delivery function. Takes fully-resolved arguments — callers that
// have already looked up title, category, and typeInfo can call this directly.
// Most internal callers should use createNotification() below instead.

async function sendHybridNotification(userId, message, title, category, typeInfo) {
  // 1. Save to DB for history
  const notification = await Notification.create({
    userId,
    message,
    title,
    category,
    type: typeInfo.type,
  });

  // 2. Foreground / Real-Time: Emit to WebSocket Room
  let isOnline = false;
  try {
    isOnline = socketService.isUserOnline(userId);
    socketService.sendNotification(userId, notification.toObject());
  } catch (socketErr) {
    console.warn('[notify] WebSocket push failed', { error: socketErr.message, userId });
  }

  // 3. FCM Push — user fetch moved inside this block
  // Only query the DB for fcmToken when Firebase is initialized
  // No point fetching if Firebase isn't ready
  if (isFirebaseInitialized) {
    const user = await User.findById(userId).select('fcmToken').lean();

    if (user?.fcmToken) {
      const fcmPayload = {
        token: user.fcmToken,
        notification: {
          title,
          body: message,
        },
        data: {
          route: '/main',
          notificationId: String(notification._id),
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
        },
        android: {
          priority: 'high',
          notification: {
            channelId: 'high_importance_channel',
            priority: 'high',
          },
        },
        apns: {
          headers: { 'apns-priority': '10' },
          payload: {
            aps: {
              sound: 'default',
              contentAvailable: true,
            },
          },
        },
      };

      try {
        await admin.messaging().send(fcmPayload);
        console.log('[notify] FCM push sent', { userId });
      } catch (fcmErr) {
        console.error('[notify] FCM push failed', { code: fcmErr.code, userId });

        if (
          fcmErr.code === 'messaging/invalid-registration-token' ||
          fcmErr.code === 'messaging/registration-token-not-registered'
        ) {
          console.warn('[notify] Dead FCM token removed', { userId });
          await User.findByIdAndUpdate(userId, { fcmToken: null });
        }
      }
    }
  }

  return notification;
}

// ─── createNotification ───────────────────────────────────────────────────────
//
// Public API used by all controllers and jobs.
//
// @param {ObjectId|string} userId   — recipient
// @param {string}          message  — notification body text
// @param {string}          typeKey  — shorthand key from TYPE_MAP (e.g. "low_balance")
//                                     OR a raw schema enum value (e.g. "LOW_BALANCE")
// @param {{ title?, category? }} [overrides] — optional, takes precedence over TYPE_MAP
//
// Throws if typeKey cannot be resolved — callers should .catch() and log,
// never let a notification failure abort a financial transaction.

async function createNotification(userId, message, typeKey, overrides = {}) {
  // Resolve typeKey: try lowercase shorthand first, then uppercase schema value.
  const normalizedKey = typeKey?.toLowerCase();
  const typeInfo = TYPE_MAP[normalizedKey] ?? TYPE_MAP[typeKey];

  if (!typeInfo) {
    throw new Error(`[notify] Unknown typeKey: "${typeKey}". Add it to TYPE_MAP.`);
  }

  const title    = overrides.title    ?? typeInfo.title;
  const category = overrides.category ?? typeInfo.category;

  return sendHybridNotification(userId, message, title, category, typeInfo);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { createNotification, sendHybridNotification };