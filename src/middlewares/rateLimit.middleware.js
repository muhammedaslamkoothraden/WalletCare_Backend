const rateLimit = require("express-rate-limit");

// general limiter — applies to all routes
// 200 requests per 15 minutes per IP
exports.generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 200,                   // max requests per window per IP
  standardHeaders: true,      // return rate limit info in headers
  legacyHeaders: false,       // disable old X-RateLimit headers
  message: {
    message: "Too many requests. Please try again after 15 minutes."
  }
});

// strict limiter — for sensitive routes like login, forgot-password
// 10 requests per 15 minutes per IP
exports.strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 20,                    // max requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many attempts. Please try again after 15 minutes."
  }
});