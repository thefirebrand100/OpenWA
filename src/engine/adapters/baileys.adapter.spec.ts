import { EventEmitter } from 'events';

// A fake Baileys socket: an event emitter wearing the methods the adapter calls.
class FakeSock extends EventEmitter {
  public ev = {
    on: (event: string, handler: (arg: unknown) => void) => {
      this.emitter.on(event, handler);
    },
  };
  public emitter = new EventEmitter();
  public user: { id: string; name?: string } | undefined;
  public requestPairingCode = jest.fn().mockResolvedValue('ABCD-EFGH');
  public end = jest.fn();
  public logout = jest.fn().mockResolvedValue(undefined);
  public sendMessage = jest.fn();
  public onWhatsApp = jest.fn();
  public sendPresenceUpdate = jest.fn().mockResolvedValue(undefined);
  fire(event: string, arg: unknown): void {
    this.emitter.emit(event, arg);
  }
  resetEmitter(): void {
    this.emitter.removeAllListeners();
  }
}

const fakeSock = new FakeSock();
const saveCreds = jest.fn().mockResolvedValue(undefined);

jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(() => fakeSock),
  useMultiFileAuthState: jest.fn().mockResolvedValue({ state: { creds: {}, keys: {} }, saveCreds }),
  fetchLatestBaileysVersion: jest.fn().mockResolvedValue({ version: [2, 3000, 0] }),
  getContentType: jest.fn(() => 'conversation'),
  DisconnectReason: { loggedOut: 401, restartRequired: 515 },
}));

import { BaileysAdapter } from './baileys.adapter';
import { EngineStatus, EngineEventCallbacks } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';

const newAdapter = (): BaileysAdapter => new BaileysAdapter({ sessionId: 'sess-1', authDir: './data/baileys' });

const noopCallbacks = (over: Partial<EngineEventCallbacks> = {}): EngineEventCallbacks => over;

describe('BaileysAdapter lifecycle & status', () => {
  beforeEach(() => {
    fakeSock.user = undefined;
    fakeSock.resetEmitter(); // drop listeners from previous test's initialize()
    jest.clearAllMocks();
  });

  it('starts DISCONNECTED', () => {
    expect(newAdapter().getStatus()).toBe(EngineStatus.DISCONNECTED);
  });

  it('emits onQRCode and moves to QR_READY on a connection.update with a qr', async () => {
    const onQRCode = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({ onQRCode }));
    fakeSock.fire('connection.update', { qr: 'QR-STRING' });
    expect(onQRCode).toHaveBeenCalledWith('QR-STRING');
    expect(adapter.getStatus()).toBe(EngineStatus.QR_READY);
    expect(adapter.getQRCode()).toBe('QR-STRING');
  });

  it('captures phone/pushName and fires onReady on connection open', async () => {
    const onReady = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({ onReady }));
    fakeSock.user = { id: '628999:12@s.whatsapp.net', name: 'Me' };
    fakeSock.fire('connection.update', { connection: 'open' });
    expect(adapter.getStatus()).toBe(EngineStatus.READY);
    expect(adapter.getPhoneNumber()).toBe('628999');
    expect(adapter.getPushName()).toBe('Me');
    expect(onReady).toHaveBeenCalledWith('628999', 'Me');
  });

  it('on a logged-out close: DISCONNECTED, onDisconnected, and NO reconnect', async () => {
    const onDisconnected = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({ onDisconnected }));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const makeWASocket = jest.requireMock('@whiskeysockets/baileys').default as jest.Mock;
    makeWASocket.mockClear();
    fakeSock.fire('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    expect(onDisconnected).toHaveBeenCalled();
    expect(makeWASocket).not.toHaveBeenCalled(); // no reconnect
  });

  it('on a recoverable close: reconnects (re-creates the socket) and does NOT fire onDisconnected', async () => {
    const onDisconnected = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({ onDisconnected }));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const makeWASocket = jest.requireMock('@whiskeysockets/baileys').default as jest.Mock;
    makeWASocket.mockClear();
    fakeSock.fire('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    await new Promise(r => setImmediate(r)); // let the async connect() run
    expect(makeWASocket).toHaveBeenCalledTimes(1);
    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it('disconnect() ends the socket and does not reconnect', async () => {
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({}));
    await adapter.disconnect();
    expect(fakeSock.end).toHaveBeenCalled();
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
  });

  it('requestPairingCode throws EngineNotReadyError before initialize()', async () => {
    const adapter = newAdapter();
    await expect(adapter.requestPairingCode('628999')).rejects.toBeInstanceOf(EngineNotReadyError);
  });

  it('requestPairingCode delegates to the socket', async () => {
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({}));
    await expect(adapter.requestPairingCode('628999')).resolves.toBe('ABCD-EFGH');
    expect(fakeSock.requestPairingCode).toHaveBeenCalledWith('628999');
  });

  it('persists creds: subscribes saveCreds to creds.update', async () => {
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({}));
    fakeSock.fire('creds.update', {});
    expect(saveCreds).toHaveBeenCalled();
  });
});

describe('BaileysAdapter capability gating', () => {
  it('throws EngineNotSupportedError for store-backed methods (e.g. getGroups, getChats)', async () => {
    const adapter = newAdapter();
    await expect(adapter.getGroups()).rejects.toBeInstanceOf(EngineNotSupportedError);
    await expect(adapter.getChats()).rejects.toBeInstanceOf(EngineNotSupportedError);
    await expect(adapter.sendImageMessage('x', { mimetype: 'image/png', data: 'AAA' })).rejects.toBeInstanceOf(
      EngineNotSupportedError,
    );
  });
});

describe('BaileysAdapter messaging', () => {
  beforeEach(() => {
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };
    jest.clearAllMocks();
  });

  const readyAdapter = async (over: Partial<EngineEventCallbacks> = {}): Promise<BaileysAdapter> => {
    const adapter = newAdapter();
    await adapter.initialize(over);
    fakeSock.fire('connection.update', { connection: 'open' });
    return adapter;
  };

  it('sendTextMessage calls sock.sendMessage(jid, { text }) and returns the message id', async () => {
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'OUT1' }, messageTimestamp: 1700000001 });
    const adapter = await readyAdapter();
    const res = await adapter.sendTextMessage('628111@s.whatsapp.net', 'hello');
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', { text: 'hello' });
    expect(res).toEqual({ id: 'OUT1', timestamp: 1700000001 });
  });

  it('getNumberId resolves via onWhatsApp and returns the jid when it exists', async () => {
    fakeSock.onWhatsApp.mockResolvedValue([{ jid: '628111@s.whatsapp.net', exists: true }]);
    const adapter = await readyAdapter();
    await expect(adapter.getNumberId('628111')).resolves.toBe('628111@s.whatsapp.net');
    await expect(adapter.checkNumberExists('628111')).resolves.toBe(true);
  });

  it('getNumberId returns null when the number is not on WhatsApp', async () => {
    fakeSock.onWhatsApp.mockResolvedValue([{ jid: '628111@s.whatsapp.net', exists: false }]);
    const adapter = await readyAdapter();
    await expect(adapter.getNumberId('628111')).resolves.toBeNull();
    await expect(adapter.checkNumberExists('628111')).resolves.toBe(false);
  });

  it('sendChatState maps typing -> composing presence', async () => {
    const adapter = await readyAdapter();
    await adapter.sendChatState('628111@s.whatsapp.net', 'typing');
    expect(fakeSock.sendPresenceUpdate).toHaveBeenCalledWith('composing', '628111@s.whatsapp.net');
  });

  it('messaging methods throw EngineNotReadyError before the connection is open', async () => {
    const adapter = newAdapter();
    await adapter.initialize({});
    await expect(adapter.sendTextMessage('x', 'y')).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(adapter.checkNumberExists('628111')).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(adapter.getNumberId('628111')).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(adapter.sendChatState('628111@s.whatsapp.net', 'typing')).rejects.toBeInstanceOf(EngineNotReadyError);
  });
});

describe('BaileysAdapter inbound fan-out', () => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const baileys = jest.requireMock('@whiskeysockets/baileys') as { getContentType: jest.Mock };

  beforeEach(() => {
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };
    jest.clearAllMocks();
    baileys.getContentType.mockReturnValue('conversation');
  });

  it('routes an inbound (not fromMe) message to onMessage with a neutral shape', async () => {
    const onMessage = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'IN1' },
          message: { conversation: 'hi there' },
          messageTimestamp: 1700000002,
          pushName: 'Alice',
        },
      ],
    });
    expect(onMessage).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const msg = onMessage.mock.calls[0][0] as { id: string; body: string; type: string; fromMe: boolean };
    expect(msg).toMatchObject({ id: 'IN1', body: 'hi there', type: 'text', fromMe: false });
  });

  it('routes a fromMe message to onMessageCreate (outgoing), not onMessage', async () => {
    const onMessage = jest.fn();
    const onMessageCreate = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage, onMessageCreate });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628111@s.whatsapp.net', fromMe: true, id: 'OUT2' },
          message: { conversation: 'sent from phone' },
          messageTimestamp: 1700000003,
        },
      ],
    });
    expect(onMessageCreate).toHaveBeenCalledTimes(1);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('ignores append (history) upserts', async () => {
    const onMessage = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage });
    fakeSock.fire('messages.upsert', {
      type: 'append',
      messages: [
        { key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'OLD' }, message: { conversation: 'old' } },
      ],
    });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('emits onMessageAck from messages.update with a neutral status', async () => {
    const onMessageAck = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessageAck });
    fakeSock.fire('messages.update', [{ key: { id: 'OUT1' }, update: { status: 3 } }]);
    expect(onMessageAck).toHaveBeenCalledWith('OUT1', 'delivered');
  });
});
