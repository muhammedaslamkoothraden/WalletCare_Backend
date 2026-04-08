'use strict';

const mongoose = require('mongoose');
const Notification = require('../models/Notification');

/**
 * ─── GET NOTIFICATIONS ──────────────────────────────────────────────────────
 * Fetches notifications for the logged-in user.
 * Supports filtering by category (AUTH_SECURITY, WALLET_TRANSACTION, etc.)
 */
exports.getNotifications = async (req, res) => {
  try {
    const userId = req.user._id;
    const { category, limit = 20 } = req.query;

    const query = { userId };
    if (category) query.category = category;

    const parsedLimit = Math.min(parseInt(limit, 10) || 20, 50);

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .limit(parsedLimit)
      .lean();

    // This stays the same - it tells Flutter how many NEW messages exist
    const unreadCount = await Notification.countDocuments({ userId, isRead: false });

    return res.status(200).json({
      success: true,
      unreadCount,
      count: notifications.length,
      data: notifications, // Now contains both Read and Unread
    });
  } catch (error) {
    console.error('[Notification Controller] Get Error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch' });
  }
};

/**
 * ─── MARK AS READ ───────────────────────────────────────────────────────────
 * Updates a single notification's status.
 */
exports.markAsRead = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: 'Invalid notification ID' });
    }

    const notification = await Notification.findOneAndUpdate(
      { _id: id, userId },
      { $set: { isRead: true } },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ success: false, error: 'Notification not found' });
    }

    return res.status(200).json({ success: true, data: notification });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to update notification' });
  }
};

/**
 * ─── MARK ALL AS READ ───────────────────────────────────────────────────────
 * Useful for the "Clear All" button in the Flutter UI.
 */
exports.markAllAsRead = async (req, res) => {
  try {
    const userId = req.user._id;
    const { category } = req.body;

    const query = { userId, isRead: false };
    if (category) query.category = category;

    const result = await Notification.updateMany(query, { $set: { isRead: true } });

    return res.status(200).json({
      success: true,
      message: `${result.modifiedCount} notifications cleared.`,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to clear notifications' });
  }
};
/**
 * ─── DELETE INDIVIDUAL (Separate Clear) ──────────────────────────────────
 * This physically removes a single notification from the database.
 */
exports.deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;
    console.log(`[DELETE] Attempting to delete notification ${id} for user ${userId}`);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      console.log(`[DELETE] Invalid ID: ${id}`);
      return res.status(400).json({ success: false, error: 'Invalid ID' });
    }

    const notification = await Notification.findOneAndDelete({ _id: id, userId });

    if (!notification) {
      console.log(`[DELETE] Notification not found.`);
      return res.status(404).json({ success: false, error: 'Notification not found' });
    }

    console.log(`[DELETE] Successfully deleted.`);
    return res.status(200).json({
      success: true,
      message: 'Notification deleted successfully.',
    });
  } catch (error) {
    console.error(`[DELETE ERROR]`, error);
    return res.status(500).json({ success: false, error: 'Delete failed.' });
  }
};

/**
 * ─── DELETE ALL (Super Clear) ─────────────────────────────────────────────
 * Use this if you want a button that completely empties the notification tray.
 */
exports.deleteAllNotifications = async (req, res) => {
  try {
    const userId = req.user._id;
    await Notification.deleteMany({ userId });

    return res.status(200).json({
      success: true,
      message: 'Notification tray emptied.',
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Clear failed.' });
  }
};