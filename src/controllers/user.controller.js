const { User } = require("../models/user");
const bcrypt = require("bcryptjs");

// Get Profile
exports.getProfile = async (req, res) => {
  try {

    // req.user._id injected by auth middleware
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isPremium: user.isPremium,
        isEmailVerified: user.isEmailVerified,
        createdAt: user.createdAt
      }
    });

  } catch (error) {
    console.error("getProfile error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// Update Profile
exports.updateProfile = async (req, res) => {
  try {
    const { name, phone } = req.body;

    // at least one field required
    if (!name && !phone) {
      return res.status(400).json({ message: "Provide at least one field to update" });
    }

    // build update object with only provided fields
    const updates = {};
    if (name) updates.name = name.trim();
    if (phone) updates.phone = phone.trim();

    const user = await User.findByIdAndUpdate(
      req.user._id,
      updates,
      { new: true, runValidators: true }  // new: true returns updated doc
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({
      message: "Profile updated successfully",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isPremium: user.isPremium,
        isEmailVerified: user.isEmailVerified,
        createdAt: user.createdAt
      }
    });

  } catch (error) {
    console.error("updateProfile error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// Change Password
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    // basic validation
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "Current and new password are required" });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ message: "New password must be at least 8 characters" });
    }

    // explicitly select password — excluded in schema by default
    const user = await User.findById(req.user._id).select("+password");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // verify current password
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Current password is incorrect" });
    }

    // prevent reusing same password
    const isSame = await bcrypt.compare(newPassword, user.password);
    if (isSame) {
      return res.status(400).json({ message: "New password must be different from current password" });
    }

    // hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // save new password + clear refresh token — forces re-login on all devices
    await User.findByIdAndUpdate(req.user._id, {
      password: hashedPassword,
      refreshToken: null
    });

    return res.status(200).json({
      message: "Password changed successfully. Please login again."
    });

  } catch (error) {
    console.error("changePassword error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// Logout
exports.logoutUser = async (req, res) => {
  try {

    // clear refresh token from DB — invalidates all devices
    await User.findByIdAndUpdate(req.user._id, { refreshToken: null });

    return res.status(200).json({ message: "Logged out successfully" });

  } catch (error) {
    console.error("logoutUser error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};