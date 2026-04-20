import { mountChat } from "./chat.js";
import { mountDataset } from "./dataset.js";
import { mountModels } from "./models/models-page.js";

const ROUTES = ["chat", "dataset", "models"];
const mounted = new Set();

function showRoute(name) {
  if (!ROUTES.includes(name)) return;
  document.querySelectorAll(".route").forEach((el) => el.classList.remove("route-active"));
  document.getElementById(`route-${name}`)?.classList.add("route-active");
  document.querySelectorAll(".sidebar-icon").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.route === name);
  });
  if (!mounted.has(name)) {
    if (name === "chat") mountChat();
    if (name === "dataset") mountDataset(document.getElementById("dataset-root"));
    if (name === "models") mountModels(document.getElementById("models-root"));
    mounted.add(name);
  }
}

document.querySelectorAll(".sidebar-icon").forEach((btn) => {
  btn.addEventListener("click", () => showRoute(btn.dataset.route));
});

showRoute("chat");
