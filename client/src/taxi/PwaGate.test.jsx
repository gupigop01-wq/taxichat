import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PwaGate } from "./PwaGate";

test("browser mode shows only the install gate with the install button", async () => {
  window.__pwaBrowserMode = true;
  render(
    <PwaGate>
      <div>Внутри приложения</div>
    </PwaGate>
  );

  expect(screen.getByRole("button", { name: /Установить приложение/i })).toBeInTheDocument();
  expect(screen.queryByText("Внутри приложения")).not.toBeInTheDocument();

  // No native prompt in jsdom: the gate explains the browser menu instead
  await userEvent.click(screen.getByRole("button", { name: /Установить приложение/i }));
  expect(screen.getByText(/меню Chrome|Поделиться/i)).toBeInTheDocument();
});

test("installed PWA mode renders the application and hides the gate", () => {
  window.__pwaBrowserMode = false;
  render(
    <PwaGate>
      <div>Внутри приложения</div>
    </PwaGate>
  );

  expect(screen.getByText("Внутри приложения")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Установить приложение/i })).not.toBeInTheDocument();
});
