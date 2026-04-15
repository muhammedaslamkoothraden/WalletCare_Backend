'use strict';

const mongoose = require('mongoose');
const { Notification } = require('../models/Notification');


const VALID_CATEGORIES = ['AUTH_SECURITY', 'WALLET_TRANSACTION', 'GOAL_PLANNING', 'SYSTEM'];

/**
 * ─── GET NOTIFICATIONS ──────────────────────────────────────────────────────
 * Fetches notifications for the logged-in user.
 * Supports filtering by category (AUTH_SECURITY, WALLET_TRANSACTION, etc.)
 */
exports.getNotifications = async (req, res) => {
  if (!req.user?._id) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

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
    console.error('Failed to fetch notifications', { error: error.message });
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
    console.error('Failed to update notification', { error: error.message });
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

    if (category && !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, error: 'Invalid category value' });
    }

    const query = { userId, isRead: false };
    if (category) query.category = category;

    const result = await Notification.updateMany(query, { $set: { isRead: true } });

    return res.status(200).json({
      success: true,
      message: `${result.modifiedCount} notifications cleared.`,
    });
  } catch (error) {
    console.error('Failed to clear notifications', { error: error.message });
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
    console.log('Delete notification requested', { notificationId: id, userId });

    if (!mongoose.Types.ObjectId.isValid(id)) {
      console.warn('Invalid notification ID in delete request', { id, userId });
      return res.status(400).json({ success: false, error: 'Invalid ID' });
    }

    const notification = await Notification.findOneAndDelete({ _id: id, userId });

    if (!notification) {
      console.warn('Notification not found for deletion', { notificationId: id, userId });
      return res.status(404).json({ success: false, error: 'Notification not found' });
    }

    console.log('Notification deleted', { notificationId: id, userId });
    return res.status(200).json({
      success: true,
      message: 'Notification deleted successfully.',
    });
  } catch (error) {
    console.error('Notification delete failed', { error: error.message, notificationId: req.params.id, userId: req.user?._id });
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
    const result = await Notification.deleteMany({ userId });
    console.log('Notification tray cleared', { userId, deletedCount: result.deletedCount });

    return res.status(200).json({
      success: true,
      message: 'Notification tray emptied.',
    });
  } catch (error) {
    console.error('Failed to clear notification tray', { error: error.message });
    return res.status(500).json({ success: false, error: 'Clear failed.' });
  }
};