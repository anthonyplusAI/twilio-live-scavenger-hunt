const form = document.getElementById("login-form");
const message = document.getElementById("login-message");
const submit = document.getElementById("submit-button");
const password = document.getElementById("password");
const show = document.getElementById("show-password");

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
show.addEventListener("click", () => {
  const visible = password.type === "password";
  password.type = visible ? "text" : "password";
  show.textContent = visible ? "Hide" : "Show";
  show.setAttribute("aria-label", visible ? "Hide password" : "Show password");
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";
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
alreadySignedIn();
