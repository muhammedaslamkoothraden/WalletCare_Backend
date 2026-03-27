const { User } = require("../models/user");
const Feedback = require("../models/Feedback");

// Update Rating — auto saves when user taps star
exports.updateRating = async (req, res) => {
  try {
    const { rating } = req.body;

    await User.findByIdAndUpdate(req.user._id, { rating });

    return res.status(200).json({ message: "Rating saved successfully." });

  } catch (error) {
    console.error("updateRating error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// Submit Feedback — creates new feedback document
exports.submitFeedback = async (req, res) => {
  try {
    const { category, description, screenshot } = req.body;

    // get current user rating snapshot
    const user = await User.findById(req.user._id);

    await Feedback.create({
      userId: req.user._id,
      rating: user.rating,   // snapshot of current rating
      category,
      description,
      screenshot: screenshot || null,
    });

    return res.status(201).json({ message: "Thank you for your feedback!" });

  } catch (error) {
    console.error("submitFeedback error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// Get My Feedback — returns all feedback submitted by logged in user
exports.getMyFeedback = async (req, res) => {
  try {
    const feedbacks = await Feedback.find({ userId: req.user._id })
      .sort({ createdAt: -1 });

    return res.status(200).json({ data: feedbacks });

  } catch (error) {
    console.error("getMyFeedback error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// Get One Feedback — returns single feedback detail
exports.getFeedbackById = async (req, res) => {
  try {
    const feedback = await Feedback.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!feedback) {
      return res.status(404).json({ message: "Feedback not found" });
    }

    return res.status(200).json({ data: feedback });

  } catch (error) {
    console.error("getFeedbackById error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};