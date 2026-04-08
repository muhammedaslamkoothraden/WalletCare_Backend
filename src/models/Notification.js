'use strict';

const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: [100, 'Title cannot exceed 100 characters'],
    },
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: [255, 'Message cannot exceed 255 characters'],
    },
    
    // ─── THE 3-PART ARCHITECTURE CATEGORY ─────────────────────────────────
    category: {
      type: String,
      enum: ['AUTH_SECURITY', 'WALLET_TRANSACTION', 'GOAL_PLANNING', 'SYSTEM'],
      required: true,
      default: 'SYSTEM',
    },

    // ─── SPECIFIC NOTIFICATION TYPES ──────────────────────────────────────
    type: {
      type: String,
      enum: [ 
        'WELCOME',
        
        'LOW_BALANCE', 
        'LARGE_TRANSACTION', 
        'TRANSFER_SUCCESS',
        
        // Part 3: Goals & Analytics
        'GOAL_REMINDER', 
        'GOAL_COMPLETED', 
        'GOAL_OVERDUE', 
        'WEEKLY_SUMMARY',

        // General
        'SYSTEM_INFO'
      ],
      required: true,
    },
    
    // Optional: Links the user directly to the relevant screen when they click
    // e.g., if type is 'LOW_BALANCE', referenceId is the Account ID
    // e.g., if type is 'GOAL_COMPLETED', referenceId is the Goal ID
    referenceId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null, 
    },
    
    isRead: {
      type: Boolean,
      default: false,
      index: true, // Speeds up the "unread count" queries
    },
  },
  { timestamps: true }
);

// Compound index: highly optimized for finding a user's newest unread alerts
notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

module.exports = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);