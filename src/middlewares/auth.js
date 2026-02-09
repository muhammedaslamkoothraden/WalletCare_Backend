const authMiddleware = (req, res, next) => {
  // TEMP: allow all requests
  next();
};

module.exports = authMiddleware;
