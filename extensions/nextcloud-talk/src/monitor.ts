import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
  CoreConfig,
  NextcloudTalkInboundMessage,
  NextcloudTalkWebhookPayload,
  NextcloudTalkWebhookServerOptions,
} from "./types.js";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import { extractNextcloudTalkHeaders, verifyNextcloudTalkSignature } from "./signature.js";

const DEFAULT_WEBHOOK_PORT = 8788;
const DEFAULT_WEBHOOK_HOST = "0.0.0.0";
const DEFAULT_WEBHOOK_PATH = "/nextcloud-talk-webhook";
const HEALTH_PATH = "/healthz";

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === "string" ? err : JSON.stringify(err);
}

function parseWebhookPayload(body: string): NextcloudTalkWebhookPayload | null {
  try {
    const data = JSON.parse(body);
    if (
      !data.type ||
      !data.actor?.type ||
      !data.actor?.id ||
      !data.object?.type ||
      !data.object?.id ||
      !data.target?.type ||
      !data.target?.id
    ) {
      return null;
    }
    return data as NextcloudTalkWebhookPayload;
  } catch {
    return null;
  }
}

/**
 * Try to parse the object.content field as JSON.
 * For system messages (file shares, etc.), Nextcloud Talk sends content as
 * a JSON string: {"message": "{file}", "parameters": {"file": {...}}}
 * For regular messages, content is plain text.
 */
function parseContentJson(content: string): {
  message: string;
  parameters: Record<string, Record<string, unknown>>;
} | null {
  if (!content || !content.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null && "message" in parsed) {
      return {
        message: String(parsed.message ?? ""),
        parameters: (parsed.parameters as Record<string, Record<string, unknown>>) ?? {},
      };
    }
    return null;
  } catch {
    return null;
  }
}

function payloadToInboundMessage(
  payload: NextcloudTalkWebhookPayload,
): NextcloudTalkInboundMessage {
  // Payload doesn't indicate DM vs room; mark as group and let inbound handler refine.
  const isGroupChat = true;

  // For system messages (type "Activity"), content is JSON-encoded with
  // message text and rich object parameters (file metadata, etc.).
  // For regular messages (type "Create"), content is plain text.
  const contentJson = parseContentJson(payload.object.content);
  const params = contentJson?.parameters;

  // Extract file attachment if present
  const fileParam = params?.file;
  const file = fileParam
    ? {
        id: String(fileParam.id ?? ""),
        name: String(fileParam.name ?? ""),
        path: String(fileParam.path ?? ""),
        mimetype: String(fileParam.mimetype ?? "application/octet-stream"),
        size: Number(fileParam.size ?? 0),
        link: fileParam.link ? String(fileParam.link) : undefined,
      }
    : undefined;

  // Determine message text:
  // - Regular messages: use content directly
  // - System messages: use parsed message field (may be "{file}" placeholder)
  let text = contentJson
    ? contentJson.message
    : payload.object.content || payload.object.name || "";
  if (file && (text === "{file}" || !text.trim())) {
    text = `[Attached file: ${file.name}]`;
  }

  return {
    messageId: String(payload.object.id),
    roomToken: payload.target.id,
    roomName: payload.target.name,
    senderId: payload.actor.id,
    senderName: payload.actor.name ?? "",
    text,
    mediaType: payload.object.mediaType || "text/plain",
    timestamp: Date.now(),
    isGroupChat,
    file,
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export function createNextcloudTalkWebhookServer(opts: NextcloudTalkWebhookServerOptions): {
  server: Server;
  start: () => Promise<void>;
  stop: () => void;
} {
  const { port, host, path, secret, onMessage, onError, abortSignal } = opts;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === HEALTH_PATH) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    if (req.url !== path || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }

    try {
      const body = await readBody(req);

      const headers = extractNextcloudTalkHeaders(
        req.headers as Record<string, string | string[] | undefined>,
      );
      if (!headers) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing signature headers" }));
        return;
      }

      const isValid = verifyNextcloudTalkSignature({
        signature: headers.signature,
        random: headers.random,
        body,
        secret,
      });

      if (!isValid) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid signature" }));
        return;
      }

      const payload = parseWebhookPayload(body);
      if (!payload) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid payload format" }));
        return;
      }

      // Accept "Create" (regular messages) and "Activity" (system messages like file shares)
      if (payload.type !== "Create" && payload.type !== "Activity") {
        res.writeHead(200);
        res.end();
        return;
      }

      const message = payloadToInboundMessage(payload);

      res.writeHead(200);
      res.end();

      try {
        await onMessage(message);
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(formatError(err)));
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(formatError(err));
      onError?.(error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  const start = (): Promise<void> => {
    return new Promise((resolve) => {
      server.listen(port, host, () => resolve());
    });
  };

  const stop = () => {
    server.close();
  };

  if (abortSignal) {
    abortSignal.addEventListener("abort", stop, { once: true });
  }

  return { server, start, stop };
}

export type NextcloudTalkMonitorOptions = {
  accountId?: string;
  config?: CoreConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  onMessage?: (message: NextcloudTalkInboundMessage) => void | Promise<void>;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export async function monitorNextcloudTalkProvider(
  opts: NextcloudTalkMonitorOptions,
): Promise<{ stop: () => void }> {
  const core = getNextcloudTalkRuntime();
  const cfg = opts.config ?? (core.config.loadConfig() as CoreConfig);
  const account = resolveNextcloudTalkAccount({
    cfg,
    accountId: opts.accountId,
  });
  const runtime: RuntimeEnv = opts.runtime ?? {
    log: (message: string) => core.logging.getChildLogger().info(message),
    error: (message: string) => core.logging.getChildLogger().error(message),
    exit: () => {
      throw new Error("Runtime exit not available");
    },
  };

  if (!account.secret) {
    throw new Error(`Nextcloud Talk bot secret not configured for account "${account.accountId}"`);
  }

  const port = account.config.webhookPort ?? DEFAULT_WEBHOOK_PORT;
  const host = account.config.webhookHost ?? DEFAULT_WEBHOOK_HOST;
  const path = account.config.webhookPath ?? DEFAULT_WEBHOOK_PATH;

  const logger = core.logging.getChildLogger({
    channel: "nextcloud-talk",
    accountId: account.accountId,
  });

  const { start, stop } = createNextcloudTalkWebhookServer({
    port,
    host,
    path,
    secret: account.secret,
    onMessage: async (message) => {
      core.channel.activity.record({
        channel: "nextcloud-talk",
        accountId: account.accountId,
        direction: "inbound",
        at: message.timestamp,
      });
      if (opts.onMessage) {
        await opts.onMessage(message);
        return;
      }
      await handleNextcloudTalkInbound({
        message,
        account,
        config: cfg,
        runtime,
        statusSink: opts.statusSink,
      });
    },
    onError: (error) => {
      logger.error(`[nextcloud-talk:${account.accountId}] webhook error: ${error.message}`);
    },
    abortSignal: opts.abortSignal,
  });

  await start();

  const publicUrl =
    account.config.webhookPublicUrl ??
    `http://${host === "0.0.0.0" ? "localhost" : host}:${port}${path}`;
  logger.info(`[nextcloud-talk:${account.accountId}] webhook listening on ${publicUrl}`);

  return { stop };
}
