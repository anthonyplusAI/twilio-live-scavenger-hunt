const form = document.getElementById("login-form");
const message = document.getElementById("login-message");
const submit = document.getElementById("submit-button");
const password = document.getElementById("password");
const show = document.getElementById("show-password");
const googleSignin = document.getElementById("google-signin");
const googleLink = document.getElementById("google-signin-link");

function safeNext() {
  const raw = new URLSearchParams(location.search).get("next");
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  try {
    const url = new URL(raw, location.origin);
    if (url.origin !== location.origin || url.pathname === "/login") return null;
    return url.pathname + url.search + url.hash;
  } catch { return null; }
}
async function homePath() {
  const next = safeNext();
  if (next) return next;
  try {
    const response = await fetch("/api/admin/events", { credentials: "same-origin" });
    if (response.ok) {
      const data = await response.json();
      if (data.events?.[0]?.slug) return "/e/" + encodeURIComponent(data.events[0].slug) + "/operator";
    }
  } catch { /* root remains a useful fallback */ }
  return "/";
}
async function alreadySignedIn() {
  try {
    const response = await fetch("/api/auth/session", { credentials: "same-origin" });
    if (response.ok) location.replace(await homePath());
  } catch { /* the form remains usable while offline */ }
}
async function showConfiguredProviders() {
  try {
    const response = await fetch("/api/auth/providers", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!response.ok) return;
    const providers = await response.json();
    if (!providers.google?.enabled) return;
    const destination = new URL("/api/auth/google/start", location.origin);
    const next = safeNext();
    if (next) destination.searchParams.set("next", next);
    googleLink.href = destination.pathname + destination.search;
    googleSignin.hidden = false;
    document.body.classList.add("google-enabled");
  } catch { /* password sign-in remains available */ }
}
function showReturnMessage() {
  const params = new URLSearchParams(location.search);
  if (params.get("notice") === "admin-credentials-changed") {
    const username = String(params.get("username") || "").trim().toLowerCase();
    if (/^[a-z][a-z0-9._-]{2,79}$/.test(username)) document.getElementById("username").value = username;
    message.textContent = "Admin login saved. Sign in with the updated credentials.";
    message.classList.add("success");
    return;
  }
  if (params.get("notice") === "username-changed") {
    const username = String(params.get("username") || "").trim().toLowerCase();
    if (/^[a-z][a-z0-9._-]{2,79}$/.test(username)) {
      document.getElementById("username").value = username;
      message.textContent = "Username changed. Sign in as " + username + " with your current password.";
    } else message.textContent = "Username changed. Sign in with your new username and current password.";
    message.classList.add("success");
    return;
  }
  if (params.get("notice") === "password-changed") {
    message.textContent = "Password changed. Sign in with your new password.";
    message.classList.add("success");
    return;
  }
  const error = params.get("error");
  if (!error) return;
  message.textContent = error === "google_domain"
    ? "Use a verified @twilio.com Google account."
    : error === "google_cancelled" || error === "access_denied"
      ? "Google sign-in was cancelled. Try again when you're ready."
      : "Google sign-in could not finish. Try again or use your booth account.";
}
show.addEventListener("click", () => {
  const visible = password.type === "password";
  password.type = visible ? "text" : "password";
  show.textContent = visible ? "Hide" : "Show";
  show.setAttribute("aria-label", visible ? "Hide password" : "Show password");
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";
  message.classList.remove("success");
  submit.disabled = true;
  submit.querySelector("span").textContent = "Signing in…";
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ username: document.getElementById("username").value.trim(), password: password.value }),
    });
    let data = {};
    try { data = await response.json(); } catch { /* keep the HTTP status */ }
    if (!response.ok) throw new Error(data.error || "Sign in failed. Check your credentials.");
    password.value = "";
    location.replace(await homePath());
  } catch (error) {
    message.textContent = error.message || "Could not sign in.";
    submit.disabled = false;
    submit.querySelector("span").textContent = "Enter control room";
    password.focus();
  }
});
showReturnMessage();
showConfiguredProviders();
alreadySignedIn();
