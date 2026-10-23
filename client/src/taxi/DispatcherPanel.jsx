import { useEffect, useState } from "react";
import { apiGet, apiPost, apiPatch } from "./api";
import { useDialog } from "./AppDialog";
import { statusBadge, formatWhen } from "./statusLabels";
import { useDispatch } from "react-redux";
import { notificationActions } from "../store/notificationSlice";
import useSocket from "../hooks/useSocket";
import OrderChat from "./OrderChat";
import { IconText } from "./TaxiIcon";

// Dispatcher panel: city order queue, manual assignment, driver applications
// review and the region admin sections (concept 1.3 / 1.9)
const callLink = (phone) => `tel:${String(phone).replace(/[^\d+]/g, "")}`;

const DispatcherPanel = ({ cityId, role, me }) => {
  const { ask, confirm } = useDialog();
  const dispatch = useDispatch();
  const { socketListen, socket } = useSocket();
  const [orders, setOrders] = useState([]);
  const [pending, setPending] = useState([]);
  const [activeDrivers, setActiveDrivers] = useState([]);
  const [error, setError] = useState(null);
  // SOS center: one banner with the newest signal on top; every signal keeps
  // its own status so two dispatchers never overwrite each other
  const [sos, setSos] = useState([]);
  const [sosBusy, setSosBusy] = useState(null);
  // City dispatch line (number + note) edited by the shift
  const [citySettings, setCitySettings] = useState({ dispatchPhone: null, dispatchPhoneNote: "" });
  const [view, setView] = useState(null);
  const [adminTab, setAdminTab] = useState("applications");
  const [assigning, setAssigning] = useState({});
  const [assignPending, setAssignPending] = useState(null);
  const [applications, setApplications] = useState([]);
  const [complaints, setComplaints] = useState([]);
  const [audit, setAudit] = useState([]);

  const isRegionAdmin = role === "region_admin";

  const loadCitySettings = async () => {
    try {
      const res = await apiGet(`/api/dispatch/${cityId}/settings`);
      setCitySettings(res.data.settings);
    } catch {
      // The line is informational: its failure must not block the queue
    }
  };

  const editDispatchPhone = async () => {
    const answer = await ask({
      title: "Диспетчерская линия города",
      placeholder: "Телефон, например +7 902 111-22-33 · и подпись через ;",
      initial: [citySettings.dispatchPhone ?? "", citySettings.dispatchPhoneNote ?? ""]
        .filter(Boolean)
        .join(";"),
      okText: "Сохранить",
    });
    if (!answer) return;
    const [phone, ...rest] = answer.split(";");
    const note = rest.join(";").trim();
    try {
      const res = await apiPatch(`/api/dispatch/${cityId}/dispatch-phone`, {
        phone: phone.trim() || null,
        ...(note && { note }),
      });
      setCitySettings(res.data.settings);
      dispatch(notificationActions.addNotification({ message: "Диспетчерская линия обновлена", type: "success" }));
    } catch (err) {
      setError(err.message);
    }
  };

  const loadSos = async () => {
    try {
      const res = await apiGet(`/api/dispatch/${cityId}/sos`);
      setSos(res.data.signals);
    } catch (err) {
      // SOS must never hide the queue: a failure here is not a panel error
    }
  };
  const load = async () => {
    try {
      const [ordersRes, pendingRes, driversRes] = await Promise.all([
        apiGet(`/api/orders?cityId=${cityId}`),
        apiGet(`/api/dispatch/${cityId}/drivers?status=PENDING`),
        apiGet(`/api/dispatch/${cityId}/drivers?status=ACTIVE`),
      ]);
      setOrders(ordersRes.data.orders);
      setPending(pendingRes.data.drivers);
      setActiveDrivers(driversRes.data.drivers);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadAdmin = async (tab) => {
    if (!isRegionAdmin) return;
    try {
      if (tab === "applications") {
        const res = await apiGet("/api/admin/applications?type=dispatcher");
        setApplications(res.data.applications);
      }
      if (tab === "complaints") {
        const res = await apiGet("/api/admin/complaints?status=OPEN");
        setComplaints(res.data.complaints);
      }
      if (tab === "audit") {
        const res = await apiGet("/api/admin/audit?limit=50");
        setAudit(res.data.entries);
      }
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
    // The list is the source of truth: a live payload only tells us to reload,
    // so a banner missed while the tab was hidden still appears.
    loadSos();
    loadCitySettings();
    const onChanged = () => load();
    const onSos = () => loadSos();
    const onSosClosed = (payload) => {
      setSos((current) => current.filter((item) => String(item._id) !== String(payload.complaintId)));
    };
    const onSosTaken = () => loadSos();
    socketListen("order:new", onChanged);
    socketListen("order:status", onChanged);
    socketListen("sos:raised", onSos);
    socketListen("sos:closed", onSosClosed);
    socketListen("sos:taken", onSosTaken);
    // A phone that slept reconnects with an empty state: refresh the signals
    const onConnect = () => loadSos();
    socket.on("connect", onConnect);
    return () => {
      socket.off("order:new", onChanged);
      socket.off("order:status", onChanged);
      socket.off("sos:raised", onSos);
      socket.off("sos:closed", onSosClosed);
      socket.off("sos:taken", onSosTaken);
      socket.off("connect", onConnect);
    };
  }, [cityId]);

  // The admin sections (applications, complaints, audit) are region-admin only;
  // a dispatcher must not request them or see their 403 as a panel error.
  useEffect(() => {
    if (isRegionAdmin && adminTab) loadAdmin(adminTab);
  }, [adminTab, isRegionAdmin]);

  if (view) {
    return <OrderChat orderId={view} me={me} onBack={() => setView(null)} startCall={() => {}} />;
  }

  const takeSos = async (signal) => {
    try {
      setSosBusy(signal._id);
      const res = await apiPost(`/api/dispatch/sos/${signal._id}/take`);
      setSos((current) => current.map((item) => (item._id === signal._id ? res.data.signal : item)));
    } catch (err) {
      setError(err.message);
      loadSos();
    } finally {
      setSosBusy(null);
    }
  };

  const closeSos = async (signal, outcome) => {
    const resolution = await ask({
      title: outcome === "resolved" ? "Сигнал обработан" : "Закрыть как ложный",
      placeholder: "Что сделано (увидит админ региона)",
      okText: "Закрыть",
      danger: outcome !== "resolved",
    });
    if (!resolution || resolution.trim().length < 3) return;
    try {
      setSosBusy(signal._id);
      await apiPatch(`/api/dispatch/sos/${signal._id}`, { outcome, resolution: resolution.trim() });
      setSos((current) => current.filter((item) => item._id !== signal._id));
      dispatch(notificationActions.addNotification({ message: "Сигнал SOS закрыт", type: "success" }));
    } catch (err) {
      setError(err.message);
      loadSos();
    } finally {
      setSosBusy(null);
    }
  };

  const assign = async (orderId, membershipId) => {
    const order = orders.find((item) => item._id === orderId);
    const driver = activeDrivers.find((item) => item._id === membershipId);
    if (!order || !driver) return;
    const approved = await confirm({
      title: "Назначить водителя?",
      text: `${driver.displayName} (${driver.carCaption}) · ${order.from?.text ?? "Откуда"} → ${order.to?.text ?? "Куда"}`,
      okText: "Назначить",
    });
    if (!approved) return;
    try {
      setAssignPending(orderId);
      await apiPost(`/api/orders/${orderId}/assign`, { membershipId });
      setAssigning((current) => ({ ...current, [orderId]: "" }));
      dispatch(
        notificationActions.addNotification({
          message: "Водитель назначен на заказ",
          type: "success",
        })
      );
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setAssignPending(null);
    }
  };

  const review = async (membershipId, decision) => {
    try {
      let reason;
      if (decision === "reject") {
        reason = await ask({ title: "Причина отказа", placeholder: "Коротко, почему", okText: "Отклонить", danger: true });
        if (!reason) return;
      }
      await apiPatch(`/api/dispatch/drivers/${membershipId}`, { decision, reason });
      dispatch(
        notificationActions.addNotification({
          message:
            decision === "approve"
              ? "Водитель одобрен"
              : "Анкета отклонена",
          type: decision === "approve" ? "success" : "info",
        })
      );
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const reviewApplication = async (applicationId, decision) => {
    try {
      let reason;
      if (decision === "reject") {
        reason = await ask({ title: "Причина отказа", placeholder: "Коротко, почему", okText: "Отклонить", danger: true });
        if (!reason) return;
      }
      await apiPatch(`/api/admin/applications/${applicationId}`, { decision, reason });
      loadAdmin("applications");
    } catch (err) {
      setError(err.message);
    }
  };

  const resolveComplaint = async (complaintId, status) => {
    try {
      const resolution = await ask({ title: "Решение по жалобе", placeholder: "Что сделано", okText: "Сохранить" });
      if (!resolution || !resolution.trim()) return;
      await apiPatch(`/api/admin/complaints/${complaintId}`, { status, resolution });
      loadAdmin("complaints");
    } catch (err) {
      setError(err.message);
    }
  };

  // Working queue: what needs a dispatcher decision first, then live rides.
  const needsAction = orders
    .filter((order) => order.status === "DISPUTE" || order.status === "PUBLISHED")
    .sort((a, b) => (a.status === "DISPUTE" ? -1 : 1) - (b.status === "DISPUTE" ? -1 : 1)
      || new Date(a.createdAt) - new Date(b.createdAt));
  const inProgress = orders
    .filter((order) => ["ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE"].includes(order.status))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const orderRouteTitle = (order) =>
    order.to?.text ? `${order.from?.text} → ${order.to?.text}` : order.from?.text;

  const queueCard = (order) => (
    <div key={order._id} className={`glass rounded-2xl p-4 text-sm ${order.status === "DISPUTE" ? "border border-danger" : order.status === "PUBLISHED" ? "border border-accent/50" : ""}`}>
      <div className="flex items-start gap-2 min-w-0">
        <div className="font-semibold min-w-0 break-words">{orderRouteTitle(order)}</div>
        {order.unreadCount > 0 && (
          <span className="ml-auto bg-danger text-white rounded-full px-2 text-xs shrink-0">
            {order.unreadCount}
          </span>
        )}
      </div>
      <div className="text-secondary-text mt-1">
          <IconText>{statusBadge(order.status)}</IconText> · <IconText>{formatWhen(order.when)}</IconText> · {order.pax} пасс.
      </div>
      {order.driver?.displayName && <div className="text-secondary-text mt-1">Водитель: {order.driver.displayName}</div>}
      <div className="flex gap-2 mt-3 items-center flex-wrap">
        {order.status === "PUBLISHED" && (
          <>
            <label className="sr-only" htmlFor={`assign-${order._id}`}>Водитель для заказа</label>
            <select id={`assign-${order._id}`} className="bg-primary p-2 rounded-xl text-sm max-w-full"
              value={assigning[order._id] ?? ""} onChange={(event) => setAssigning((current) => ({ ...current, [order._id]: event.target.value }))}>
              <option value="">Выберите водителя</option>
              {activeDrivers.map((driver) => (
                <option key={driver._id} value={driver._id}>{driver.displayName} ({driver.carCaption})</option>
              ))}
            </select>
            <button className="btn-accent press px-3 py-2 rounded-xl font-semibold disabled:opacity-50"
              disabled={!assigning[order._id] || assignPending === order._id}
              onClick={() => assign(order._id, assigning[order._id])}>
              {assignPending === order._id ? "Назначаем…" : "Подтвердить назначение"}
            </button>
          </>
        )}
        <button className="underline" onClick={() => setView(order._id)}>
          Открыть заказ
        </button>
      </div>
    </div>
  );

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full max-w-[42rem] mx-auto w-full">
      {sos.length > 0 && (
        <div className="bg-danger text-white rounded-2xl p-4 space-y-3" role="alert" aria-live="assertive">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-display font-bold">
              <IconText>🚨 SOS · {sos.length}</IconText>
            </h3>
            <span className="text-xs opacity-90">
              {sos.some((item) => !item.takenBy) ? "никто не взял" : "в работе"}
            </span>
          </div>
          {sos.map((item) => {
            const order = orders.find((candidate) => String(candidate._id) === String(item.orderId));
            const driverPhone = order?.driver?.phone;
            const busy = sosBusy === item._id;
            return (
              <div key={item._id} className="bg-white/10 rounded-xl p-3 space-y-2">
                <div className="font-semibold">
                  {item.reporter?.name ?? "Пассажир"} · {order?.from?.text ?? "заказ"}
                </div>
                <div className="text-sm opacity-90 break-words">{item.text}</div>
                {item.takenBy && (
                  <div className="text-xs">
                    В работе: {item.takenBy.name}
                    {item.status === "IN_REVIEW" ? "" : " (взят ранее)"}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {item.phone && (
                    <a href={callLink(item.phone)} className="bg-white text-danger px-3 py-2 rounded-xl font-semibold">
                      <IconText>📞 Позвонить пассажиру</IconText>
                    </a>
                  )}
                  {driverPhone && (
                    <a href={callLink(driverPhone)} className="bg-white text-danger px-3 py-2 rounded-xl font-semibold">
                      <IconText>📞 Позвонить водителю</IconText>
                    </a>
                  )}
                  <button className="bg-black/30 px-3 py-2 rounded-xl font-semibold" onClick={() => setView(item.orderId)}>
                    Открыть чат
                  </button>
                  {!item.takenBy && (
                    <button
                      className="bg-white text-danger px-3 py-2 rounded-xl font-semibold disabled:opacity-60"
                      disabled={busy}
                      onClick={() => takeSos(item)}
                    >
                      {busy ? "Берём…" : "Взять в работу"}
                    </button>
                  )}
                  <button
                    className="bg-white text-danger px-3 py-2 rounded-xl font-semibold disabled:opacity-60"
                    disabled={busy}
                    onClick={() => closeSos(item, "resolved")}
                  >
                    Обработан
                  </button>
                  <button
                    className="px-3 py-2 rounded-xl font-semibold underline disabled:opacity-60"
                    disabled={busy}
                    onClick={() => closeSos(item, "dismissed")}
                  >
                    Ложный
                  </button>
                </div>
                {!item.phone && (
                  <p className="text-xs opacity-80">У пассажира нет телефона — свяжитесь через чат или позвоните водителю.</p>
                )}
              </div>
            );
          })}
          <p className="text-xs opacity-90">Закрытые сигналы остаются в журнале у админа региона.</p>
        </div>
      )}
      {error && <div className="text-danger text-sm">{error}</div>}

      {/* Диспетчерская линия города: пассажир видит её и звонит откуда угодно */}
      <div className="glass rounded-2xl p-3 space-y-1">
        <div className="font-semibold">Диспетчерская линия города</div>
        {citySettings.dispatchPhone && (
          <a
            className="text-cta-icon font-semibold underline text-[1.6rem]"
            href={`tel:${String(citySettings.dispatchPhone).replace(/[^\d+]/g, "")}`}
          >
            <IconText>📞 {citySettings.dispatchPhone}</IconText>
          </a>
        )}
        {citySettings.dispatchPhoneNote && (
          <div className="text-xs text-secondary-text">{citySettings.dispatchPhoneNote}</div>
        )}
        {!citySettings.dispatchPhone && (
          <div className="text-xs text-secondary-text">Номер не задан — пассажиры не смогут позвонить</div>
        )}
        <button className="underline text-sm" onClick={editDispatchPhone}>
          {citySettings.dispatchPhone ? "Изменить номер" : "Добавить номер"}
        </button>
      </div>

      {/* Заявки на диспетчера и управление регионом — наверху, под SOS */}
      {isRegionAdmin && (
        <div>
          <h3 className="font-display font-bold mb-2 tracking-wide">Управление регионом</h3>
          <div className="flex gap-2 flex-wrap text-sm mb-3" role="tablist" aria-label="Управление регионом">
            {[
              ["applications", `Заявки · ${applications.length}`],
              ["complaints", `Жалобы · ${complaints.length}`],
              ["audit", "Журнал"],
            ].map(([key, label]) => (
              <button
                key={key}
                role="tab" aria-selected={adminTab === key}
                className={`px-3 py-2 rounded-xl ${adminTab === key ? "bg-accent text-black" : "bg-secondary"}`}
                onClick={() => setAdminTab(key)}
                aria-controls={`admin-panel-${key}`}
              >
                {label}
              </button>
            ))}
          </div>

          {adminTab === "applications" && (
            <div id="admin-panel-applications" role="tabpanel" className="space-y-2 max-w-lg">
              {applications.length === 0 && (
                <div className="text-sm text-secondary-text">Заявок нет</div>
              )}
              {applications.map((application) => (
                <div key={application._id} className="glass rounded-2xl p-3 text-sm text-center">
                  <div className="font-semibold text-center">
                    {application.userId?.name} → {application.cityId?.name}
                  </div>
                  {application.note && (
                    <div className="text-secondary-text text-center break-words">{application.note}</div>
                  )}
                  <div className="flex gap-2 mt-2">
                    <button
                      className="bg-success text-white px-3 py-1 rounded"
                      onClick={() => reviewApplication(application._id, "approve")}
                    >
                      Одобрить
                    </button>
                    <button
                      className="bg-danger text-white px-3 py-1 rounded"
                      onClick={() => reviewApplication(application._id, "reject")}
                    >
                      Отклонить
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {adminTab === "complaints" && (
            <div id="admin-panel-complaints" role="tabpanel" className="space-y-2 max-w-lg">
              {complaints.length === 0 && (
                <div className="text-sm text-secondary-text">Открытых жалоб нет</div>
              )}
              {complaints.map((complaint) => (
                <div key={complaint._id} className="glass rounded-2xl p-3 text-sm text-center">
                  <div className="font-semibold text-center">
                    {complaint.type === "sos" ? "SOS" : "Жалоба"} ·{" "}
                    {complaint.reporterId?.name}
                  </div>
                  <div className="break-words">{complaint.text}</div>
                  <div className="flex gap-2 mt-2">
                    <button
                      className="bg-success text-white px-3 py-1 rounded"
                      onClick={() => resolveComplaint(complaint._id, "RESOLVED")}
                    >
                      Решено
                    </button>
                    <button
                      className="underline"
                      onClick={() => resolveComplaint(complaint._id, "DISMISSED")}
                    >
                      Отклонить
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {adminTab === "audit" && (
            <div id="admin-panel-audit" role="tabpanel" className="space-y-1 max-w-lg text-sm">
              {audit.map((entry) => (
                <div key={entry._id} className="text-secondary-text text-center">
                  {new Date(entry.at).toLocaleString()} · {entry.action} ·{" "}
                  {entry.actorId?.name ?? "система"}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Что требует решения: споры + неназначенные; сюда же анкеты водителей */}
      <div>
        <h3 className="font-display font-bold mb-2 tracking-wide">Требуют действий · {needsAction.length + pending.length}</h3>
        {pending.length > 0 && (
          <div className="space-y-2 mb-3">
            {pending.map((driver) => (
              <div key={driver._id} className="glass rounded-2xl p-3 text-sm">
                <div className="font-semibold break-words">Анкета: {driver.displayName}</div>
                <div className="text-secondary-text break-words">
                  {driver.carCaption} · {driver.user?.name}
                </div>
                <div className="flex gap-2 mt-2">
                  <button
                    className="bg-success text-white px-3 py-1 rounded"
                    onClick={() => review(driver._id, "approve")}
                  >
                    Одобрить
                  </button>
                  <button
                    className="bg-danger text-white px-3 py-1 rounded"
                    onClick={() => review(driver._id, "reject")}
                  >
                    Отклонить
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="space-y-2">
          {needsAction.length === 0 && pending.length === 0 && (
            <div className="text-sm text-secondary-text">Всё обработано — заказов без решения нет</div>
          )}
          {needsAction.map(queueCard)}
        </div>
      </div>

      {/* Активные поездки: назначены и едут */}
      <div>
        <h3 className="font-display font-bold mb-2 tracking-wide">Активные поездки · {inProgress.length}</h3>
        <div className="space-y-2">
          {inProgress.length === 0 && (
            <div className="text-sm text-secondary-text">Активных поездок нет</div>
          )}
          {inProgress.map(queueCard)}
        </div>
      </div>
    </div>
  );
};

export default DispatcherPanel;

