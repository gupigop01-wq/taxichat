import { render, screen } from "@testing-library/react";
import TaxiIcon, { IconText } from "./TaxiIcon";

// Icons come from the tabler set. The logical name travels in aria-label, so
// the tests can check which glyph was chosen with a plain role query.
test("replaces the taxi emoji with a route icon, not a car", () => {
  render(<IconText>🚕 Заказы</IconText>);
  expect(screen.getByText(/Заказы/)).toBeInTheDocument();
  expect(screen.getByLabelText("иконка route")).toBeInTheDocument();
  expect(screen.queryByLabelText("иконка road")).not.toBeInTheDocument();
  expect(screen.queryByText("🚕")).not.toBeInTheDocument();
});

test("renders road and driver icons for the emoji text", () => {
  render(<IconText>🧑‍✈️ Иван · 🚗 Машина</IconText>);
  expect(screen.getByLabelText("иконка driver")).toBeInTheDocument();
  expect(screen.getByLabelText("иконка road")).toBeInTheDocument();
  expect(screen.queryByText(/🚗/)).not.toBeInTheDocument();
});

test("a known icon name renders a glyph and an unknown name renders nothing", () => {
  render(<>
    <TaxiIcon name="cash" />
    <TaxiIcon name="does-not-exist" />
  </>);
  expect(screen.getByLabelText("иконка cash")).toBeInTheDocument();
  expect(screen.queryByLabelText("иконка does-not-exist")).not.toBeInTheDocument();
});
