import ui from "./ui.html";
import { handleChat } from "./chat.js";
import { handleConfig, handlePlaces } from "./map.js";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/") {
      return new Response(ui, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (request.method === "POST" && pathname === "/chat") {
      return handleChat(request, env);
    }

    if (request.method === "GET" && pathname === "/config") {
      return handleConfig(env);
    }

    if (request.method === "GET" && pathname === "/places") {
      return handlePlaces(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};
