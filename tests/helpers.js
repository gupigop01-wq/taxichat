const request = require("supertest");

// Registers a unique user and returns the auth cookie for API tests
const registerAndLogin = async (app, overrides = {}) => {
  const { cookie } = await registerUser(app, overrides);
  return cookie;
};

// Registers a unique user and returns { cookie, user }
const registerUser = async (app, overrides = {}) => {
  const username =
    overrides.username ?? `user_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

  const res = await request(app)
    .post("/api/user/register")
    .send({
      name: "Тестовый Пользователь",
      // The phone is mandatory at registration; each test user gets its own
      phone: `+7900${String(Date.now()).slice(-7)}`,
      password: "Bombila2026",
      confirmPassword: "Bombila2026",
      username,
      ...overrides,
    });

  return { cookie: res.headers["set-cookie"], user: res.body.data.user };
};

module.exports = { registerAndLogin, registerUser };

