const jwt = require("jsonwebtoken");
const { User } = require("../models/user");

const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    // 1. Check if Authorization header exists and is properly formatted
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Access token missing"
      });
    }

    // 2. Extract access token from header
    const token = authHeader.split(" ")[1];

    // 3. Verify access token using ACCESS_TOKEN_SECRET
    const decoded = jwt.verify(
      token,
      process.env.ACCESS_TOKEN_SECRET
    );

    // 4. Validate that the user still exists in the database
    const user = await User.findById(decoded.userId).select("-password");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User no longer exists"
      });
    }

    // 5. Attach authenticated user to request object
    req.user = user;

    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Access token expired"
      });
    }

    return res.status(401).json({
      success: false,
      message: "Invalid access token"
    });
  }
};

module.exports = protect;
