const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 50 },
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    password: { type: String, required: true, minlength: 8, select: false },
    phone: { type: String, default: null },
    isPremium: { type: Boolean, default: false },
    role: { type: String, enum: ["user", "admin"], default: "user" },
    isEmailVerified: { type: Boolean, default: false },
    refreshToken: { type: String, default: null },

    // soft delete — null means active, Date means scheduled for deletion
    scheduledDeletionAt: { type: Date, default: null }
  },
  { timestamps: true }
);

// TTL index — MongoDB auto-deletes User document at scheduledDeletionAt
// null values are ignored by TTL ✅
userSchema.index({ scheduledDeletionAt: 1 }, { expireAfterSeconds: 0, sparse: true });

// skip hashing if password unchanged or already hashed ($ignoreHooks set in verificationController)
userSchema.pre("save", async function () {
  if (!this.isModified("password") || this.$ignoreHooks) return;
  this.password = await bcrypt.hash(this.password, 10);
});

// used during login — explicit .select("+password") required before calling
userSchema.methods.comparePassword = async function (enteredPassword) {
  return bcrypt.compare(enteredPassword, this.password);
};


const pendingUserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 50 },
    email: { type: String, required: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 8 },  // already hashed
    phone: { type: String, default: null },
    role: { type: String, enum: ["user", "admin"], default: "user" },
    expiresAt: { type: Date, default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) }
    // resendCount, otpExhausted, otpExpiresAt removed — OTP document owns this state now
  },
  { timestamps: true }
);

pendingUserSchema.index({ email: 1 }, { unique: true });

// auto-delete pending users after 24 hours
pendingUserSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const User = mongoose.models.User || mongoose.model("User", userSchema);
const PendingUser = mongoose.models.PendingUser || mongoose.model("PendingUser", pendingUserSchema);

module.exports = { User, PendingUser };