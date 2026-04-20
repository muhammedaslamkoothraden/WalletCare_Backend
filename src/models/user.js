const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

// User Schema 
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 50 },
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    password: { type: String, required: true, minlength: 8, select: false },
    isPremium: { type: Boolean, default: false },
    role: { type: String, enum: ["user", "admin", "superadmin"], default: "user" },
    isEmailVerified: { type: Boolean, default: false },
    refreshToken: { type: String, default: null },
    scheduledDeletionAt: { type: Date, default: null },
    rating: { type: Number, min: 1, max: 5, default: null },
    isBanned: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// TTL index — auto-deletes document when scheduledDeletionAt is reached, ignores null
userSchema.index({ scheduledDeletionAt: 1 }, { expireAfterSeconds: 0, sparse: true });

// Hash password before save — skipped if password unchanged or $ignoreHooks is set
userSchema.pre("save", async function () {
  if (!this.isModified("password") || this.$ignoreHooks) return;
  this.password = await bcrypt.hash(this.password, 10);
});

// Compare entered password with hashed — requires .select("+password") before calling
userSchema.methods.comparePassword = async function (enteredPassword) {
  return bcrypt.compare(enteredPassword, this.password);
};

// Pending User Schema 
const pendingUserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 50 },
    email: { type: String, required: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 8 },
    role: { type: String, enum: ["user", "admin"], default: "user" },
    expiresAt: { type: Date, default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) },
  },
  { timestamps: true }
);

// Unique email index
pendingUserSchema.index({ email: 1 }, { unique: true });

// TTL index — auto-deletes pending users after 24 hours
pendingUserSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const User = mongoose.models.User || mongoose.model("User", userSchema);
const PendingUser = mongoose.models.PendingUser || mongoose.model("PendingUser", pendingUserSchema);

module.exports = { User, PendingUser };