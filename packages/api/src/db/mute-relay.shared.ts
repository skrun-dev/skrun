/**
 * A TCP relay on the loopback, for the Postgres tests: it passes everything
 * both ways between a client and the database until `mute()`. From then on,
 * the connections already open hear nothing more from the database — its
 * answers, and its closing the connection, are dropped — while what the
 * client sends still reaches it; connections opened after `mute()` pass as
 * before. It plays a database gone silent on a connection a pool already
 * holds, which only the client's own timer can give up on.
 */
import { type AddressInfo, connect, createServer, type Socket } from "node:net";

export interface MuteRelay {
  /** The database's URL, its host and port replaced by the relay's. */
  readonly url: string;
  /** From now on, the connections already open hear nothing more from the database. */
  mute(): void;
  /** Ends every connection through the relay, and stops listening. */
  close(): Promise<void>;
}

interface Passage {
  client: Socket;
  database: Socket;
  muted: boolean;
}

/** Starts a relay on 127.0.0.1, on a port the system picks, in front of `databaseUrl`. */
export async function startMuteRelay(databaseUrl: string): Promise<MuteRelay> {
  const target = new URL(databaseUrl);
  const host = target.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = Number(target.port || 5432);
  const open = new Set<Passage>();

  const server = createServer((client) => {
    const database = connect(port, host);
    const passage: Passage = { client, database, muted: false };
    open.add(passage);
    client.on("data", (chunk) => {
      if (!database.destroyed) database.write(chunk);
    });
    database.on("data", (chunk) => {
      if (!passage.muted && !client.destroyed) client.write(chunk);
    });
    database.on("end", () => {
      if (!passage.muted) client.end();
    });
    database.on("close", () => {
      if (!passage.muted) client.destroy();
    });
    // A socket's error ends that side; its close ends the other one.
    database.on("error", () => {});
    client.on("error", () => {});
    client.on("close", () => {
      database.destroy();
      open.delete(passage);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const through = new URL(databaseUrl);
  through.hostname = "127.0.0.1";
  through.port = String((server.address() as AddressInfo).port);

  return {
    url: through.toString(),
    mute() {
      for (const passage of open) passage.muted = true;
    },
    async close() {
      for (const passage of open) {
        passage.client.destroy();
        passage.database.destroy();
      }
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
