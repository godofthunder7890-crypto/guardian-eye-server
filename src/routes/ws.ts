import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
import { logger } from "../lib/logger";

const PAIR_CODE = process.env["PAIR_CODE"];
if (!PAIR_CODE) {
  throw new Error("PAIR_CODE env var is required but not set.");
}

interface Client {
  ws: WebSocket;
  role: "parent" | "child" | null;
  authenticated: boolean;
}

const clients = new Set<Client>();

function getByRole(role: "parent" | "child"): Client | undefined {
  for (const c of clients) {
    if (c.role === role && c.authenticated && c.ws.readyState === WebSocket.OPEN)
      return c;
  }
  return undefined;
}

function notifyParentChildStatus(online: boolean) {
  const parent = getByRole("parent");
  if (parent) {
    parent.ws.send(
      JSON.stringify({ type: "status", child_online: online, ts: Date.now() }),
    );
  }
}

function reject(ws: WebSocket, reason: string) {
  try {
    ws.send(JSON.stringify({ type: "error", reason }));
  } catch (_) {}
  ws.close(4001, reason);
}

export function attachWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: "/api/ws" });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    const client: Client = { ws, role: null, authenticated: false };
    clients.add(client);

    // Auto-kick unauthenticated clients after 10 seconds
    const authTimeout = setTimeout(() => {
      if (!client.authenticated) {
        reject(ws, "auth_timeout");
      }
    }, 10_000);

    ws.on("message", (raw) => {
      try {
        // BUG FIX: No message size limit — large base64 screen frames (1-3 MB) could OOM
        // the server on Replit's free tier. 4 MB covers a full-screen JPEG at max quality.
        if (raw.toString().length > 4 * 1024 * 1024) {
          logger.warn({ role: client.role }, "WS message too large, dropping");
          return;
        }
        const data = JSON.parse(raw.toString());

        // ── Ping (no auth required) ──────────────────────────────────────
        if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
          return;
        }

        // ── Register + authenticate ──────────────────────────────────────
        if (data.type === "register") {
          const role = data.role;
          const code = data.pair_code;

          if (role !== "parent" && role !== "child") {
            reject(ws, "invalid_role");
            return;
          }

          if (code !== PAIR_CODE) {
            logger.warn({ role }, "WS rejected: wrong pair_code");
            reject(ws, "wrong_pair_code");
            return;
          }

          // Fix: if same role reconnects, remove stale old client first
          for (const existing of clients) {
            if (
              existing !== client &&
              existing.role === role &&
              existing.authenticated
            ) {
              existing.ws.close(4002, "replaced_by_new_connection");
              clients.delete(existing);
            }
          }

          client.role = role;
          client.authenticated = true;
          clearTimeout(authTimeout);
          logger.info({ role }, "WS client authenticated");

          ws.send(JSON.stringify({ type: "auth_ok", role, ts: Date.now() }));

          if (role === "parent") {
            const childOnline = !!getByRole("child");
            ws.send(
              JSON.stringify({ type: "status", child_online: childOnline, ts: Date.now() }),
            );
          }

          if (role === "child") {
            notifyParentChildStatus(true);
          }
          return;
        }

        // ── All further messages require authentication ───────────────────
        if (!client.authenticated) {
          reject(ws, "not_authenticated");
          return;
        }

        // ── Command: parent → child ──────────────────────────────────────
        if (data.type === "command" && client.role === "parent") {
          const child = getByRole("child");
          if (child) {
            child.ws.send(raw.toString());
          }
          return;
        }

        // ── Data: child → parent ─────────────────────────────────────────
        if (client.role === "child") {
          const parent = getByRole("parent");
          if (parent) {
            parent.ws.send(raw.toString());
          }
          return;
        }
      } catch (_) {}
    });

    ws.on("close", () => {
      clearTimeout(authTimeout);
      const wasChild = client.role === "child" && client.authenticated;
      clients.delete(client);
      logger.info({ role: client.role }, "WS client disconnected");
      if (wasChild) {
        notifyParentChildStatus(false);
      }
    });

    ws.on("error", (err) => {
      clearTimeout(authTimeout);
      logger.error({ err }, "WS client error");
      clients.delete(client);
    });
  });

  logger.info("WebSocket relay server attached at /api/ws");
}
