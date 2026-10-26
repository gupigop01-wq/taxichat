// Phone inputs: a bare 10-digit local number is a common way to type a
// Russian mobile, so the client prefixes it with 7 before sending. The server
// stays strict (11 digits starting with 7/8) so a typo cannot silently become
// another subscriber's number.
export const withRussianPrefix = (raw) => {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.length === 10 ? `7${digits}` : String(raw ?? "");
};
