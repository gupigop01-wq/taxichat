import { act, renderHook, waitFor } from "@testing-library/react";
import useUpload from "./useUpload";

const mockDispatch = jest.fn();
const mockUpload = jest.fn();
let mockSuccess;

jest.mock("react-redux", () => ({ useDispatch: () => mockDispatch }));
jest.mock("./useFetch", () => ({
  __esModule: true,
  default: (_options, success) => {
    mockSuccess = success;
    return { reqFn: mockUpload, reqState: "success" };
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
});

test("uploads recorder bytes with their MIME and retains local URL metadata", async () => {
  const onUploaded = jest.fn();
  const { result } = renderHook(() => useUpload(onUploaded, ["audio"]));
  const file = new Blob(["hello"], { type: "audio/webm;codecs=opus" });
  const extraFileData = { duration: "0:03" };
  act(() => result.current.handleFileUpload({ target: { files: [file], extraFileData } }));
  await waitFor(() => expect(mockUpload).toHaveBeenCalledWith({
    data: "data:audio/webm;codecs=opus;base64,aGVsbG8=", fileType: "video",
  }));
  const uploadData = { secure_url: "/api/uploads/voice.webm" };
  act(() => mockSuccess({ data: { uploadData } }));
  expect(onUploaded).toHaveBeenCalledWith({ ...uploadData, extraFileData });
  expect(onUploaded.mock.calls[0][0]).not.toHaveProperty("public_id");
});

test("preserves genuine Cloudinary IDs and URLs in upload responses", () => {
  const onUploaded = jest.fn();
  renderHook(() => useUpload(onUploaded, ["image"]));
  const uploadData = { public_id: "photos/existing", secure_url: "https://res.cloudinary.com/test/image/upload/existing.png" };
  act(() => mockSuccess({ data: { uploadData } }));
  expect(onUploaded).toHaveBeenCalledWith({ ...uploadData, extraFileData: undefined });
});

test("ignores a cancelled file selection", () => {
  const { result } = renderHook(() => useUpload(jest.fn(), ["image"]));
  act(() => result.current.handleFileUpload({ target: { files: [] } }));
  expect(mockUpload).not.toHaveBeenCalled();
  expect(mockDispatch).not.toHaveBeenCalled();
});

test.each([
  ["image/png", 0],
  ["image/png", 10 * 1024 * 1024 + 1],
  ["audio/webm", 15 * 1024 * 1024 + 1],
])("rejects empty or oversized %s files of %s bytes before reading", (type, size) => {
  const { result } = renderHook(() => useUpload(jest.fn(), ["image", "audio"]));
  act(() => result.current.handleFileUpload({ target: { files: [{ type, size }] } }));
  expect(mockUpload).not.toHaveBeenCalled();
  expect(mockDispatch).toHaveBeenCalledWith(expect.objectContaining({
    payload: expect.objectContaining({ type: "error" }),
  }));
});

test("rejects unsupported media before reading", () => {
  const { result } = renderHook(() => useUpload(jest.fn(), ["image"]));
  act(() => result.current.handleFileUpload({ target: { files: [{ type: "text/html", size: 10 }] } }));
  expect(mockUpload).not.toHaveBeenCalled();
  expect(mockDispatch).toHaveBeenCalledWith(expect.objectContaining({
    payload: expect.objectContaining({ type: "error" }),
  }));
});
