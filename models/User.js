const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const contactSchema = new mongoose.Schema({
  contactDetails: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  name: String,
  chatRoomId: mongoose.Schema.Types.ObjectId,
});

// Account of a person; roles live in city memberships, not here.
// `username` is the account login.
const Schema = new mongoose.Schema({
  // Login of the account
  username: {
    unique: true,
    type: String,
    required: true,
  },
  // Contact phone in E.164 (+7XXXXXXXXXX). Neither drivers nor passengers see
  // each other's number in chat; a dispatcher uses it to call on SOS.
  phone: { type: String, default: null },
  // Display name
  name: {
    type: String,
    required: true,
  },
  // Bio, shouldn't be more than 100 characters
  bio: {
    type: String,
    min: 1,
    max: 100,
    default: "Hi there, I'm using TaxiChat",
  },
  // User profile image (Avatar)
  avatar: {
    type: String,
    default:
      "https://res.cloudinary.com/dlanhtzbw/image/upload/v1675343188/Telegram%20Clone/no-profile_aknbeq.jpg",
  },
  // User contacts
  contacts: [contactSchema],
  // Status, whether user is online or not
  status: {
    online: { type: Boolean, default: true },
    lastSeen: Date,
  },
  // User password (bcrypt hash)
  password: {
    type: String,
    required: true,
    min: [8, "Password too short"],
  },
  // Platform-wide superadmin flag; city roles live in Membership
  isSuperadmin: { type: Boolean, default: false, index: true },
  // Banned users cannot log in or use the platform
  banned: { type: Boolean, default: false },
  // Penalty points for late cancels; the threshold triggers an auto-ban
  // (concept 1.9). Points fade: one leaves for every day without a penalty.
  penaltyPoints: { type: Number, default: 0 },
  // When the last point was added (the decay is counted from it)
  penaltyAt: Date,
  // Set on an automatic ban: the reason shown to the user and the end of the
  // temporary block. Manual bans by an admin have no banUntil.
  banReason: String,
  banUntil: Date,
  bannedAt: Date,
  // Home city; changes are limited to once per 30 days
  homeCityId: { type: mongoose.Schema.Types.ObjectId, ref: "City" },
  homeCityChangedAt: Date,
  // Chat rooms user belongs to
  chatRooms: [mongoose.Schema.Types.ObjectId],
  // Pinned chat rooms by user
  pinnedChatRooms: [],
  // Unread messages
  unreadMessages: [{}],
  // Undelivered messages
  undeliveredMessages: [{}],
});

Schema.pre("save", async function (next) {
  if (!this.$isNew) this.$ignore("password");
});

Schema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const hashedPassword = await bcrypt.hash(this.password, 12);
  this.password = hashedPassword;
  next();
});

Schema.methods.checkPasswordValidity = async (
  givenPassword,
  originalPassword
) => await bcrypt.compare(givenPassword, originalPassword);

Schema.set("toJSON", {
  transform: (doc, ret) => {
    delete ret.password;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("User", Schema);
