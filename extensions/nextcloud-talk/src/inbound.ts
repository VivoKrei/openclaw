import { readFile } from "node:fs/promises";
import {
  createReplyPrefixOptions,
  logInboundDrop,
  resolveControlCommandGate,
  type OpenClawConfig,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import type { CoreConfig, GroupPolicy, NextcloudTalkInboundMessage } from "./types.js";
import {
  normalizeNextcloudTalkAllowlist,
  resolveNextcloudTalkAllowlistMatch,
  resolveNextcloudTalkGroupAllow,
  resolveNextcloudTalkMentionGate,
  resolveNextcloudTalkRequireMention,
  resolveNextcloudTalkRoomMatch,
} from "./policy.js";
import { resolveNextcloudTalkRoomKind } from "./room-info.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import { sendMessageNextcloudTalk } from "./send.js";

const CHANNEL_ID = "nextcloud-talk" as const;

async function downloadNextcloudFile(params: {
  baseUrl: string;
  apiUser: string;
  apiPassword: string;
  filePath: string;
  maxBytes?: number;
  log?: (msg: string) => void;
}): Promise<{ content: string; truncated: boolean } | null> {
  const { baseUrl, apiUser, apiPassword, filePath, maxBytes = 100_000, log } = params;
  const cleanPath = filePath.replace(/^\/+/, "");
  const auth = Buffer.from(`${apiUser}:${apiPassword}`).toString("base64");

  // Try the path as-is first, then with Talk/ prefix (shared files land in Talk/ folder)
  const candidates = [cleanPath];
  if (!cleanPath.startsWith("Talk/")) {
    candidates.push(`Talk/${cleanPath}`);
  }

  for (const candidate of candidates) {
    const encodedPath = candidate.split("/").map(encodeURIComponent).join("/");
    const url = `${baseUrl}/remote.php/dav/files/${apiUser}/${encodedPath}`;

    log?.(`nextcloud-talk: trying file download from ${url}`);

    try {
      const res = await fetch(url, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        log?.(`nextcloud-talk: ${url} returned HTTP ${res.status}`);
        continue;
      }
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      log?.(`nextcloud-talk: downloaded ${bytes.length} bytes from ${candidate}`);
      const truncated = bytes.length > maxBytes;
      const slice = truncated ? bytes.slice(0, maxBytes) : bytes;
      return { content: new TextDecoder().decode(slice), truncated };
    } catch (err) {
      log?.(
        `nextcloud-talk: file download error for ${candidate}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return null;
}

async function deliverNextcloudTalkReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string; replyToId?: string };
  roomToken: string;
  accountId: string;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, roomToken, accountId, statusSink } = params;
  const text = payload.text ?? "";
  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];

  if (!text.trim() && mediaList.length === 0) {
    return;
  }

  const mediaBlock = mediaList.length
    ? mediaList.map((url) => `Attachment: ${url}`).join("\n")
    : "";
  const combined = text.trim()
    ? mediaBlock
      ? `${text.trim()}\n\n${mediaBlock}`
      : text.trim()
    : mediaBlock;

  await sendMessageNextcloudTalk(roomToken, combined, {
    accountId,
    replyTo: payload.replyToId,
  });
  statusSink?.({ lastOutboundAt: Date.now() });
}

export async function handleNextcloudTalkInbound(params: {
  message: NextcloudTalkInboundMessage;
  account: ResolvedNextcloudTalkAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, statusSink } = params;
  const core = getNextcloudTalkRuntime();

  const rawBody = message.text?.trim() ?? "";
  if (!rawBody && !message.file) {
    return;
  }

  // Download file content if a file attachment is present
  let fileContent = "";
  if (message.file && account.config.apiUser && account.config.baseUrl) {
    let apiPassword = account.config.apiPassword ?? "";
    if (!apiPassword && account.config.apiPasswordFile) {
      try {
        apiPassword = (await readFile(account.config.apiPasswordFile, "utf-8")).trim();
      } catch (err) {
        runtime.error?.(
          `nextcloud-talk: failed to read apiPasswordFile ${account.config.apiPasswordFile}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    runtime.log?.(
      `nextcloud-talk: file attachment detected: ${message.file.name} (${message.file.mimetype}, path=${message.file.path}, passwordLen=${apiPassword.length})`,
    );

    if (apiPassword) {
      const isText =
        message.file.mimetype.startsWith("text/") ||
        /\.(md|txt|json|csv|xml|yaml|yml|toml|ini|conf|cfg|log|sh|py|js|ts|html|css)$/i.test(
          message.file.name,
        );

      if (isText) {
        const result = await downloadNextcloudFile({
          baseUrl: account.config.baseUrl,
          apiUser: account.config.apiUser,
          apiPassword,
          filePath: message.file.path,
          log: (msg) => runtime.log?.(msg),
        });
        if (result) {
          fileContent = `\n\n--- File: ${message.file.name} ---\n${result.content}${result.truncated ? "\n[... truncated]" : ""}\n--- End of file ---`;
        } else {
          runtime.error?.(`nextcloud-talk: file download returned null for ${message.file.path}`);
        }
      } else {
        fileContent = `\n\n[Binary file attached: ${message.file.name} (${message.file.mimetype}, ${message.file.size} bytes)]`;
      }
    } else {
      runtime.error?.("nextcloud-talk: no apiPassword available, cannot download file");
    }
  }

  const bodyWithFile = rawBody + fileContent;

  const roomKind = await resolveNextcloudTalkRoomKind({
    account,
    roomToken: message.roomToken,
    runtime,
  });
  const isGroup = roomKind === "direct" ? false : roomKind === "group" ? true : message.isGroupChat;
  const senderId = message.senderId;
  const senderName = message.senderName;
  const roomToken = message.roomToken;
  const roomName = message.roomName;

  statusSink?.({ lastInboundAt: message.timestamp });

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = (config.channels as Record<string, unknown> | undefined)?.defaults as
    | { groupPolicy?: string }
    | undefined;
  const groupPolicy = (account.config.groupPolicy ??
    defaultGroupPolicy?.groupPolicy ??
    "allowlist") as GroupPolicy;

  const configAllowFrom = normalizeNextcloudTalkAllowlist(account.config.allowFrom);
  const configGroupAllowFrom = normalizeNextcloudTalkAllowlist(account.config.groupAllowFrom);
  const storeAllowFrom = await core.channel.pairing.readAllowFromStore(CHANNEL_ID).catch(() => []);
  const storeAllowList = normalizeNextcloudTalkAllowlist(storeAllowFrom);

  const roomMatch = resolveNextcloudTalkRoomMatch({
    rooms: account.config.rooms,
    roomToken,
    roomName,
  });
  const roomConfig = roomMatch.roomConfig;
  if (isGroup && !roomMatch.allowed) {
    runtime.log?.(`nextcloud-talk: drop room ${roomToken} (not allowlisted)`);
    return;
  }
  if (roomConfig?.enabled === false) {
    runtime.log?.(`nextcloud-talk: drop room ${roomToken} (disabled)`);
    return;
  }

  const roomAllowFrom = normalizeNextcloudTalkAllowlist(roomConfig?.allowFrom);
  const baseGroupAllowFrom =
    configGroupAllowFrom.length > 0 ? configGroupAllowFrom : configAllowFrom;

  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowList].filter(Boolean);
  const effectiveGroupAllowFrom = [...baseGroupAllowFrom, ...storeAllowList].filter(Boolean);

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  const useAccessGroups =
    (config.commands as Record<string, unknown> | undefined)?.useAccessGroups !== false;
  const senderAllowedForCommands = resolveNextcloudTalkAllowlistMatch({
    allowFrom: isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom,
    senderId,
  }).allowed;
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config as OpenClawConfig);
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [
      {
        configured: (isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom).length > 0,
        allowed: senderAllowedForCommands,
      },
    ],
    allowTextCommands,
    hasControlCommand,
  });
  const commandAuthorized = commandGate.commandAuthorized;

  if (isGroup) {
    const groupAllow = resolveNextcloudTalkGroupAllow({
      groupPolicy,
      outerAllowFrom: effectiveGroupAllowFrom,
      innerAllowFrom: roomAllowFrom,
      senderId,
    });
    if (!groupAllow.allowed) {
      runtime.log?.(`nextcloud-talk: drop group sender ${senderId} (policy=${groupPolicy})`);
      return;
    }
  } else {
    if (dmPolicy === "disabled") {
      runtime.log?.(`nextcloud-talk: drop DM sender=${senderId} (dmPolicy=disabled)`);
      return;
    }
    if (dmPolicy !== "open") {
      const dmAllowed = resolveNextcloudTalkAllowlistMatch({
        allowFrom: effectiveAllowFrom,
        senderId,
      }).allowed;
      if (!dmAllowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: CHANNEL_ID,
            id: senderId,
            meta: { name: senderName || undefined },
          });
          if (created) {
            try {
              await sendMessageNextcloudTalk(
                roomToken,
                core.channel.pairing.buildPairingReply({
                  channel: CHANNEL_ID,
                  idLine: `Your Nextcloud user id: ${senderId}`,
                  code,
                }),
                { accountId: account.accountId },
              );
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              runtime.error?.(
                `nextcloud-talk: pairing reply failed for ${senderId}: ${String(err)}`,
              );
            }
          }
        }
        runtime.log?.(`nextcloud-talk: drop DM sender ${senderId} (dmPolicy=${dmPolicy})`);
        return;
      }
    }
  }

  if (isGroup && commandGate.shouldBlock) {
    logInboundDrop({
      log: (message) => runtime.log?.(message),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: senderId,
    });
    return;
  }

  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config as OpenClawConfig);
  const wasMentioned = mentionRegexes.length
    ? core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes)
    : false;
  const shouldRequireMention = isGroup
    ? resolveNextcloudTalkRequireMention({
        roomConfig,
        wildcardConfig: roomMatch.wildcardConfig,
      })
    : false;
  const mentionGate = resolveNextcloudTalkMentionGate({
    isGroup,
    requireMention: shouldRequireMention,
    wasMentioned,
    allowTextCommands,
    hasControlCommand,
    commandAuthorized,
  });
  if (isGroup && mentionGate.shouldSkip) {
    runtime.log?.(`nextcloud-talk: drop room ${roomToken} (no mention)`);
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: isGroup ? roomToken : senderId,
    },
  });

  const fromLabel = isGroup ? `room:${roomName || roomToken}` : senderName || `user:${senderId}`;
  const storePath = core.channel.session.resolveStorePath(
    (config.session as Record<string, unknown> | undefined)?.store as string | undefined,
    {
      agentId: route.agentId,
    },
  );
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config as OpenClawConfig);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Nextcloud Talk",
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: bodyWithFile,
  });

  const groupSystemPrompt = roomConfig?.systemPrompt?.trim() || undefined;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: bodyWithFile,
    RawBody: bodyWithFile,
    CommandBody: rawBody,
    From: isGroup ? `nextcloud-talk:room:${roomToken}` : `nextcloud-talk:${senderId}`,
    To: `nextcloud-talk:${roomToken}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    GroupSubject: isGroup ? roomName || roomToken : undefined,
    GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: isGroup ? wasMentioned : undefined,
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `nextcloud-talk:${roomToken}`,
    CommandAuthorized: commandAuthorized,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`nextcloud-talk: failed updating session meta: ${String(err)}`);
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config as OpenClawConfig,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config as OpenClawConfig,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload) => {
        await deliverNextcloudTalkReply({
          payload: payload as {
            text?: string;
            mediaUrls?: string[];
            mediaUrl?: string;
            replyToId?: string;
          },
          roomToken,
          accountId: account.accountId,
          statusSink,
        });
      },
      onError: (err, info) => {
        runtime.error?.(`nextcloud-talk ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      skillFilter: roomConfig?.skills,
      onModelSelected,
      disableBlockStreaming:
        typeof account.config.blockStreaming === "boolean"
          ? !account.config.blockStreaming
          : undefined,
    },
  });
}
