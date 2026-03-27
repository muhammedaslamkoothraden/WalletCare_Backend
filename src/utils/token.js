const jwt = require("jsonwebtoken");

// Access token — short-lived, contains userId and role
const generateAccessToken = (userId, role) => {
  return jwt.sign(
    { userId, role },
    process.env.ACCESS_TOKEN_SECRET,
    { expiresIn: process.env.ACCESS_TOKEN_EXPIRY }
  );
};

// Refresh token — long-lived, used to rotate access tokens
const generateRefreshToken = (userId) => {
  return jwt.sign(
    { userId },
    process.env.REFRESH_TOKEN_SECRET,
    { expiresIn: process.env.REFRESH_TOKEN_EXPIRY }
  );
};

// Reset token — proves OTP was verified, used only for password reset
const generateResetToken = (userId) => {
  return jwt.sign(
    { userId, purpose: "reset_password" },
    process.env.ACCESS_TOKEN_SECRET,
    { expiresIn: "10m" }
  );
};

// Verify refresh token
const verifyRefreshToken = (token) => {
  return jwt.verify(token, process.env.REFRESH_TOKEN_SECRET);
};

// Verify reset token — purpose check handled in auth.middleware.js
const verifyResetToken = (token) => {
  return jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  generateResetToken,
  verifyRefreshToken,
  verifyResetToken,
};