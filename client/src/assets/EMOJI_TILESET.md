# Бомбила — список эмодзи проекта и спецификация тайлсета

Все эмодзи, которые сейчас используются в клиенте (`client/src`), с назначением,
контекстом и рекомендуемым размером. Размеры указаны для готовых PNG с прозрачным
фоном (экспорт @3x, чтобы на экране 1x/2x выглядеть резко).

База стиля — тёмная тема проекта (`client/src/index.css`):
- фон `#0D0D0D`, панели `#1E1E1E`, стекло `rgba(20,20,20,0.78)`;
- акцент (CTA) `#F7C700`, градиент кнопок `#FFD84D → #F7C700 → #E0A800`;
- danger `#E5484D`, success `#2EA043`, secondary-текст `#9C9C9C`;
- шрифты: display `Unbounded`, body `Manrope`.

Три размера:
- **S = 24 px** (мелкие инлайн-иконки внутри текста и строк статуса);
- **M = 32 px** (кнопки, карточки-бейджи, заголовки блоков);
- **L = 40 px** (крупные баннеры, «пустое состояние», модальные кнопки).

---

## 1. Статусы заказа (statusLabels.js — statusBadge)

| № | Эмодзи | Имя файла | Размер | Описание | Где |
|---|--------|-----------|--------|----------|-----|
| 1 | 🕓 | `status-draft.png` | S (24) | Часы со стрелкой — «Запланирован» | бейдж статуса |
| 2 | 🔎 | `status-published.png` | S (24) | Лупа — «Ищем водителя» | бейдж статуса |
| 3 | 🔖 | `status-booked.png` | S (24) | Закладка — «Забронирован» | бейдж статуса |
| 4 | 🚕 | `status-assigned.png` | S (24) | Машина такси — «Водитель назначен» | бейдж статуса |
| 5 | 🚕 | `status-arriving.png` | S (24) | Машина такси с движением — «Выехал» | бейдж статуса |
| 6 | 📍 | `status-waiting.png` | S (24) | Метка места — «На месте» | бейдж статуса |
| 7 | 🛣 | `status-in-ride.png` | S (24) | Дорога — «В пути» | бейдж статуса |
| 8 | ✅ | `status-completed.png` | S (24) | Галочка в круге — «Завершён» | бейдж статуса |
| 9 | ⌛ | `status-expired.png` | S (24) | Песочные часы — «Истёк» | бейдж статуса |
| 10 | ✖️ | `status-cancelled.png` | S (24) | Крест — «Отменён» | бейдж статуса |
| 11 | 🚫 | `status-no-show.png` | S (24) | Запрет — «Неявка» | бейдж статуса |
| 12 | ⚠️ | `status-dispute.png` | S (24) | Предупреждение — «Спор» | бейдж статуса |

Статусы ASSIGNED и ARRIVING используют один и тот же 🚕 — нужны две разные
картинки (стоящая и едущая машина).

## 2. Статусы города (statusLabels.js — cityStatusEmoji)

| № | Эмодзи | Имя файла | Размер | Описание |
|---|--------|-----------|--------|----------|
| 13 | 😴 | `city-dormant.png` | M (32) | Спящий — «Не запущен» |
| 14 | 🕓 | `city-waitlist.png` | M (32) | Часы — «Список ожидания» (можно тот же, что `status-draft`, отдельная копия) |
| 15 | ✅ | `city-pilot.png` | M (32) | Галочка — «Активен» |
| 16 | 🟢 | `city-active.png` | M (32) | Зелёный круг — «Полностью активен» |
| 17 | ⛔ | `city-suspended.png` | M (32) | Красный запрет — «Приостановлен» |
| 18 | ❔ | `city-unknown.png` | M (32) | Знак вопроса — неизвестный статус |

## 3. Навигация и разделы (TaxiApp / RolesSection)

| № | Эмодзи | Имя файла | Размер | Описание | Где |
|---|--------|-----------|--------|----------|-----|
| 19 | 🚕 | `nav-orders.png` | M (32) | Такси — вкладка «Заказы» | нижняя навигация |
| 20 | 🧾 | `nav-trips.png` | M (32) | Чек — вкладка «Поездки» | нижняя навигация |
| 21 | 🪪 | `nav-cabinet.png` | M (32) | Удостоверение — вкладка «Кабинет»/«Регистрация» | навигация, экран регистрации |
| 22 | 🚪 | `nav-exit.png` | M (32) | Дверь — «Выйти» | навигация, экран входа |
| 23 | 🎧 | `role-support.png` | M (32) | Наушники — роль/поддержка | RolesSection, TaxiApp |
| 24 | 🗺️ | `role-map.png` | M (32) | Карта — регионы/города | RolesSection, TaxiApp |
| 25 | 🧍 | `role-person.png` | M (32) | Силуэт человека — участник/роль | DriverPanel, OrderChat, RolesSection |
| 26 | 👤 | `role-profile.png` | L (40) | Профиль — аватар/личные данные | CallModal, RolesSection |
| 27 | 📨 | `action-application.png` | M (32) | Входящее письмо — заявка на роль | RolesSection |
| 28 | 🎨 | `action-region-paint.png` | M (32) | Палитра — оформление региона | RolesSection |
| 29 | 🔢 | `action-code.png` | M (32) | Цифры — код/номер | CallModal, RolesSection |

## 4. Заказы, отклики, цены

| № | Эмодзи | Имя файла | Размер | Описание | Где |
|---|--------|-----------|--------|----------|-----|
| 30 | 💰 | `order-price.png` | S (24) | Мешок с деньгами — цена | уведомления, карточки, чат |
| 31 | ⏱ | `order-eta.png` | S (24) | Секундомер — время подачи | уведомления, карточки |
| 32 | 🧑‍✈️ | `order-driver.png` | M (32) | Водитель — имя водителя | уведомления, карточки |
| 33 | 🚗 | `order-car.png` | M (32) | Машина — марка/цвет/номер | уведомления, карточки |
| 34 | 📞 | `order-call.png` | M (32) | Трубка — «Позвонить» | кнопки заказа, водители |
| 35 | 📋 | `order-list.png` | M (32) | Планшет с зажимом — список заказов | DriverPanel, PassengerPanel |
| 36 | 📢 | `order-feed.png` | M (32) | Громкоговоритель — «Лента заказов» | DriverPanel |
| 37 | 🏁 | `order-finished.png` | M (32) | Флаг финиша — завершённые поездки | TripsList |
| 38 | 🛋 | `order-idle.png` | M (32) | Диван — «Пока пусто» / отдых | TripsList |
| 39 | 🗂 | `order-archive.png` | M (32) | Папка — архив/история | TripsList |
| 40 | 📭 | `order-empty.png` | M (32) | Пустой ящик — «Нет заказов» | DriverPanel |
| 41 | ⚡ | `order-now.png` | M (32) | Молния — «Сейчас» | PassengerPanel |
| 42 | 🕓 | `order-scheduled.png` | M (32) | Часы — «На время»/«Когда» | PassengerPanel, TimePicker, AddressInput |
| 43 | 🕒 | `order-time.png` | M (32) | Часы с цифрой — время заказа | OrderChat |
| 44 | 🕐 | `order-time-alt.png` | M (32) | Циферблат — выбор времени | TimePicker |
| 45 | 📝 | `order-note.png` | M (32) | Записка — комментарий/пометка | DispatcherPanel |
| 46 | ⭐ | `order-favorite.png` | M (32) | Звезда залитая — избранное | PassengerPanel |
| 47 | ★ | `order-favorite-outline.png` | S (24) | Звезда контурная — добавить в избранное | DriverPanel, OrderChat, PassengerPanel |
| 48 | ☆ | `order-favorite-empty.png` | S (24) | Звезда пустая — не в избранном | PassengerPanel |

## 5. Чат и сообщения

| № | Эмодзи | Имя файла | Размер | Описание |
|---|--------|-----------|--------|----------|
| 49 | 💬 | `chat-message.png` | M (32) | Облако диалога — сообщение/диалоги |
| 50 | 📷 | `chat-photo.png` | M (32) | Фотоаппарат — отправить фото |
| 51 | 🎤 | `chat-voice.png` | M (32) | Микрофон — голосовое сообщение |
| 52 | 🎙 | `chat-voice-live.png` | M (32) | Студийный микрофон — идёт запись |
| 53 | ⏺ | `chat-record.png` | M (32) | Кнопка записи — начать запись |
| 54 | ➤ | `chat-send.png` | M (32) | Стрелка отправки — отправить |
| 55 | ← | `chat-scroll-left.png` | M (32) | Стрелка влево — прокрутка/назад |
| 56 | ⬅️ | `chat-back.png` | M (32) | Стрелка влево — «Назад» |

## 6. Звонки

| № | Эмодзи | Имя файла | Размер | Описание |
|---|--------|-----------|--------|----------|
| 57 | 🔇 | `call-mic-off.png` | M (32) | Микрофон выключен |
| 58 | 🔊 | `call-speaker.png` | M (32) | Динамик — громкая связь |
| 59 | 📵 | `call-decline.png` | L (40) | Телефон с запретом — отклонить/сбросить |

## 7. Системные действия

| № | Эмодзи | Имя файла | Размер | Описание |
|---|--------|-----------|--------|----------|
| 60 | 🔗 | `action-share.png` | M (32) | Звено цепи — «Поделиться» |
| 61 | 🔽 | `action-collapse.png` | S (24) | Треугольник вниз — раскрыть/свернуть |
| 62 | 🔼 | `action-expand.png` | S (24) | Треугольник вверх — свернуть |
| 63 | 🔴 | `action-offline.png` | S (24) | Красный круг — офлайн/на линии |
| 64 | ⏳ | `action-waiting.png` | M (32) | Песочные часы — ожидание |
| 65 | ❌ | `action-remove.png` | M (32) | Крест — удалить/отменить |
| 66 | 🏙 | `address-city.png` | M (32) | Городской пейзаж — город в адресе |
| 67 | 🛣 | `address-street.png` | M (32) | Дорога — улица в адресе |

> Эмодзи «→» (стрелка перехода, 9 использований в DispatcherPanel/DriverPanel)
> и «Слюдянка/с»-чипы лучше оставить текстовыми, отдельных картинок не требуют.

---

## Полные промпты для генерации (по одному на каждый размер)

Каждый промпт самодостаточный: копируй целиком и вставляй без правок.
Общий для всех трёх: сетка 1024×1024, 8 столбцов × 8 строк, ячейка 128×128.
Различаются только итоговый размер и уровень детализации.

---

### ПРОМПТ S — маленький тайлсет (иконки 24 px на экране, экспорт 72 px @3x)

Сюжеты: статусы заказа, цена, время подачи, звёзды-контуры, chevrons, «офлайн».

```
Design a premium mobile-app ICON SET for a Russian taxi-ordering app called "Бомбила" (Bombila). This is NOT an emoji pack. Do not render emoji, do not use the emoji look. Render each subject as a purpose-built flat-vector UI icon that belongs to one branded family.

BRAND / TAXI IDENTITY (must be visible in the set):
- Primary motif: a taxi. Wherever a vehicle, a status, or "active/online" is shown, tie it to taxi language: roof light sign, checkered taxi stripe (yellow/black squares), steering wheel, road, meter, driver cap, radio.
- Signature accent: taxi checkered band = alternating small squares of #F7C700 and #111111. Repeat this checker as a brand detail on car roof signs, pins, ribbon tips.
- Night-city mood: objects are a dark charcoal body (#1E1E1E) with a warm yellow (#F7C700) light/glow, as if street lamps and headlights on a dark street.

VISUAL CANON (identical for every icon):
- Construction: geometric flat vector from simple primitives (circles, rounded rectangles, triangles). Slightly chunky, sticker-like proportions.
- Weight: ONE uniform very bold stroke, round caps and round joins, no hairlines.
- Depth: exactly ONE shading style — a soft top-to-bottom gradient inside the main shape plus one thin white inner highlight at the top edge. NO 3D bevel, NO cast shadows, NO glossy plastic.
- Corners: generously rounded. Perspective: flat frontal OR one gentle 3/4 angle, never mixed.
- Silhouettes: bold and readable at 24 px.

SIZE / DETAIL RULES (this is the SMALL set):
- Output: one 1024x1024 sprite sheet, 8 columns x 8 rows, 128x128 px per cell, PNG-32 with true alpha, transparent background.
- Each icon will be exported at 72x72 px and displayed at 24 px.
- SIMPLIFY FOR SMALL SIZE: main silhouette only, max 2-3 elements, NO fine inner detail. Stroke about 22-24 px within the 128 px cell so it survives downscaling.
- Taxi checker: at most 2 checker squares. Keep a wider safe padding (~16%) so nothing looks cramped.
- If an element would vanish at 24 px, remove it.

PALETTE (nothing else): warm yellow #F7C700, gradient #FFD84D -> #F7C700 -> #E0A800, near-black #111111, charcoal body #1E1E1E, white #FFFFFF, neutral gray #9C9C9C, danger red #E5484D, success green #2EA043. Yellow = accent/active/vehicles. Charcoal+gray = neutral. Red/green ONLY for state. No blue, purple, pink, teal, brown.

HARD RULES: transparent background; no background tile, no plate, no frame, no text, no letters, no numbers, no watermark. Do not use Apple/Google/Twitter emoji style, no cartoon eyes on objects, no airbrush, no realism, no isometric. Same optical weight and padding across all cells. Near-black #111111 outer contour on bright parts so icons read on a #0D0D0D background.

SUBJECTS (row, col, name, description):
r1c1, status-draft, clock face with a small forward arrow, gray, subtle checker on rim
r1c2, status-published, magnifying glass over a small taxi silhouette, yellow
r1c3, status-booked, bookmark ribbon with a tiny checker tip, yellow
r1c4, status-assigned, taxi sedan front 3/4 with a lit roof sign, yellow body
r1c5, status-arriving, same taxi sedan with motion lines and a headlight cone, yellow
r1c6, status-waiting, map pin whose base sits on a short checkered kerb, yellow
r1c7, status-in-ride, winding road with a dashed center line, charcoal and gray
r1c8, status-completed, rounded check mark, green
r2c1, status-expired, hourglass, gray
r2c2, status-cancelled, bold cross, red
r2c3, status-no-show, prohibition sign (circle with slash), red
r2c4, status-dispute, warning triangle with exclamation, red
r2c5, order-price, money bag with a coin, yellow accent
r2c6, order-eta, stopwatch, yellow accent
r2c7, order-favorite-outline, outlined star, gray
r2c8, order-favorite-empty, plain empty star, gray
r3c1, action-collapse, down chevron, gray
r3c2, action-expand, up chevron, gray
r3c3, action-offline, filled circle, red

Leave the remaining cells fully transparent. OUTPUT: 1024x1024 PNG-32, 8x8 grid, 128x128 cells, transparent background, no grid lines, no labels, every icon from the SAME family with the taxi checker motif and yellow night-street glow.
```

---

### ПРОМПТ M — средний тайлсет (иконки 32 px на экране, экспорт 96 px @3x)

Основной набор: навигация, роли, города, чат, звонки, заказы. Этот лист —
стилевой эталон для всего семейства.

```
Design a premium mobile-app ICON SET for a Russian taxi-ordering app called "Бомбила" (Bombila). This is NOT an emoji pack. Do not render emoji, do not use the emoji look. Render each subject as a purpose-built flat-vector UI icon that belongs to one branded family.

BRAND / TAXI IDENTITY (must be visible in the set):
- Primary motif: a taxi. Wherever a vehicle, a status, or "active/online" is shown, tie it to taxi language: roof light sign, checkered taxi stripe (yellow/black squares), steering wheel, road, meter, driver cap, radio.
- Signature accent: taxi checkered band = alternating small squares of #F7C700 and #111111. Repeat this checker on car roof signs, badges, receipt corners, folder tabs, pin bases.
- Night-city mood: objects are a dark charcoal body (#1E1E1E) with a warm yellow (#F7C700) light/glow, as if street lamps and headlights on a dark street.

VISUAL CANON (identical for every icon):
- Construction: geometric flat vector from simple primitives (circles, rounded rectangles, triangles). Slightly chunky, sticker-like proportions.
- Weight: ONE uniform bold stroke, round caps and round joins, no hairlines.
- Depth: exactly ONE shading style — a soft top-to-bottom gradient inside the main shape plus one thin white inner highlight at the top edge. NO 3D bevel, NO cast shadows, NO glossy plastic.
- Corners: generously rounded. Perspective: flat frontal OR one gentle 3/4 angle, never mixed.
- Silhouettes: bold and readable at 32 px, max 3-4 elements per icon.

SIZE / DETAIL RULES (this is the STANDARD set):
- Output: one 1024x1024 sprite sheet, 8 columns x 8 rows, 128x128 px per cell, PNG-32 with true alpha, transparent background.
- Each icon will be exported at 96x96 px and displayed at 32 px.
- DETAIL LEVEL: full canon — main shape + ONE accent detail + the taxi checker motif, max 3-4 elements. Stroke about 18-20 px within the 128 px cell. Safe padding ~12%.
- This sheet DEFINES THE STYLE REFERENCE for the whole family: keep construction, stroke and light direction identical across cells.

PALETTE (nothing else): warm yellow #F7C700, gradient #FFD84D -> #F7C700 -> #E0A800, near-black #111111, charcoal body #1E1E1E, white #FFFFFF, neutral gray #9C9C9C, danger red #E5484D, success green #2EA043. Yellow = accent/active/vehicles. Charcoal+gray = neutral. Red/green ONLY for state. No blue, purple, pink, teal, brown.

HARD RULES: transparent background; no background tile, no plate, no frame, no text, no letters, no numbers, no watermark. Do not use Apple/Google/Twitter emoji style, no cartoon eyes on objects, no airbrush, no realism, no isometric. Same optical weight and padding across all cells. Near-black #111111 outer contour on bright parts so icons read on a #0D0D0D background.

SUBJECTS (row, col, name, description):
r1c1, city-dormant, relaxed sleeping face, gray
r1c2, city-waitlist, clock, gray
r1c3, city-pilot, check mark inside a rounded badge, yellow accent
r1c4, city-active, filled circle, green
r1c5, city-suspended, solid prohibition sign, red
r1c6, city-unknown, question mark, gray
r1c7, nav-orders, taxi sedan side view with a roof sign, yellow
r1c8, nav-trips, receipt slip with a checkered corner, gray and checker
r2c1, nav-cabinet, id badge card with a small taxi mark, gray
r2c2, nav-exit, open door, gray
r2c3, role-support, headset headphones, gray
r2c4, role-map, folded map with a route line and a pin, gray
r2c5, role-person, person silhouette with a driver cap, gray
r2c6, action-application, incoming envelope, yellow accent
r2c7, action-region-paint, artist palette, gray
r2c8, action-code, abstract keypad dots, gray
r3c1, order-driver, driver bust with a cap and a small wheel, yellow accent
r3c2, order-car, sedan car side view, charcoal and gray
r3c3, order-call, phone handset, yellow accent
r3c4, order-list, clipboard with rows, gray
r3c5, order-feed, megaphone, yellow accent
r3c6, order-finished, checkered finish flag, yellow and black checker
r3c7, order-idle, low sofa couch, gray
r3c8, order-archive, folder with a checkered tab, gray and checker
r4c1, order-empty, empty open tray, gray
r4c2, order-now, lightning bolt, yellow accent
r4c3, order-scheduled, clock, gray
r4c4, order-time, clock with a small tick mark, gray
r4c5, order-time-alt, plain clock face, gray
r4c6, order-note, notepad with a pen, gray
r4c7, order-favorite, filled star, yellow accent
r4c8, chat-message, speech bubble, gray
r5c1, chat-photo, camera, gray
r5c2, chat-voice, microphone, gray
r5c3, chat-voice-live, studio microphone with small level bars, yellow accent
r5c4, chat-record, big filled record dot, red
r5c5, chat-send, paper-plane arrow, yellow accent
r5c6, chat-scroll-left, arrow left, gray
r5c7, chat-back, bold arrow left, white
r5c8, call-mic-off, microphone with a slash, red
r6c1, call-speaker, speaker with sound waves, yellow accent
r6c2, action-share, chain link, gray
r6c3, action-waiting, hourglass, gray
r6c4, address-city, city skyline, charcoal and gray
r6c5, address-street, road with a dashed line, charcoal and gray

Leave the remaining cells fully transparent. OUTPUT: 1024x1024 PNG-32, 8x8 grid, 128x128 cells, transparent background, no grid lines, no labels, every icon from the SAME family with the taxi checker motif and yellow night-street glow.
```

---

### ПРОМПТ L — крупный тайлсет (иконки 40 px на экране, экспорт 120 px @3x)

Hero-иконки, «пустые состояния», модальные кнопки. Детализация самая богатая.

```
Design a premium mobile-app ICON SET for a Russian taxi-ordering app called "Бомбила" (Bombila). This is NOT an emoji pack. Do not render emoji, do not use the emoji look. Render each subject as a purpose-built flat-vector UI icon that belongs to one branded family.

BRAND / TAXI IDENTITY (must be visible in the set):
- Primary motif: a taxi. Wherever a vehicle, a status, or "active/online" is shown, tie it to taxi language: roof light sign, checkered taxi stripe (yellow/black squares), steering wheel, road, meter, driver cap, radio.
- Signature accent: taxi checkered band = alternating small squares of #F7C700 and #111111. Repeat this checker on car roof signs, badges, finish flags, pin bases.
- Night-city mood: objects are a dark charcoal body (#1E1E1E) with a warm yellow (#F7C700) light/glow, as if street lamps and headlights on a dark street.

VISUAL CANON (identical for every icon):
- Construction: geometric flat vector from simple primitives (circles, rounded rectangles, triangles). Slightly chunky, sticker-like proportions.
- Weight: ONE uniform bold stroke, round caps and round joins, no hairlines.
- Depth: exactly ONE shading style — a soft top-to-bottom gradient inside the main shape plus one thin white inner highlight at the top edge. NO 3D bevel, NO cast shadows, NO glossy plastic.
- Corners: generously rounded. Perspective: flat frontal OR one gentle 3/4 angle, never mixed.
- Silhouettes: bold and readable, hero quality at 40 px, max 4-5 elements per icon.

SIZE / DETAIL RULES (this is the HERO set):
- Output: one 1024x1024 sprite sheet, 8 columns x 8 rows, 128x128 px per cell, PNG-32 with true alpha, transparent background.
- Each icon will be exported at 120x120 px and displayed at 40 px.
- DETAIL LEVEL: richest of the three — main shape + a light source/glow + the taxi checker motif + one accent element, max 4-5 elements. Stroke about 16-18 px within the 128 px cell. Safe padding ~10%.
- Keep the same stroke, skew and light direction as the standard set so the family matches.

PALETTE (nothing else): warm yellow #F7C700, gradient #FFD84D -> #F7C700 -> #E0A800, near-black #111111, charcoal body #1E1E1E, white #FFFFFF, neutral gray #9C9C9C, danger red #E5484D, success green #2EA043. Yellow = accent/active/vehicles. Charcoal+gray = neutral. Red/green ONLY for state. No blue, purple, pink, teal, brown.

HARD RULES: transparent background; no background tile, no plate, no frame, no text, no letters, no numbers, no watermark. Do not use Apple/Google/Twitter emoji style, no cartoon eyes on objects, no airbrush, no realism, no isometric. Same optical weight and padding across all cells. Near-black #111111 outer contour on bright parts so icons read on a #0D0D0D background.

SUBJECTS (row, col, name, description):
r1c1, role-profile, profile avatar circle with a checkered ring, gray
r1c2, call-decline, phone handset with a slash, red
r1c3, order-driver, driver bust with a cap and small steering wheel, yellow accent
r1c4, order-car, detailed taxi sedan with a lit roof sign, yellow body
r1c5, order-finished, checkered finish flag, yellow and black checker
r1c6, address-city, night city skyline with lit windows, charcoal and yellow glow
r1c7, order-empty, empty open tray with a small floating dust dot, gray
r1c8, city-active, big filled circle with a soft yellow glow ring, green
r2c1, nav-orders, hero taxi sedan side view with roof sign and motion, yellow
r2c2, order-favorite, large filled star with a soft glow, yellow accent

Leave the remaining cells fully transparent. OUTPUT: 1024x1024 PNG-32, 8x8 grid, 128x128 cells, transparent background, no grid lines, no labels, every icon from the SAME family with the taxi checker motif and yellow night-street glow.
```

### Как не получить «просто эмодзи» — чеклист
- Плоский вектор + одна градиентная заливка + белый inner-highlight, **без** 3D,
  без теней, без глянца (эмодзи-стиль — это как раз глянец и объём).
- Единая толщина обводки и скругления у всех иконок.
- Жёлто-чёрная **шашечка такси** как повторяющийся фирменный элемент.
- Никаких «плиток» и кружков под иконкой.
- Сначала сгенерируй **3 эталона** (`status-assigned` — машина, `nav-orders` —
  такси сбоку, `order-favorite` — звезда) и дальше прикладывай их как
  reference-изображения: тогда вся семья будет единой.

### Как нарезать и назвать
- Экспорт тайлсета: `1024×1024`, 8×8 → каждая ячейка `128×128`.
- Нарезать по сетке в имена из колонки «Имя файла» (см. таблицы).
- Масштаб на экспорт: **S = 72 px**, **M = 96 px**, **L = 120 px** (это @3x для
  24/32/40 px на экране), PNG-32 с прозрачностью.
- Повторяющиеся сюжеты (🕓 встречается 4 раза, ✅ — 3, 🚕 — много) —
  сгенерировать одну эталонную картинку и переиспользовать файл, чтобы стиль
  не «плыл».
