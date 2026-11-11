declare module "qrcode-terminal" {
  interface QrCodeTerminal {
    generate(text: string, options?: { small?: boolean }, callback?: (qr: string) => void): void;
    error: (message: string) => void;
  }
  const qrcode: QrCodeTerminal;
  export = qrcode;
}
