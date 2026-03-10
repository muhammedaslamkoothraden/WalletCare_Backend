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

    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true
    },
    transactionType: {
      type: String,
      enum: ["expense", "reserved"],
      default: "expense"
    },
    directiontype: {
      type: String,
      enum: ["NORMAL", "GOAL_ALLOCATION", "GOAL_DEALLOCATION"],
      default: "NORMAL"
    },

    category: {
      type: String,
      required: true,
      enum: [
        "Savings",
        "Travel",
        "Education",
        "Emergency",
        "Investment",
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

    status: {
      type: String,
      enum: ["active", "completed", "overdue"],
      default: "active",
    },
    reminderFrequency: {
      type: String,
      enum: ["daily", "weekly", "monthly", "none"],
      default: "weekly"
    }
  },
  { timestamps: true }

);
goalSchema.index({ userId: 1, status: 1 });
goalSchema.index({ userId: 1, targetDate: 1 });



module.exports = mongoose.models.Goal || mongoose.model("Goal", goalSchema);
