import { parseArgs } from "@std/cli/parse-args";
import { iterateReader } from "@std/io/iterate-reader";

const WS_STATUS_GOING_AWAY = 1001;
const WS_STATUS_INVALID_PROXY_RESPONSE = 1014;

function setupProxy(ws: WebSocket, upstreamConn: Deno.Conn) {
  let enc = new TextEncoder();

  ws.onopen = async function (event) {
    try {
      for await (const m of iterateReader(upstreamConn)) {
        ws.send(m);
      }

      ws.close(WS_STATUS_GOING_AWAY, "Upstream server closed the connection");
    } catch (err) {
      console.log("Conn errr", err);
      ws.close(WS_STATUS_INVALID_PROXY_RESPONSE);
    }
  };

  ws.onmessage = async function (event: MessageEvent) {
    let b = event.data;
    if (typeof (event.data) == "string") {
      b = enc.encode(event.data);
    }

    await upstreamConn.write(b);
  };

  ws.onclose = function (event) {
    // client went away so we are done proxying
    upstreamConn.close();
  };
}

async function reqHandler(req: Request) {
  console.log(req);

  if (req.headers.get("upgrade") != "websocket") {
    return new Response(null, { status: 501 });
  }

  // 1. Get the hostname from the request
  const u = new URL(req.url);
  let addr = u.searchParams.get("addr");
  if (addr == null) {
    return new Response("?addr=<host:port> expected", { status: 400 });
  }

  if (addr.lastIndexOf(":") == -1) {
    return new Response("?addr=<host>:<port> expected", { status: 400 });
  }

  let [hostname, portString] = addr.split(":", 2);
  let port = parseInt(portString);
  if (isNaN(port)) {
    return new Response(`invalid addr port specified: ${portString}`, {
      status: 400,
    });
  }

  // 2. Connect to the remote host
  try {
    let upstreamConn = await Deno.connect({
      hostname: hostname,
      port: port,
    });

    // 3. Upgrade the WebSocket
    const { socket: ws, response } = Deno.upgradeWebSocket(req);

    setupProxy(ws, upstreamConn);

    return response;
  } catch (err) {
    console.log(err);
    return new Response("Internal Error", { status: 502 });
  }
}

let args = parseArgs(Deno.args);
let port = 13000;
if (typeof (args.p) == "number") {
  port = args.p;
}

if ((typeof (args.key) == "string") && (typeof (args.cert) == "string")) {
  Deno.serve({
    handler: reqHandler,
    port: port,
    cert: args.cert,
    key: args.key,
  });
} else {
  Deno.serve({
    handler: reqHandler,
    port: port,
  });
}
