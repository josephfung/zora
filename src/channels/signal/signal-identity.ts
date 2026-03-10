/**
 * SignalIdentity — normalizes Signal sender identity from signal-cli envelope fields
 * to Zora's ChannelIdentity type.
 *
 * Maps:
 *   msg.envelope.sourceNumber → phoneNumber (E.164)
 *   msg.envelope.sourceUuid  → signalUuid
 *   msg.envelope.sourceName  → displayName
 */

import { ChannelIdentity, ChannelMessage } from "../../types/channel.js";

// E.164 pattern: +[country code][number], 7-15 digits total
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

/**
 * Normalizes a phone number string to E.164 format.
 * Strips whitespace, dashes, parentheses.
 * Throws if result is not valid E.164.
 */
export function normalizeToE164(raw: string): string {
  // Strip common formatting characters
  const stripped = raw.replace(/[\s\-().]/g, "");

  // Already has + prefix
  if (stripped.startsWith("+")) {
    if (!E164_PATTERN.test(stripped)) {
      throw new Error(`Invalid E.164 phone number: ${raw}`);
    }
    return stripped;
  }

  // Try adding + prefix (handles "14155551234" → "+14155551234")
  const withPlus = "+" + stripped;
  if (E164_PATTERN.test(withPlus)) {
    return withPlus;
  }

  throw new Error(`Cannot normalize to E.164: ${raw}`);
}

/**
 * Maps a signal-cli message envelope to a ChannelIdentity.
 * signal-sdk envelope shape:
 *   envelope.sourceNumber  — E.164 phone string (may have formatting)
 *   envelope.sourceUuid    — Signal UUID string (optional)
 *   envelope.sourceName    — Display name (optional)
 */
export function envelopeToChannelIdentity(envelope: {
  sourceNumber?: string;
  sourceUuid?: string;
  sourceName?: string;
}): ChannelIdentity {
  if (!envelope.sourceNumber) {
    throw new Error("Envelope missing sourceNumber — cannot identify sender");
  }

  return {
    type: "signal",
    phoneNumber: normalizeToE164(envelope.sourceNumber),
    signalUuid: envelope.sourceUuid ?? undefined,
    displayName: envelope.sourceName ?? undefined,
    isLinkedDevice: false,  // Incoming messages are from external contacts
  };
}

/**
 * Extracts channelId from a signal-cli message envelope.
 * Group messages have groupInfo.groupId; direct messages use "direct".
 */
export function extractChannelId(envelope: {
  dataMessage?: {
    groupInfo?: {
      groupId?: string;
    };
  };
}): { channelId: string; channelType: "direct" | "group" } {
  const groupId = envelope.dataMessage?.groupInfo?.groupId;
  if (groupId) {
    return { channelId: `group:${groupId}`, channelType: "group" };
  }
  return { channelId: "direct", channelType: "direct" };
}

/** Maximum allowed message length (DoS protection) */
export const MAX_MESSAGE_LENGTH = 10_000;

/** signal-sdk message event shape */
export interface SignalEvent {
  envelope: {
    sourceNumber?: string;
    sourceUuid?: string;
    sourceName?: string;
    timestamp?: number;
    dataMessage?: {
      message?: string;
      groupInfo?: { groupId?: string };
      attachments?: Array<{ id?: string; filename?: string }>;
    };
  };
}

/**
 * Maps a full signal-sdk message event to a ChannelMessage.
 * Throws if message exceeds DoS length limit.
 */
export function signalEventToChannelMessage(event: SignalEvent): ChannelMessage {
  const { envelope } = event;
  const identity = envelopeToChannelIdentity(envelope);
  const { channelId, channelType } = extractChannelId(envelope);

  const content = envelope.dataMessage?.message ?? "";

  if (content.length > MAX_MESSAGE_LENGTH) {
    throw new Error(
      `Message from ${identity.phoneNumber} exceeds max length ` +
      `(${content.length} > ${MAX_MESSAGE_LENGTH}). Rejected.`
    );
  }

  const attachments = (envelope.dataMessage?.attachments ?? [])
    .map(a => a.filename ?? a.id ?? "unknown")
    .filter(Boolean);

  // Capture a single timestamp to avoid id/timestamp skew when envelope.timestamp is absent
  const ts = envelope.timestamp ?? Date.now();

  return {
    id: String(ts),
    from: identity,
    channelId,
    channelType,
    content,
    timestamp: new Date(ts),
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}
