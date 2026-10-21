import { render, screen } from "@testing-library/react";
import TaxiIcon, { IconText } from "./TaxiIcon";

test("replaces the taxi emoji with a route icon, not a car", () => {
  const { container } = render(<IconText>🚕 Заказы</IconText>);
  expect(screen.getByText(/Заказы/)).toBeInTheDocument();
  expect(container.textContent).not.toContain("🚕");
  expect(container.querySelector("svg.tabler-icon-route")).toBeInTheDocument();
});

test("renders road and driver icons with the requested size", () => {
  const { container } = render(<>
    <IconText>🧑‍✈️ Иван · 🚗 Машина</IconText>
    <TaxiIcon name="driver" size={32} />
  </>);
  expect(container.textContent).not.toContain("🚗");
  expect(container.querySelector("svg.tabler-icon-road")).toBeInTheDocument();
  expect(container.querySelector("svg.tabler-icon-steering-wheel[width='32']")).toBeInTheDocument();
});
