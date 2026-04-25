const mongoose = require("mongoose");

const FEEDBACK_CATEGORIES = ["Bug Report", "Feature Request", "UI/UX Issue",
  "Transaction Issue", "Security Concern", "Other"];

const feedbackSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    rating: {
      type: Number,
      min: 1,
      max: 5,
      default: null, // snapshot of user's rating at submit time
    },
    category: {
      type: String,
      enum: FEEDBACK_CATEGORIES,
      required: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
    screenshot: {
      type: String,
      default: null, // image URL
    },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Feedback || mongoose.model("Feedback", feedbackSchema);