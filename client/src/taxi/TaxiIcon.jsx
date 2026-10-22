import {
  IconAlertTriangle, IconArchive, IconArrowLeft, IconBan, IconBed,
  IconBolt, IconBookmark, IconBuildingSkyscraper, IconCamera, IconCash,
  IconCheck, IconChevronDown, IconChevronUp, IconCircle, IconCircleCheck,
  IconClipboardList, IconClock, IconClockHour3, IconCoin, IconDoorExit,
  IconFlag, IconHeadset, IconHourglass, IconId, IconInbox, IconLink,
  IconMail, IconMap, IconMapPin, IconMessageCircle, IconMicrophone,
  IconMicrophoneOff, IconNote, IconNumbers, IconPalette, IconPhone,
  IconPhoneOff, IconPlayerRecord, IconQuestionMark, IconReceipt, IconRoad,
  IconRoute, IconSearch, IconSend, IconSpeakerphone, IconStar,
  IconStarFilled, IconSteeringWheel, IconStopwatch, IconUser,
  IconUserCircle, IconVolume2, IconX,
} from "@tabler/icons-react";

// One visual family for all interface icons. No car or taxi silhouette is used.
const icons = {
  alert: IconAlertTriangle, archive: IconArchive, back: IconArrowLeft,
  ban: IconBan, bed: IconBed, bolt: IconBolt, bookmark: IconBookmark,
  city: IconBuildingSkyscraper, camera: IconCamera, cash: IconCash,
  check: IconCheck, down: IconChevronDown, up: IconChevronUp,
  circle: IconCircle, completed: IconCircleCheck, orders: IconClipboardList,
  clock: IconClock, time: IconClockHour3, coin: IconCoin, exit: IconDoorExit,
  finish: IconFlag, support: IconHeadset, hourglass: IconHourglass,
  cabinet: IconId, empty: IconInbox, share: IconLink, mail: IconMail,
  map: IconMap, pin: IconMapPin, message: IconMessageCircle,
  microphone: IconMicrophone, muted: IconMicrophoneOff, note: IconNote,
  number: IconNumbers, palette: IconPalette, phone: IconPhone,
  hangup: IconPhoneOff, record: IconPlayerRecord, unknown: IconQuestionMark,
  trips: IconReceipt, road: IconRoad, route: IconRoute, search: IconSearch,
  send: IconSend, feed: IconSpeakerphone, star: IconStar,
  starFilled: IconStarFilled, driver: IconSteeringWheel, eta: IconStopwatch,
  passenger: IconUser, profile: IconUserCircle, speaker: IconVolume2,
  close: IconX,
};

export default function TaxiIcon({ name, size = 20, className = "", style, ...props }) {
  const Icon = icons[name];
  if (!Icon) return null;
  // Filled glyphs must keep their fill: the global base style sets fill:none
  const solid = /^(starFilled|record|circle|completed)$/.test(name);
  return <Icon aria-hidden="true" className={`taxi-icon ${solid ? "taxi-icon-solid" : ""} shrink-0 ${className}`} size={size} stroke={2} style={{ width: size, height: size, ...style }} {...props} />;
}

const emojiIcons = {
  "🚕": "route", "🚗": "road", "🧾": "trips", "🪪": "cabinet",
  "🚪": "exit", "🎧": "support", "🗺️": "map", "🧍": "passenger",
  "👤": "profile", "📨": "mail", "🎨": "palette", "🔢": "number",
  "💰": "cash", "⏱": "eta", "🧑‍✈️": "driver", "📞": "phone",
  "📋": "orders", "📢": "feed", "🏁": "finish", "🛋": "bed",
  "🗂": "archive", "📭": "empty", "⚡": "bolt", "🕓": "clock",
  "🕒": "time", "🕐": "time", "📝": "note", "⭐": "starFilled",
  "★": "starFilled", "☆": "star", "💬": "message", "📷": "camera",
  "🎤": "microphone", "🎙": "microphone", "⏺": "record", "➤": "send",
  "←": "back", "⬅️": "back", "🔇": "muted", "🔊": "speaker",
  "📵": "hangup", "🔗": "share", "🔽": "down", "🔼": "up",
  "🔴": "circle", "⏳": "hourglass", "❌": "close", "🏙": "city",
  "🛣": "road", "✅": "completed", "🔎": "search", "🔖": "bookmark",
  "📍": "pin", "⌛": "hourglass", "✖️": "close", "🚫": "ban",
  "⚠️": "alert", "😴": "bed", "🟢": "circle", "⛔": "ban",
  "❔": "unknown", "🗺": "map", "✖": "close", "⚠": "alert",
};

const emojiPattern = new RegExp(`(${Object.keys(emojiIcons)
  .sort((a, b) => b.length - a.length)
  .map((emoji) => emoji.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|")})`, "g");

export function IconText({ children }) {
  if (typeof children !== "string") return children;
  return <>{children.split(emojiPattern).map((part, index) =>
    emojiIcons[part] ? (
      <TaxiIcon key={index} name={emojiIcons[part]} size={18}
        className={`inline-block align-[-0.2em] ${part === "🔴" || part === "❌" || part === "⛔" ? "text-danger" : part === "🟢" || part === "✅" ? "text-success" : ""}`} />
    ) : part
  )}</>;
}
