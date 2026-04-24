const jwt = require("jsonwebtoken");
const { User } = require("../models/user");

const adminMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Access token missing" });
    }

    const token = authHeader.split(" ")[1];

    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);

    // Block resetToken
    if (decoded.purpose) {
      return res.status(401).json({ success: false, message: "Invalid access token" });
    }

    const user = await User.findById(decoded.userId).select("-password");

    if (!user) {
      return res.status(401).json({ success: false, message: "User no longer exists" });
    }

    // Admin check — only addition compared to protect middleware
    if (user.role !== "admin" && user.role !== "superadmin") {
      return res.status(403).json({ success: false, message: "Access denied. Admins only." });
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

// Superadmin-only middleware
const requireSuperAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Access token missing" });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);

    if (decoded.purpose) {
      return res.status(401).json({ success: false, message: "Invalid access token" });
    }

    const user = await User.findById(decoded.userId).select("-password");

    if (!user) {
      return res.status(401).json({ success: false, message: "User no longer exists" });
    }

    // Superadmin check
    if (user.role !== "superadmin") {
      return res.status(403).json({ success: false, message: "Access denied. Superadmins only." });
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

module.exports = { adminMiddleware, requireSuperAdmin };