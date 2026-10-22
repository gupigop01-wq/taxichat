const request = require("supertest");
const app = require("../app");
const { connectTestDb, disconnectTestDb, clearTestDb } = require("./db");

beforeAll(async () => {
  await connectTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await clearTestDb();
});

describe("Auth API", () => {
  const userData = {
    name: "Тест Пассажир",
    username: "TestPassenger",
    password: "Bombila2026",
    confirmPassword: "Bombila2026",
  };

  it("health check responds ok", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("registers a user, lowercases the username and sets an httpOnly cookie", async () => {
    const res = await request(app).post("/api/user/register").send(userData);
    expect(res.status).toBe(201);
    expect(res.body.data.user.username).toBe("testpassenger");
    expect(res.body.data.user.password).toBeUndefined();

    const cookieHeader = res.headers["set-cookie"].join(";");
    expect(cookieHeader).toMatch(/telegramToken=/);
    expect(cookieHeader).toMatch(/HttpOnly/i);
  });

  it("rejects registration with mismatched passwords", async () => {
    const res = await request(app)
      .post("/api/user/register")
      .send({ ...userData, confirmPassword: "different-pass" });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Пароли не совпадают");
  });

  it("rejects registration with a short password", async () => {
    const res = await request(app)
      .post("/api/user/register")
      .send({ ...userData, password: "short", confirmPassword: "short" });
    expect(res.status).toBe(400);
  });

  it("logs in and returns the user", async () => {
    await request(app).post("/api/user/register").send(userData);
    const res = await request(app)
      .post("/api/user/login")
      .send({ username: "testpassenger", password: "Bombila2026" });
    expect(res.status).toBe(200);
    expect(res.body.data.user.username).toBe("testpassenger");
  });

  it("rejects login with a wrong password", async () => {
    await request(app).post("/api/user/register").send(userData);
    const res = await request(app)
      .post("/api/user/login")
      .send({ username: "testpassenger", password: "wrong-password" });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Неверный логин или пароль");
  });

  it("rejects duplicate usernames", async () => {
    await request(app).post("/api/user/register").send(userData);
    const res = await request(app).post("/api/user/register").send(userData);
    expect(res.status).toBe(409);
  });

  it("returns the current user for /me with a valid cookie", async () => {
    const registerRes = await request(app)
      .post("/api/user/register")
      .send(userData);
    const res = await request(app)
      .get("/api/user/me")
      .set("Cookie", registerRes.headers["set-cookie"]);
    expect(res.status).toBe(200);
    expect(res.body.data.user.username).toBe("testpassenger");
    expect(res.body.data.user.password).toBeUndefined();
  });

  it("rejects /me without a token", async () => {
    const res = await request(app).get("/api/user/me");
    expect(res.status).toBe(401);
  });

  it("rejects /me with an invalid token", async () => {
    const res = await request(app)
      .get("/api/user/me")
      .set("Cookie", "telegramToken=garbage");
    expect(res.status).toBe(401);
  });

  it("protects other API routes without a token", async () => {
    const res = await request(app).get("/api/profile");
    expect(res.status).toBe(401);
  });

  it("clears the auth cookie on logout", async () => {
    const registerRes = await request(app)
      .post("/api/user/register")
      .send(userData);
    const res = await request(app)
      .post("/api/user/logout")
      .set("Cookie", registerRes.headers["set-cookie"]);
    expect(res.status).toBe(200);

    // The logout response must carry an expired cookie
    const clearedCookie = res.headers["set-cookie"].find((cookie) =>
      cookie.startsWith("telegramToken=")
    );
    expect(clearedCookie).toBeDefined();
    expect(clearedCookie).toMatch(/Expires=Thu, 01 Jan 1970/i);

    // The cleared cookie no longer authenticates
    const after = await request(app)
      .get("/api/user/me")
      .set("Cookie", [clearedCookie.split(";")[0]]);
    expect(after.status).toBe(401);
  });
});

