import noble from "@stoprocent/noble";
import type {
  BleTransport,
  BleConnection,
  BleService,
  BleCharacteristic,
  BlePeripheral,
  ScanOptions,
  ScanHandle,
} from "@thermoprint/core";

function toPeripheral(p: any): BlePeripheral {
  return {
    id: p.id ?? p.uuid,
    name: p.advertisement?.localName ?? "",
    rssi: p.rssi ?? -100,
  };
}

const BT_BASE_SUFFIX = "00001000800000805f9b34fb";

function toShortUuid(uuid: string): string | null {
  const stripped = uuid.replace(/-/g, "").toLowerCase();
  if (stripped.length === 32 && stripped.startsWith("0000") && stripped.slice(8) === BT_BASE_SUFFIX) {
    return stripped.slice(4, 8);
  }
  return null;
}

function normalizeUuid(uuid: string): string {
  return toShortUuid(uuid) ?? uuid.replace(/-/g, "").toLowerCase();
}

const peripheralMap = new Map<string, any>();

class NobleCharacteristic implements BleCharacteristic {
  private listener: ((data: Uint8Array) => void) | null = null;

  constructor(private readonly char: any) {}

  async write(data: Uint8Array, withoutResponse: boolean): Promise<void> {
    await this.char.writeAsync(Buffer.from(data), withoutResponse);
  }

  async subscribe(listener: (data: Uint8Array) => void): Promise<void> {
    this.listener = listener;
    this.char.on("data", (data: Buffer) => {
      this.listener?.(new Uint8Array(data));
    });
    await this.char.subscribeAsync();
  }

  async unsubscribe(): Promise<void> {
    await this.char.unsubscribeAsync();
    this.char.removeAllListeners("data");
    this.listener = null;
  }
}

class NobleService implements BleService {
  constructor(private readonly characteristics: any[]) {}

  async getCharacteristic(uuid: string): Promise<BleCharacteristic | null> {
    const target = normalizeUuid(uuid);
    const char = this.characteristics.find((c: any) => normalizeUuid(c.uuid) === target);
    return char ? new NobleCharacteristic(char) : null;
  }
}

class NobleConnection implements BleConnection {
  private connected = true;

  constructor(private readonly peripheral: any) {
    peripheral.once("disconnect", () => {
      this.connected = false;
    });
  }

  async discoverService(uuid: string): Promise<BleService | null> {
    const serviceFilter = [normalizeUuid(uuid)];
    const result = await this.peripheral.discoverSomeServicesAndCharacteristicsAsync(serviceFilter, []);
    const characteristics = result.characteristics;
    if (!characteristics || characteristics.length === 0) return null;
    return new NobleService(characteristics);
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.peripheral.disconnectAsync();
      this.connected = false;
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }
}

export class NobleBleTransport implements BleTransport {
  private async waitForPoweredOn(): Promise<void> {
    if (noble.state === "poweredOn") return;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        noble.removeAllListeners("stateChange");
        reject(new Error(`Bluetooth adapter not ready (state: ${noble.state}). Is Bluetooth enabled?`));
      }, 5000);

      noble.on("stateChange", (state: string) => {
        if (state === "poweredOn") {
          clearTimeout(timeout);
          noble.removeAllListeners("stateChange");
          resolve();
        }
      });
    });
  }

  async scan(
    onDiscover: (peripheral: BlePeripheral) => void,
    options?: ScanOptions,
  ): Promise<ScanHandle> {
    await this.waitForPoweredOn();
    const namePrefix = options?.namePrefix;

    noble.on("discover", (peripheral: any) => {
      const name = peripheral.advertisement?.localName ?? "";
      if (namePrefix && !name.startsWith(namePrefix)) return;
      if (!name) return;
      const blePeriph = toPeripheral(peripheral);
      peripheralMap.set(blePeriph.id, peripheral);
      onDiscover(blePeriph);
    });

    await noble.startScanningAsync([], true);

    return {
      stop: async () => {
        await noble.stopScanningAsync();
        noble.removeAllListeners("discover");
      },
    };
  }

  async connect(peripheral: BlePeripheral): Promise<BleConnection> {
    const noblePeripheral = peripheralMap.get(peripheral.id);
    if (!noblePeripheral) {
      throw new Error(`Peripheral "${peripheral.name}" (${peripheral.id}) not found — was it discovered?`);
    }
    await noblePeripheral.connectAsync();
    return new NobleConnection(noblePeripheral);
  }
}
