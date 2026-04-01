const jwt = require("jsonwebtoken");
const { User } = require("../models/user");

const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Access token missing" });
    }

    const token = authHeader.split(" ")[1];

    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);

    // Block resetToken — it carries a purpose field, accessToken never does
    if (decoded.purpose) {
      return res.status(401).json({ success: false, message: "Invalid access token" });
    }

    const user = await User.findById(decoded.userId).select("-password");

    if (!user) {
      return res.status(401).json({ success: false, message: "User no longer exists" });
    }

    // Block banned users
    if (user.isBanned) {
      return res.status(403).json({ success: false, message: "Your account has been suspended" });
    }

    // Block admin from user routes
    if (user.role === "admin") {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    req.user = user;
    next();

  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ success: false, message: "Access token expired" });
    }

    return res.status(401).json({ success: false, message: "Invalid access token" });
  }
};

module.exports = protect;