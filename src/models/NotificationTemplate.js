const mongoose = require("mongoose");

/**
 * NotificationTemplate
 * ─────────────────────────────────────────────────────────────────────────────
 * Stores admin-created notification drafts/templates that persist across
 * sessions and are shared between all admins. These are NOT user notifications
 * (that's the Notification model) — these are reusable admin panel templates.
 *
 * Used by: Notifications page (broadcast) + UserDetail page (send to user)
 */
const notificationTemplateSchema = new mongoose.Schema(
  {
    title: {
      type:      String,
      required:  true,
      trim:      true,
      maxlength: 100,
    },
    message: {
      type:      String,
      required:  true,
      trim:      true,
      maxlength: 255,
    },
    // Default broadcast filter — matches FILTERS keys in adminNotification.service.js
    filter: {
      type:    String,
      enum:    ["active", "all", "premium", "free", "verified", "banned", "pending_deletion"],
      default: "active",
    },
    // Which admin created this template
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  "User",
      required: true,
    },
    createdByName: {
      type: String,
      default: "",
    },
    // Tracks the last broadcast made from this template (not per-user sends)
    lastBroadcastAt: {
      type:    Date,
      default: null,
    },
    lastBroadcastResult: {
      total:  { type: Number, default: null },
      sent:   { type: Number, default: null },
      failed: { type: Number, default: null },
    },
    broadcastCount: {
      type:    Number,
      default: 0,
    },
  },
  { timestamps: true }
);

// Index so list fetches are fast (newest first)
notificationTemplateSchema.index({ createdAt: -1 });

const NotificationTemplate =
  mongoose.models.NotificationTemplate ||
  mongoose.model("NotificationTemplate", notificationTemplateSchema);

module.exports = { NotificationTemplate };