const crypto = require("crypto");

// SHA-256 hash for refresh tokens — deterministic, allows atomic DB lookup
const hashToken = (token) => {
  return crypto.createHash("sha256").update(token).digest("hex");
};

module.exports = hashToken;