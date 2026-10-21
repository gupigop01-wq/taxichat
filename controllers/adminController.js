const { z } = require("zod");
const mongoose = require("mongoose");
const Application = require("../models/Application");
const City = require("../models/City");
const Membership = require("../models/Membership");
const AuditLog = require("../models/AuditLog");
const User = require("../models/User");
const ApiError = require("../utilities/errors");
const catchAsyncError = require("../utilities/catchAsyncError");
const { validateBody } = require("../utilities/catchAsyncError");
const { logAudit } = require("../utilities/audit");
const { recalcCityStatus } = require("../utilities/cityStatus");
const { isSuperadmin, loadMemberships, membershipCityId } = require("../utilities/rbac");

const reviewApplicationSchema = z.object({
  decision: z.enum(["approve", "reject"], {
    errorMap: () => ({ message: "Решение должно быть approve или reject" }),
  }),
  reason: z.string().trim().max(500).optional(),
});

const assignRoleSchema = z.object({
  userId: z.string().min(1, "Не указан пользователь"),
  cityId: z.string().min(1, "Не указан город"),
  role: z.enum(["dispatcher", "region_admin"], {
    errorMap: () => ({ message: "Роль должна быть dispatcher или region_admin" }),
  }),
});

exports.reviewApplicationSchema = reviewApplicationSchema;
exports.assignRoleSchema = assignRoleSchema;

// City ids of the regions where the requester is an ACTIVE region admin
// Проверка прав администратора региона: сам админ региона или суперадмин.
// memberships уже загружены мидлваром loadMemberships.
const requireRegionAdminOrThrow = (req) => {
  if (isSuperadmin(req)) return;
  const ok = (req.memberships ?? []).some(
    (item) => item.role === "region_admin" && item.status === "ACTIVE"
  );
  if (!ok) throw new ApiError(403, "Требуются права администратора региона");
};

const getRegionAdminCityScope = async (req) => {
  const adminCities = (req.memberships ?? []).filter(
    (item) => item.role === "region_admin" && item.status === "ACTIVE"
  );
  const cities = await City.find({
    _id: { $in: adminCities.map((item) => membershipCityId(item)) },
  });
  const regionIds = [...new Set(cities.map((city) => String(city.regionId)))];
  const regionCityIds = await City.find({ regionId: { $in: regionIds } }).select("_id");
  return regionCityIds.map((city) => String(city._id));
};

// Throws unless the requester may approve this application type in the city
const assertApplicationReviewer = async (req, application) => {
  if (isSuperadmin(req)) return;

  const City = require("../models/City");
  const city = await City.findById(application.cityId);
  if (!city) throw new ApiError(404, "Город не найден");

  if (application.type === "region_admin")
    throw new ApiError(403, "Назначать админов региона может только суперадмин");

  const scope = await getRegionAdminCityScope(req);
  if (!scope.includes(String(application.cityId)))
    throw new ApiError(403, "Недостаточно прав для рассмотрения этой заявки");
};

// Creates or reactivates a role membership
const upsertRoleMembership = async ({ userId, cityId, role, reviewedBy }) => {
  const membership = await Membership.findOneAndUpdate(
    { userId, cityId, role },
    { $set: { status: "ACTIVE", reviewedBy, reason: undefined } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await recalcCityStatus(cityId);
  return membership;
};

// GET /api/admin/applications?type=&status=
exports.listApplications = [
  loadMemberships,
  catchAsyncError(async (req, res) => {
    if (!isSuperadmin(req) && !(req.memberships ?? []).some(
      (item) => item.role === "region_admin" && item.status === "ACTIVE"
    )) {
      throw new ApiError(403, "Требуются права администратора региона");
    }

    const filter = {};
    if (req.query.type) {
      if (!["dispatcher", "region_admin"].includes(req.query.type))
        throw new ApiError(400, "Недопустимый тип заявки");
      filter.type = req.query.type;
    }
    filter.status = req.query.status ?? "PENDING";

    if (!isSuperadmin(req)) {
      filter.cityId = { $in: await getRegionAdminCityScope(req) };
    }

    const applications = await Application.find(filter)
      .populate("userId", "username name")
      .populate("cityId", "name status")
      .sort({ createdAt: 1 })
      .limit(200);

    res.json({ status: "success", data: { applications } });
  }),
];

// PATCH /api/admin/applications/:id — approve or reject an application
exports.reviewApplication = [
  loadMemberships,
  validateBody(reviewApplicationSchema),
  catchAsyncError(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id))
      throw new ApiError(400, "Некорректный идентификатор заявки");

    const application = await Application.findById(id);
    if (!application) throw new ApiError(404, "Заявка не найдена");
    if (application.status !== "PENDING")
      throw new ApiError(409, "Заявка уже обработана");

    await assertApplicationReviewer(req, application);

    const { decision, reason } = req.body;
    if (decision === "reject" && !reason)
      throw new ApiError(400, "Укажите причину отказа");

    application.status = decision === "approve" ? "APPROVED" : "REJECTED";
    application.reviewedBy = req.user._id;
    application.reason = reason;
    await application.save();

    let membership = null;
    if (decision === "approve") {
      membership = await upsertRoleMembership({
        userId: application.userId,
        cityId: application.cityId,
        role: application.type,
        reviewedBy: req.user._id,
      });
    }

    // Notify the applicant so the client can refresh the roles
    const { emitOrderEvents } = require("../utilities/sockets");
    emitOrderEvents([
      {
        room: `user:${application.userId}`,
        event: "membership:updated",
        payload: {
          cityId: String(application.cityId),
          role: application.type,
          status: decision === "approve" ? "ACTIVE" : application.status,
        },
      },
    ]);

    await logAudit({
      actorId: req.user._id,
      action: "admin.applicationReviewed",
      targetType: "Application",
      targetId: application._id,
      payload: {
        cityId: application.cityId,
        type: application.type,
        decision,
        reason,
      },
    });

    res.json({ status: "success", data: { application, membership } });
  }),
];

// POST /api/admin/roles — direct role assignment
exports.assignRole = [
  loadMemberships,
  validateBody(assignRoleSchema),
  catchAsyncError(async (req, res) => {
    requireRegionAdminOrThrow(req);
    const { userId, cityId, role } = req.body;

    if (!mongoose.isValidObjectId(userId))
      throw new ApiError(400, "Некорректный идентификатор пользователя");
    const user = await User.findById(userId);
    if (!user) throw new ApiError(404, "Пользователь не найден");

    const city = await City.findById(cityId);
    if (!city) throw new ApiError(404, "Город не найден");

    if (role === "region_admin" && !isSuperadmin(req))
      throw new ApiError(403, "Назначать админов региона может только суперадмин");

    if (role === "dispatcher" && !isSuperadmin(req)) {
      const scope = await getRegionAdminCityScope(req);
      if (!scope.includes(String(cityId)))
        throw new ApiError(403, "Недостаточно прав в этом регионе");
    }

    const membership = await upsertRoleMembership({
      userId,
      cityId,
      role,
      reviewedBy: req.user._id,
    });

    await logAudit({
      actorId: req.user._id,
      action: "admin.roleAssigned",
      targetType: "Membership",
      targetId: membership._id,
      payload: { cityId, role, userId },
    });

    res.status(201).json({ status: "success", data: { membership } });
  }),
];

// PATCH /api/admin/users/:id/ban — block or unblock an account
exports.setUserBan = [
  loadMemberships,
  catchAsyncError(async (req, res) => {
  requireRegionAdminOrThrow(req);
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id))
    throw new ApiError(400, "Некорректный пользователь");

  const user = await User.findById(id);
  if (!user) throw new ApiError(404, "Пользователь не найден");
  if (String(user._id) === String(req.user._id))
    throw new ApiError(400, "Нельзя заблокировать себя");
  if (user.isSuperadmin && !req.user.isSuperadmin)
    throw new ApiError(403, "Недостаточно прав");

  // A region admin may only ban users of their own region: a membership in
  // one of its cities or the home city there
  if (!isSuperadmin(req)) {
    const scope = await getRegionAdminCityScope(req);
    const inRegion =
      (user.homeCityId && scope.includes(String(user.homeCityId))) ||
      (await Membership.exists({ userId: user._id, cityId: { $in: scope } }));
    if (!inRegion)
      throw new ApiError(403, "Пользователь не относится к вашему региону");
  }

  const banned = req.body?.banned !== false;
  user.banned = banned;
  await user.save();
  if (banned) require("../utilities/sockets").disconnectUser(user._id);

  await logAudit({
    actorId: req.user._id,
    action: banned ? "admin.userBanned" : "admin.userUnbanned",
    targetType: "User",
    targetId: user._id,
    payload: { reason: req.body?.reason },
  });

  res.json({ status: "success", data: { user: { _id: user._id, banned: user.banned } } });
  }),
];

// GET /api/admin/audit — role journal for the region or the whole platform
exports.getAudit = [
  loadMemberships,
  catchAsyncError(async (req, res) => {
    if (!isSuperadmin(req) && !(req.memberships ?? []).some(
      (item) => item.role === "region_admin" && item.status === "ACTIVE"
    )) {
      throw new ApiError(403, "Требуются права администратора региона");
    }

    const filter = {};
    if (!isSuperadmin(req)) {
      filter["payload.cityId"] = { $in: await getRegionAdminCityScope(req) };
    }

    const limit = Math.min(parseInt(req.query.limit ?? "100", 10) || 100, 500);
    const entries = await AuditLog.find(filter)
      .sort({ at: -1 })
      .limit(limit)
      .populate("actorId", "username name");

    res.json({ status: "success", data: { entries } });
  }),
];
