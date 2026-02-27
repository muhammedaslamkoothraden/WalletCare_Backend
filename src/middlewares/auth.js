const mongoose = require("mongoose");

const authMiddleware = (req, res, next) => {
  try {
    // Temporary fake logged-in user
    const fakeUserId = "699e8fea9a6c85ac1f0970eb";

    req.user = {
      id: new mongoose.Types.ObjectId(fakeUserId)
    };

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Authentication failed"
    });
  }
};

module.exports = authMiddleware;