const Chat = require("../models/Chat");
const Message = require("../models/Message");
const Block = require("../models/Block");

// Chats of the current city may receive media; closed or foreign-city dialogs
// may not. Direct dialogs exist in the city where the call happened.
const UPLOADS_PER_HOUR = 20;
const CLOSED_DIRECT_CHAT_MS = 60 * 60 * 1000;

// A chat is usable for media when it is not closed and belongs to a city the
// user is an ACTIVE member of.
const isChatUsableForUpload = (chat, memberships) => {
  if (chat.type === "direct") {
    const closedAt = chat.closedAt ? new Date(chat.closedAt).getTime() : null;
    // Closed after the conversation ended, or too old without activity
    const lastActivity = chat.lastActivityAt ? new Date(chat.lastActivityAt).getTime() : null;
    if (closedAt && closedAt <= Date.now()) return false;
    if (!closedAt && lastActivity && Date.now() - lastActivity > CLOSED_DIRECT_CHAT_MS) return false;
  }
  const cityKey = String(chat.cityId ?? "");
  if (!cityKey) return true;
  return (memberships ?? []).some(
    (item) => item.status === "ACTIVE" && String(item.cityId?._id ?? item.cityId) === cityKey
  );
};

// Per-user budget: media blobs are 10-15 MB each, so counting recent messages
// written by the user keeps one account from filling the disk.
const withinHourlyQuota = async (userId) => {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await Message.countDocuments({
    senderId: userId,
    kind: { $in: ["photo", "voice"] },
    createdAt: { $gte: since },
  });
  return recent < UPLOADS_PER_HOUR;
};

// A direct dialog between blocked peers accepts nothing, including media
const isBlockedWithChatPeer = async (chat, userId) => {
  if (chat.type !== "direct" || !chat.members?.length) return false;
  const peerId = chat.members.map(String).find((id) => id !== String(userId));
  if (!peerId) return false;
  return Boolean(
    await Block.exists({
      $or: [
        { userId, blockedUserId: peerId },
        { userId: peerId, blockedUserId: userId },
      ],
    })
  );
};

module.exports = { Chat, isChatUsableForUpload, isBlockedWithChatPeer, withinHourlyQuota, UPLOADS_PER_HOUR };
