const { normalizePhone, isValidPhone, formatPhone } = require("../utilities/phone");
const drivers = require("../utilities/drivers");

// One canonical phone form for the whole server: registration, the passenger
// order form, memberships and the city line all must agree.
describe("phone normalization", () => {
  it.each([
    ["+7 902 111 22 33", "+79021112233"],
    ["8 (902) 111-22-33", "+79021112233"],
    ["79021112233", "+79021112233"],
    ["+79021112233", "+79021112233"],
  ])("normalizes %s to %s", (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
    expect(isValidPhone(normalizePhone(raw))).toBe(true);
  });

  it.each(["", "12345", "+1 555 000 0000", "9021112233", "790211122", null, 42, {}])(
    "rejects %p",
    (raw) => expect(normalizePhone(raw)).toBeNull()
  );

  it("keeps a single implementation for every caller", () => {
    expect(drivers.normalizePhone).toBe(normalizePhone);
  });

  it("formats for lists", () => {
    expect(formatPhone("+79021112233")).toBe("+7 902 111-22-33");
    expect(formatPhone("")).toBe("");
  });
});
