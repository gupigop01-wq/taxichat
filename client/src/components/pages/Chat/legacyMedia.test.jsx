import React from "react";
import { act, fireEvent, render, renderHook } from "@testing-library/react";
import { Audio as CloudAudio, Image as CloudImage } from "cloudinary-react";
import { useReactMediaRecorder } from "react-media-recorder";
import Image from "../../globals/Image";
import VoiceMessage from "./VoiceMessage";
import AttachFileModal from "./AttachFileModal";
import Settings from "../../../pages/Settings";
import useRecorder from "../../../hooks/useRecorder";
import useUpload from "../../../hooks/useUpload";

const mockDispatch = jest.fn();
const mockSendMessage = jest.fn();
const mockUpdateProfile = jest.fn();

jest.mock("react-redux", () => ({ useDispatch: () => mockDispatch }));
jest.mock("../../../hooks/useUpload", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../../../hooks/useSendMessage", () => ({
  __esModule: true, default: () => ({ sendMessage: mockSendMessage }),
}));
jest.mock("../../../hooks/useSettings", () => ({
  __esModule: true,
  default: () => ({
    user: { name: "Test", username: "test", bio: "", avatar: "/api/uploads/avatar.png" },
    updateProfile: mockUpdateProfile,
  }),
}));
jest.mock("../../../hooks/useSocket", () => ({
  __esModule: true, default: () => ({ socketEmit: jest.fn() }),
}));
jest.mock("../../../hooks/useCounter", () => ({
  __esModule: true,
  default: () => ({ formattedTime: "0:03,00", playCounter: jest.fn(), startCounter: jest.fn(), stopCounter: jest.fn() }),
}));
jest.mock("react-media-recorder", () => ({ useReactMediaRecorder: jest.fn() }));
jest.mock("../../globals/Modal", () => ({ __esModule: true, default: ({ children }) => children }));
jest.mock("../Sidebar/ActivePage", () => ({ __esModule: true, default: ({ children }) => children }));
jest.mock("../Settings/LogoutModal", () => ({ __esModule: true, default: () => null }));
jest.mock("cloudinary-react", () => ({
  Image: jest.fn(),
  Audio: jest.fn(),
  Placeholder: () => null,
}));

beforeEach(() => {
  jest.clearAllMocks();
  useUpload.mockReturnValue({ handleFileUpload: jest.fn(), fileUploadState: "success" });
  useReactMediaRecorder.mockReturnValue({});
  CloudImage.mockImplementation(({ publicId, alt, className }) => <img data-cloudinary-id={publicId} alt={alt} className={className} />);
  CloudAudio.mockImplementation(({ publicId, innerRef }) => <audio data-cloudinary-id={publicId} ref={innerRef} />);
});

test.each([
  "/api/uploads/photo.png",
  "https://res.cloudinary.com/test/image/upload/photo.png",
])("renders image URL %s directly", (src) => {
  const { container } = render(<Image src={src} alt="Photo" className="rounded" />);
  expect(container.querySelector("img")).toHaveAttribute("src", src);
  expect(CloudImage).not.toHaveBeenCalled();
});

test("keeps Cloudinary rendering for existing image public IDs", () => {
  const { container } = render(<Image src="photos/existing" alt="Photo" />);
  expect(container.querySelector("img")).toHaveAttribute("data-cloudinary-id", "photos/existing");
  expect(CloudImage).toHaveBeenCalled();
});

test.each([
  "/api/uploads/voice.webm",
  "https://res.cloudinary.com/test/video/upload/voice.webm",
])("plays and pauses voice URL %s using native audio", (voiceNoteUrl) => {
  const { container } = render(<VoiceMessage voiceNoteUrl={voiceNoteUrl} voiceDuration="0:03" time="2026-10-21T20:00:00Z" />);
  const audio = container.querySelector("audio");
  expect(audio).toHaveAttribute("src", voiceNoteUrl);
  expect(CloudAudio).not.toHaveBeenCalled();
  Object.defineProperty(audio, "duration", { configurable: true, value: 3 });
  audio.play = jest.fn().mockResolvedValue();
  audio.pause = jest.fn();
  fireEvent.canPlayThrough(audio);
  fireEvent.click(container.querySelector(".bg-avatar-check"));
  expect(audio.play).toHaveBeenCalledTimes(1);
  fireEvent.click(container.querySelector(".bg-avatar-check"));
  expect(audio.pause).toHaveBeenCalledTimes(1);
});

test("keeps Cloudinary rendering for existing voice public IDs", () => {
  const { container } = render(<VoiceMessage voiceNoteUrl="voices/existing" voiceDuration="0:03" time="2026-10-21T20:00:00Z" />);
  expect(container.querySelector("audio")).toHaveAttribute("data-cloudinary-id", "voices/existing");
  expect(CloudAudio).toHaveBeenCalled();
});

describe.each([
  [{ secure_url: "/api/uploads/media.png" }, "/api/uploads/media.png"],
  [{ public_id: "media/existing", secure_url: "https://res.cloudinary.com/test/image/upload/media.png" }, "media/existing"],
])("legacy upload consumers for %j", (uploadData, expectedSource) => {
  test("uses a real media source for image attachments", () => {
    render(<AttachFileModal />);
    act(() => useUpload.mock.calls[0][0](uploadData));
    expect(mockSendMessage).toHaveBeenCalledWith({ url: expectedSource });
  });

  test("uses a real media source for profile avatars", () => {
    render(<Settings />);
    act(() => useUpload.mock.calls[0][0](uploadData));
    expect(mockUpdateProfile).toHaveBeenCalledWith({ avatar: expectedSource });
  });

  test("uses a real media source for recordings without relabeling their MIME", () => {
    renderHook(() => useRecorder({ currentChatRoom: { _id: "room" } }));
    act(() => useUpload.mock.calls[0][0]({ ...uploadData, extraFileData: { duration: "0:03" } }));
    expect(mockSendMessage).toHaveBeenCalledWith({ url: expectedSource, duration: "0:03" });
    expect(useReactMediaRecorder.mock.calls[0][0].blobPropertyBag).toEqual({});
  });
});
