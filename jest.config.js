module.exports = {
  testEnvironment: "node",
  setupFiles: ["<rootDir>/tests/setupEnv.js"],
  testMatch: ["<rootDir>/tests/**/*.test.js"],
  // Agent Manager worktrees live in .kilo/worktrees and carry their own
  // package.json; they must not be scanned by the root test run.
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/client/", "<rootDir>/.kilo/"],
  modulePathIgnorePatterns: ["<rootDir>/.kilo/", "<rootDir>/client/"],
  forceExit: true,
};
