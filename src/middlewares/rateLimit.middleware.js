const rateLimit = require("express-rate-limit");

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// General limiter — 200 requests per 15 minutes per IP
exports.generalLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests. Please try again after 15 minutes." },
});

// Strict limiter — 20 requests per 15 minutes per IP (login, forgot-password)
exports.strictLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts. Please try again after 15 minutes." },
});