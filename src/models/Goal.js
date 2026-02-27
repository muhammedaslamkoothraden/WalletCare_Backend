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
      enum: ["active", "completed"],
      default: "active",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Goal || mongoose.model("Goal", goalSchema);