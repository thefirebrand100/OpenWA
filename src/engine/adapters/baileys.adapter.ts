import * as path from 'path';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { buildIncomingMessageFromBaileys, mapBaileysStatus } from './baileys-message-mapper';
import type { ILogger } from '@whiskeysockets/baileys/lib/Utils/logger.js';
import {
  ChatState,
  Channel,
  ChannelMessage,
  Catalog,
  Contact,
  ContactCard,
  EngineEventCallbacks,
  EngineStatus,
  Group,
  GroupInfo,
  IncomingMessage,
  IWhatsAppEngine,
  Label,
  LocationInput,
  MediaInput,
  MessageReaction,
  MessageResult,
  PaginatedProducts,
  Product,
  ProductQueryOptions,
  Status,
  StatusResult,
  ChatSummary,
  TextStatusOptions,
} from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { createLogger } from '../../common/services/logger.service';
import { BaileysAdapterConfig, BaileysLogger } from '../types/baileys.types';

/** Linked-device identity shown in WhatsApp (Settings → Linked Devices). */
const BAILEYS_BROWSER: [string, string, string] = ['OpenWA', 'Chrome', '120.0.0'];

/** Fully silent logger so Baileys does not spam stdout; diagnostics flow via connection.update. */
function createSilentLogger(): BaileysLogger {
  const noop = (): void => {};
  const logger: BaileysLogger = {
    level: 'silent',
    child: () => logger,
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  };
  return logger;
}

export class BaileysAdapter implements IWhatsAppEngine {
  private readonly logger = createLogger('BaileysAdapter');
  private readonly authPath: string;
  private sock: WASocket | null = null;
  private status: EngineStatus = EngineStatus.DISCONNECTED;
  private qrCode: string | null = null;
  private phoneNumber: string | null = null;
  private pushName: string | null = null;
  private callbacks: EngineEventCallbacks = {};
  private intentionalClose = false;

  constructor(private readonly config: BaileysAdapterConfig) {
    // Isolate each session's auth state under its own subdirectory of the shared auth dir.
    this.authPath = path.join(config.authDir, config.sessionId);
    if (config.proxyUrl) {
      // Proxy support is gated for this slice — Baileys proxying needs an http/socks agent (a new dep).
      this.logger.warn('Proxy configured but not supported by the baileys engine in this slice; ignoring it', {
        action: 'baileys_proxy_unsupported',
        sessionId: config.sessionId,
      });
    }
  }

  // ----- Lifecycle -----

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.intentionalClose = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    this.setStatus(EngineStatus.INITIALIZING);
    const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      auth: state,
      version,
      browser: BAILEYS_BROWSER,
      printQRInTerminal: false,
      // BaileysLogger matches ILogger exactly; cast needed because the module resolves
      // the type through a deep import path that TypeScript does not auto-unify here.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      logger: createSilentLogger() as unknown as ILogger,
    });
    this.sock = sock;

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', update => this.handleConnectionUpdate(update));
    sock.ev.on('messages.upsert', event => this.handleMessagesUpsert(event));
    sock.ev.on('messages.update', updates => this.handleMessagesUpdate(updates));
  }

  private handleConnectionUpdate(update: {
    connection?: string;
    qr?: string;
    lastDisconnect?: { error?: unknown };
  }): void {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      this.qrCode = qr;
      this.setStatus(EngineStatus.QR_READY);
      this.callbacks.onQRCode?.(qr);
    }

    if (connection === 'connecting') {
      this.setStatus(EngineStatus.INITIALIZING);
    }

    if (connection === 'open') {
      this.qrCode = null;
      this.phoneNumber = this.extractPhone(this.sock?.user?.id);
      this.pushName = this.sock?.user?.name ?? null;
      this.setStatus(EngineStatus.READY);
      this.callbacks.onReady?.(this.phoneNumber ?? '', this.pushName ?? '');
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
        ?.statusCode;

      if (this.intentionalClose) {
        this.setStatus(EngineStatus.DISCONNECTED);
        return;
      }

      if (statusCode === DisconnectReason.loggedOut) {
        // Credentials invalidated — terminal. Re-linking requires a fresh QR/pairing.
        this.setStatus(EngineStatus.DISCONNECTED);
        this.callbacks.onDisconnected?.('logged out');
        return;
      }

      // Recoverable (e.g. restartRequired right after pairing, transient drop) — reconnect.
      // Do NOT fire onDisconnected here; this is a transient drop, not a terminal disconnect.
      // connect() calls setStatus(INITIALIZING) which fires onStateChanged — that is the correct signal.
      this.logger.log('Baileys connection dropped; reconnecting', { statusCode });
      this.connect().catch(err => {
        this.setStatus(EngineStatus.FAILED);
        this.callbacks.onError?.(err instanceof Error ? err.message : String(err));
      });
    }
  }

  disconnect(): Promise<void> {
    this.intentionalClose = true;
    this.sock?.end(undefined);
    this.sock = null;
    this.setStatus(EngineStatus.DISCONNECTED);
    return Promise.resolve();
  }

  async logout(): Promise<void> {
    this.intentionalClose = true;
    try {
      await this.sock?.logout();
    } catch (err) {
      this.logger.warn('Baileys logout failed; ending socket', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.sock?.end(undefined);
    }
    this.sock = null;
    this.setStatus(EngineStatus.DISCONNECTED);
    // ponytail: leaves the multi-file auth dir on disk; a fresh link overwrites it. Add fs cleanup if
    // stale creds ever block re-linking.
  }

  destroy(): Promise<void> {
    this.intentionalClose = true;
    this.sock?.end(undefined);
    this.sock = null;
    this.setStatus(EngineStatus.DISCONNECTED);
    return Promise.resolve();
  }

  // ----- Status -----

  getStatus(): EngineStatus {
    return this.status;
  }

  getQRCode(): string | null {
    return this.qrCode;
  }

  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (!this.sock) {
      throw new EngineNotReadyError('Cannot request a pairing code before the engine is initialized.');
    }
    return this.sock.requestPairingCode(phoneNumber);
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  getPushName(): string | null {
    return this.pushName;
  }

  // ----- Messaging -----

  async sendTextMessage(chatId: string, text: string): Promise<MessageResult> {
    this.ensureReady();
    const sent = await this.sock!.sendMessage(chatId, { text });
    return {
      id: sent?.key?.id ?? '',
      timestamp: this.toUnixSeconds(sent?.messageTimestamp),
    };
  }

  async checkNumberExists(number: string): Promise<boolean> {
    return (await this.getNumberId(number)) !== null;
  }

  async getNumberId(number: string): Promise<string | null> {
    this.ensureReady();
    const results = await this.sock!.onWhatsApp(number);
    const hit = results?.[0];
    return hit?.exists ? hit.jid : null;
  }

  async sendChatState(chatId: string, state: ChatState): Promise<void> {
    this.ensureReady();
    const presence = state === 'typing' ? 'composing' : state === 'recording' ? 'recording' : 'paused';
    await this.sock!.sendPresenceUpdate(presence, chatId);
  }

  // ----- Gated: not supported by this minimal slice (no store) -----
  /* eslint-disable @typescript-eslint/no-unused-vars */

  sendImageMessage(_chatId: string, _media: MediaInput): Promise<MessageResult> {
    return this.unsupported('sendImageMessage');
  }
  sendVideoMessage(_chatId: string, _media: MediaInput): Promise<MessageResult> {
    return this.unsupported('sendVideoMessage');
  }
  sendAudioMessage(_chatId: string, _media: MediaInput): Promise<MessageResult> {
    return this.unsupported('sendAudioMessage');
  }
  sendDocumentMessage(_chatId: string, _media: MediaInput): Promise<MessageResult> {
    return this.unsupported('sendDocumentMessage');
  }
  sendLocationMessage(_chatId: string, _location: LocationInput): Promise<MessageResult> {
    return this.unsupported('sendLocationMessage');
  }
  sendContactMessage(_chatId: string, _contact: ContactCard): Promise<MessageResult> {
    return this.unsupported('sendContactMessage');
  }
  sendStickerMessage(_chatId: string, _media: MediaInput): Promise<MessageResult> {
    return this.unsupported('sendStickerMessage');
  }
  replyToMessage(_chatId: string, _quotedMsgId: string, _text: string): Promise<MessageResult> {
    return this.unsupported('replyToMessage');
  }
  forwardMessage(_fromChatId: string, _toChatId: string, _messageId: string): Promise<MessageResult> {
    return this.unsupported('forwardMessage');
  }
  reactToMessage(_chatId: string, _messageId: string, _emoji: string): Promise<void> {
    return this.unsupported('reactToMessage');
  }
  getMessageReactions(_chatId: string, _messageId: string): Promise<MessageReaction[]> {
    return this.unsupported('getMessageReactions');
  }
  getContacts(): Promise<Contact[]> {
    return this.unsupported('getContacts');
  }
  getContactById(_contactId: string): Promise<Contact | null> {
    return this.unsupported('getContactById');
  }
  resolveContactPhone(_contactId: string): Promise<string | null> {
    return this.unsupported('resolveContactPhone');
  }
  getGroups(): Promise<Group[]> {
    return this.unsupported('getGroups');
  }
  getGroupInfo(_groupId: string): Promise<GroupInfo | null> {
    return this.unsupported('getGroupInfo');
  }
  createGroup(_name: string, _participants: string[]): Promise<Group> {
    return this.unsupported('createGroup');
  }
  addParticipants(_groupId: string, _participants: string[]): Promise<void> {
    return this.unsupported('addParticipants');
  }
  removeParticipants(_groupId: string, _participants: string[]): Promise<void> {
    return this.unsupported('removeParticipants');
  }
  promoteParticipants(_groupId: string, _participants: string[]): Promise<void> {
    return this.unsupported('promoteParticipants');
  }
  demoteParticipants(_groupId: string, _participants: string[]): Promise<void> {
    return this.unsupported('demoteParticipants');
  }
  leaveGroup(_groupId: string): Promise<void> {
    return this.unsupported('leaveGroup');
  }
  setGroupSubject(_groupId: string, _subject: string): Promise<void> {
    return this.unsupported('setGroupSubject');
  }
  setGroupDescription(_groupId: string, _description: string): Promise<void> {
    return this.unsupported('setGroupDescription');
  }
  getGroupInviteCode(_groupId: string): Promise<string> {
    return this.unsupported('getGroupInviteCode');
  }
  revokeGroupInviteCode(_groupId: string): Promise<string> {
    return this.unsupported('revokeGroupInviteCode');
  }
  deleteMessage(_chatId: string, _messageId: string, _forEveryone?: boolean): Promise<void> {
    return this.unsupported('deleteMessage');
  }
  getChatHistory(_chatId: string, _limit?: number, _includeMedia?: boolean): Promise<IncomingMessage[]> {
    return this.unsupported('getChatHistory');
  }
  getProfilePicture(_contactId: string): Promise<string | null> {
    return this.unsupported('getProfilePicture');
  }
  blockContact(_contactId: string): Promise<void> {
    return this.unsupported('blockContact');
  }
  unblockContact(_contactId: string): Promise<void> {
    return this.unsupported('unblockContact');
  }
  getLabels(): Promise<Label[]> {
    return this.unsupported('getLabels');
  }
  getLabelById(_labelId: string): Promise<Label | null> {
    return this.unsupported('getLabelById');
  }
  getChatLabels(_chatId: string): Promise<Label[]> {
    return this.unsupported('getChatLabels');
  }
  addLabelToChat(_chatId: string, _labelId: string): Promise<void> {
    return this.unsupported('addLabelToChat');
  }
  removeLabelFromChat(_chatId: string, _labelId: string): Promise<void> {
    return this.unsupported('removeLabelFromChat');
  }
  getSubscribedChannels(): Promise<Channel[]> {
    return this.unsupported('getSubscribedChannels');
  }
  getChannelById(_channelId: string): Promise<Channel | null> {
    return this.unsupported('getChannelById');
  }
  subscribeToChannel(_inviteCode: string): Promise<Channel> {
    return this.unsupported('subscribeToChannel');
  }
  unsubscribeFromChannel(_channelId: string): Promise<void> {
    return this.unsupported('unsubscribeFromChannel');
  }
  getChannelMessages(_channelId: string, _limit?: number): Promise<ChannelMessage[]> {
    return this.unsupported('getChannelMessages');
  }
  getContactStatuses(): Promise<Status[]> {
    return this.unsupported('getContactStatuses');
  }
  getContactStatus(_contactId: string): Promise<Status[]> {
    return this.unsupported('getContactStatus');
  }
  postTextStatus(_text: string, _options?: TextStatusOptions): Promise<StatusResult> {
    return this.unsupported('postTextStatus');
  }
  postImageStatus(_media: MediaInput, _caption?: string): Promise<StatusResult> {
    return this.unsupported('postImageStatus');
  }
  postVideoStatus(_media: MediaInput, _caption?: string): Promise<StatusResult> {
    return this.unsupported('postVideoStatus');
  }
  deleteStatus(_statusId: string): Promise<void> {
    return this.unsupported('deleteStatus');
  }
  getCatalog(): Promise<Catalog | null> {
    return this.unsupported('getCatalog');
  }
  getProducts(_options?: ProductQueryOptions): Promise<PaginatedProducts> {
    return this.unsupported('getProducts');
  }
  getProduct(_productId: string): Promise<Product | null> {
    return this.unsupported('getProduct');
  }
  sendProduct(_chatId: string, _productId: string, _body?: string): Promise<MessageResult> {
    return this.unsupported('sendProduct');
  }
  sendCatalog(_chatId: string, _body?: string): Promise<MessageResult> {
    return this.unsupported('sendCatalog');
  }
  getChats(): Promise<ChatSummary[]> {
    return this.unsupported('getChats');
  }
  sendSeen(_chatId: string): Promise<boolean> {
    return this.unsupported('sendSeen');
  }
  deleteChat(_chatId: string): Promise<boolean> {
    return this.unsupported('deleteChat');
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */

  // ----- Helpers -----

  private handleMessagesUpsert(event: { messages: WAMessage[]; type: string }): void {
    // Only live messages ('notify'); 'append' is history sync, which this storeless slice skips.
    if (event.type !== 'notify') {
      return;
    }
    for (const msg of event.messages) {
      if (!msg.message || !msg.key?.remoteJid) {
        continue; // protocol/empty messages carry no neutral content
      }
      const incoming = this.mapMessage(msg);
      if (msg.key.fromMe === true) {
        this.callbacks.onMessageCreate?.(incoming);
      } else {
        this.callbacks.onMessage?.(incoming);
      }
    }
  }

  private handleMessagesUpdate(
    updates: Array<{ key?: { id?: string | null }; update?: { status?: number | null } }>,
  ): void {
    for (const u of updates) {
      const status = mapBaileysStatus(u.update?.status);
      if (status && u.key?.id) {
        this.callbacks.onMessageAck?.(u.key.id, status);
      }
    }
  }

  private mapMessage(msg: WAMessage): IncomingMessage {
    const content = msg.message ?? {};
    const contentType = getContentType(msg.message ?? undefined);
    const body = content.conversation ?? content.extendedTextMessage?.text ?? '';
    return buildIncomingMessageFromBaileys({
      id: msg.key.id ?? '',
      remoteJid: msg.key.remoteJid!,
      fromMe: msg.key.fromMe === true,
      participant: msg.key.participant ?? undefined,
      body,
      contentType,
      isPtt: content.audioMessage?.ptt === true,
      timestamp: this.toUnixSeconds(msg.messageTimestamp),
      pushName: msg.pushName ?? undefined,
      selfJid: this.normalizedSelfJid(),
    });
  }

  private normalizedSelfJid(): string {
    const phone = this.extractPhone(this.sock?.user?.id);
    return phone ? `${phone}@s.whatsapp.net` : '';
  }

  /** Baileys timestamps are `number | Long`; normalize to unix seconds. */
  private toUnixSeconds(ts: number | { toNumber(): number } | null | undefined): number {
    if (ts == null) {
      return Math.floor(Date.now() / 1000);
    }
    return typeof ts === 'number' ? ts : ts.toNumber();
  }

  private unsupported(method: string): Promise<any> {
    return Promise.reject(new EngineNotSupportedError(method));
  }

  protected ensureReady(): void {
    if (this.status !== EngineStatus.READY || !this.sock) {
      throw new EngineNotReadyError();
    }
  }

  private setStatus(status: EngineStatus): void {
    if (this.status === status) {
      return;
    }
    this.status = status;
    this.callbacks.onStateChanged?.(status);
  }

  /** `628999:12@s.whatsapp.net` / `628999@s.whatsapp.net` -> `628999`. */
  private extractPhone(id: string | undefined): string | null {
    if (!id) {
      return null;
    }
    return id.split(':')[0].split('@')[0] || null;
  }
}
