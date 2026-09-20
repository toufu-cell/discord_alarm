import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";

export async function checkStunUdp(): Promise<boolean> {
    const socket = createSocket("udp4");
    const transactionId = randomBytes(12);
    const request = Buffer.alloc(20);
    request.writeUInt16BE(0x0001, 0);
    request.writeUInt32BE(0x2112a442, 4);
    request.set(transactionId, 8);
    return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (success: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.close();
            resolve(success);
        };
        const timer = setTimeout(() => finish(false), 5_000);
        socket.once("error", () => finish(false));
        socket.on("message", (response) => {
            if (response.length < 20) return;
            const view = new DataView(response.buffer, response.byteOffset, response.byteLength);
            if (view.getUint16(0) === 0x0101 && view.getUint32(4) === 0x2112a442
                && transactionId.every((byte, index) => response[8 + index] === byte)) finish(true);
        });
        socket.send(request, 3478, "stun.cloudflare.com", (error) => {
            if (error) finish(false);
        });
    });
}
