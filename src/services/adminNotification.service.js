const { User } = require("../models/user");
const { createNotification } = require("./notification.service");

// ================= VALIDATION =================
function validate(message, title) {
  if (!message || !message.trim()) {
    throw new Error("Message is required");
  }

  if (message.trim().length > 255) {
    throw new Error("Message cannot exceed 255 characters");
  }

  if (title && title.trim().length > 100) {
    throw new Error("Title cannot exceed 100 characters");
  }
}

// ================= FILTERS =================
const FILTERS = {
  active: { role: "user", isBanned: false, scheduledDeletionAt: null },
  banned: { role: "user", isBanned: true },
  premium: { role: "user", isPremium: true, isBanned: false },
  free: { role: "user", isPremium: false, isBanned: false },
  verified: { role: "user", isEmailVerified: true, isBanned: false },
  pending_deletion: { role: "user", scheduledDeletionAt: { $ne: null } },
  all: { role: "user" },
};

// ================= SEND TO SINGLE USER =================
exports.sendToUser = async (userId, message, title) => {
  validate(message, title);

  const user = await User.findById(userId).select("_id role isBanned");

  if (!user) {
    throw new Error("User not found");
  }

  if (user.role !== "user") {
    throw new Error("Target is not a normal user");
  }

  return await createNotification(userId, message.trim(), "admin_message", {
    title: title?.trim() || "Message from WalletCare",
  });
};

// ================= BROADCAST =================
exports.broadcast = async (filter, message, title) => {
  validate(message, title);

  const query = FILTERS[filter || "active"];

  if (!query) {
    throw new Error(
      `Invalid filter. Allowed: ${Object.keys(FILTERS).join(", ")}`
    );
  }

  const users = await User.find(query).select("_id").lean();

  if (users.length === 0) {
    return {
      total: 0,
      sent: 0,
      failed: 0,
    };
  }

  const results = await Promise.allSettled(
    users.map((u) =>
      createNotification(u._id, message.trim(), "admin_broadcast", {
        title: title?.trim() || "Message from WalletCare",
      })
    )
  );

  let sent = 0;
  let failed = 0;

  results.forEach((r) => {
    if (r.status === "fulfilled") sent++;
    else failed++;
  });

  return {
    total: users.length,
    sent,
    failed,
  };
};

// ================= SEND TO ADMIN (SUPERADMIN) =================
exports.sendToAdmin = async (adminId, message, title) => {
  validate(message, title);

  const admin = await User.findById(adminId).select("_id role");

  if (!admin) {
    throw new Error("Admin not found");
  }

  if (admin.role !== "admin") {
    throw new Error("Target is not an admin");
  }

  return await createNotification(adminId, message.trim(), "admin_message", {
    title: title?.trim() || "Admin Message",
  });
};

// ================= BROADCAST TO ADMINS =================
exports.broadcastAdmins = async (message, title) => {
  validate(message, title);

  const admins = await User.find({
    role: { $in: ["admin", "superadmin"] },
  })
    .select("_id")
    .lean();

  const results = await Promise.allSettled(
    admins.map((a) =>
      createNotification(a._id, message.trim(), "admin_broadcast", {
        title: title?.trim() || "Admin Broadcast",
      })
    )
  );

  let sent = 0;
  let failed = 0;

  results.forEach((r) => {
    if (r.status === "fulfilled") sent++;
    else failed++;
  });

  return {
    total: admins.length,
    sent,
    failed,
  };
};