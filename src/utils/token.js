const jwt = require("jsonwebtoken");

// short-lived — contains userId and role, used to access protected routes
const generateAccessToken = (userId, role) => {
  return jwt.sign(
    { userId, role },
    process.env.ACCESS_TOKEN_SECRET,
    { expiresIn: process.env.ACCESS_TOKEN_EXPIRY }
  );
};

// long-lived — minimal payload, used to rotate access tokens
const generateRefreshToken = (userId) => {
  return jwt.sign(
    { userId },
    process.env.REFRESH_TOKEN_SECRET,
    { expiresIn: process.env.REFRESH_TOKEN_EXPIRY }
  );
};

// short-lived — proves OTP was verified, used only for password reset flow
const generateResetToken = (userId) => {
  return jwt.sign(
    { userId, purpose: "reset_password" },
    process.env.ACCESS_TOKEN_SECRET,
    { expiresIn: "10m" }
  );
};

// verify refresh token — throws TokenExpiredError or JsonWebTokenError
const verifyRefreshToken = (token) => {
  return jwt.verify(token, process.env.REFRESH_TOKEN_SECRET);
};

// verify reset token — throws TokenExpiredError or JsonWebTokenError
const verifyResetToken = (token) => {
  return jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
};

module.exports = { generateAccessToken, generateRefreshToken, generateResetToken, verifyRefreshToken, verifyResetToken };