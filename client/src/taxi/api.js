// Thin fetch layer for the TaxiChat API; cookies carry the JWT session
const request = async (url, options = {}) => {
  const res = await fetch(url, {
    credentials: "include",
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  // Expired or invalid session: drop the local flag and reload to the login
  if (res.status === 401 && !url.includes("/api/user/login")) {
    localStorage.removeItem("loggedIn");
    if (!window.location.pathname.startsWith("/share/")) {
      window.location.reload();
    }
    throw new Error("Сессия истекла, войдите заново");
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message ?? "Ошибка запроса");
  }
  return data;
};

export const apiGet = (url, options = {}) => request(url, options);
export const apiPost = (url, body = {}) => request(url, { method: "POST", body });
export const apiPatch = (url, body = {}) => request(url, { method: "PATCH", body });
export const apiDelete = (url) => request(url, { method: "DELETE" });

// Uploads a file to Cloudinary via the server; returns uploadData
export const apiUpload = async (file, fileType) => {
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
  });
  const res = await apiPost("/api/upload", {
    data: base64.replace(/^data:[^;,]+(?:;codecs=[^;,]+)?;base64,/, (header) =>
      header.replace(/;codecs=[^;,]+/, "")
    ),
    fileType: fileType === "audio" ? "video" : fileType,
  });
  return res.data.uploadData;
};
