(() => {
  const key = "live-scavenger-hunt-theme";
  const root = document.documentElement;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  const darkThemeColor = themeColor?.content || "#000d25";
  let current = "dark";

  try {
    if (localStorage.getItem(key) === "light") current = "light";
  } catch { /* Private browsing may disable storage. */ }

  const sun = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
  const moon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.2 15.5A8.5 8.5 0 0 1 8.5 3.8 8.5 8.5 0 1 0 20.2 15.5Z"/></svg>';

  function updateButton(button) {
    button.type = "button";
    button.classList.add("theme-toggle");
    button.setAttribute("role", "switch");
    button.setAttribute("aria-label", "Light mode");
    button.setAttribute("aria-checked", String(current === "light"));
    button.setAttribute("title", current === "light" ? "Switch to dark mode" : "Switch to light mode");
    button.innerHTML = `<span class="theme-toggle__icon" aria-hidden="true">${current === "light" ? sun : moon}</span><span class="theme-toggle__label">${current === "light" ? "LIGHT" : "DARK"}</span>`;
  }

  function apply(value) {
    current = value === "light" ? "light" : "dark";
    root.dataset.theme = current;
    root.style.colorScheme = current;
    if (themeColor) themeColor.content = current === "light" ? "#f5f7fb" : darkThemeColor;
    document.querySelectorAll("[data-theme-toggle]").forEach(updateButton);
    document.dispatchEvent(new CustomEvent("lsh:themechange", { detail: { theme: current } }));
  }

  apply(current);

  function mount() {
    let buttons = [...document.querySelectorAll("[data-theme-toggle]")];
    if (!buttons.length) {
      const fallback = document.createElement("button");
      fallback.dataset.themeToggle = "";
      fallback.className = "theme-toggle--floating";
      document.body.append(fallback);
      buttons = [fallback];
    }
    buttons.forEach(button => {
      updateButton(button);
      button.addEventListener("click", () => {
        const next = current === "light" ? "dark" : "light";
        try { localStorage.setItem(key, next); } catch { /* Keep the current page usable. */ }
        apply(next);
      });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();

  window.addEventListener("storage", event => {
    if (event.key === key || event.key === null) apply(event.newValue === "light" ? "light" : "dark");
  });
})();
