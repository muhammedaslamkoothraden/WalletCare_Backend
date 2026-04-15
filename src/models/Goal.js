const mongoose = require("mongoose");

const goalSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    
    // 🗑️ REMOVED: accountId, transactionType, and directiontype
    // Goals are now floating envelopes!

    category: {
      type: String,
      required: true,
      enum: [
        "Savings",
        "Travel",
        "Education",
        "Emergency",
        "Investment",
        "Bills",
        "Business",
        "Other"
      ]
    },

    targetAmount: {
      type: Number,
      required: true,
      min: 1,
    },
    
    currentAmount: {
      type: Number,
      default: 0,
      min: 0
    },

    targetDate: {
      type: Date,
      required: true,
    },

    description: {
      type: String,
      trim: true,
      maxlength: 500
    },

    status: {
      type: String,
      enum: ["active", "completed", "overdue"],
      default: "active",
    },
    
    reminderFrequency: {
      type: String,
      enum: ["daily", "weekly", "monthly", "none"],
      default: "weekly"
    },
    
    sharedWith: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
      }
    ]
  },
  { timestamps: true }
);

// Excellent indexes! These will keep your queries fast.
goalSchema.index({ userId: 1, status: 1 });
goalSchema.index({ userId: 1, targetDate: 1 });

module.exports = mongoose.models.Goal || mongoose.model("Goal", goalSchema);