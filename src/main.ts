import { mountBrowserApp } from "./browserApp.js";

const root = document.getElementById("app");
if (!root) {
  throw new Error("App root was not found.");
}

mountBrowserApp(root);
