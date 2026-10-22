// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

// Recorder dependencies create worker URLs at import time; jsdom has no blobs.
Object.defineProperties(URL, {
  createObjectURL: { configurable: true, writable: true, value: jest.fn() },
  revokeObjectURL: { configurable: true, writable: true, value: jest.fn() },
});

beforeEach(() => {
  URL.createObjectURL.mockReturnValue('blob:test');
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  delete window.__bombilaOpenOrderId;
});
