// Phone numbers are stored in one canonical form (+7XXXXXXXXXX) so the
// dispatcher can dial them directly and comparisons never break on spacing.
const RU_PHONE = /^\+7\d{10}$/;

// Accepts "+7 902 111 22 33", "8 (902) 111-22-33", "79021112233" and
// normalises them to "+79021112233". Returns null for anything else.
const normalizePhone = (raw) => {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && (digits.startsWith("7") || digits.startsWith("8"))) {
    return `+7${digits.slice(1)}`;
  }
  if (/^\+7/.test(raw.trim()) && digits.length === 11 && digits.startsWith("7")) {
    return `+7${digits.slice(1)}`;
  }
  return null;
};

const isValidPhone = (value) => typeof value === "string" && RU_PHONE.test(value);

// Human-friendly caption for lists: +7 902 111-22-33
const formatPhone = (value) => {
  if (!isValidPhone(value)) return value ?? "";
  const d = value.slice(2);
  return `+7 ${d.slice(0, 3)} ${d.slice(3, 6)}-${d.slice(6, 8)}-${d.slice(8)}`;
};

module.exports = { normalizePhone, isValidPhone, formatPhone };
