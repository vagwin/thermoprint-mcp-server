import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Printer } from "@thermoprint/core";
import type { BlePeripheral, BleTransport, BleConnection, BleService, BleCharacteristic } from "@thermoprint/core";
import noble from "@stoprocent/noble";

// --- Noble transport (reused from cli/src/transport/noble.ts) ---
function toPeripheral(p: any): BlePeripheral {
  return { id: p.id ?? p.uuid, name: p.advertisement?.localName ?? "", rssi: p.rssi ?? -100 };
}
const BT_BASE_SUFFIX = "00001000800000805f9b34fb";
function toShortUuid(uuid: string): string | null {
  const s = uuid.replace(/-/g, "").toLowerCase();
  if (s.length === 32 && s.startsWith("0000") && s.slice(8) === BT_BASE_SUFFIX) return s.slice(4, 8);
  return null;
}
function normalizeUuid(uuid: string): string { return toShortUuid(uuid) ?? uuid.replace(/-/g, "").toLowerCase(); }
const peripheralMap = new Map<string, any>();

class NobleCharacteristic implements BleCharacteristic {
  private listener: ((data: Uint8Array) => void) | null = null;
  constructor(private readonly char: any) {}
  async write(data: Uint8Array, withoutResponse: boolean): Promise<void> {
    await this.char.writeAsync(Buffer.from(data), withoutResponse);
  }
  async subscribe(listener: (data: Uint8Array) => void): Promise<void> {
    this.listener = listener;
    this.char.on("data", (data: Buffer) => this.listener?.(new Uint8Array(data)));
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
    peripheral.once("disconnect", () => { this.connected = false; });
  }
  async discoverService(uuid: string): Promise<BleService | null> {
    const result = await this.peripheral.discoverSomeServicesAndCharacteristicsAsync([normalizeUuid(uuid)], []);
    if (!result.characteristics?.length) return null;
    return new NobleService(result.characteristics);
  }
  async disconnect(): Promise<void> {
    if (this.connected) { await this.peripheral.disconnectAsync(); this.connected = false; }
  }
  get isConnected(): boolean { return this.connected; }
}

class NobleBleTransport implements BleTransport {
  private async waitForPoweredOn(): Promise<void> {
    if (noble.state === "poweredOn") return;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        noble.removeAllListeners("stateChange");
        reject(new Error(`Bluetooth adapter not ready (state: ${noble.state}). Is Bluetooth enabled?`));
      }, 5000);
      noble.on("stateChange", (state: string) => {
        if (state === "poweredOn") { clearTimeout(timeout); noble.removeAllListeners("stateChange"); resolve(); }
      });
    });
  }
  async scan(onDiscover: (peripheral: BlePeripheral) => void, options?: any): Promise<any> {
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
    return { stop: async () => { await noble.stopScanningAsync(); noble.removeAllListeners("discover"); } };
  }
  async connect(peripheral: BlePeripheral): Promise<BleConnection> {
    const noblePeripheral = peripheralMap.get(peripheral.id);
    if (!noblePeripheral) throw new Error(`Peripheral "${peripheral.name}" not found — was it discovered?`);
    await noblePeripheral.connectAsync();
    return new NobleConnection(noblePeripheral);
  }
}

// --- MCP tools ---
const TOOLS = [
  {
    name: "discover",
    description: "Scan for nearby BLE thermal printers (P12, M60, P15, etc.). Returns name, MAC, RSSI.",
    inputSchema: {
      type: "object",
      properties: {
        timeoutMs: { type: "number", description: "Scan duration in ms (default 5000)", default: 5000 },
      },
    },
  },
  {
    name: "print_text",
    description: "Print text on a thermal label. Renders text via PIL, applies Floyd-Steinberg dithering, sends to printer.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to print (supports \\n for multi-line)" },
        mac: { type: "string", description: "Printer BLE MAC address (e.g. 5E:55:09:0C:DF:BB). If omitted, scans for first P12." },
        density: { type: "number", description: "Print density 0-255 (default 3, matching verified fix)", default: 3 },
        copies: { type: "number", description: "Number of copies (default 1)", default: 1 },
        border: { type: "boolean", description: "Draw a border around the label", default: false },
        font_size: { type: "number", description: "Font size in points (default 24)", default: 24 },
        paperType: { type: "string", description: "gap = seek next gap (can spool); continuous = fixed 100-dot feed", enum: ["gap", "continuous"], default: "continuous" },
        rotate: { type: "number", description: "Rotation of the rendered label in degrees (0, 90, 180, 270)", default: 0, enum: [0, 90, 180, 270] },
      },
      required: ["text"],
    },
  },
  {
    name: "print_image",
    description: "Print a PNG/JPEG image on a thermal label. Accepts base64 or file path. Applies Floyd-Steinberg dithering.",
    inputSchema: {
      type: "object",
      properties: {
        image: { type: "string", description: "Base64-encoded image data or absolute file path" },
        mac: { type: "string", description: "Printer BLE MAC address" },
        density: { type: "number", description: "Print density 0-255 (default 3)", default: 3 },
        copies: { type: "number", description: "Number of copies (default 1)", default: 1 },
        paperType: { type: "string", description: "gap = seek next gap (can spool); continuous = fixed 100-dot feed", enum: ["gap", "continuous"], default: "continuous" },
      },
      required: ["image"],
    },
  },
  {
    name: "print_qr",
    description: "Generate a QR code and print it on a thermal label.",
    inputSchema: {
      type: "object",
      properties: {
        data: { type: "string", description: "Data to encode in the QR code" },
        mac: { type: "string", description: "Printer BLE MAC address" },
        density: { type: "number", description: "Print density 0-255 (default 3)", default: 3 },
        copies: { type: "number", description: "Number of copies (default 1)", default: 1 },
        paperType: { type: "string", description: "gap = seek next gap (can spool); continuous = fixed 100-dot feed", enum: ["gap", "continuous"], default: "continuous" },
        size: { type: "number", description: "QR code pixel size (default 96 = full tape width)", default: 96 },
      },
      required: ["data"],
    },
  },
  {
    name: "status",
    description: "Query printer status: battery level, model, firmware, cover state, paper state.",
    inputSchema: {
      type: "object",
      properties: {
        mac: { type: "string", description: "Printer BLE MAC address" },
      },
    },
  },
] as const;

// --- Helpers ---

async function findPrinter(mac?: string): Promise<BlePeripheral> {
  const transport = new NobleBleTransport();
  return new Promise<BlePeripheral>((resolve, reject) => {
    const timeout = setTimeout(() => {
      handle.stop().catch(() => {});
      reject(new Error(`No printer found within timeout${mac ? ` (MAC: ${mac})` : ""}`));
    }, 10000);
    const handle = {
      stop: async () => {
        clearTimeout(timeout);
        // noble.stopScanningAsync is called by transport
      },
    };
    // We need to use the transport's scan, but we need to capture the handle
    let scanHandle: any;
    transport.scan((p) => {
      if (mac) {
        // Match by MAC (noble uses UUID which is often the MAC lowercase without colons)
        const normalizedMac = mac.toLowerCase().replace(/:/g, "");
        if (p.id.toLowerCase().replace(/:/g, "") === normalizedMac || p.name.toLowerCase().includes(normalizedMac.slice(-6))) {
          clearTimeout(timeout);
          scanHandle?.stop?.().catch(() => {});
          resolve(p);
        }
      } else {
        // First P12 found
        if (p.name.startsWith("P12") || p.name.startsWith("LP90") || p.name.startsWith("P11")) {
          clearTimeout(timeout);
          scanHandle?.stop?.().catch(() => {});
          resolve(p);
        }
      }
    }, { namePrefix: mac ? undefined : "P12" }).then((h) => { scanHandle = h; }).catch(reject);
  });
}

async function connectPrinter(mac?: string): Promise<Printer> {
  const peripheral = await findPrinter(mac);
  const transport = new NobleBleTransport();
  return Printer.connect(transport, peripheral);
}

// --- Text rendering via PIL ---
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
const execFileAsync = promisify(execFile);

async function renderTextToPng(text: string, opts: { fontSize?: number; border?: boolean; width?: number; rotate?: number }): Promise<string> {
  const { fontSize = 24, border = false, width = 96, rotate = 0 } = opts;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "thermoprint-"));
  const pngPath = path.join(tmpDir, "label.png");
  const script = `
from PIL import Image, ImageDraw, ImageFont
import sys
text = ${JSON.stringify(text)}
font_size = ${fontSize}
border = ${border ? "True" : "False"}
width = ${width}
rotate = ${rotate}
# Render text
try:
    font = ImageFont.truetype("/home/debian/.local/share/fonts/inter/Inter-Bold.ttf", font_size)
except:
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", font_size)
    except:
        font = ImageFont.load_default()
# Measure
bbox = font.getbbox("M")
line_height = max(bbox[3] - bbox[1], font_size)
lines = text.split("\\n")
max_w = 0
for line in lines:
    w = font.getlength(line)
    if w > max_w: max_w = w
# Height - add extra padding at bottom to avoid clipping
h = int(line_height * len(lines) * 1.4) + 10
w = int(max_w) + 20
# Create image (white bg, black text)
img = Image.new("L", (w, h), 255)
draw = ImageDraw.Draw(img)
y = 5
for line in lines:
    draw.text((10, y), line, fill=0, font=font)
    y += int(line_height * 1.2)
if border:
    draw.rectangle([0, 0, w-1, h-1], outline=0, width=2)
# Rotate if requested (before resize to target width)
if rotate:
    img = img.rotate(rotate, expand=True)
# Resize to target width (96 dots) preserving aspect
curr_w, curr_h = img.size
scale = width / curr_w
new_h = max(1, int(curr_h * scale))
img = img.resize((width, new_h), Image.LANCZOS)
img.save(${JSON.stringify(pngPath)})
print(${JSON.stringify(pngPath)})
`;
  const scriptPath = path.join(tmpDir, "render.py");
  fs.writeFileSync(scriptPath, script);
  const { stdout } = await execFileAsync("python3", [scriptPath], { timeout: 30000 });
  return stdout.trim();
}

async function renderQrToPng(data: string, size: number): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "thermoprint-"));
  const pngPath = path.join(tmpDir, "qr.png");
  const script = `
import qrcode
from PIL import Image
qr = qrcode.QRCode(version=1, box_size=10, border=2)
qr.add_data(${JSON.stringify(data)})
qr.make(fit=True)
img = qr.make_image(fill_color="black", back_color="white")
img = img.resize((${size}, ${size}), Image.NEAREST)
img.save(${JSON.stringify(pngPath)})
print(${JSON.stringify(pngPath)})
`;
  const scriptPath = path.join(tmpDir, "qr.py");
  fs.writeFileSync(scriptPath, script);
  const { stdout } = await execFileAsync("python3", [scriptPath], { timeout: 30000 });
  return stdout.trim();
}

// --- Image loading ---
import sharp from "sharp";

async function loadImageToRaw(imageInput: string): Promise<{ data: Uint8Array; width: number; height: number }> {
  let buffer: Buffer;
  if (imageInput.startsWith("/") && fs.existsSync(imageInput)) {
    buffer = fs.readFileSync(imageInput);
  } else {
    // Assume base64
    buffer = Buffer.from(imageInput, "base64");
  }
  const img = sharp(buffer);
  const metadata = await img.metadata();
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

// --- Server ---
const server = new Server(
  { name: "thermoprint-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
  const { name, arguments: args } = req.params;
  try {
    switch (name) {
      case "discover": {
        const transport = new NobleBleTransport();
        const found: any[] = [];
        const handle = await transport.scan((p) => { found.push(p); }, { namePrefix: undefined });
        await new Promise((r) => setTimeout(r, args?.timeoutMs ?? 5000));
        await handle.stop();
        return { content: [{ type: "text", text: JSON.stringify(found, null, 2) }] };
      }
      case "print_text": {
        const pngPath = await renderTextToPng(args.text, { fontSize: args.font_size ?? 24, border: args.border ?? false, width: 96, rotate: args.rotate ?? 0 });
        const raw = await loadImageToRaw(pngPath);
        const printer = await connectPrinter(args.mac);
        try {
          await printer.print(raw, { density: args.density ?? 3, copies: args.copies ?? 1, paperType: args.paperType ?? "continuous" });
        } finally { await printer.disconnect(); }
        return { content: [{ type: "text", text: `Printed "${args.text}" (${args.copies ?? 1} copy/copies)` }] };
      }
      case "print_image": {
        const raw = await loadImageToRaw(args.image);
        const printer = await connectPrinter(args.mac);
        try {
          await printer.print(raw, { density: args.density ?? 3, copies: args.copies ?? 1, paperType: args.paperType ?? "continuous" });
        } finally { await printer.disconnect(); }
        return { content: [{ type: "text", text: `Printed image (${raw.width}x${raw.height}, ${args.copies ?? 1} copy/copies)` }] };
      }
      case "print_qr": {
        const pngPath = await renderQrToPng(args.data, args.size ?? 96);
        const raw = await loadImageToRaw(pngPath);
        const printer = await connectPrinter(args.mac);
        try {
          await printer.print(raw, { density: args.density ?? 3, copies: args.copies ?? 1, paperType: args.paperType ?? "continuous" });
        } finally { await printer.disconnect(); }
        return { content: [{ type: "text", text: `Printed QR code for "${args.data}"` }] };
      }
      case "status": {
        const printer = await connectPrinter(args.mac);
        try {
          const [status, battery, model, firmware] = await Promise.all([
            printer.getStatus(), printer.getBattery(), printer.getModel(), printer.getInfo("firmware"),
          ]);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ status: status.status, battery, model, firmware }, null, 2),
            }],
          };
        } finally { await printer.disconnect(); }
      }
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack ?? "") : String(err);
    return { content: [{ type: "text", text: `Error: ${msg}\n${stack}` }], isError: true };
  }
});

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("thermoprint MCP server running on stdio");
