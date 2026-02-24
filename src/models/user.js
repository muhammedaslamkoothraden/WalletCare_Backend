const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

/* =========================
   Main User Schema
========================= */
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 50 },
    email: { type: String, required: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 8, select: false },
    phone: { type: String, default: null },
    isPremium: { type: Boolean, default: false },
    role: { type: String, enum: ["user", "admin"], default: "user" },
    isEmailVerified: { type: Boolean, default: false }
  },
  { timestamps: true }
);

/*
  Automatically hash password before saving.
  Skips hashing if password unchanged or flagged to ignore hooks (used in OTP verification).
*/
userSchema.pre("save", async function () {
  if (!this.isModified("password") || this.$ignoreHooks) return;
  this.password = await bcrypt.hash(this.password, 10);
});

/*
  Compare entered password with stored hashed password
*/
userSchema.methods.comparePassword = async function (enteredPassword) {
  return bcrypt.compare(enteredPassword, this.password);
};

// Ensure unique email at DB level
userSchema.index({ email: 1 }, { unique: true });

/* =========================
   Pending User Schema
========================= */
const pendingUserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 50 },
    email: { type: String, required: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 8 }, // already hashed
    phone: { type: String, default: null },
    role: { type: String, enum: ["user", "admin"], default: "user" }
  },
  { timestamps: true }
);

// Prevent duplicate pending registrations
pendingUserSchema.index({ email: 1 }, { unique: true });

/* =========================
   Export Models
========================= */
const User = mongoose.model("User", userSchema); // collection: users
const PendingUser = mongoose.model("PendingUser", pendingUserSchema); // collection: pendingusers

module.exports = { User, PendingUser };