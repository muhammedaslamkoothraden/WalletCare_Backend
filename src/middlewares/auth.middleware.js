const mongoose = require("mongoose");

const authMiddleware = (req, res, next) => {
  try {
    // Temporary fake logged-in user
    const fakeUserId = "69a7c2ee3b7e643684e7b2d0";

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