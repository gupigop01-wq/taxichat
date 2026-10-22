import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CityPicker from "./CityPicker";

const cities = [
  { _id: "moscow", name: "Москва", status: "ACTIVE" },
  { _id: "irkutsk", name: "Иркутск", status: "PILOT" },
  { _id: "slyudyanka", name: "Слюдянка", status: "WAITLIST" },
];
const originalWidth = window.innerWidth;
const originalHeight = window.innerHeight;
const originalViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");

const renderPicker = () => {
  const onSelect = jest.fn();
  const view = render(<>
    <CityPicker cities={cities} cityId="moscow" onSelect={onSelect} />
    <button>Outside</button>
  </>);
  const trigger = screen.getByRole("button", { name: "Москва" });
  jest.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
    left: 20, right: 220, top: 100, bottom: 142, width: 200, height: 42,
  });
  return { ...view, trigger, onSelect };
};

afterEach(() => {
  jest.restoreAllMocks();
  window.innerWidth = originalWidth;
  window.innerHeight = originalHeight;
  if (originalViewport) Object.defineProperty(window, "visualViewport", originalViewport);
  else delete window.visualViewport;
});

test("a letter click inside the portal filters without closing the picker", () => {
  const { container, trigger, onSelect } = renderPicker();
  userEvent.click(trigger);
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  expect(within(container).queryByRole("listbox")).not.toBeInTheDocument();
  userEvent.click(screen.getByRole("button", { name: "И" }));
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(screen.getAllByRole("option")).toHaveLength(1);
  userEvent.click(screen.getByRole("option", { name: /Иркутск/ }));
  expect(onSelect).toHaveBeenCalledWith("irkutsk");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  userEvent.click(trigger);
  expect(screen.getAllByRole("option")).toHaveLength(3);
});

test("outside clicks and moving focus outside dismiss the portal", () => {
  const { trigger } = renderPicker();
  const outside = screen.getByRole("button", { name: "Outside" });
  userEvent.click(trigger);
  userEvent.click(outside);
  expect(outside).toHaveFocus();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  userEvent.click(trigger);
  act(() => outside.focus());
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

test("the panel fits a 320px viewport and remeasures on resize", () => {
  window.innerWidth = 320;
  const { trigger } = renderPicker();
  userEvent.click(trigger);
  // Position belongs to the portal wrapper, not the accessible listbox.
  // eslint-disable-next-line testing-library/no-node-access
  const panel = screen.getByRole("listbox").parentElement;
  expect(panel).toHaveStyle({ left: "8px", width: "304px" });
  window.innerWidth = 640;
  fireEvent(window, new Event("resize"));
  expect(panel).toHaveStyle({ left: "20px", width: "320px" });
});

test("the panel is clamped to a short visual viewport and removes its listeners", () => {
  const viewport = new EventTarget();
  Object.assign(viewport, { width: 320, height: 180, offsetLeft: 14, offsetTop: 40 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  const add = jest.spyOn(viewport, "addEventListener");
  const remove = jest.spyOn(viewport, "removeEventListener");
  const { trigger, unmount } = renderPicker();
  userEvent.click(trigger);
  // eslint-disable-next-line testing-library/no-node-access
  const panel = screen.getByRole("listbox").parentElement;
  expect(panel).toHaveStyle({ left: "22px", top: "48px", width: "304px", maxHeight: "164px" });
  unmount();
  expect(remove.mock.calls).toEqual(add.mock.calls);
});

test("keyboard opening, arrows, Home/End and Enter work with focus restoration", () => {
  const { trigger, onSelect } = renderPicker();
  act(() => trigger.focus());
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const options = screen.getAllByRole("option");
  expect(options[1]).toHaveFocus();
  expect(trigger).toHaveAttribute("aria-controls", screen.getByRole("listbox").id);
  fireEvent.keyDown(options[1], { key: "End" });
  expect(options[2]).toHaveFocus();
  fireEvent.keyDown(options[2], { key: "ArrowDown" });
  expect(options[0]).toHaveFocus();
  fireEvent.keyDown(options[0], { key: "ArrowUp" });
  expect(options[2]).toHaveFocus();
  fireEvent.keyDown(options[2], { key: "Home" });
  expect(options[0]).toHaveFocus();
  userEvent.keyboard("{enter}");
  expect(onSelect).toHaveBeenCalledWith("irkutsk");
  expect(trigger).toHaveFocus();
});

test("ArrowUp opens on the last city and Escape returns focus to the trigger", () => {
  const { trigger } = renderPicker();
  act(() => trigger.focus());
  fireEvent.keyDown(trigger, { key: "ArrowUp" });
  expect(screen.getByRole("option", { name: /Слюдянка/ })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole("option", { name: /Слюдянка/ }), { key: "Escape" });
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});
